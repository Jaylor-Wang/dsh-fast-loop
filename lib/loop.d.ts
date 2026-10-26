import { type LlmCallConfig, type ToolCallBlock } from "@deepseek-ai/dsh-llm";
import type { FastAgent } from "./agent.js";
export declare function resolveToolScheduler(ctxOrTools: any): any;
export interface NormalizedBlocksResult {
    blocks: any[];
    toolCalls: ToolCallBlock[];
    hasDsmlLeak: boolean;
}
export declare function stripDsmlFromText(text: string): {
    text: string;
    hasLeak: boolean;
};
export declare function normalizeAssistantBlocks(rawBlocks: readonly any[]): NormalizedBlocksResult;
export declare function requestProposal(header: {
    config: LlmCallConfig;
    adapterDefaults?: {
        reasoningEffort?: boolean;
        maxTokens?: boolean;
    };
}): LlmCallConfig;
export declare const TRANSIENT_RETRYABLE_CODES: Set<string>;
export declare function isTransientRetryableFailure(code: unknown): boolean;
export declare class FastLoopDriver {
    private readonly agent;
    private assistantStreamRevision;
    private assistantAttemptCounter;
    private requestHeaderLogged;
    private frozenMessages;
    private requestSurfaceGeneration;
    private systemPrompt;
    private runtimeContext;
    constructor(agent: FastAgent);
    run(): Promise<void>;
    private runStep;
    private tryTransientFallbackRetry;
    private prepareRequest;
    private toolsChanged;
    private executeTools;
    private appendSkippedToolCall;
    private appendToolCall;
    private appendToolResult;
    private runToolGroup;
}
//# sourceMappingURL=loop.d.ts.map