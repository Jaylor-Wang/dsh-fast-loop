import type { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentCancelCause,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  AgentEventDispatch
} from "@deepseek-ai/dsh-agent";
import type { Scope } from "@deepseek-ai/dsh-scope";
import { getHostServices } from "./host.js";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { Session } from "@deepseek-ai/dsh-session";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { FastInbox } from "./inbox.js";
import type { AgentPhase, FastLoopConfig } from "./types.js";
import { FastLoopDriver } from "./loop.js";

export function getCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined;
  const reason = signal.reason;
  if (reason && typeof reason === "object" && "kind" in reason) {
    const kind = reason.kind;
    if (kind === "user" || kind === "parent" || kind === "disposed") {
      return { kind };
    }
    if (kind === "hook") {
      const hookReason =
        "reason" in reason && typeof reason.reason === "string"
          ? reason.reason
          : String("reason" in reason ? (reason.reason ?? "") : "");
      return { kind: "hook", reason: hookReason };
    }
  }
  return { kind: "disposed" };
}

export class FastAgent implements Agent {
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
  activityDone: Promise<void> = Promise.resolve();

  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    loopConfig?: FastLoopConfig
  ) {
    this.loopCtx = loopCtx;
    this.id = id;
    this.options = options;
    this.session = session;
    this.loopConfig = loopConfig;

    const hostServices = getHostServices(loopCtx);
    this.dispatch = hostServices.agentEvents(loopCtx, this as unknown as Agent);
    this.scope = hostServices.createScope(loopCtx, this as unknown as Agent);
    this.ctx = this.scope.ctx;
    this.inbox = new FastInbox(this.loopCtx.sessionProjections, session, this.dispatch);

    const lastTurn = this.loopCtx.sessionProjections.stateOf(session, "turnBoundary")?.lastTurn ?? 0;
    this.phase = {
      kind: "idle",
      lastTurn
    };

    this.driver = new FastLoopDriver(this);
  }

  get status(): AgentStatus {
    return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running";
  }

  setPhase(next: AgentPhase): void {
    const previousStatus = this.status;
    this.phase = next;
    const currentStatus = this.status;
    if (currentStatus !== previousStatus) {
      this.dispatch.emit("agent/status", { status: currentStatus });
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
    const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
    this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
    if (wakeup) {
      this.wakeDriver(wakingAfterAbort);
    }
  }

  followup(input: UserMessage): void {
    this.send(input, "next-turn", true);
  }

  steer(input: UserMessage): void {
    this.send(input, "next-step", true);
  }

  inject(input: UserMessage): void {
    this.send(input, "next-step", false);
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear();
      if (this.phase.kind !== "idle") {
        this.phase.wakeRequested = false;
      }
    }
    if (this.phase.kind !== "idle") {
      this.phase.abort.abort(cause);
    }
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== "idle") {
      throw new Error(`agent "${this.id}" already has active work`);
    }
    const done = Promise.withResolvers<void>();
    const maintenance: AgentPhase = {
      kind: "maintenance",
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false
    };
    this.setPhase(maintenance);
    this.activityDone = done.promise;

    return (async () => {
      try {
        return await job(maintenance.abort.signal);
      } finally {
        this.setPhase({
          kind: "idle",
          lastTurn: maintenance.lastTurn
        });
        if (
          getCancelCause(maintenance.abort.signal)?.kind !== "disposed" &&
          maintenance.wakeRequested &&
          this.inbox.hasPending
        ) {
          this.wakeDriver();
        }
        done.resolve();
      }
    })();
  }

  wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== "idle") {
      if (
        getCancelCause(this.phase.abort.signal)?.kind !== "disposed" &&
        (this.phase.kind === "maintenance" || this.phase.kind === "running" || wakeAfterAbort)
      ) {
        this.phase.wakeRequested = true;
      }
      return;
    }

    const driverPromise = Promise.withResolvers<void>();
    this.activityDone = driverPromise.promise;
    this.setPhase({
      kind: "running",
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false
    });

    this.loopCtx.agents
      .withInitiator(this as unknown as Agent, () => this.driver.run())
      .then(driverPromise.resolve, (err: unknown) => {
        try {
          this.loopCtx.logger("fast-loop").warn(`FastAgent [${this.id}] driver error: ${String(err)}`);
        } catch {
          console.warn(`FastAgent [${this.id}] driver error:`, err);
        }
        driverPromise.resolve();
      });
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>;
    do {
      activity = this.activityDone;
      await activity;
    } while (activity !== this.activityDone);
  }
}
