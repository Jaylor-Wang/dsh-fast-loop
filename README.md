# dsh-fast-loop

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-fast-loop.svg?color=blue)](https://www.npmjs.com/package/dsh-fast-loop)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-fast-loop.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-fast-loop.svg)](https://github.com/Jaylor-Wang/dsh-fast-loop/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

High-performance streaming agent loop plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Replaces the default `agent-loop` with a high-throughput, bounded concurrent execution engine featuring zero-allocation transactional message routing, caller-shadow safe Cordis service reachability, and resilient durable turn/step boundary recovery.

---

## Highlights in v0.3.0

- **Bulletproof Session Lifecycle & Zero-Leak Write Lock Cleanup**: Resolves the `SessionAlreadyOwnedError` (`session/writer-held`) lock conflict when switching or resuming sessions in DSH Web / Electron. Guarantees persistence handles and preparation states are cleanly disposed via transaction-rollback `finally` blocks on cold read errors, aborted requests, or setup failures.
- **Isolated Multi-Stage Teardown Pipeline**: Fault-tolerant agent teardown executes cancellation, scope disposal, handle closure, and registry detachment in independent catch blocks, ensuring persistence handles are released even if `whenIdle()` or child tasks throw.
- **Native Cordis Async Disposer Awaiting**: Properly integrates async lifecycle disposers into `ownerCtx.effect`, preventing teardown race conditions when users refresh browsers, disconnect WebSockets, or change session tabs.
- **Clean Service Unload Draining**: Automatically tracks and settles all active session handles when the plugin itself is disabled or reloaded.
- **Comprehensive Lifecycle & Failure Recovery Test Suite**: Added dedicated `node:test` lifecycle test suite validating lock release across disk failures, setup rejections, caller aborts, and teardown errors.
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

## Installation

### Via DSH Plugin CLI (Recommended)

```sh
dsh plugin --profile web add dsh-fast-loop@latest
```

### Via npm / pnpm

```sh
npm install dsh-fast-loop@latest
# or
pnpm add dsh-fast-loop@latest
```

### Method 1: One-Click CLI Switcher (Recommended)

Switch between Fast Loop and Official Loop effortlessly without manual YAML editing:

```sh
# Enable dsh-fast-loop and disable official agent-loop
npx dsh-fast-loop enable

# Restore official agent-loop and disable fast-loop
npx dsh-fast-loop disable

# Check current active loop mode
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
| `agents` | `array` | `[]` | Static agent identity and configuration overrides. |

---

## License

[MIT](LICENSE) © [dsh-fast-loop contributors](LICENSE)
