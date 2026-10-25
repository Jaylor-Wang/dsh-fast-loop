# dsh-fast-loop

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-fast-loop.svg?color=blue)](https://www.npmjs.com/package/dsh-fast-loop)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-fast-loop.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-fast-loop.svg)](https://github.com/Jaylor-Wang/dsh-fast-loop/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 打造的高性能流式智能体循环（Agent Loop）插件。

全面替代默认的 `agent-loop`，提供高吞吐有界并发工具调度、防影子穿透的 Cordis 服务依赖注入架构、事务级零延迟消息收件箱（Inbox），以及完备的持久化轮次与步骤（Turn / Step）弹性自愈能力。

---

## v0.4.2 版本核心特性

- **路径级读写并发屏障（Path-Aware Barrier）**：打破 DSH 原生“一元独占”调度枷锁。跨文件读写编辑（`edit`、`write`、`read`）并发度拉满至物理极限（`maxParallelToolCalls`），同文件操作自动安全串行互斥；全局副作用工具（`bash`）自动升格为隔离屏障。
- **内置全局 CLI 一键开关（`dsh-fast-loop`）**：原生提供系统级命令行工具，支持在任意终端直接运行 `dsh-fast-loop enable`、`dsh-fast-loop disable` 与 `dsh-fast-loop status`，安全外科手术式修改 `cordis.patch.yml` 并触发 DSH live HMR，实现秒级无感切换与回退。
- **崩溃断点自动兜底防崩（ToolCallRecovery）**：对齐 DSH 会话事件溯源要求，在 Step 意外崩溃或中断时自动补齐未成对的 `tool/result`，彻底杜绝孤儿调用导致下一次恢复报 `400 Bad Request`。
- **耗时等待与 Steer 协作式软打断（零延迟响应）**：工具批次执行期间实时监听 `inbox`，在用户中途发送指导意见时立即触发局部软打断（`TOOL_INTERRUPT_ABORT_REASON`），耗时等待工具（`wait`、`sleep`、`ask`）即刻让出控制权，交互响应零延迟。
- **DeepSeek 畸变拦截与 Nudge 自愈机制**：清洗文本中泄漏的裸 `<｜tool_calls｜>` 标签；当模型纯文本泄漏而无结构化调用时，自动注入自愈 Nudge 推动模型步入下一步正确调用；对重复与空 ID 自动规整为会话唯一 ID。
- **官方错误重试瀑布流与遥测对齐**：完整还原 `agent/request-error` 瀑布流并分发 `agent/error` 事件，与官方指数退避、429 限流重试插件 100% 契约兼容。
- **会话全生命周期事务级回滚与零锁泄漏**：彻底修复切换/恢复会话时出现的 `SessionAlreadyOwnedError`（`当前会话已被占用 / session/writer-held`）死锁 Bug。在创建、恢复、冷读取失败、外部中断或 setup 校验失败时，均通过 `finally` 块强制回收持久化句柄（Handle）与释放写锁。
---

## 核心特性与架构设计

### 1. 高并发工具调度器
- **有界并发池**：根据步骤指令动态发起最多 `maxParallelToolCalls` 路并行工具调用，并严格按照 FIFO 顺序完成与落盘，兼顾并发吞吐与数据确定性。
- **独占工具同步屏障**：当遇到需要独占控制台或文件系统的工具（如持久化执行等）时，自动等待在飞并发任务清空并有序执行。
- **工具崩溃容错自愈**：捕获单次工具调用的非预期异常，确保前序及同批次其余工具调用结果完整落盘，杜绝 Agent 状态悬挂。

### 2. 底层架构与 Cordis 规范接入
- **运行时依赖持有机制**：彻底隔绝外部调用方 Context 影子代理，确保 `sessionProjections`、`systemPrompt`、`tools`、`llm` 等核心服务在任何调用栈下均可安全触达。
- **持久化轮次投影对齐**：通过 `turnBoundary` 投影在冷启动与会话恢复时精确对齐历史最后轮次，杜绝轮次跳变与意外终止。
- **断点续跑补全机制**：会话恢复时自动扫描并补全未闭合的异常中断事件（`interruptedTurnClosers`），保证事件流合规。

---

## 安装与快速上手

### 通过 DSH 插件命令安装（推荐）

```sh
dsh plugin --profile web add dsh-fast-loop@latest
```

### 通过 npm / pnpm 安装

```sh
npm install dsh-fast-loop@latest
# 或
pnpm add dsh-fast-loop@latest
```

### 方式一：命令行一键切换（推荐，零风险）

内置 CLI 自动安全更新 `cordis.patch.yml`，彻底杜绝手写 YAML 缩进错误：

```sh
# 启用 dsh-fast-loop 并禁用官方 loop
npx dsh-fast-loop enable

# 一键回退至官方原生 agent-loop
npx dsh-fast-loop disable

# 查看当前激活模式
npx dsh-fast-loop status
```

### 方式二：手动在 `cordis.patch.yml` 中配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 中禁用默认的 `agent-loop` 并插入 `dsh-fast-loop`：

```yaml
# 禁用原生 Agent Loop
- id: agent-loop
  disabled: true

# 接入高性能 Fast Loop
- insert:
  - id: fast-loop
    name: dsh-fast-loop
    config:
      maxParallelToolCalls: 10
      enableStreamingTools: true
      enablePathAwareBarrier: true
      enableSteeringSoftInterrupt: true
```

---

## 配置项说明

| 配置键 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `maxParallelToolCalls` | `number` | `10` | 单个 Step 中允许并发执行的最大工具调用数量。 |
| `enableStreamingTools` | `boolean` | `true` | 是否启用工具执行结果流式推送。 |
| `enablePathAwareBarrier` | `boolean` | `true` | 是否启用路径级读写并发屏障（多文件并发编辑）。 |
| `enableSteeringSoftInterrupt` | `boolean` | `true` | 是否启用长等待工具与 Steer 消息的协作式软打断。 |
| `agents` | `array` | `[]` | 静态声明的 Agent 标识符及个性化配置覆盖列表。 |
---

## 开源协议

[MIT](LICENSE) © [dsh-fast-loop contributors](LICENSE)
