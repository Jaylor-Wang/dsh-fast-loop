# dsh-fast-loop

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-fast-loop.svg?color=blue)](https://www.npmjs.com/package/dsh-fast-loop)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-fast-loop.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-fast-loop.svg)](https://github.com/Jaylor-Wang/dsh-fast-loop/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

An experimental agent-loop plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), preserved for reference.

## Maintenance status

**Active maintenance ended on October 28, 2026. This repository is archived.** The final GitHub release is [v0.5.2](https://github.com/Jaylor-Wang/dsh-fast-loop/releases/tag/v0.5.2). Compatibility with future DSH versions is not guaranteed.

The official loop continues to evolve, while maintaining a complete replacement requires substantial compatibility work without a demonstrated general performance benefit. **Use the official DSH `agent-loop` for ongoing use.** Source code, release history, and experiments remain available for study and forks.

If the plugin is already installed, restore the official loop for your profile:

```sh
dsh-fast-loop disable --profile web
dsh-fast-loop status --profile web
```

Replace `web` with your profile name, then restart DSH. The installation and configuration instructions below are retained as historical reference.

---

## Highlights in v0.5.2

- **Step Metrics**: Exports `StepMetrics`, exposes `agent.lastStepMetrics`, and emits runtime `agent/step-metrics` events with step duration, final-attempt model timing, first-chunk latency, tool duration, attempt count, and token usage.
- **Structured Soft Interrupts**: Replaces error-text substring checks with Symbol-based classification and per-call interruption tracking, retaining polling as a fallback.
- **DSML Fast Path**: Skips DSML regex scanning for text without `<`.
- **Expanded Fallback Retry Classification**: Includes `PROTOCOL_DRIFT`, `RATE_LIMIT`, and `SERVER`.
- **API Note**: `TRANSIENT_RETRYABLE_CODES` is now a readonly lookup object instead of a `Set`; use `isTransientRetryableFailure(code)` instead of `.has()`.
- **Measurement Limits**: Metrics are runtime-only; prior failed attempts and retry waits contribute to residual overhead. The existing concurrency benchmark does not establish a speedup over the current official loop.

---

## Features

### 1. High-Concurrency Tool Scheduler
- **Bounded Concurrency Pool**: Dynamically dispatches parallelizable tool calls up to `maxParallelToolCalls` concurrently, preserving strict sequential FIFO order for durable event persistence.
- **Exclusive Tool Barrier**: Automatically blocks and synchronizes in-flight tasks before running exclusive tools (e.g. state-mutating commands or terminal operations).
- **Tool Crash Recovery**: Traps and contains unhandled tool execution failures, ensuring prior tool results are safely settled and recorded without corrupting agent state.

### 2. Architecture & Cordis Integration
- **Runtime Dependency Holding**: Shields factory dependency lookups from caller shadow proxies, ensuring `sessionProjections`, `systemPrompt`, `tools`, and `llm` services remain reachable in all execution contexts.
- **Durable Turn Boundaries**: Accurately tracks turn/step boundaries across process restarts and reloads (`turnBoundary` projection), preventing state drift and premature interruptions.
- **Session Persistence Splicing**: Seamlessly restores historical turns and appends interrupted turn closers during resume.

---

## Installation (Historical Reference)

### Via DSH Plugin CLI

```sh
dsh plugin --profile web add dsh-fast-loop@latest
```

### Via npm / pnpm

```sh
npm install dsh-fast-loop@latest
# or
pnpm add dsh-fast-loop@latest
```

### Method 1: One-Click CLI Switcher

Switch between Fast Loop and Official Loop effortlessly without manual YAML editing:

```sh
# Enable dsh-fast-loop and disable official agent-loop
dsh-fast-loop enable
# or run without global install via npx:
npx dsh-fast-loop enable

# Restore official agent-loop and disable fast-loop
dsh-fast-loop disable
# or
npx dsh-fast-loop disable

# Check current active loop mode
dsh-fast-loop status
# or
npx dsh-fast-loop status
```

### Method 2: Manual `cordis.patch.yml` Configuration

In `~/.dsh/profiles/web/cordis.patch.yml`, disable `agent-loop` and insert `dsh-fast-loop`:

```yaml
# Disable standard loop
- id: agent-loop
  disabled: true

# Insert high-performance fast loop
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

## Configuration

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `maxParallelToolCalls` | `number` | `10` | Maximum number of concurrent parallel tool calls allowed per step. |
| `enableStreamingTools` | `boolean` | `true` | Whether to enable streaming tool result delivery. |
| `enablePathAwareBarrier` | `boolean` | `true` | Whether to enable Path-Aware Barrier for multi-file concurrent edits. |
| `enableSteeringSoftInterrupt` | `boolean` | `true` | Whether to enable cooperative soft-interruption for wait tools upon incoming steer messages. |
| `maxTransientRetries` | `number` | `2` | Maximum per-step fallback retries for transient stream timeouts or network failures. |
| `agents` | `array` | `[]` | Static agent identity and configuration overrides. |
---

## License

[MIT](LICENSE) © [dsh-fast-loop contributors](LICENSE)
