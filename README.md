# dsh-fast-loop

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-fast-loop.svg?color=blue)](https://www.npmjs.com/package/dsh-fast-loop)
[![license](https://img.shields.io/github/license/Jaylor-Wang/dsh-fast-loop.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Jaylor-Wang/dsh-fast-loop.svg)](https://github.com/Jaylor-Wang/dsh-fast-loop/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Types-blue.svg)](tsconfig.json)

High-performance streaming agent loop plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Replaces the default `agent-loop` with a high-throughput, bounded concurrent execution engine featuring zero-allocation transactional message routing, caller-shadow safe Cordis service reachability, and resilient durable turn/step boundary recovery.

---

## Highlights in v0.5.1

- **Strict `sessionProjections.register` Receiver Context & Wire Typing**: Natively types `inboxProjectionDefinition` as `Required<ProjectionDefinition<"inbox", InboxState>>`, enabling direct `ctx.sessionProjections.register(inboxProjectionDefinition)` invocation without intermediate function extraction or `any` casts—eliminating `this.ctx` binding loss and `"no agent factory registered"` session resume failures.
- **Receiver-Context Regression Guard**: Enforces `this.ctx` receiver verification directly inside the lifecycle test suite's projection registry mock to prevent unbound method regressions.

---

## Highlights in v0.5.0

- **Built-In Transient Stream Timeout & Network Auto-Retry**: Automatically recovers from mid-turn transient stream failures (`TIMEOUT`, `TRANSPORT`, `UPSTREAM`, `EMPTY_RESPONSE`, `STREAM_ERROR`) with abort-aware exponential backoff (`maxTransientRetries`, default `2`), rescuing long multi-step turns even when upstream adapters enforce `maxRetries: 0`.
- **Setup-Window Event Persistence (`appendUnstoredSuffix`)**: Durably flushes both constructor `seed` events and `setup()` window session events right before publication, preventing delegation policy or setup records from being lost across restarts while leaving zero uncommitted residue on setup failure.
- **Adapter Defaults Stripping (`requestProposal`)**: Strips adapter-populated `maxTokens` and `reasoningEffort` defaults (`adapterDefaults`) before proposing subsequent `agent/request` configs, preventing redundant `request/header` change logs and cross-model default lock-in.
- **Declarative `config.agents` Startup & Identity Validation**: Supports declarative startup/resume of configured agents, `CONFIGURED_AGENT_IDENTITIES_KEY` launcher overrides, and upfront identity conflict validation.
- **Sanitized Cancel Causes & Dynamic Host Anchor Resolution**: Strips Node `fetch`/`undici` error stack pollution from `turn/end` cancel causes via whitelist shallow copy, and dynamically resolves global DSH host anchors across platforms without hardcoded paths.

---

## Highlights in v0.4.6

- **Native Web GUI Settings Card**: Seamlessly registers an interactive settings card in DSH General Settings (`通用设置`), offering a visual slider (1–32) and quick presets for `maxParallelToolCalls` without modifying DSH core code.
- **Dynamic Volatile Store Sampling**: Concurrency limits dynamically resolve reactive state from client volatile stores or functions in real time without restarting the web service or refreshing the page.
- **DSH Client Plugin Web Manifest**: Fully exports `./client` conforming to DSH client specifications, declaring `dsh.client` for the `web` platform with clean locale and settings dependencies.

---

## Highlights in v0.4.5

- **Strict Monotonic Stream Revisions & Terminal Guard**: Enforces monotonic assistant stream revisions with a terminal guard (`push`, `settle`, `abandon`), eliminating duplicate frames and preventing `RemoteStreamCarrierError: session assistant stream skipped revision` in DSH Web UI.
- **Active Phase Wake Latching (Steering Guarantee)**: Latches `phase.wakeRequested = true` when messages arrive during active execution (`phase.kind === "running"`), automatically waking the driver upon turn completion so mid-turn user inputs are never dropped.
- **Clean Turn Settlement & Signal Reset**: Resets `AbortController` and step counters per turn, ensuring turns end with clean `{ kind: "completed" }` statuses and eliminating spurious UI "处理失败" error markers.
- **Event-Sourced V4 Protocol Compliance**: Correctly sets producer-owned source kinds on synthetic recovery messages to satisfy strict DSH Session V4 formatting contracts.
- **Comprehensive Front-End Contract Test Suite**: Ships with dedicated mock tests covering stream monotonicity, idempotent abandonment, V4 source compliance, and phase wake latching.

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
