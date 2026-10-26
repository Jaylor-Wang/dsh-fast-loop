import test from "node:test";
import assert from "node:assert/strict";
import { AssistantStreamAttempt } from "../lib/stream.js";
import { SessionId } from "@deepseek-ai/dsh-session/types";

test("Contract 1: AssistantStreamAttempt guarantees strictly monotonic revisions with no gaps", () => {
  const frames = [];
  let revisionCounter = 0;
  const nextRevision = () => ++revisionCounter;

  const attempt = new AssistantStreamAttempt(
    SessionId("test-session"),
    1,
    nextRevision,
    1,
    1,
    (frame) => frames.push(frame)
  );

  attempt.start();
  attempt.push({ type: "text-delta", index: 0, text: "Hello" });
  attempt.push({ type: "text-delta", index: 0, text: " world" });
  attempt.settle("assistant/message", () => 42);

  // Attempting to push or abandon after settle must be idempotent and emit no extra frames
  attempt.push({ type: "text-delta", index: 0, text: "ignored" });
  attempt.abandon();

  assert.equal(frames.length, 4);
  assert.equal(frames[0].type, "start");
  assert.equal(frames[1].type, "chunk");
  assert.equal(frames[2].type, "chunk");
  assert.equal(frames[3].type, "end");

  // Invariant: revisions must be strictly 1, 2, 3, 4 without skips
  for (let i = 0; i < frames.length; i++) {
    assert.equal(frames[i].revision, i + 1, `Frame at index ${i} has unexpected revision`);
  }
});

test("Contract 2: AssistantStreamAttempt abandonment is idempotent and preserves revision order", () => {
  const frames = [];
  let revisionCounter = 10;
  const nextRevision = () => ++revisionCounter;

  const attempt = new AssistantStreamAttempt(
    SessionId("test-session"),
    2,
    nextRevision,
    1,
    2,
    (frame) => frames.push(frame)
  );

  attempt.start();
  attempt.abandon();
  attempt.abandon(); // repeated abandon must do nothing

  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, "start");
  assert.equal(frames[0].revision, 11);
  assert.equal(frames[1].type, "end");
  assert.equal(frames[1].revision, 12);
  assert.equal(frames[1].outcome.kind, "abandoned");
});

test("Contract 3: Format V4 Producer-owned Source Kind compliance", async () => {
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");

  const msg = createUserMessage({
    source: { kind: "fast-loop" },
    content: [{ type: "text", text: "Test recovery" }]
  });

  assert.ok(msg.source, "Message must have a source object");
  assert.equal(typeof msg.source.kind, "string", "source.kind must be a string");
  assert.notEqual(msg.source.kind, "plugin", "source.kind cannot be generic 'plugin'");
});

test("Contract 4: Phase wake latching when running guarantees subsequent messages trigger driver without getting lost", async () => {
  const { FastAgent } = await import("../lib/agent.js");
  const { Context } = await import("@deepseek-ai/cordis");
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");

  const ctx = new Context();
  ctx.provide("agents");
  ctx.agents = { withInitiator: (agent, fn) => fn() };
  const inboxState = { "next-turn": [], "next-step": [] };
  ctx.provide("sessionProjections");
  ctx.sessionProjections = {
    register: () => () => {},
    stateOf: () => inboxState
  };
  ctx.provide("systemPrompt");
  ctx.systemPrompt = { variable: () => {} };

  const session = {
    id: SessionId("test-session"),
    header: { id: "test-session" },
    inheritedEventCount: 0,
    surface: { nodes: [] },
    append: (type, data) => {
      if (type === "agent/inbox/spliced") {
        inboxState[data.target].splice(data.start, data.removedCount ?? 0, ...(data.inserted ?? []));
      }
      return { seq: 1, type, data };
    },
    snapshotEvents: () => []
  };

  const agent = new FastAgent(ctx, SessionId("test-session"), {}, session);
  
  // Set agent to running phase simulating an ongoing turn
  agent.setPhase({
    kind: "running",
    abort: new AbortController(),
    turn: 1,
    step: 1,
    wakeRequested: false
  });

  const msg = createUserMessage({
    source: { kind: "user" },
    content: [{ type: "text", text: "Mid-turn message" }]
  });

  // User sends a message while the agent is actively executing
  agent.send(msg, "next-turn", true);

  // Invariant: wakeRequested must be latched so the driver runs another turn instead of dropping the message
  assert.equal(agent.phase.wakeRequested, true, "wakeRequested must be latched to true during running phase");
  assert.equal(agent.inbox.hasPending, true, "inbox must retain the incoming message");
});

test("Contract 5: resolveMaxParallel supports dynamic volatile getters and plain numbers", async () => {
  const { resolveMaxParallel } = await import("../lib/types.js");

  // Default fallback
  assert.equal(resolveMaxParallel(undefined), 10);
  assert.equal(resolveMaxParallel({}), 10);

  // Plain number
  assert.equal(resolveMaxParallel({ maxParallelToolCalls: 4 }), 4);

  // Dynamic volatile getter
  let currentCap = 7;
  const volatileConfig = {
    maxParallelToolCalls: {
      get: () => currentCap
    }
  };
  assert.equal(resolveMaxParallel(volatileConfig), 7);

  // Dynamic update without restarting or recreating config
  currentCap = 15;
  assert.equal(resolveMaxParallel(volatileConfig), 15);
});

test("Contract 6: getCancelCause strips extraneous fetch stack properties via whitelist copy", async () => {
  const { getCancelCause } = await import("../lib/agent.js");

  const ctrl1 = new AbortController();
  const pollutedUserReason = {
    kind: "user",
    stack: "Error: aborted\n    at node:internal/deps/undici/undici:1234:11",
    extraField: "should-be-removed"
  };
  ctrl1.abort(pollutedUserReason);
  const clean1 = getCancelCause(ctrl1.signal);
  assert.deepEqual(clean1, { kind: "user" });
  assert.equal("stack" in clean1, false);

  const ctrl2 = new AbortController();
  ctrl2.abort({
    kind: "hook",
    reason: "budget exceeded",
    stack: "Error: hook abort stack"
  });
  const clean2 = getCancelCause(ctrl2.signal);
  assert.deepEqual(clean2, { kind: "hook", reason: "budget exceeded" });
  assert.equal("stack" in clean2, false);
});

test("Contract 7: requestProposal strips adapterDefaults for maxTokens and reasoningEffort", async () => {
  const { requestProposal } = await import("../lib/loop.js");

  const headerWithDefaults = {
    config: {
      provider: "google-antigravity",
      model: "antigravity-gemini-3.8-flash",
      reasoningEffort: "high",
      maxTokens: 65536
    },
    adapterDefaults: {
      maxTokens: true
    }
  };
  const proposal1 = requestProposal(headerWithDefaults);
  assert.deepEqual(proposal1, {
    provider: "google-antigravity",
    model: "antigravity-gemini-3.8-flash",
    reasoningEffort: "high"
  });
  assert.equal("maxTokens" in proposal1, false);

  const headerBothDefaults = {
    config: {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningEffort: "medium",
      maxTokens: 32768
    },
    adapterDefaults: {
      reasoningEffort: true,
      maxTokens: true
    }
  };
  const proposal2 = requestProposal(headerBothDefaults);
  assert.deepEqual(proposal2, {
    provider: "deepseek",
    model: "deepseek-reasoner"
  });
});

test("Contract 8: FastLoopDriver automatically retries transient TIMEOUT stream failure when provider maxRetries is 0", async () => {
  const { FastLoopDriver } = await import("../lib/loop.js");
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");

  const appendedEvents = [];
  let seqCounter = 0;
  let currentHeader;
  let currentContext;

  const session = {
    id: SessionId("test-timeout-retry"),
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

  let streamCallCount = 0;
  const mockPreparedCall = {
    config: {
      provider: "google-antigravity",
      model: "antigravity-gemini-3.8-flash",
      reasoningEffort: "high",
      maxTokens: 65536
    },
    adapterDefaults: { maxTokens: true },
    retryPolicy: { mode: "normal", maxRetries: 0, retryableCodes: ["TIMEOUT"] },
    async *stream() {
      streamCallCount++;
      if (streamCallCount === 1) {
        yield { type: "block-start", index: 0, blockType: "reasoning" };
        yield { type: "reasoning-delta", index: 0, text: "Generating SVG..." };
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: {
              message: "The Antigravity private request failed safely (TIMEOUT)",
              code: "TIMEOUT"
            }
          }
        };
        return;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: " SVG generated successfully!" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "text", text: " SVG generated successfully!" }
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  };

  const mockAgent = {
    id: SessionId("test-timeout-retry"),
    options: {
      provider: "google-antigravity",
      model: "antigravity-gemini-3.8-flash",
      reasoningEffort: "high"
    },
    session,
    loopConfig: {
      maxTransientRetries: 2,
      transientRetryDelayMs: 5
    },
    ctx: {
      on: () => () => {}
    },
    loopCtx: {
      systemPrompt: {
        refreshContext: () => ({ contexts: [] })
      },
      llm: {
        prepareCall: async () => mockPreparedCall
      },
      logger: () => ({ warn: () => {}, error: () => {} })
    },
    dispatch: {
      emit: () => {},
      waterfall: async (name, _payload, fallback) => {
        if (name === "agent/request-error") {
          // Simulate dsh-llm-retry returning undefined due to maxRetries: 0
          return undefined;
        }
        return fallback();
      }
    }
  };

  const driver = new FastLoopDriver(mockAgent);
  const userMsg = createUserMessage({
    source: { kind: "user" },
    content: [{ type: "text", text: "Draw pelican" }]
  });

  const outcome = await driver.runStep(
    2,
    24,
    { kind: "enter", messages: [userMsg] },
    { sections: [], tools: [] },
    new AbortController().signal
  );

  assert.deepEqual(outcome, { kind: "completed" });
  assert.equal(streamCallCount, 2, "Driver must retry once after transient TIMEOUT");

  const attempts = appendedEvents.filter((e) => e.type === "assistant/attempt");
  const messages = appendedEvents.filter((e) => e.type === "assistant/message");
  const headers = appendedEvents.filter((e) => e.type === "request/header");

  assert.equal(attempts.length, 1, "First failed attempt must be recorded as assistant/attempt");
  assert.equal(messages.length, 1, "Second succeeded attempt must be recorded as assistant/message");
  assert.equal(headers.length, 1, "Retry with adapterDefaults must not log redundant change header");
});

