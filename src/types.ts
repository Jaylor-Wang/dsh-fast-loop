import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

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
  maxParallelToolCalls?: number | { get(): number };
  enableStreamingTools?: boolean;
  enablePathAwareBarrier?: boolean;
  enableSteeringSoftInterrupt?: boolean;
  maxTransientRetries?: number;
  transientRetryDelayMs?: number;
  agents?: ConfiguredAgentEntry[];
}

export function resolveMaxParallel(config?: FastLoopConfig): number {
  const val = config?.maxParallelToolCalls;
  if (val != null && typeof val === "object" && "get" in val && typeof val.get === "function") {
    const num: unknown = val.get();
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
