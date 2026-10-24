import test from "node:test";
import assert from "node:assert/strict";
import { FastLoopDriver } from "../lib/loop.js";
import { TOOL_RUNTIME_SCHEDULER, TOOL_ABORTED_BEFORE_DISPATCH } from "@deepseek-ai/dsh-tools";

function createMockEnvironment(config = {}) {
  const events = [];
  let seqCounter = 100;

  const session = {
    surface: { nodes: [] },
    append(type, data, meta) {
      const seq = ++seqCounter;
      const ev = { type, seq, time: Date.now(), data, ...meta };
      events.push(ev);
      return { seq };
    },
    eventAt(seq) {
      return events.find(e => e.seq === seq);
    },
    requestContext() {
      return null;
    },
    snapshotEvents() {
      return events;
    }
  };

  const activeInFlight = new Set();
  let peakInFlight = 0;

  const mockScheduler = {
    async prepare(exec) {
      return { kind: "dispatch", exec };
    },
    async dispatch(exec) {
      activeInFlight.add(exec.callId);
      peakInFlight = Math.max(peakInFlight, activeInFlight.size);
      
      const delay = exec.arguments?.delay ?? 10;
      await new Promise((r) => setTimeout(r, delay));
      
      activeInFlight.delete(exec.callId);
      return {
        kind: "final-result",
        result: {
          content: [{ type: "text", text: `result-of-${exec.callId}` }],
          isError: false
        }
      };
    },
    finish(exec, result) {
      return result;
    },
    async finalize(exec, result) {
      return result;
    }
  };

  const mockTools = {
    [TOOL_RUNTIME_SCHEDULER]: mockScheduler,
    executionMode(exec) {
      return { kind: exec.arguments?.mode ?? "parallel" };
    }
  };

  const mockAgent = {
    session,
    loopConfig: {
      maxParallelToolCalls: config.maxParallelToolCalls ?? 10,
      enableStreamingTools: true
    },
    loopCtx: {
      tools: mockTools,
      systemPrompt: {
        assemble: async () => ({})
      }
    },
    ctx: {
      get: () => undefined,
      on: () => () => {}
    },
    phase: {
      kind: "running",
      turn: 1,
      abort: new AbortController()
    }
  };

  const driver = new FastLoopDriver(mockAgent);

  return {
    driver,
    events,
    mockAgent,
    getPeakInFlight: () => peakInFlight
  };
}

test("1. Concurrent execution preserves strict FIFO commit order and exact sourceEventSeqs pairing", async () => {
  const env = createMockEnvironment({ maxParallelToolCalls: 10 });
  const toolCalls = [
    { id: "call_0", name: "testTool", arguments: JSON.stringify({ delay: 60 }) },
    { id: "call_1", name: "testTool", arguments: JSON.stringify({ delay: 10 }) }, // finishes first
    { id: "call_2", name: "testTool", arguments: JSON.stringify({ delay: 40 }) },
    { id: "call_3", name: "testTool", arguments: JSON.stringify({ delay: 20 }) }, // finishes second
    { id: "call_4", name: "testTool", arguments: JSON.stringify({ delay: 50 }) }
  ];

  const startTime = Date.now();
  const outcome = await env.driver.executeTools(1, 1, toolCalls, new AbortController().signal, () => {});
  const elapsed = Date.now() - startTime;

  assert.equal(outcome.concluded, false);

  // 1. Verify concurrency: total elapsed time should be close to max delay (60ms), well below sum of delays (180ms)
  assert.ok(elapsed < 140, `Expected elapsed time < 140ms for parallel run, got ${elapsed}ms`);

  // 2. Extract call and result events
  const calls = env.events.filter(e => e.type === "tool/call");
  const results = env.events.filter(e => e.type === "tool/result");

  assert.equal(calls.length, 5);
  assert.equal(results.length, 5);

  // 3. Verify order and exact pairing
  for (let i = 0; i < 5; i++) {
    assert.equal(calls[i].data.callId, `call_${i}`);
    assert.equal(results[i].data.message.toolCallId, `call_${i}`);
    // Card pairing contract: sourceEventSeqs must match call event seq
    assert.deepEqual(results[i].sourceEventSeqs, [calls[i].seq]);
  }
});

test("2. Bounded concurrency strictly throttles in-flight calls to maxParallelToolCalls", async () => {
  const env = createMockEnvironment({ maxParallelToolCalls: 2 });
  const toolCalls = [
    { id: "call_a", name: "testTool", arguments: JSON.stringify({ delay: 30 }) },
    { id: "call_b", name: "testTool", arguments: JSON.stringify({ delay: 30 }) },
    { id: "call_c", name: "testTool", arguments: JSON.stringify({ delay: 30 }) },
    { id: "call_d", name: "testTool", arguments: JSON.stringify({ delay: 30 }) }
  ];

  await env.driver.executeTools(1, 1, toolCalls, new AbortController().signal, () => {});

  assert.ok(env.getPeakInFlight() <= 2, `Peak in-flight (${env.getPeakInFlight()}) exceeded limit of 2`);
});

test("3. Barrier isolation for mixed parallel and exclusive tools", async () => {
  const env = createMockEnvironment({ maxParallelToolCalls: 10 });
  const executionLog = [];

  // Override mockScheduler to record start and finish timestamps
  const origDispatch = env.mockAgent.loopCtx.tools[TOOL_RUNTIME_SCHEDULER].dispatch;
  env.mockAgent.loopCtx.tools[TOOL_RUNTIME_SCHEDULER].dispatch = async (exec) => {
    executionLog.push({ callId: exec.callId, action: "start", time: Date.now() });
    const res = await origDispatch(exec);
    executionLog.push({ callId: exec.callId, action: "finish", time: Date.now() });
    return res;
  };

  const toolCalls = [
    { id: "call_par1", name: "testTool", arguments: JSON.stringify({ delay: 40, mode: "parallel" }) },
    { id: "call_excl", name: "testTool", arguments: JSON.stringify({ delay: 30, mode: "exclusive" }) },
    { id: "call_par2", name: "testTool", arguments: JSON.stringify({ delay: 20, mode: "parallel" }) }
  ];

  await env.driver.executeTools(1, 1, toolCalls, new AbortController().signal, () => {});

  const finishPar1 = executionLog.find(e => e.callId === "call_par1" && e.action === "finish").time;
  const startExcl = executionLog.find(e => e.callId === "call_excl" && e.action === "start").time;
  const finishExcl = executionLog.find(e => e.callId === "call_excl" && e.action === "finish").time;
  const startPar2 = executionLog.find(e => e.callId === "call_par2" && e.action === "start").time;

  // Exclusive tool must start AFTER parallel 1 finishes
  assert.ok(startExcl >= finishPar1 - 5, "Exclusive tool started before parallel tool finished");
  // Parallel 2 must start AFTER exclusive finishes
  assert.ok(startPar2 >= finishExcl - 5, "Parallel 2 started before exclusive tool finished");
});

test("4. Aborted signal cancels subsequent dispatches with TOOL_ABORTED_BEFORE_DISPATCH", async () => {
  const env = createMockEnvironment({ maxParallelToolCalls: 2 });
  const controller = new AbortController();

  const toolCalls = [
    { id: "call_1", name: "testTool", arguments: JSON.stringify({ delay: 50 }) },
    { id: "call_2", name: "testTool", arguments: JSON.stringify({ delay: 50 }) },
    { id: "call_3", name: "testTool", arguments: JSON.stringify({ delay: 50 }) },
    { id: "call_4", name: "testTool", arguments: JSON.stringify({ delay: 50 }) }
  ];

  // Abort shortly after dispatching first batch
  setTimeout(() => controller.abort(), 20);

  const outcome = await env.driver.executeTools(1, 1, toolCalls, controller.signal, () => {});
  assert.equal(controller.signal.aborted, true);

  const results = env.events.filter(e => e.type === "tool/result");
  assert.equal(results.length, 4);

  // Check skipped calls have TOOL_ABORTED_BEFORE_DISPATCH
  const skippedResults = results.filter(r => r.data.error?.code === TOOL_ABORTED_BEFORE_DISPATCH);
  assert.ok(skippedResults.length >= 2, `Expected at least 2 skipped calls, got ${skippedResults.length}`);
});

test("5. Latency & Throughput Benchmark: Parallel vs Serial comparison", async () => {
  const toolsCount = 8;
  const toolDelay = 30; // 30ms per tool

  // Serial simulation (like legacy agent-loop with concurrency=1)
  const envSerial = createMockEnvironment({ maxParallelToolCalls: 1 });
  const callsSerial = Array.from({ length: toolsCount }, (_, i) => ({
    id: `serial_${i}`,
    name: "testTool",
    arguments: JSON.stringify({ delay: toolDelay })
  }));

  const startSerial = Date.now();
  await envSerial.driver.executeTools(1, 1, callsSerial, new AbortController().signal, () => {});
  const elapsedSerial = Date.now() - startSerial;

  // Parallel fast-loop
  const envFast = createMockEnvironment({ maxParallelToolCalls: 10 });
  const callsFast = Array.from({ length: toolsCount }, (_, i) => ({
    id: `fast_${i}`,
    name: "testTool",
    arguments: JSON.stringify({ delay: toolDelay })
  }));

  const startFast = Date.now();
  await envFast.driver.executeTools(1, 1, callsFast, new AbortController().signal, () => {});
  const elapsedFast = Date.now() - startFast;

  const speedup = (elapsedSerial / elapsedFast).toFixed(2);
  console.log(`\n  [Benchmark Results]`);
  console.log(`  - 8 Tools @ ${toolDelay}ms:`);
  console.log(`  - Serial Execution Time: ${elapsedSerial} ms`);
  console.log(`  - FastLoop Execution Time: ${elapsedFast} ms`);
  console.log(`  - Speedup Factor: ${speedup}x\n`);

  assert.ok(elapsedFast < elapsedSerial / 2, `FastLoop should be at least 2x faster, got ${speedup}x`);
});
