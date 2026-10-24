import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import { SessionSeq, type Session } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { type SystemMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
/**
 * Turn boundary projection definition.
 * Required by dsh-agent-instructions, dsh-plan-mode, dsh-session-title, Web UI, etc.
 */
export declare const turnBoundaryProjectionDefinition: ProjectionDefinition<"turnBoundary">;
/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export declare const inboxProjectionSchema: z.ZodReadonly<z.ZodObject<{
    "next-turn": z.ZodReadonly<z.ZodArray<z.ZodCustom<UserMessage, UserMessage>>>;
    "next-step": z.ZodReadonly<z.ZodArray<z.ZodCustom<UserMessage, UserMessage>>>;
}, z.core.$strip>>;
/**
 * Inbox projection definition.
 * Fold that reconstructs pending input from durable 'agent/inbox/spliced' events.
 */
export declare const inboxProjectionDefinition: ProjectionDefinition<"inbox">;
/**
 * Reconciles system prompt text with the session surface.
 * Node 0 is reserved for the initial system prompt, and updates either replace node 0
 * or append subsequent prompts for in-history updates.
 */
export declare class SystemPromptProjection {
    private readonly session;
    constructor(session: Session);
    systemNodes(): {
        seq: SessionSeq;
        text: string;
    }[];
    project(rendered: string, input: {
        inHistory?: boolean;
        startsSeries?: boolean;
    }): {
        message: SystemMessage;
        intent: {
            surfaceOp: unknown;
            sourceEventSeqs?: SessionSeq[];
        };
    }[];
    replace(seq: SessionSeq, text: string): {
        message: SystemMessage;
        intent: {
            surfaceOp: {
                op: "replace";
                startSeq: SessionSeq;
                endSeq: SessionSeq;
            };
            sourceEventSeqs: SessionSeq[];
        };
    };
}
/**
 * Tracks the dynamic runtime context snapshot (working dir, branch, etc.)
 * in session history to avoid duplicate snapshots.
 */
export declare class RuntimeContextProjection {
    private readonly session;
    retained?: {
        seq: SessionSeq;
        text?: string;
    } | null;
    constructor(ctx: Context, session: Session);
    project(current: string, sections: unknown[]): UserMessage | undefined;
}
//# sourceMappingURL=projections.d.ts.map