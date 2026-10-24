import type { FastAgent } from "./agent.js";
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
    private prepareRequest;
    private toolsChanged;
    private executeTools;
    private appendSkippedToolCall;
    private appendToolCall;
    private appendToolResult;
    private runToolGroup;
}
//# sourceMappingURL=loop.d.ts.map