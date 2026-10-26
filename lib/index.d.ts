import { Service, type Context } from "@deepseek-ai/cordis";
import type { AgentFactory, AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";
import { turnBoundaryProjectionDefinition, inboxProjectionDefinition } from "./projections.js";
import type { ConfiguredAgentEntry, ConfiguredAgentIdentities, FastLoopConfig } from "./types.js";
export declare const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
export declare const CONFIGURED_AGENT_IDENTITIES_KEY = "configuredAgentIdentities";
export declare function assertAgentOptions(options?: AgentOptions): void;
export declare function applyLauncherIdentities(agents: readonly ConfiguredAgentEntry[] | undefined, identities?: ConfiguredAgentIdentities): ConfiguredAgentEntry[];
export declare function validateConfiguredAgents(agents: readonly ConfiguredAgentEntry[]): void;
export declare class FastAgentLoop extends Service implements AgentFactory {
    static inject: string[];
    static Config: z<Schemastery.ObjectS<NoInfer<{
        maxParallelToolCalls: z<number, number, "volatile-defined">;
        enableStreamingTools: z<boolean, boolean, "defined">;
        enablePathAwareBarrier: z<boolean, boolean, "defined">;
        enableSteeringSoftInterrupt: z<boolean, boolean, "defined">;
        maxTransientRetries: z<number, number, "defined">;
        agents: z<any[], any[], "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        maxParallelToolCalls: z<number, number, "volatile-defined">;
        enableStreamingTools: z<boolean, boolean, "defined">;
        enablePathAwareBarrier: z<boolean, boolean, "defined">;
        enableSteeringSoftInterrupt: z<boolean, boolean, "defined">;
        maxTransientRetries: z<number, number, "defined">;
        agents: z<any[], any[], "defined">;
    }>>, "plain">;
    /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
    private readonly runtime;
    private readonly activeTeardowns;
    private readonly startupTasks;
    readonly config: FastLoopConfig;
    constructor(ctx: Context, config?: FastLoopConfig);
    private trackStartup;
    private reportConfiguredStartupFailure;
    private restoreOrCreateConfigured;
    private appendUnstoredSuffix;
    createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
    resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
    private setupAndPublish;
}
export { normalizeAssistantBlocks, requestProposal, isTransientRetryableFailure, TRANSIENT_RETRYABLE_CODES } from "./loop.js";
export * from "./barrier.js";
export { turnBoundaryProjectionDefinition, inboxProjectionDefinition };
export default FastAgentLoop;
//# sourceMappingURL=index.d.ts.map