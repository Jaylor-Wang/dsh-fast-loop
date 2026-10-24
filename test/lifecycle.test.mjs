import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { FastAgentLoop } from "../lib/index.js";
import { SessionId } from "@deepseek-ai/dsh-session/types";

function createMockEnvironment() {
  const ctx = new Context();

  const handlesCreated = [];
  const handlesClosed = [];

  const mockSession = {
    id: SessionId("test-session-1"),
    header: { id: "test-session-1" },
    inheritedEventCount: 0,
    surface: { nodes: [] },
    append() {
      return { seq: 1 };
    },
    snapshotEvents() {
      return [];
    }
  };

  const mockHandle = {
    header: { id: "test-session-1" },
    inheritedEventCount: 0,
    readFail: false,
    async read() {
      if (this.readFail) throw new Error("Mock read failure: disk error");
      return { events: [], eventState: {} };
    },
    async append() {},
    async close() {
      handlesClosed.push(this);
    }
  };

  const mockPersistence = {
    async open(id) {
      const h = { ...mockHandle, id };
      handlesCreated.push(h);
      return h;
    },
    async create(header) {
      const h = { ...mockHandle, id: header.id };
      handlesCreated.push(h);
      return h;
    }
  };

  ctx.provide("sessionPersistence");
  ctx.sessionPersistence = mockPersistence;

  ctx.provide("sessions");
  ctx.sessions = {
    prepare(id) {
      return { ...mockSession, id: SessionId(id), header: { id: SessionId(id) } };
    },
    enter() {
      return () => {};
    },
    announce() {}
  };

  ctx.provide("agents");
  ctx.agents = {
    setFactory() {},
    enter() {
      return () => {};
    },
    async announce() {}
  };

  ctx.provide("sessionProjections");
  ctx.sessionProjections = {
    register() {
      return () => {};
    },
    stateOf() {
      return { lastTurn: 0 };
    }
  };

  ctx.provide("systemPrompt");
  ctx.systemPrompt = {
    variable() {}
  };

  return { ctx, mockPersistence, handlesCreated, handlesClosed };
}

test("1. resume guarantees persistence handle is closed if handle.read fails", async () => {
  const env = createMockEnvironment();
  env.mockPersistence.open = async (id) => {
    const h = {
      header: { id },
      inheritedEventCount: 0,
      async read() {
        throw new Error("Simulated storage read error / corrupted file");
      },
      async append() {},
      async close() {
        env.handlesClosed.push(h);
      }
    };
    env.handlesCreated.push(h);
    return h;
  };

  const loop = new FastAgentLoop(env.ctx);
  const ownerCtx = new Context();

  await assert.rejects(
    async () => {
      await loop.resume(ownerCtx, {
        resumeSessionId: SessionId("session-err-read")
      });
    },
    { message: /Simulated storage read error/ }
  );

  assert.equal(env.handlesCreated.length, 1);
  assert.equal(env.handlesClosed.length, 1, "Persistence handle must be closed to prevent session lock leak");
});

test("2. resume guarantees persistence handle is closed if setup rejects", async () => {
  const env = createMockEnvironment();
  const loop = new FastAgentLoop(env.ctx);
  const ownerCtx = new Context();

  await assert.rejects(
    async () => {
      await loop.resume(ownerCtx, {
        resumeSessionId: SessionId("session-err-setup"),
        setup: async () => {
          throw new Error("Setup failed: invalid preset or plugin failure");
        }
      });
    },
    { message: /Setup failed/ }
  );

  assert.equal(env.handlesCreated.length, 1);
  assert.equal(env.handlesClosed.length, 1, "Handle must be closed on setup failure");
});

test("3. resume guarantees persistence handle is closed if caller aborts during setup", async () => {
  const env = createMockEnvironment();
  const loop = new FastAgentLoop(env.ctx);
  const ownerCtx = new Context();

  const abortController = new AbortController();

  await assert.rejects(
    async () => {
      await loop.resume(ownerCtx, {
        resumeSessionId: SessionId("session-abort"),
        signal: abortController.signal,
        setup: async () => {
          abortController.abort(new Error("User cancelled"));
        }
      });
    },
    { message: /User cancelled/ }
  );

  assert.equal(env.handlesCreated.length, 1);
  assert.equal(env.handlesClosed.length, 1, "Handle must be closed when aborted");
});

test("4. createAgent guarantees persistence handle is closed if setup rejects", async () => {
  const env = createMockEnvironment();
  const loop = new FastAgentLoop(env.ctx);
  const ownerCtx = new Context();

  await assert.rejects(
    async () => {
      await loop.createAgent(ownerCtx, {
        sessionId: SessionId("session-create-fail"),
        setup: async () => {
          throw new Error("Create agent setup rejected");
        }
      });
    },
    { message: /Create agent setup rejected/ }
  );

  assert.equal(env.handlesCreated.length, 1);
  assert.equal(env.handlesClosed.length, 1, "Handle must be closed on createAgent failure");
});

test("5. Successful resume returns handle whose dispose is idempotent and releases handle", async () => {
  const env = createMockEnvironment();
  const loop = new FastAgentLoop(env.ctx);
  const ownerCtx = new Context();

  const handle = await loop.resume(ownerCtx, {
    resumeSessionId: SessionId("session-ok")
  });

  assert.equal(env.handlesCreated.length, 1);
  assert.equal(env.handlesClosed.length, 0, "Handle must remain open during active session");

  await handle.dispose();
  assert.equal(env.handlesClosed.length, 1, "Handle must be closed after dispose()");

  // Repeat dispose should be idempotent and not close twice
  await handle.dispose();
  assert.equal(env.handlesClosed.length, 1, "Repeated dispose must be a no-op");
});

test("6. Teardown closes persistence handle even if agent.whenIdle() throws", async () => {
  const env = createMockEnvironment();
  const loop = new FastAgentLoop(env.ctx);
  const ownerCtx = new Context();

  const handle = await loop.resume(ownerCtx, {
    resumeSessionId: SessionId("session-idle-throw")
  });

  // Sabotage whenIdle to throw
  handle.agent.whenIdle = async () => {
    throw new Error("whenIdle corrupted error");
  };

  // Teardown should not hang and must still close the persistence handle!
  await handle.dispose();
  assert.equal(env.handlesClosed.length, 1, "Persistence handle must still be closed even if whenIdle throws");
});
