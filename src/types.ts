import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

export interface FastLoopConfig {
  maxParallelToolCalls?: number | { get(): number };
  enableStreamingTools?: boolean;
  enablePathAwareBarrier?: boolean;
  enableSteeringSoftInterrupt?: boolean;
  agents?: (AgentOptions & {
    id: string;
    sessionId?: SessionId;
    cwd?: string;
    resumeSessionId?: SessionId;
  })[];
}

export function resolveMaxParallel(config?: FastLoopConfig): number {
  const val = config?.maxParallelToolCalls;
  if (val != null && typeof val === "object" && "get" in val && typeof (val as any).get === "function") {
    const num = (val as any).get();
    return typeof num === "number" ? num : 10;
  }
  return typeof val === "number" ? val : 10;
}

export type AgentPhase =
  | { kind: "idle"; lastTurn: number }
  | {
      kind: "maintenance";
      abort: AbortController;
      lastTurn: number;
      wakeRequested: boolean;
    }
  | {
      kind: "running";
      abort: AbortController;
      turn: number;
      step: number;
      wakeRequested: boolean;
    };
