在深入阅读了 DSH 官方默认实现（`@deepseek-ai/dsh-agent-loop`，位于宿主环境 `dsh` 内）的核心源码、类型定义与设计决策后，结合你的 `dsh-fast-loop` 以及此前对 `pi` 与 `oh-my-pi` 的分析，为你带来**当前版本 DSH 原生 Agent Loop 的深度全景剖析**，并在此基础上提出针对性的**重构优化进化建议**。

---

### 一、 DSH 原生 `dsh-agent-loop` 的架构全景与实现剖析

DSH 的 `dsh-agent-loop`（即 `ReactLoopAgent`）并不是一个普通的“LLM 发请求-收工具”循环，它是一个**基于 Cordis 依赖注入微内核的完全事件溯源（Event-Sourcing）状态机**：

```
                    ┌────────────────────────────────────────────────────────┐
                    │               Cordis Service Context                  │
                    │ (agents, sessions, llm, tools, systemPrompt, etc.)     │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
                                 ┌─────────────▼─────────────┐
                                 │     ReactLoopInbox        │
                                 │ (next-turn / next-step)   │
                                 └─────────────┬─────────────┘
                                               │ inbox.claim()
                                 ┌─────────────▼─────────────┐
                                 │     agent/pre-step        │
                                 └─────────────┬─────────────┘
                                               │
               ┌───────────────────────────────┴───────────────────────────────┐
               ▼                                                               ▼
    ┌──────────────────────┐                                        ┌──────────────────────┐
    │     prepareRequest   │ ──> agent/request waterfall            │    ToolCallRecovery  │
    │  (adapter defaults)  │                                        │ (observe session     │
    └──────────┬───────────┘                                        │  events in step)     │
               ▼                                                    └──────────┬───────────┘
    ┌──────────────────────┐                                                   │
    │  AssistantStream     │ ──> agent/assistant-stream                        │
    │   (attempt / chunks) │ ──> agent/request-error (waterfall)               │
    └──────────┬───────────┘                                                   │
               ▼                                                               │
    ┌──────────────────────┐                                                   │
    │  executeToolCalls    │ ──> runGroup (bounded parallel / exclusive)       │
    │                      │ ──> 调度失败/中断时由 ToolCallRecovery 兜底补齐 ────┘
    └──────────────────────┘
```

#### 1. 官方原生设计的核心长板（为何这么设计）

1. **严格的事件溯源与不可变历史（Event-Sourced Projection）**：
   - 官方将所有状态持久化为离散事件：`turn/start`、`step/start`、`request/header`、`request/context`、`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end`。
   - 所有内存状态（`inbox`、`turnBoundary`）均通过纯函数 `Projection` 从事件日志中折叠计算得出。这种设计天然支持**会话无损回放、跨进程冷启动恢复与时间旅行调试**。
2. **深冻结防污染（Deep Freezing）**：
   - 官方在 [`ReactLoopAgent.buildRequest`](D:/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L1214) 中，对每次组装派生出的历史消息调用 `deepFreeze(m)`，并用 `WeakSet<object>` 记忆已冻结对象。任何下层工具或插件若试图直接在内存中篡改历史消息，都会直接在严格模式下报错抛出，保障了多插件环境的数据完整性。
3. **断网与异常下的工具成对性兜底（`ToolCallRecovery`）**：
   - 官方在每次 `step()` 启动时挂载了单例 [`ToolCallRecovery`](D:/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L975-L998)，监听该 step 产生的所有 `session/event`。如果模型流式吐出了 `tool/call` 后，循环因为网络异常、底层崩溃或被意外中断，`catch` 块会从 `toolRecovery.results()` 中抽取未闭合的调用，强制补全合成的 `tool/result`，**绝不在持久化日志中留下孤儿 `tool/call`**。
4. **适配器生命周期与错误重试瀑布（`agent/request-error`）**：
   - 当模型流式断开或返回错误（`finish.kind === "error"`）时，官方会触发 `this.dispatch.waterfall("agent/request-error", ...)`。重试策略插件（如指数退避、429 限流等待、Token 轮换）可在不污染核心循环的前提下截获错误并返回 `{ kind: "retry" }`，驱动 step 内原地重试。

---

#### 2. 官方原生实现的设计缺陷与历史负债（为什么卡顿与死锁）

官方 `dsh-agent-loop` 虽然设计完备，但在实际运行中有严重痛点：

1. **会话持久化写锁泄漏（Session Writer-Held Deadlock）**：
   - 官方在 `resume` / `createAgent` 的错误路径中，对 `SessionHandle` 的注销分散在各个异步回调和 effect 中。当浏览器快速刷新、WebSocket 重连或插件热重载时，未正常执行 `handle.close()`，后一个连接再次调用 `persistence.open(id, "write")` 便会直接报 `SessionAlreadyOwnedError`，导致整个 Session 彻底死锁不可用。
2. **并发工具调度的“一元静态分类”（Unary Tool Classification）**：
   - 官方文档在已知限制中明确写道：“_分类是一元的：安全性取决于比较同级调用或资源的调用必须保持独占_”。
   - 官方调度器仅通过 `ctx.tools.executionMode(first.exec).kind` 检查单个工具是否声明为 `parallel`。它无法识别**参数级并发**（例如两个 `fs_read` 并发，一个 `fs_write` 独占；或者针对不同文件路径的 `edit`），导致许多本质安全的调用被强行切成独占屏障，极度浪费 LLM 批次并发吞吐。
3. **全流程单一 Abort 信号（缺少软打断与协作机制）**：
   - 整个 Turn 期间只有一个 `phase.abort.signal`。用户发送中途指导（Steer）时，无法温和打断纯等待工具（如 `wait` 或等待用户确认的卡片），如果点强制取消则会直接“硬杀”所有正在执行的子进程，破坏宿主环境状态。
4. **对大模型输出畸变零自愈（Healer Blank）**：
   - 官方完全假设大模型总是吐出合规的 JSON 与 Tool ID。一旦 DeepSeek 吐出裸 XML（DSML 泄漏）或者模型生成了重复的 `callId`，官方代码会直接把坏数据透传到下游，引发 Provider 抛出 400 坏请求进而导致整个 Turn 挂死。

---

### 二、 `dsh-fast-loop` 对比原生的“得”与“失”

你目前编写的 `dsh-fast-loop` 成功干掉了原版的痛点，但在重构时也无意中丢弃了几个极其关键的安全保障：

| 机制与能力                 | DSH 官方 `dsh-agent-loop`                   | 你的 `dsh-fast-loop`                                        | 现状诊断与影响                                                                                                   |
| :------------------------- | :------------------------------------------ | :---------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| **会话锁回收与销毁流水线** | ❌ 易泄漏，产生死锁报错                     | ✅ **极佳（重构核心胜利）**：引入事务级回滚与多阶段独立清理 | 彻底解决了刷新与切标签崩溃。                                                                                     |
| **工具批次并发吞吐**       | ⚠️ 吞吐受限（易被一元独占阻塞）             | ✅ **提升显著**：有界并发池 + 8x 吞吐加速                   | 性能测试数据扎实。                                                                                               |
| **断点崩溃成对性自愈**     | ✅ 拥有 `ToolCallRecovery` 监听器           | ❌ **丢失**：`loop.ts:126` 的 step 失败时无兜底补齐         | **高危**：一旦 step 抛错，会话日志将残留孤儿 `tool/call`，下次恢复或重试将直接被 OpenAI/Claude API 报 400 拒收！ |
| **LLM 错误重试瀑布**       | ✅ 拥有 `agent/request-error` waterfall     | ❌ **丢失**：`loop.ts:363` 直接抛错 `throw error`           | **破坏契约**：上层挂载的自动重试、429 退避插件全部失效。                                                         |
| **全局错误事件分发**       | ✅ 触发 `this.dispatch.emit("agent/error")` | ❌ **丢失**：仅打印 logger，未分发事件                      | DSH Web 界面和遥测插件无法获知 Agent 崩溃详情。                                                                  |
| **参数解析容错性**         | 兼容非 JSON 文本：`catch { return raw; }`   | 简单返回空对象：`catch { return {}; }`                      | 丢失非法参数原始上下文，模型无法得知自己的参数错在哪里。                                                         |
| **单工具执行失败隔离**     | 框架内捕获并生成错误 ToolResult             | 存在 `throwSchedulerFailure` 漏洞可能引发 step 崩溃         | 工具业务报错容易演化为系统级 Crash。                                                                             |

---

### 三、 汲取 `pi` 与 `oh-my-pi` 的针对性优化建议

为了让 `dsh-fast-loop` 既保留现有的高性能与死锁免疫，又能具备工业级的抗击打能力，建议实施以下三大维度的重构升级：

```
                ┌────────────────────────────────────────────────────────┐
                │             dsh-fast-loop 下一阶段架构演进              │
                └───────────────────┬────────────────────────────────────┘
                                    │
     ┌──────────────────────────────┼──────────────────────────────┐
     ▼                              ▼                              ▼
【P0 契约对齐与成对防崩】      【P1 深度调度与抗畸变自愈】    【P2 极致缓存与流式投机】
 1. 挂回 ToolCallRecovery       1. 多级信号 (Soft Steering)    1. 稳定 System 字节前缀
 2. 补回 agent/request-error    2. 资源级细粒度读写屏障         2. 流式参数提前投机执行
 3. 工具业务崩溃无害化          3. DeepSeek DSML 标签拦截自愈   3. 事件循环协作让出 (yield)
```

---

#### 核心优化 1（P0）：挂回 `ToolCallRecovery`，防御崩溃后的历史损坏

在事件溯源模型中，大模型 API（如 Claude / GPT / DeepSeek）有一条铁律：**每一个 `tool_use`/`tool/call` 必须紧随一个相同 ID 的 `tool_result`，否则后续请求直接 400**。

在 [`src/loop.ts`](E:/Github/dsh-fast-loop/src/loop.ts#L126-L135) 的 `runStep` 调用外层，必须像官方一样引入 `ToolCallRecovery`：

```ts
import { ToolCallRecovery } from "@deepseek-ai/dsh-session";

// 在 step 执行块中：
const toolRecovery = new ToolCallRecovery();
const stopRecovery = this.agent.ctx.on("session/event", (session, event) => {
  if (session === this.agent.session) toolRecovery.observe(event);
});

try {
  stepConcluded = await this.runStep(turn, step, decision, assembly, signal);
} catch (error) {
  // 核心：Step 意外中断时，将所有未回答的 toolCall 自动补全合成错误结果
  try {
    for (const event of toolRecovery.results()) {
      this.agent.session.append("tool/result", event.data, {
        surfaceOp: "append",
        ...(event.sourceEventSeqs !== undefined
          ? { sourceEventSeqs: event.sourceEventSeqs }
          : {}),
      });
    }
  } catch (recoveryError) {
    throw new AggregateError(
      [error, recoveryError],
      "Step failed and pending tool results could not be recorded",
    );
  }
  throw error;
} finally {
  stopRecovery();
  this.agent.session.append("step/end", stepPosition);
}
```

---

#### 核心优化 2（P0）：还原 `agent/request-error` 瀑布流，打通 DSH 官方插件生态

在 [`src/loop.ts:353-402`](E:/Github/dsh-fast-loop/src/loop.ts#L353-L402) 中，当 LLM 请求流结束时，应校验 `live.finish` 并支持插件介入重试：

```ts
const finish = live.finish;
if (finish.kind === "error" || finish.kind === "aborted") {
  live.settle(
    "assistant/attempt",
    () =>
      this.agent.session.append("assistant/attempt", {
        turn,
        step,
        stream: [...live.stream],
      }).seq,
  );

  // 触发 DSH 官方重试瀑布流，允许重试插件介入
  const action = await this.agent.dispatch.waterfall(
    "agent/request-error",
    {
      turn,
      step,
      provider: request.provider,
      failure: finish.failure,
      retryPolicy: preparedCall?.retryPolicy,
      signal,
    },
    () => Promise.resolve(undefined),
  );

  signal.throwIfAborted();
  // 若插件允许重试，则在 while 循环中原地进行下一次 attempt，而不是直接 Crash
  if (action?.kind === "retry") {
    continue;
  }
  throw new LlmError(
    finish.failure.message,
    finish.failure.code,
    finish.failure,
  );
}
```

---

#### 核心优化 3（P1）：学习 `oh-my-pi`，构建多级信号与“协作式软打断”

当前 DSH 的用户痛点之一是：执行耗时工具（如一个跑 30 秒的测试命令）时，用户如果在前端发了一条新提示（Steer），界面毫无反应，必须干等。

借鉴 `oh-my-pi` 的分层打断机制：

1. **纯等待工具打断信号（`steeringAbortSignal`）**：
   - 在 `FastLoopDriver` 执行工具组时，监听 `inbox` 是否有新入队消息。
   - 如果遇到等待类工具（如 `ask_user` 或 `wait`），直接触发局部信号提前退出，立即将用户的 Steer 消息纳入下一步。
2. **长耗时工具协作软信号（`steeringSoftSignal`）**：
   - 传递给 `exec` 包装对象。如果 `bash` 工具支持自动后台化（Auto-Background），收到该软信号后**不杀死进程，而是自动将该进程推到后台并返回 Job ID**，立即把主循环让给用户的最新消息。

---

#### 核心优化 4（P1）：针对 DeepSeek 模型的防御清洗器（DSML & ID Healer）

在 `loop.ts` 收到大模型返回的 `blocks` 后，向 `executeTools` 传递前增加拦截检查：

1. **DSML 原始标签检测**：
   - 检查 `blocks` 中是否有 `type === "text"` 包含了 `<|tool_calls|>` 或 `<invoke name="...">`。
   - 若存在且未解析出 `tool-call` block，利用正则表达式在前端流式层实时提取补全为虚拟的 `tool-call`，或者像 `oh-my-pi` 一样向 session 追加一个 Nudge 系统提示（`"检测到原始标签泄漏，请通过标准工具调用语法重新执行"`），避免 Agent 静默终止。
2. **ToolCall ID 保证唯一与合法**：
   - 过滤 `toolCalls` 时，利用 `Set<string>` 检查 ID：
     ```ts
     const seenIds = new Set<string>();
     for (const call of toolCalls) {
       if (!call.id || seenIds.has(call.id)) {
         call.id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
       }
       seenIds.add(call.id);
     }
     ```

---

#### 核心优化 5（P2）：动态资源读写屏障（Argument-Aware Barrier）

官方和当前 `dsh-fast-loop` 的 `executionMode` 是只看工具名（一元化）。
可扩展为**基于参数的读写屏障**：

- 例如：`read_file` 工具无论调多少次，均为 `shared` 并发。
- `edit_file` / `write_file`：
  - 如果两个编辑操作针对的是**不同文件路径**（例如 `a.ts` 和 `b.ts`），它们依然可以标记为 `shared` 并行！
  - 只有当同一批次中操作了**相同文件路径**，或者调用了全局副作用命令（`bash`），才升格为 `exclusive` 屏障。
- 这将使多文件代码生成的性能再次翻倍。

---

### 四、 总结与展望

你当前的 `dsh-fast-loop` 已经精准完成了重构中最难啃的一块骨头——**通过精准的生命周期管理干掉了困扰 DSH 的 Session 死锁 Bug，并引入了高质量的 FIFO 有界并发池**。

接下来只需按照：

1. **第一步（对齐安全底线）**：补回 `ToolCallRecovery`、恢复 `agent/request-error` 与 `agent/error`，消除单工具执行崩溃引发的调度器雪崩；
2. **第二步（增强交互韧性）**：引入多级软打断，加入针对 DeepSeek 输出特性的防畸变清洗（DSML/ID 去重）；
3. **第三步（挖掘极致吞吐）**：实现参数感知的路径级读写并发屏障。

你的 `dsh-fast-loop` 就能在保持与 DSH 生态 100% 契约兼容的同时，成为整个 DeepSeek Harness 体系中性能最强、最稳定的工业级 Agent Loop！
