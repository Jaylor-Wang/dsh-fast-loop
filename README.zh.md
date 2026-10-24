# dsh-fast-loop

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-fast-loop.svg?color=blue)](https://www.npmjs.com/package/dsh-fast-loop)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-fast-loop.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-fast-loop.svg)](https://github.com/Jaylor-Wang/dsh-fast-loop/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 打造的高性能流式智能体循环（Agent Loop）插件。

全面替代默认的 `agent-loop`，提供高吞吐有界并发工具调度、防影子穿透的 Cordis 服务依赖注入架构、事务级零延迟消息收件箱（Inbox），以及完备的持久化轮次与步骤（Turn / Step）弹性自愈能力。

---

## v0.2.0 版本核心特性

- **完整上下文用量透传（Context Occupancy）**：精确补齐 `request/context` 调度事件，完整支持前端上下文占用百分比与环形进度条的即时渲染。
- **全链路保序并发调度**：多工具并发调用下，严格按照模型指令顺序 FIFO 落盘，`tool/result` 携带 `sourceEventSeqs` 完美实现 Web UI 卡片 1:1 配对。
- **性能实测套件与 Benchmark**：集成原生并发测试套件，在典型 I/O 工具批次调度中实测取得 ~8x 吞吐提速。
- **Cordis 影子上下文防穿透隔离**：解耦工厂依赖解析与外部调用方影子上下文（Caller Shadow），彻底消除服务依赖提取丢失问题。
- **零延迟事务级收件箱与自愈能力**：支持消息原子认领与跨轮次状态自愈，保证会话持久化绝对一致性。

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

### 在 `cordis.patch.yml` 中启用

禁用默认的 `agent-loop` 并插入 `dsh-fast-loop`：

```yaml
# 禁用原生 Agent Loop
- id: agent-loop
  disabled: true

# 接入高性能 Fast Loop
- insert:
  - id: fast-loop
    name: dsh-fast-loop
    config:
      agents: []
      maxParallelToolCalls: 10
      enableStreamingTools: true
```

---

## 配置项说明

| 配置键 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `maxParallelToolCalls` | `number` | `10` | 单个 Step 中允许并发执行的最大工具调用数量。 |
| `enableStreamingTools` | `boolean` | `true` | 是否启用工具执行结果流式推送。 |
| `agents` | `array` | `[]` | 静态声明的 Agent 标识符及个性化配置覆盖列表。 |

---

## 开源协议

[MIT](LICENSE) © [dsh-fast-loop contributors](LICENSE)
