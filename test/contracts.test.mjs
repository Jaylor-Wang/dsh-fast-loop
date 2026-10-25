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

