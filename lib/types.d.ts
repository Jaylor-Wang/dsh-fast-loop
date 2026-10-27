import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
export interface StepMetrics {
    readonly turn: number;
    readonly step: number;
    readonly totalDurationMs: number;
    readonly llmDurationMs?: number;
    readonly ttftMs?: number;
    readonly toolsDurationMs?: number;
    readonly overheadMs?: number;
    readonly attempts: number;
    readonly toolCallCount: number;
    readonly usage?: TokenUsage;
}
export interface LauncherAgentIdentity {
    readonly id: SessionId;
    readonly resume: boolean;
}
export type ConfiguredAgentIdentities = Readonly<Record<string, LauncherAgentIdentity>>;
export type ConfiguredAgentEntry = AgentOptions & {
    id: string;
    sessionId?: SessionId;
    cwd?: string;
    resumeSessionId?: SessionId;
};
export interface FastLoopConfig {
    maxParallelToolCalls?: number | {
        get(): number;
    };
    enableStreamingTools?: boolean;
    enablePathAwareBarrier?: boolean;
    enableSteeringSoftInterrupt?: boolean;
    maxTransientRetries?: number;
    transientRetryDelayMs?: number;
    agents?: ConfiguredAgentEntry[];
}
export declare function resolveMaxParallel(config?: FastLoopConfig): number;
export type AgentPhase = {
    kind: "idle";
    lastTurn: number;
} | {
    kind: "maintenance";
    abort: AbortController;
    lastTurn: number;
    wakeRequested: boolean;
} | {
    kind: "running";
    abort: AbortController;
    turn: number;
    step: number;
    wakeRequested: boolean;
};
//# sourceMappingURL=types.d.ts.map