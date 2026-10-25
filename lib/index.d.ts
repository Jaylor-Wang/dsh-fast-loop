import { Service, type Context } from "@deepseek-ai/cordis";
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";
import { turnBoundaryProjectionDefinition, inboxProjectionDefinition } from "./projections.js";
import type { FastLoopConfig } from "./types.js";
export declare class FastAgentLoop extends Service implements AgentFactory {
    readonly config: FastLoopConfig;
    static inject: string[];
    static Config: z<FastLoopConfig, FastLoopConfig>;
    /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
    private readonly runtime;
    private readonly activeTeardowns;
    constructor(ctx: Context, config?: FastLoopConfig);
    createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
    resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
    private setupAndPublish;
}
export { normalizeAssistantBlocks } from "./loop.js";
export * from "./barrier.js";
export { turnBoundaryProjectionDefinition, inboxProjectionDefinition };
export default FastAgentLoop;
//# sourceMappingURL=index.d.ts.map