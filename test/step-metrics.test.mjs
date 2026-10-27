import test from "node:test";
import assert from "node:assert/strict";
import { AssistantStreamAttempt } from "../lib/stream.js";
import { stripDsmlFromText } from "../lib/loop.js";
import { SessionId } from "@deepseek-ai/dsh-session/types";

test("Step Metrics 1: AssistantStreamAttempt measures ttftMs and durationMs accurately", async () => {
  let revisionCounter = 0;
  const nextRevision = () => ++revisionCounter;
  const frames = [];

  const attempt = new AssistantStreamAttempt(
    SessionId("test-metrics-session"),
    1,
    nextRevision,
    1,
    1,
    (frame) => frames.push(frame)
  );

  assert.equal(attempt.ttftMs, undefined);
  assert.equal(attempt.durationMs, undefined);

  attempt.start();
  await new Promise((r) => setTimeout(r, 25));

  attempt.push({ type: "text-delta", index: 0, text: "Chunk 1" });
  await new Promise((r) => setTimeout(r, 35));

  attempt.push({ type: "text-delta", index: 0, text: "Chunk 2" });
  attempt.settle("assistant/message", () => 101);

  assert.ok(attempt.ttftMs !== undefined && attempt.ttftMs >= 15, `ttftMs should be >= 15ms, got ${attempt.ttftMs}`);
  assert.ok(attempt.durationMs !== undefined && attempt.durationMs >= 45, `durationMs should be >= 45ms, got ${attempt.durationMs}`);
  assert.ok(attempt.durationMs >= attempt.ttftMs, `durationMs (${attempt.durationMs}) must be >= ttftMs (${attempt.ttftMs})`);
});

test("Step Metrics 2: stripDsmlFromText fast-path skips plain text without '<' and cleans leaked DSML", () => {
  const plainText = "This is a normal assistant message with no DSML leakage whatsoever.";
  const plainRes = stripDsmlFromText(plainText);
  assert.equal(plainRes.hasLeak, false);
  assert.equal(plainRes.text, plainText);

  const leakedText = "Here is the code:\n<tool_calls><invoke name=\"bash\"><parameter>ls</parameter></invoke></tool_calls>\nDone.";
  const leakedRes = stripDsmlFromText(leakedText);
  assert.equal(leakedRes.hasLeak, true);
  assert.ok(!leakedRes.text.includes("<tool_calls>"));
  assert.ok(leakedRes.text.includes("Here is the code:"));
  assert.ok(leakedRes.text.includes("Done."));
});

test("Step Metrics 3: FastLoopDriver emits agent/step-metrics and updates agent.lastStepMetrics on step completion", async () => {
  const { FastLoopDriver } = await import("../lib/loop.js");
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");

  const emittedMetrics = [];
  const loggedLines = [];
  const appendedEvents = [];
  let seqCounter = 0;
  let currentHeader;
  let currentContext;

  const session = {
    id: SessionId("test-step-metrics-agent"),
    surface: {
      nodes: [],
      contentGeneration: 1
    },
    append(type, data) {
      const seq = ++seqCounter;
      appendedEvents.push({ seq, type, data });
      if (type === "request/header") currentHeader = data.header;
      if (type === "request/context") currentContext = data;
      return { seq, type, data };
    },
    eventAt(seq) {
      return appendedEvents.find((e) => e.seq === seq);
    },
    snapshotEvents() {
      return appendedEvents;
    },
    requestHeader() {
      return currentHeader;
    },
    requestContext() {
      return currentContext;
    },
    deriveMessages() {
      return [];
    },
    toolHistory() {
      return [];
    }
  };

  const agent = {
    id: SessionId("test-step-metrics-agent"),
    session,
    options: {
      provider: "google-antigravity",
      model: "antigravity-gemini-3.8-flash"
    },
    phase: {
      kind: "running",
      turn: 0,
      step: 0,
      abort: new AbortController()
    },
    setPhase(phase) {
      this.phase = phase;
    },
    ctx: {
      on: () => () => {}
    },
    inbox: {
      hasPending: true,
      nextStep: [],
      nextTurn: [],
      claim() {
        this.hasPending = false;
        return [createUserMessage({ content: [{ type: "text", text: "Run step" }], source: { kind: "user" } })];
      },
      append() {}
    },
    loopCtx: {
      systemPrompt: {
        assemble: async () => ({ sections: [], contexts: [], tools: [] }),
        refreshContext: (assembly) => assembly
      },
      logger: () => ({
        info: (msg) => loggedLines.push(msg),
        warn: (msg) => loggedLines.push(msg),
        error: (msg) => loggedLines.push(msg)
      }),
      llm: {
        prepareCall: async (config) => ({
          config,
          stream: async function* () {
            await new Promise((r) => setTimeout(r, 20));
            yield { type: "text-delta", index: 0, text: "Step result" };
          }
        })
      }
    },
    dispatch: {
      waterfall: async (_event, _data, fallback) => fallback(),
      serial: async () => {},
      emit: (event, data) => {
        if (event === "agent/step-metrics") {
          emittedMetrics.push(data);
        }
      }
    }
  };

  const driver = new FastLoopDriver(agent);
  await driver.run();

  assert.equal(emittedMetrics.length, 1, "Must emit exactly one agent/step-metrics event");
  const metrics = emittedMetrics[0];

  assert.equal(metrics.turn, 1);
  assert.equal(metrics.step, 1);
  assert.ok(metrics.totalDurationMs >= 15, `totalDurationMs should be >= 15ms, got ${metrics.totalDurationMs}`);
  assert.ok(metrics.llmDurationMs >= 15, `llmDurationMs should be >= 15ms, got ${metrics.llmDurationMs}`);
  assert.ok(metrics.ttftMs !== undefined && metrics.ttftMs >= 15, `ttftMs should be >= 15ms, got ${metrics.ttftMs}`);
  assert.equal(metrics.toolCallCount, 0);
  assert.equal(metrics.attempts, 1);

  assert.ok(agent.lastStepMetrics !== undefined);
  assert.equal(agent.lastStepMetrics.turn, 1);
  assert.equal(agent.lastStepMetrics.step, 1);

  assert.ok(loggedLines.length > 0, "Fast-loop logger must output Step timing summary");
  assert.ok(loggedLines.some((line) => line.includes("[Step 1.1]") && line.includes("llm:") && line.includes("ttft:")));
});

test("Step Metrics 4: isToolInterruptReason accurately identifies abort reasons without substring heuristics", async () => {
  const { TOOL_INTERRUPT_ABORT_REASON, isToolInterruptReason } = await import("../lib/barrier.js");

  assert.equal(isToolInterruptReason(TOOL_INTERRUPT_ABORT_REASON), true);
  assert.equal(isToolInterruptReason({ cause: TOOL_INTERRUPT_ABORT_REASON }), true);
  assert.equal(isToolInterruptReason({ reason: TOOL_INTERRUPT_ABORT_REASON }), true);

  // Normal errors that happen to contain words like 'tool-interrupt' or 'user steering' must NOT be misclassified
  assert.equal(isToolInterruptReason(new Error("Failed reading file: tool-interrupt.txt")), false);
  assert.equal(isToolInterruptReason(new Error("user steering direction unavailable")), false);
  assert.equal(isToolInterruptReason(new Error("regular execution crash")), false);
  assert.equal(isToolInterruptReason(undefined), false);
  assert.equal(isToolInterruptReason(null), false);
});
