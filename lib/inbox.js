export class FastInbox {
    projections;
    session;
    dispatch;
    constructor(projections, session, dispatch) {
        this.projections = projections;
        this.session = session;
        this.dispatch = dispatch;
    }
    get nextTurn() {
        return this.current()["next-turn"];
    }
    get nextStep() {
        return this.current()["next-step"];
    }
    get hasPending() {
        const state = this.current();
        return state["next-turn"].length > 0 || state["next-step"].length > 0;
    }
    clear() {
        this.splice("next-step", 0, this.nextStep.length, []);
        this.splice("next-turn", 0, this.nextTurn.length, []);
    }
    claim(target, turn) {
        const claimed = this.mutate("next-step", 0, this.nextStep.length, [], false);
        if (target === "next-turn") {
            claimed.push(...this.mutate("next-turn", 0, 1, [], false));
        }
        for (const message of claimed) {
            this.dispatch.emit("agent/inbox/claimed", { message, turn });
        }
        return claimed;
    }
    append(target, message) {
        this.splice(target, this.current()[target].length, 0, [message]);
    }
    prepend(target, message) {
        this.splice(target, 0, 0, [message]);
    }
    replace(messageId, newMessage) {
        const location = this.locate(messageId);
        if (location === undefined)
            return false;
        this.splice(location.target, location.index, 1, [newMessage]);
        return true;
    }
    remove(messageId) {
        const location = this.locate(messageId);
        if (location === undefined)
            return false;
        this.splice(location.target, location.index, 1, []);
        return true;
    }
    splice(target, start, deleteCount, inserted) {
        return this.mutate(target, start, deleteCount, inserted, true);
    }
    locate(messageId) {
        const state = this.current();
        for (const target of ["next-turn", "next-step"]) {
            const index = state[target].findIndex((msg) => msg.id === messageId);
            if (index >= 0)
                return { target, index };
        }
        return undefined;
    }
    current() {
        const state = this.projections.stateOf(this.session, "inbox");
        if (state === undefined) {
            throw new Error(`agent "${this.session.id}" cannot read inbox state: inbox projection registration is not active`);
        }
        return state;
    }
    mutate(target, start, deleteCount, inserted, discardRemoved) {
        const state = this.current();
        const inbox = state[target];
        const truncatedStart = Math.trunc(start);
        const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart;
        const actualStart = offset < 0 ? Math.max(inbox.length + offset, 0) : Math.min(offset, inbox.length);
        const truncatedDeleteCount = Math.trunc(deleteCount);
        const actualDeleteCount = Math.min(Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0), inbox.length - actualStart);
        if (actualDeleteCount === 0 && inserted.length === 0)
            return [];
        const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted);
        const ids = new Set();
        const otherList = target === "next-turn" ? state["next-step"] : state["next-turn"];
        for (const message of [...candidate, ...otherList]) {
            if (ids.has(message.id))
                throw new Error(`message "${message.id}" is already pending`);
            ids.add(message.id);
        }
        const outcome = discardRemoved && actualDeleteCount > 0 ? "canceled" : undefined;
        const splice = {
            target,
            start: actualStart,
            ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
            inserted,
            ...(outcome === undefined ? {} : { outcome })
        };
        const removed = inbox.slice(actualStart, actualStart + actualDeleteCount);
        const event = this.session.append("agent/inbox/spliced", splice);
        if (discardRemoved) {
            for (const message of removed) {
                this.dispatch.emit("agent/inbox/discarded", { message });
            }
        }
        for (const message of event.data.inserted) {
            this.dispatch.emit("agent/inbox/inserted", { message });
        }
        return removed;
    }
}
//# sourceMappingURL=inbox.js.map