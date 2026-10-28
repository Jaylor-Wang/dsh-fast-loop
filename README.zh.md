# dsh-fast-loop

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-fast-loop.svg?color=blue)](https://www.npmjs.com/package/dsh-fast-loop)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-fast-loop.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-fast-loop.svg)](https://github.com/Jaylor-Wang/dsh-fast-loop/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 开发的实验性 Agent Loop 插件，现保留供参考。

## 维护状态

**本项目已于 2026 年 10 月 28 日停止主动维护，仓库已归档。** 最后正式 GitHub Release 为 [v0.5.2](https://github.com/Jaylor-Wang/dsh-fast-loop/releases/tag/v0.5.2)，不再保证与后续 DSH 版本兼容。

官方 loop 持续演进，独立维护完整替代实现需要较高的兼容性成本，目前也没有证据证明本项目在真实任务中普遍更快。**后续使用推荐回归 DSH 官方 `agent-loop`。** 源码、发布历史和实验成果继续保留，供研究与 Fork。

如果已安装本插件，可为对应配置恢复官方 loop：

```sh
dsh-fast-loop disable --profile web
dsh-fast-loop status --profile web
```

将 `web` 替换为实际配置名称，然后重启 DSH。下方安装与配置说明仅作为历史参考保留。

---

## v0.5.2 版本核心特性

- **步骤级指标**：导出 `StepMetrics`，提供 `agent.lastStepMetrics` 与运行时 `agent/step-metrics` 事件，记录步骤耗时、最后一次模型尝试耗时、首 chunk 延迟、工具耗时、尝试次数及 token 用量。
- **结构化软中断**：使用 Symbol 分类与调用索引跟踪替换错误文本子串匹配，保留轮询兜底。
- **DSML 快速路径**：对不含 `<` 的文本跳过 DSML 正则扫描。
- **扩展兜底重试分类**：新增 `PROTOCOL_DRIFT`、`RATE_LIMIT` 和 `SERVER`。
- **接口注意事项**：`TRANSIENT_RETRYABLE_CODES` 从 `Set` 改为只读对象表；外部调用者应使用 `isTransientRetryableFailure(code)` 替代 `.has()`。
- **指标边界**：指标仅通过运行时提供；先前失败尝试和重试等待会计入剩余开销。现有并发 Benchmark 不能证明比当前官方 loop 更快。

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

## 安装与快速上手（历史参考）

### 通过 DSH 插件命令安装

```sh
dsh plugin --profile web add dsh-fast-loop@latest
```

### 通过 npm / pnpm 安装

```sh
npm install dsh-fast-loop@latest
# 或
pnpm add dsh-fast-loop@latest
```

### 方式一：命令行一键切换

内置 CLI 自动安全更新 `cordis.patch.yml`，彻底杜绝手写 YAML 缩进错误：

```sh
# 启用 dsh-fast-loop 并禁用官方 agent-loop
dsh-fast-loop enable
# 或使用 npx 免安装直接执行：
npx dsh-fast-loop enable

# 一键回退至官方原生 agent-loop
dsh-fast-loop disable
# 或
npx dsh-fast-loop disable

# 查看当前激活模式
dsh-fast-loop status
# 或
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
| `maxTransientRetries` | `number` | `2` | 单个 Step 遇到流式超时或瞬态网络错误时的最大自动兜底重试次数。 |
| `agents` | `array` | `[]` | 静态声明的 Agent 标识符及个性化配置覆盖列表。 |
---

## 开源协议

[MIT](LICENSE) © [dsh-fast-loop contributors](LICENSE)
