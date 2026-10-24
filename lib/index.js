import { Service } from "@deepseek-ai/cordis";
import { interruptedTurnClosers, SessionPreparation, SessionLogOffset } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { turnBoundaryProjectionDefinition, inboxProjectionDefinition } from "./projections.js";
import { FastAgent } from "./agent.js";
export class FastAgentLoop extends Service {
    config;
    static inject = [
        "agents",
        "sessions",
        "llm",
        "tools",
        "systemPrompt",
        "sessionProjections"
    ];
    static Config = z.object({
        maxParallelToolCalls: z.number().step(1).min(1).default(10),
        enableStreamingTools: z.boolean().default(true),
        agents: z.array(z.any()).default([])
    });
    /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
    runtime;
    constructor(ctx, config = {}) {
        super(ctx, "agentLoop");
        this.config = config;
        this.runtime = { ctx };
        ctx.effect(function* () {
            const unregisterTurnBoundary = ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
            yield unregisterTurnBoundary;
            const unregisterInbox = ctx.sessionProjections.register(inboxProjectionDefinition);
            yield unregisterInbox;
        }, "fastAgentLoop.projections()");
        ctx.effect(() => ctx.agents.setFactory(this), "fastAgentLoop.setFactory()");
        ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
        ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
    }
    async createAgent(ownerCtx, options) {
        const loopCtx = this.runtime.ctx;
        const preparation = SessionPreparation.create(loopCtx.sessions.prepare(options.sessionId, {
            ...(options.seed !== undefined ? { seed: options.seed } : {}),
            ...(options.meta !== undefined ? { meta: options.meta } : {}),
            ...(options.inheritedEventCount !== undefined
                ? { inheritedEventCount: options.inheritedEventCount }
                : {})
        }));
        const session = preparation.session;
        const persistence = loopCtx.get("sessionPersistence");
        let handle;
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
        const agent = new FastAgent(loopCtx, options.sessionId, options.agentOptions ?? {}, session, this.config);
        if (options.setup) {
            const commit = await options.setup(agent.ctx, agent);
            if (commit && typeof commit.commit === "function") {
                commit.commit();
            }
        }
        const detachSession = agent.ctx.sessions.enter(session);
        const detachAgent = loopCtx.agents.enter(agent, options.parentAgent);
        agent.ctx.sessions.announce(session);
        await loopCtx.agents.announce(agent, "startup", options.signal);
        const dispose = async () => {
            agent.cancel({ kind: "disposed" });
            await agent.whenIdle();
            await agent.scope.dispose();
            if (handle) {
                await handle.close().catch(() => { });
            }
            detachAgent();
            detachSession();
        };
        ownerCtx.effect(function* () {
            yield () => void dispose();
        }, `fastAgentLoop.lifecycle(${options.sessionId})`);
        return {
            agent: agent,
            dispose
        };
    }
    async resume(ownerCtx, options) {
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
        const preparation = SessionPreparation.create(loopCtx.sessions.prepare(options.resumeSessionId, {
            seed: [...persisted, ...closers],
            meta: structuredClone(handle.header),
            inheritedEventCount: handle.inheritedEventCount,
            eventState: coldRead.eventState
        }));
        const session = preparation.session;
        const suffix = session.snapshotEvents(SessionLogOffset(persisted.length + closers.length));
        if (suffix.length > 0) {
            await handle.append(suffix);
        }
        const agent = new FastAgent(loopCtx, options.resumeSessionId, options.agentOptions ?? {}, session, this.config);
        if (options.setup) {
            const commit = await options.setup(agent.ctx, agent);
            if (commit && typeof commit.commit === "function") {
                commit.commit();
            }
        }
        const detachSession = agent.ctx.sessions.enter(session);
        const detachAgent = loopCtx.agents.enter(agent, options.parentAgent);
        agent.ctx.sessions.announce(session);
        await loopCtx.agents.announce(agent, "resume", options.signal);
        const dispose = async () => {
            agent.cancel({ kind: "disposed" });
            await agent.whenIdle();
            await agent.scope.dispose();
            await handle.close().catch(() => { });
            detachAgent();
            detachSession();
        };
        ownerCtx.effect(function* () {
            yield () => void dispose();
        }, `fastAgentLoop.lifecycle(${options.resumeSessionId})`);
        return {
            agent: agent,
            dispose
        };
    }
}
export { turnBoundaryProjectionDefinition, inboxProjectionDefinition };
export default FastAgentLoop;
//# sourceMappingURL=index.js.map