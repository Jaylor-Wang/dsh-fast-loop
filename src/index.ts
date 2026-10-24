import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  AgentFactory,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions
} from "@deepseek-ai/dsh-agent";
import {
  interruptedTurnClosers,
  SessionPreparation,
  SessionLogOffset
} from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { turnBoundaryProjectionDefinition, inboxProjectionDefinition } from "./projections.js";
import { FastAgent } from "./agent.js";
import type { FastLoopConfig } from "./types.js";

export class FastAgentLoop extends Service implements AgentFactory {
  static inject = [
    "agents",
    "sessions",
    "llm",
    "tools",
    "systemPrompt",
    "sessionProjections"
  ];

  static Config: z<any, FastLoopConfig> = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(10),
    enableStreamingTools: z.boolean().default(true),
    agents: z.array(z.any()).default([])
  });

  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context };

  constructor(ctx: Context, public readonly config: FastLoopConfig = {}) {
    super(ctx, "agentLoop");
    this.runtime = { ctx };

    ctx.effect(function* () {
      const unregisterTurnBoundary = ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
      yield unregisterTurnBoundary;
      const unregisterInbox = ctx.sessionProjections.register(inboxProjectionDefinition as any);
      yield unregisterInbox;
    }, "fastAgentLoop.projections()");

    ctx.effect(() => ctx.agents.setFactory(this), "fastAgentLoop.setFactory()");

    ctx.systemPrompt.variable("provider", (context: any) => context.agent?.options.provider);
    ctx.systemPrompt.variable("model", (context: any) => context.agent?.options.model);
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const preparation = SessionPreparation.create(
      loopCtx.sessions.prepare(options.sessionId, {
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.meta !== undefined ? { meta: options.meta } : {}),
        ...(options.inheritedEventCount !== undefined
          ? { inheritedEventCount: options.inheritedEventCount }
          : {})
      })
    );

    const session = preparation.session;
    const persistence = loopCtx.get("sessionPersistence");
    let handle: any;
    if (persistence) {
      handle = await persistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
        ...(options.signal ? { signal: options.signal } : {})
      });
      const suffix = session.snapshotEvents(SessionLogOffset(0));
      if (suffix.length > 0) {
        await handle.append(suffix);
      }
    }

    const agent = new FastAgent(
      loopCtx,
      options.sessionId,
      options.agentOptions ?? {},
      session,
      this.config
    );

    if (options.setup) {
      const commit = await options.setup(agent.ctx, agent as any);
      if (commit && typeof (commit as any).commit === "function") {
        (commit as any).commit();
      }
    }

    const detachSession = agent.ctx.sessions.enter(session);
    const detachAgent = loopCtx.agents.enter(agent as any, options.parentAgent);
    agent.ctx.sessions.announce(session);
    await loopCtx.agents.announce(agent as any, "startup", options.signal);

    const dispose = async () => {
      agent.cancel({ kind: "disposed" });
      await agent.whenIdle();
      await agent.scope.dispose();
      if (handle) {
        await handle.close().catch(() => {});
      }
      detachAgent();
      detachSession();
    };

    ownerCtx.effect(function* () {
      yield () => void dispose();
    }, `fastAgentLoop.lifecycle(${options.sessionId})`);

    return {
      agent: agent as any,
      dispose
    };
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const persistence = loopCtx.get("sessionPersistence");
    if (!persistence) {
      throw new Error("cannot resume: session persistence is not configured");
    }

    const handle = await persistence.open(options.resumeSessionId, "write", {
      signal: options.signal
    });
    const coldRead = await handle.read(0, undefined, { signal: options.signal });
    const persisted = coldRead.events;
    const closers = interruptedTurnClosers(persisted);
    if (closers.length > 0) {
      await handle.append(closers);
    }

    const preparation = SessionPreparation.create(
      loopCtx.sessions.prepare(options.resumeSessionId, {
        seed: [...persisted, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState
      })
    );

    const session = preparation.session;
    const suffix = session.snapshotEvents(
      SessionLogOffset(persisted.length + closers.length)
    );
    if (suffix.length > 0) {
      await handle.append(suffix);
    }

    const agent = new FastAgent(
      loopCtx,
      options.resumeSessionId,
      options.agentOptions ?? {},
      session,
      this.config
    );

    if (options.setup) {
      const commit = await options.setup(agent.ctx, agent as any);
      if (commit && typeof (commit as any).commit === "function") {
        (commit as any).commit();
      }
    }

    const detachSession = agent.ctx.sessions.enter(session);
    const detachAgent = loopCtx.agents.enter(agent as any, options.parentAgent);
    agent.ctx.sessions.announce(session);
    await loopCtx.agents.announce(agent as any, "resume", options.signal);

    const dispose = async () => {
      agent.cancel({ kind: "disposed" });
      await agent.whenIdle();
      await agent.scope.dispose();
      await handle.close().catch(() => {});
      detachAgent();
      detachSession();
    };

    ownerCtx.effect(function* () {
      yield () => void dispose();
    }, `fastAgentLoop.lifecycle(${options.resumeSessionId})`);

    return {
      agent: agent as any,
      dispose
    };
  }
}

export { turnBoundaryProjectionDefinition, inboxProjectionDefinition };
export default FastAgentLoop;
