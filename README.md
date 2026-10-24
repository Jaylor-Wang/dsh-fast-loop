# dsh-fast-loop

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-fast-loop.svg?color=blue)](https://www.npmjs.com/package/dsh-fast-loop)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-fast-loop.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-fast-loop.svg)](https://github.com/Jaylor-Wang/dsh-fast-loop/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

High-performance streaming agent loop plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Replaces the default `agent-loop` with a high-throughput, bounded concurrent execution engine featuring zero-allocation transactional message routing, caller-shadow safe Cordis service reachability, and resilient durable turn/step boundary recovery.

---

## Highlights in v0.2.0

- **Full Context Occupancy Feeding**: Dispatches `request/context` scheduling events on turn boundaries, ensuring real-time context token occupancy percentage and meter rendering in Web UI.
- **Strict FIFO Commit Order & Card Pairing**: Bounded concurrent tool execution guarantees exact FIFO event persistence; each `tool/result` links `sourceEventSeqs` for flawless Web UI card pairing.
- **Verified Benchmark Suite**: Built-in test suite verifying bounded concurrency limits, exclusive tool synchronization barriers, and achieving ~8x throughput speedup in batch I/O workloads.
- **Cordis Caller-Shadow Isolation Protection**: Decouples factory dependency resolution from caller shadow contexts to prevent service resolution errors without breaking isolation realms.
- **Zero-Latency Transactional Inbox & Resiliency**: Atomic message claiming and durable turn/step boundary self-healing across reloads and interruptions.

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

### Enable in `cordis.patch.yml`

Disable the default `agent-loop` and insert `dsh-fast-loop`:

```yaml
# Disable standard loop
- id: agent-loop
  disabled: true

# Insert high-performance fast loop
- insert:
  - id: fast-loop
    name: dsh-fast-loop
    config:
      agents: []
      maxParallelToolCalls: 10
      enableStreamingTools: true
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
