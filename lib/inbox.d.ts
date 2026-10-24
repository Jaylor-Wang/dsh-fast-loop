import type { Inbox, InboxTarget, AgentEventDispatch } from "@deepseek-ai/dsh-agent";
import type { MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import type { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
export declare class FastInbox implements Inbox {
    private readonly projections;
    private readonly session;
    private readonly dispatch;
    constructor(projections: SessionProjectionRegistry, session: Session, dispatch: AgentEventDispatch);
    get nextTurn(): readonly UserMessage[];
    get nextStep(): readonly UserMessage[];
    get hasPending(): boolean;
    clear(): void;
    claim(target: "next-turn" | "next-step", turn: number): UserMessage[];
    append(target: InboxTarget, message: UserMessage): void;
    prepend(target: InboxTarget, message: UserMessage): void;
    replace(messageId: MessageId, newMessage: UserMessage): boolean;
    remove(messageId: MessageId): boolean;
    splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[];
    private locate;
    private current;
    private mutate;
}
//# sourceMappingURL=inbox.d.ts.map