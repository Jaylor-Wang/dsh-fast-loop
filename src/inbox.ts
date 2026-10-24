import type { Inbox, InboxTarget, AgentEventDispatch } from "@deepseek-ai/dsh-agent";
import type { MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import type { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";

export class FastInbox implements Inbox {
  constructor(
    private readonly projections: SessionProjectionRegistry,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch
  ) {}

  get nextTurn(): readonly UserMessage[] {
    return this.current()["next-turn"];
  }

  get nextStep(): readonly UserMessage[] {
    return this.current()["next-step"];
  }

  get hasPending(): boolean {
    const state = this.current();
    return state["next-turn"].length > 0 || state["next-step"].length > 0;
  }

  clear(): void {
    this.splice("next-step", 0, this.nextStep.length, []);
    this.splice("next-turn", 0, this.nextTurn.length, []);
  }

  claim(target: "next-turn" | "next-step", turn: number): UserMessage[] {
    const claimed = this.mutate("next-step", 0, this.nextStep.length, [], false);
    if (target === "next-turn") {
      claimed.push(...this.mutate("next-turn", 0, 1, [], false));
    }
    for (const message of claimed) {
      this.dispatch.emit("agent/inbox/claimed", { message, turn });
    }
    return claimed;
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.current()[target].length, 0, [message]);
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message]);
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId);
    if (location === undefined) return false;
    this.splice(location.target, location.index, 1, [newMessage]);
    return true;
  }

  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId);
    if (location === undefined) return false;
    this.splice(location.target, location.index, 1, []);
    return true;
  }

  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[]
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true);
  }

  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.current();
    for (const target of ["next-turn", "next-step"] as const) {
      const index = state[target].findIndex((msg: any) => msg.id === messageId);
      if (index >= 0) return { target, index };
    }
    return undefined;
  }

  private current() {
    const state = this.projections.stateOf(this.session, "inbox");
    if (state === undefined) {
      throw new Error(
        `agent "${this.session.id}" cannot read inbox state: inbox projection registration is not active`
      );
    }
    return state;
  }

  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean
  ): UserMessage[] {
    const state = this.current();
    const inbox = state[target];
    const truncatedStart = Math.trunc(start);
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart;
    const actualStart = offset < 0 ? Math.max(inbox.length + offset, 0) : Math.min(offset, inbox.length);
    const truncatedDeleteCount = Math.trunc(deleteCount);
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart
    );

    if (actualDeleteCount === 0 && inserted.length === 0) return [];

    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted);
    const ids = new Set<string>();
    const otherList = target === "next-turn" ? state["next-step"] : state["next-turn"];
    for (const message of [...candidate, ...otherList]) {
      if (ids.has((message as any).id)) throw new Error(`message "${(message as any).id}" is already pending`);
      ids.add((message as any).id);
    }

    const outcome = discardRemoved && actualDeleteCount > 0 ? ("canceled" as const) : undefined;
    const splice = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome })
    };

    const removed = (inbox as UserMessage[]).slice(actualStart, actualStart + actualDeleteCount);
    const event = this.session.append("agent/inbox/spliced", splice);

    if (discardRemoved) {
      for (const message of removed) {
        this.dispatch.emit("agent/inbox/discarded", { message });
      }
    }
    for (const message of (event.data as any).inserted) {
      this.dispatch.emit("agent/inbox/inserted", { message });
    }

    return removed;
  }
}
