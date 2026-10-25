import { getHostServices } from "./host.js";
import { FastInbox } from "./inbox.js";
import { FastLoopDriver } from "./loop.js";
export function getCancelCause(signal) {
    if (!signal.aborted)
        return undefined;
    const reason = signal.reason;
    if (reason && typeof reason === "object" && "kind" in reason) {
        return reason;
    }
    return { kind: "disposed" };
}
export class FastAgent {
    loopCtx;
    id;
    options;
    session;
    loopConfig;
    inbox;
    scope;
    ctx;
    dispatch;
    driver;
    phase;
    activityDone = Promise.resolve();
    constructor(loopCtx, id, options, session, loopConfig) {
        this.loopCtx = loopCtx;
        this.id = id;
        this.options = options;
        this.session = session;
        this.loopConfig = loopConfig;
        const hostServices = getHostServices(loopCtx);
        this.dispatch = hostServices.agentEvents(loopCtx, this);
        this.scope = hostServices.createScope(loopCtx, this);
        this.ctx = this.scope.ctx;
        this.inbox = new FastInbox(this.loopCtx.sessionProjections, session, this.dispatch);
        const lastTurn = this.loopCtx.sessionProjections.stateOf(session, "turnBoundary")?.lastTurn ?? 0;
        this.phase = {
            kind: "idle",
            lastTurn
        };
        this.driver = new FastLoopDriver(this);
    }
    get status() {
        return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running";
    }
    setPhase(next) {
        const previousStatus = this.status;
        this.phase = next;
        const currentStatus = this.status;
        if (currentStatus !== previousStatus) {
            this.dispatch.emit("agent/status", { status: currentStatus });
        }
    }
    send(message, target, wakeup) {
        const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
        const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
        this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
        if (wakeup) {
            this.wakeDriver(wakingAfterAbort);
        }
    }
    followup(input) {
        this.send(input, "next-turn", true);
    }
    steer(input) {
        this.send(input, "next-step", true);
    }
    inject(input) {
        this.send(input, "next-step", false);
    }
    cancel(cause, options = {}) {
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
    runMaintenance(job) {
        if (this.phase.kind !== "idle") {
            throw new Error(`agent "${this.id}" already has active work`);
        }
        const done = Promise.withResolvers();
        const maintenance = {
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
            }
            finally {
                this.setPhase({
                    kind: "idle",
                    lastTurn: maintenance.lastTurn
                });
                if (getCancelCause(maintenance.abort.signal)?.kind !== "disposed" &&
                    maintenance.wakeRequested &&
                    this.inbox.hasPending) {
                    this.wakeDriver();
                }
                done.resolve();
            }
        })();
    }
    wakeDriver(wakeAfterAbort = false) {
        if (this.phase.kind !== "idle") {
            if (getCancelCause(this.phase.abort.signal)?.kind !== "disposed" &&
                (this.phase.kind === "maintenance" || this.phase.kind === "running" || wakeAfterAbort)) {
                this.phase.wakeRequested = true;
            }
            return;
        }
        const driverPromise = Promise.withResolvers();
        this.activityDone = driverPromise.promise;
        this.setPhase({
            kind: "running",
            abort: new AbortController(),
            turn: this.phase.lastTurn,
            step: 0,
            wakeRequested: false
        });
        this.loopCtx.agents
            .withInitiator(this, () => this.driver.run())
            .then(driverPromise.resolve, (err) => {
            try {
                this.loopCtx.logger("fast-loop").warn(`FastAgent [${this.id}] driver error: ${String(err)}`);
            }
            catch {
                console.warn(`FastAgent [${this.id}] driver error:`, err);
            }
            driverPromise.resolve();
        });
    }
    async whenIdle() {
        let activity;
        do {
            activity = this.activityDone;
            await activity;
        } while (activity !== this.activityDone);
    }
}
//# sourceMappingURL=agent.js.map