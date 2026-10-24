import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
export interface FastLoopConfig {
    maxParallelToolCalls?: number;
    enableStreamingTools?: boolean;
    agents?: (AgentOptions & {
        id: string;
        sessionId?: SessionId;
        cwd?: string;
        resumeSessionId?: SessionId;
    })[];
}
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