import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentCancelCause, AgentOptions, AgentStatus, CancelOptions, InboxTarget, AgentEventDispatch } from "@deepseek-ai/dsh-agent";
import type { Scope } from "@deepseek-ai/dsh-scope";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { Session } from "@deepseek-ai/dsh-session";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { FastInbox } from "./inbox.js";
import type { AgentPhase, FastLoopConfig, StepMetrics } from "./types.js";
import { FastLoopDriver } from "./loop.js";
export declare function getCancelCause(signal: AbortSignal): AgentCancelCause | undefined;
export declare class FastAgent implements Agent {
    readonly loopCtx: Context;
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    readonly loopConfig?: FastLoopConfig;
    readonly inbox: FastInbox;
    readonly scope: Scope;
    readonly ctx: Context;
    readonly dispatch: AgentEventDispatch;
    readonly driver: FastLoopDriver;
    phase: AgentPhase;
    lastStepMetrics?: StepMetrics;
    activityDone: Promise<void>;
    constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, loopConfig?: FastLoopConfig);
    get status(): AgentStatus;
    setPhase(next: AgentPhase): void;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    followup(input: UserMessage): void;
    steer(input: UserMessage): void;
    inject(input: UserMessage): void;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
    wakeDriver(wakeAfterAbort?: boolean): void;
    whenIdle(): Promise<void>;
}
//# sourceMappingURL=agent.d.ts.map