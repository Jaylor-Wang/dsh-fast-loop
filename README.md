# dsh-fast-loop

High-performance streaming agent loop plugin for DeepSeek Harness (DSH).

## Features

- **Bounded Parallel Tool Execution**: Supports concurrent tool calls (`maxParallelToolCalls`) with strict FIFO completion guarantees and isolated exception containment.
- **Robust Scoped Context Handling**: Adheres to Cordis service injection contracts without caller shadow context leaks.
- **Durable Lifecycle Management**: Integrated turn/step boundaries with resilient recovery, graceful pre-step rejection handling, and full session persistence synchronization.
- **Zero-Latency In-Memory Message Routing**: High-throughput inbox management with transactional claimed message processing.

## Installation

Add to your DSH profile `package.json` dependencies:

```json
{
  "dependencies": {
    "dsh-fast-loop": "^0.1.0"
  }
}
```

Enable in `cordis.patch.yml`:

```yaml
- id: agent-loop
  disabled: true

- insert:
  - id: fast-loop
    name: dsh-fast-loop
    config:
      agents: []
      maxParallelToolCalls: 10
      enableStreamingTools: true
```

## License

MIT
