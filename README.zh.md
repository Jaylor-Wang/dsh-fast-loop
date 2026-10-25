# dsh-fast-loop

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-fast-loop.svg?color=blue)](https://www.npmjs.com/package/dsh-fast-loop)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-fast-loop.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-fast-loop.svg)](https://github.com/Jaylor-Wang/dsh-fast-loop/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 打造的高性能流式智能体循环（Agent Loop）插件。

全面替代默认的 `agent-loop`，提供高吞吐有界并发工具调度、防影子穿透的 Cordis 服务依赖注入架构、事务级零延迟消息收件箱（Inbox），以及完备的持久化轮次与步骤（Turn / Step）弹性自愈能力。

---

## v0.4.5 版本核心特性

- **流式帧号严格单调递增与终止守卫**：引入 `AssistantStreamAttempt` 状态机终结守卫，杜绝重复发射帧与跳号，彻底消除前端因 `RemoteStreamCarrierError: session assistant stream skipped revision` 导致的白屏断流。
- **活跃阶段输入唤醒锁存（用户中途追问保障）**：当驱动处于执行态（`running`）接收用户消息时，硬件级强制锁存 `phase.wakeRequested = true` 并在轮次结算后自动唤醒驱动，根治“正在分析请求卡死、消息被吞”。
- **纯净轮次结算与信号隔离**：严格按轮次重新分配全新的 `AbortController` 并重置步骤计数，结算始终返回标准 `{ kind: "completed" }`，彻底根除前端 UI 虚假弹出的红字“处理失败”。
- **对齐 DSH 会话 V4 事件溯源规范**：合成自愈消息均携带生产者所有权标识（`source: { kind: "fast-loop" }`），100% 满足会话事件规范校验。
- **全套前端洁癖契约回归测试**：内置 4 项针对前端挑剔时序的专属 Mock 契约测试，保障版本迭代稳定不破约。

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
