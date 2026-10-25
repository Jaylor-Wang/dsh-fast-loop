import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  AgentFactory,
  AgentHandle,
  AgentSetupCommit,
  CreateAgentOptions,
  ResumeAgentOptions
} from "@deepseek-ai/dsh-agent";
import {
  interruptedTurnClosers,
  SessionPreparation,
  SessionLogOffset,
  type Session
} from "@deepseek-ai/dsh-session";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionHandle, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
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

  static Config: z<FastLoopConfig, FastLoopConfig> = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(10),
    enableStreamingTools: z.boolean().default(true),
    enablePathAwareBarrier: z.boolean().default(true),
    enableSteeringSoftInterrupt: z.boolean().default(true),
    agents: z.array(z.any()).default([])
  });

  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context };
  private readonly activeTeardowns = new Set<() => Promise<void>>();

  constructor(ctx: Context, public readonly config: FastLoopConfig = {}) {
    super(ctx, "agentLoop");
    this.runtime = { ctx };

    ctx.effect(function* () {
      const unregisterTurnBoundary = ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
      yield unregisterTurnBoundary;
      // Unchecked cast on complex recursive sessionProjections.register wire schema
      const unregisterInbox = ctx.sessionProjections.register(inboxProjectionDefinition as any);
      yield unregisterInbox;
    }, "fastAgentLoop.projections()");

    ctx.effect(() => ctx.agents.setFactory(this), "fastAgentLoop.setFactory()");

    const activeTeardowns = this.activeTeardowns;
    ctx.effect(function* () {
      yield async () => {
        const teardowns = Array.from(activeTeardowns);
        activeTeardowns.clear();
        await Promise.allSettled(teardowns.map((td) => td()));
      };
    }, "fastAgentLoop.activeSessions()");

    ctx.systemPrompt.variable("provider", (context: { agent?: { options?: { provider?: string } } }) => context.agent?.options?.provider);
    ctx.systemPrompt.variable("model", (context: { agent?: { options?: { model?: string } } }) => context.agent?.options?.model);
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    let preparation: SessionPreparation | undefined;
    let handle: SessionHandle | undefined;
    let published = false;

    try {
      preparation = SessionPreparation.create(
        loopCtx.sessions.prepare(options.sessionId, {
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
          ...(options.meta !== undefined ? { meta: options.meta } : {}),
          ...(options.inheritedEventCount !== undefined
            ? { inheritedEventCount: options.inheritedEventCount }
            : {})
        })
      );

      const session = preparation.session;
      const persistence = loopCtx.get("sessionPersistence") as SessionPersistence | undefined;
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

      const result = await this.setupAndPublish(
        ownerCtx,
        options.sessionId,
        agent,
        session,
        handle,
        options,
        "startup"
      );
      published = true;
      return result;
    } finally {
      if (!published) {
        preparation?.[Symbol.dispose]?.();
        if (handle) {
          await handle.close().catch(() => {});
        }
      }
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const persistence = loopCtx.get("sessionPersistence") as SessionPersistence | undefined;
    if (!persistence) {
      throw new Error("cannot resume: session persistence is not configured");
    }

    let preparation: SessionPreparation | undefined;
    let handle: SessionHandle | undefined;
    let published = false;

    try {
      handle = await persistence.open(options.resumeSessionId, "write", {
        ...(options.signal ? { signal: options.signal } : {})
      });

      const coldRead = await handle.read(0, undefined, {
        ...(options.signal ? { signal: options.signal } : {})
      });
      const persisted = coldRead.events;
      const closers = interruptedTurnClosers(persisted);
      if (closers.length > 0) {
        await handle.append(closers);
      }

      preparation = SessionPreparation.create(
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

      const result = await this.setupAndPublish(
        ownerCtx,
        options.resumeSessionId,
        agent,
        session,
        handle,
        options,
        "resume"
      );
      published = true;
      return result;
    } finally {
      if (!published) {
        preparation?.[Symbol.dispose]?.();
        if (handle) {
          await handle.close().catch(() => {});
        }
      }
    }
  }

  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    agent: FastAgent,
    session: Session,
    handle: SessionHandle | undefined,
    options: CreateAgentOptions | ResumeAgentOptions,
    source: "startup" | "resume"
  ): Promise<AgentHandle> {
    const loopCtx = this.runtime.ctx;
    const abortController = new AbortController();

    const onCallerAbort = () => {
      abortController.abort(options.signal?.reason ?? new Error(`agent "${id}" setup aborted`));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const unfollowSetup = ownerCtx.effect(() => () => {
      abortController.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
    }, `fastAgentLoop.setup(${id})`);

    let detachSession: (() => void) | undefined;
    let detachAgent: (() => void) | undefined;
    let published = false;

    try {
      abortController.signal.throwIfAborted();
      const setup = options.setup;
      if (setup) {
        await agent.runMaintenance(async () => {
          abortController.signal.throwIfAborted();
          const commit = await setup(agent.ctx, agent);
          abortController.signal.throwIfAborted();
          if (
            commit &&
            typeof commit === "object" &&
            "commit" in commit &&
            typeof (commit as AgentSetupCommit).commit === "function"
          ) {
            (commit as AgentSetupCommit).commit();
          }
        });
      }
      abortController.signal.throwIfAborted();

      detachSession = agent.ctx.sessions.enter(session);
      detachAgent = loopCtx.agents.enter(agent, options.parentAgent);
      agent.ctx.sessions.announce(session);
      await loopCtx.agents.announce(agent, source, abortController.signal);
      abortController.signal.throwIfAborted();
      published = true;
    } finally {
      options.signal?.removeEventListener("abort", onCallerAbort);
      await unfollowSetup();
      if (!published) {
        try {
          detachAgent?.();
        } catch {}
        try {
          detachSession?.();
        } catch {}
        try {
          await agent.scope.dispose();
        } catch {}
      }
    }

    let disposing: Promise<void> | undefined;
    const teardown = () =>
      (disposing ??= (async () => {
        this.activeTeardowns.delete(teardown);
        const errors: unknown[] = [];
        try {
          agent.cancel({ kind: "disposed" });
          await agent.whenIdle();
        } catch (err) {
          errors.push(err);
        }
        try {
          await agent.scope.dispose();
        } catch (err) {
          errors.push(err);
        }
        try {
          if (handle) {
            await handle.close();
          }
        } catch (err) {
          errors.push(err);
        }
        try {
          detachAgent?.();
        } catch (err) {
          errors.push(err);
        }
        try {
          detachSession?.();
        } catch (err) {
          errors.push(err);
        }
        if (errors.length > 0) {
          try {
            loopCtx.logger("fast-loop").warn(`FastAgent [${id}] teardown errors:`, errors);
          } catch {
            console.warn(`FastAgent [${id}] teardown errors:`, errors);
          }
        }
      })());

    this.activeTeardowns.add(teardown);

    const unfollowOwner = ownerCtx.effect(function* () {
      yield async () => {
        await teardown();
      };
    }, `fastAgentLoop.lifecycle(${id})`);

    const dispose = async () => {
      try {
        await teardown();
      } finally {
        await unfollowOwner?.();
      }
    };

    return {
      agent,
      dispose
    };
  }
}

export { normalizeAssistantBlocks } from "./loop.js";
export * from "./barrier.js";
export { turnBoundaryProjectionDefinition, inboxProjectionDefinition };
export default FastAgentLoop;
