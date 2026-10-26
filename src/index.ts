import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  AgentFactory,
  AgentHandle,
  AgentOptions,
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
import type {
  ConfiguredAgentEntry,
  ConfiguredAgentIdentities,
  FastLoopConfig
} from "./types.js";

export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
export const CONFIGURED_AGENT_IDENTITIES_KEY = "configuredAgentIdentities";

interface StoredSession {
  handle: SessionHandle;
  storedCount: number;
}

function mintUuid(): string {
  const gCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof gCrypto?.randomUUID === "function") {
    return gCrypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
export function assertAgentOptions(options?: AgentOptions): void {
  if (
    options?.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
  ) {
    throw new TypeError("agent maxTokens must be a positive safe integer");
  }
}

export function applyLauncherIdentities(
  agents: readonly ConfiguredAgentEntry[] | undefined,
  identities?: ConfiguredAgentIdentities
): ConfiguredAgentEntry[] {
  if (!agents || agents.length === 0) return [];
  if (identities === undefined) return [...agents];
  return agents.map((agent) => {
    const identity = identities[agent.id];
    if (identity === undefined) return agent;
    const { sessionId: _sessionId, resumeSessionId: _resumeSessionId, ...rest } = agent;
    return identity.resume
      ? { ...rest, resumeSessionId: identity.id }
      : { ...rest, sessionId: identity.id };
  });
}

export function validateConfiguredAgents(agents: readonly ConfiguredAgentEntry[]): void {
  const exactIdentities = new Map<string, string>();
  for (const { id, sessionId, resumeSessionId, ...rest } of agents) {
    assertAgentOptions(rest);
    const hasResumeId = resumeSessionId !== undefined && String(resumeSessionId).length > 0;
    if (sessionId !== undefined && hasResumeId) {
      throw new Error(`agent "${id}": sessionId and resumeSessionId are mutually exclusive`);
    }
    const exactIdentity = hasResumeId ? resumeSessionId : sessionId;
    if (exactIdentity === undefined) continue;
    const firstId = exactIdentities.get(exactIdentity);
    if (firstId !== undefined) {
      throw new Error(
        `agents "${firstId}" and "${id}" use duplicate exact session identity "${exactIdentity}"`
      );
    }
    exactIdentities.set(exactIdentity, id);
  }
}

function isSessionNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "SessionPersistenceNotFoundError") return true;
  if ("code" in error && (error.code === "NOT_FOUND" || error.code === "ENOENT")) return true;
  return false;
}

export class FastAgentLoop extends Service implements AgentFactory {
  static inject = [
    "agents",
    "sessions",
    "llm",
    "tools",
    "systemPrompt",
    "sessionProjections"
  ];

  static Config = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS).volatile(),
    enableStreamingTools: z.boolean().default(true),
    enablePathAwareBarrier: z.boolean().default(true),
    enableSteeringSoftInterrupt: z.boolean().default(true),
    maxTransientRetries: z.number().step(1).min(0).default(2),
    agents: z.array(z.any()).default([])
  });

  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context };
  private readonly activeTeardowns = new Set<() => Promise<void>>();
  private readonly startupTasks = new Set<Promise<unknown>>();
  public readonly config: FastLoopConfig;

  constructor(ctx: Context, config: FastLoopConfig = {}) {
    const rawIdentities =
      typeof ctx.get === "function"
        ? (ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY as never) as ConfiguredAgentIdentities | undefined)
        : undefined;
    const configuredAgents = applyLauncherIdentities(config.agents, rawIdentities);
    validateConfiguredAgents(configuredAgents);

    super(ctx, "agentLoop");
    this.runtime = { ctx };
    this.config = {
      ...config,
      agents: configuredAgents
    };

    ctx.effect(function* () {
      const unregisterTurnBoundary = ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
      yield unregisterTurnBoundary;
      // Unchecked cast on complex recursive sessionProjections.register wire schema
      const reg = ctx.sessionProjections.register as (def: unknown) => () => void;
      const unregisterInbox = reg(inboxProjectionDefinition);
      yield unregisterInbox;
    }, "fastAgentLoop.projections()");

    ctx.effect(() => ctx.agents.setFactory(this), "fastAgentLoop.setFactory()");

    const activeTeardowns = this.activeTeardowns;
    const startupTasks = this.startupTasks;
    ctx.effect(function* () {
      yield async () => {
        const teardowns = Array.from(activeTeardowns);
        const startups = Array.from(startupTasks);
        activeTeardowns.clear();
        startupTasks.clear();
        await Promise.allSettled([...teardowns.map((td) => td()), ...startups]);
      };
    }, "fastAgentLoop.activeSessions()");

    ctx.systemPrompt.variable("provider", (context: { agent?: { options?: { provider?: string } } }) => context.agent?.options?.provider);
    ctx.systemPrompt.variable("model", (context: { agent?: { options?: { model?: string } } }) => context.agent?.options?.model);

    for (const { id, sessionId, cwd, resumeSessionId, ...options } of configuredAgents) {
      const meta = cwd === undefined ? undefined : { cwd };
      const hasResumeId = resumeSessionId !== undefined && String(resumeSessionId).length > 0;
      if (!hasResumeId) {
        // Branded SessionId minting for fresh declarative sessions without explicit sessionId
        const configuredId = (sessionId ?? `${id}-session-${mintUuid()}`) as SessionId;
        const persistence =
          sessionId === undefined
            ? undefined
            : (ctx.get?.("sessionPersistence") as SessionPersistence | undefined);
        const job = (
          persistence === undefined
            ? this.createAgent(ctx, {
                sessionId: configuredId,
                agentOptions: options,
                ...(meta !== undefined ? { meta } : {})
              })
            : this.restoreOrCreateConfigured(ctx, configuredId, options, meta)
        ).then(
          () => undefined,
          (error: unknown) => {
            this.reportConfiguredStartupFailure(id, "restore", configuredId, error);
          }
        );
        this.trackStartup(job);
        continue;
      }

      const existingPersistence = ctx.get?.("sessionPersistence") as SessionPersistence | undefined;
      if (existingPersistence !== undefined || typeof ctx.inject !== "function") {
        const job = this.resume(ctx, {
          resumeSessionId,
          agentOptions: options
        }).then(
          () => undefined,
          (error: unknown) => {
            this.reportConfiguredStartupFailure(id, "resume", resumeSessionId, error);
          }
        );
        this.trackStartup(job);
      } else {
        ctx.effect(() => {
          return ctx.inject(["sessionPersistence"], () => {
            const job = this.resume(ctx, {
              resumeSessionId,
              agentOptions: options
            }).then(
              () => undefined,
              (error: unknown) => {
                this.reportConfiguredStartupFailure(id, "resume", resumeSessionId, error);
              }
            );
            this.trackStartup(job);
          }).dispose;
        }, `fastAgentLoop.resume(${id})`);
      }
    }
  }

  private trackStartup(job: Promise<unknown>): void {
    this.startupTasks.add(job);
    const forget = () => {
      this.startupTasks.delete(job);
    };
    job.then(forget, forget);
  }

  private reportConfiguredStartupFailure(
    configId: string,
    action: "restore" | "resume",
    sessionId: SessionId,
    error: unknown
  ): void {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      this.runtime.ctx.logger("fast-loop").warn(
        `agent "${configId}": config-driven ${action} of "${sessionId}" failed: ${msg}`
      );
    } catch {
      // ignore logger failure
    }
    const ctxWithEvents = this.runtime.ctx as Context & {
      events?: { dispatch?: (type: string, args: unknown[]) => Iterable<(...a: unknown[]) => unknown> };
    };
    if (typeof ctxWithEvents.events?.dispatch === "function") {
      const args = ["agent-loop/config-start-failed", { sessionId, error }];
      for (const callback of ctxWithEvents.events.dispatch("emit", args)) {
        try {
          Promise.resolve(callback(...args)).catch(() => {});
        } catch {
          // ignore listener failure
        }
      }
    }
  }

  private async restoreOrCreateConfigured(
    ownerCtx: Context,
    sessionId: SessionId,
    agentOptions: AgentOptions,
    meta?: { cwd: string }
  ): Promise<AgentHandle> {
    try {
      return await this.resume(ownerCtx, {
        resumeSessionId: sessionId,
        agentOptions
      });
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
    }
    return await this.createAgent(ownerCtx, {
      sessionId,
      agentOptions,
      ...(meta !== undefined ? { meta } : {})
    });
  }

  private async appendUnstoredSuffix(
    stored: StoredSession | undefined,
    session: Session
  ): Promise<void> {
    if (stored === undefined) return;
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount));
    if (suffix.length > 0) {
      await stored.handle.append(suffix);
      stored.storedCount += suffix.length;
    }
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    assertAgentOptions(options.agentOptions);
    const loopCtx = this.runtime.ctx;
    let preparation: SessionPreparation | undefined;
    let stored: StoredSession | undefined;
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
        const handle = await persistence.create(session.header, {
          inheritedEventCount: session.inheritedEventCount,
          ...(options.signal ? { signal: options.signal } : {})
        });
        stored = { handle, storedCount: 0 };
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
        stored,
        options,
        "startup"
      );
      published = true;
      return result;
    } finally {
      if (!published) {
        preparation?.[Symbol.dispose]?.();
        if (stored) {
          await stored.handle.close().catch(() => {});
        }
      }
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    assertAgentOptions(options.agentOptions);
    const loopCtx = this.runtime.ctx;
    const persistence = loopCtx.get("sessionPersistence") as SessionPersistence | undefined;
    if (!persistence) {
      throw new Error("cannot resume: session persistence is not configured");
    }

    let preparation: SessionPreparation | undefined;
    let stored: StoredSession | undefined;
    let published = false;
    try {
      const handle = await persistence.open(options.resumeSessionId, "write", {
        ...(options.signal ? { signal: options.signal } : {})
      });
      stored = { handle, storedCount: 0 };

      const coldRead = await handle.read(0, undefined, {
        ...(options.signal ? { signal: options.signal } : {})
      });
      const persisted = coldRead.events;
      const closers = interruptedTurnClosers(persisted);
      if (closers.length > 0) {
        await handle.append(closers);
      }
      stored.storedCount = persisted.length + closers.length;

      preparation = SessionPreparation.create(
        loopCtx.sessions.prepare(options.resumeSessionId, {
          seed: [...persisted, ...closers],
          meta: structuredClone(handle.header),
          inheritedEventCount: handle.inheritedEventCount,
          eventState: coldRead.eventState
        })
      );

      const session = preparation.session;
      await this.appendUnstoredSuffix(stored, session);

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
        stored,
        options,
        "resume"
      );
      published = true;
      return result;
    } finally {
      if (!published) {
        preparation?.[Symbol.dispose]?.();
        if (stored) {
          await stored.handle.close().catch(() => {});
        }
      }
    }
  }

  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    agent: FastAgent,
    session: Session,
    stored: StoredSession | undefined,
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
            typeof commit.commit === "function"
          ) {
            commit.commit();
          }
        });
      }
      abortController.signal.throwIfAborted();
      await this.appendUnstoredSuffix(stored, session);
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
          if (stored) {
            await stored.handle.close();
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

export {
  normalizeAssistantBlocks,
  requestProposal,
  isTransientRetryableFailure,
  TRANSIENT_RETRYABLE_CODES
} from "./loop.js";
export * from "./barrier.js";
export { turnBoundaryProjectionDefinition, inboxProjectionDefinition };
export default FastAgentLoop;
