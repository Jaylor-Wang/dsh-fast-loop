import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import {
  SessionSeq,
  isReplacementSurfaceEvent,
  type Session
} from "@deepseek-ai/dsh-session";
import type {
  TurnBoundaryProjection,
  InboxState,
  InboxWireState
} from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import {
  createSystemMessage,
  createUserMessage,
  type SystemMessage,
  type UserMessage
} from "@deepseek-ai/dsh-llm";

/**
 * Turn boundary projection definition.
 * Required by dsh-agent-instructions, dsh-plan-mode, dsh-session-title, Web UI, etc.
 */
export const turnBoundaryProjectionDefinition = {
  key: "turnBoundary" as const,
  stateVersion: 2,
  stateSchema: z.object({
    openTurnStartSeq: z.number().int().nonnegative().transform(SessionSeq).nullable(),
    lastStepStartSeq: z.number().int().nonnegative().transform(SessionSeq).nullable(),
    lastStepBoundary: z.object({
      kind: z.union([z.literal("start"), z.literal("end")]),
      seq: z.number().int().nonnegative().transform(SessionSeq)
    }).nullable(),
    lastTurn: z.number().int().nonnegative()
  }),
  init: (): TurnBoundaryProjection => ({
    openTurnStartSeq: null,
    lastStepStartSeq: null,
    lastStepBoundary: null,
    lastTurn: 0
  }),
  apply: (state: TurnBoundaryProjection, event: SessionEvent): TurnBoundaryProjection => {
    switch (event.type) {
      case "turn/start": {
        const turnData = event.data as { turn: number };
        return {
          ...state,
          openTurnStartSeq: event.seq,
          lastTurn: turnData.turn
        };
      }
      case "turn/end":
        return {
          ...state,
          openTurnStartSeq: null
        };
      case "step/start":
        return {
          ...state,
          lastStepStartSeq: event.seq,
          lastStepBoundary: {
            kind: "start",
            seq: event.seq
          }
        };
      case "step/end":
        return {
          ...state,
          lastStepBoundary: {
            kind: "end",
            seq: event.seq
          }
        };
      default:
        return state;
    }
  }
} as unknown as ProjectionDefinition<"turnBoundary">;

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  "next-turn": z.array(z.custom<UserMessage>()).readonly(),
  "next-step": z.array(z.custom<UserMessage>()).readonly()
}).readonly();

/**
 * Inbox projection definition.
 * Fold that reconstructs pending input from durable 'agent/inbox/spliced' events.
 */
export const inboxProjectionDefinition = {
  key: "inbox" as const,
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({
    "next-turn": [],
    "next-step": []
  }),
  apply(state: InboxState, event: SessionEvent): InboxState {
    if (event.type !== "agent/inbox/spliced") return state;
    const splice = event.data as {
      target: "next-turn" | "next-step";
      start: number;
      removedCount?: number;
      inserted: UserMessage[];
    };
    try {
      const targetList = state[splice.target];
      const removedCount = splice.removedCount ?? 0;
      if (
        !Number.isSafeInteger(splice.start) ||
        splice.start < 0 ||
        splice.start > targetList.length ||
        !Number.isSafeInteger(removedCount) ||
        removedCount < 0 ||
        splice.start + removedCount > targetList.length
      ) {
        throw new Error("invalid inbox splice bounds");
      }
      const next = targetList.toSpliced(splice.start, removedCount, ...splice.inserted);
      const ids = new Set<string>();
      const otherList = splice.target === "next-turn" ? state["next-step"] : state["next-turn"];
      for (const msg of [...next, ...otherList]) {
        if (ids.has(msg.id)) {
          throw new Error(`message "${msg.id}" is already pending in inbox`);
        }
        ids.add(msg.id);
      }
      return splice.target === "next-turn"
        ? { "next-turn": next, "next-step": state["next-step"] }
        : { "next-turn": state["next-turn"], "next-step": next };
    } catch (error) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error });
    }
  },
  wire: {
    viewSchema: inboxProjectionSchema,
    view: (state: InboxState): InboxWireState => state as unknown as InboxWireState
  },
  stateVersion: 1
} as unknown as Required<ProjectionDefinition<"inbox", InboxState>>;

function textOfMessage(message: { content: readonly { type: string; text?: string }[] }): string | undefined {
  const block = message.content[0];
  return message.content.length === 1 && block?.type === "text" ? block.text : undefined;
}

/**
 * Reconciles system prompt text with the session surface.
 * Node 0 is reserved for the initial system prompt, and updates either replace node 0
 * or append subsequent prompts for in-history updates.
 */
export class SystemPromptProjection {
  constructor(private readonly session: Session) {}

  systemNodes(): { seq: SessionSeq; text: string }[] {
    const nodes: { seq: SessionSeq; text: string }[] = [];
    for (const seq of this.session.surface.nodes) {
      const event = this.session.eventAt(seq);
      if (event?.type !== "system/message") continue;
      const data = event.data as { message: SystemMessage };
      const text = data.message.content.length === 0 ? "" : (textOfMessage(data.message) ?? "");
      nodes.push({ seq, text });
    }
    return nodes;
  }

  project(
    rendered: string,
    input: { inHistory?: boolean; startsSeries?: boolean }
  ): { message: SystemMessage; intent: { surfaceOp: unknown; sourceEventSeqs?: SessionSeq[] } }[] {
    const nodes = this.systemNodes();
    const head = nodes[0];
    if (head === undefined) {
      return [{
        message: createSystemMessage(rendered),
        intent: { surfaceOp: "append" }
      }];
    }
    const latest = nodes.findLast((node) => node.text !== "") ?? head;
    if (!input.inHistory || input.startsSeries || rendered.length === 0) {
      const updates = nodes
        .slice(1)
        .filter((node) => node.text !== "")
        .map((node) => this.replace(node.seq, ""));
      if (head.text !== rendered) {
        updates.push(this.replace(head.seq, rendered));
      }
      return updates;
    }
    if (latest.text === rendered) return [];
    return [{
      message: createSystemMessage(rendered),
      intent: { surfaceOp: "append" }
    }];
  }

  replace(seq: SessionSeq, text: string) {
    return {
      message: createSystemMessage(text),
      intent: {
        surfaceOp: {
          op: "replace" as const,
          startSeq: seq,
          endSeq: seq
        },
        sourceEventSeqs: [seq]
      }
    };
  }
}

const RUNTIME_CONTEXT_SOURCE = "runtime-context";
const RUNTIME_CONTEXT_CLEARED = "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";

function isRuntimeContextMessage(message: unknown): message is UserMessage {
  if (typeof message !== "object" || message === null) return false;
  const msg = message as { source?: { kind?: string } };
  return msg.source?.kind === RUNTIME_CONTEXT_SOURCE;
}

/**
 * Tracks the dynamic runtime context snapshot (working dir, branch, etc.)
 * in session history to avoid duplicate snapshots.
 */
export class RuntimeContextProjection {
  retained?: { seq: SessionSeq; text?: string } | null;

  constructor(ctx: Context, private readonly session: Session) {
    const surface = new Set(session.surface.nodes);
    const events = session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type !== "user/message" || !isRuntimeContextMessage(event.data)) continue;
      this.retained ??= null;
      if (surface.has(event.seq)) {
        this.retained = {
          seq: event.seq,
          text: textOfMessage(event.data)
        };
        break;
      }
    }

    ctx.on("session/event", (subject: unknown, event: SessionEvent) => {
      if (subject !== this.session) return;
      if (event.type === "user/message" && isRuntimeContextMessage(event.data)) {
        this.retained = {
          seq: event.seq,
          text: textOfMessage(event.data)
        };
      } else if (
        this.retained &&
        isReplacementSurfaceEvent(event) &&
        event.sourceEventSeqs?.includes(this.retained.seq) === true
      ) {
        this.retained = null;
      }
    });
  }

  project(current: string, sections: unknown[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return undefined;
    const snapshot = current.length === 0 ? RUNTIME_CONTEXT_CLEARED : current;
    if (this.retained?.text === snapshot) return undefined;
    return createUserMessage({
      content: [{ type: "text", text: snapshot }],
      source:
        sections.length === 0
          ? ({ kind: RUNTIME_CONTEXT_SOURCE } as unknown as UserMessage["source"])
          : ({
              kind: RUNTIME_CONTEXT_SOURCE,
              form: "snapshot",
              sections
            } as unknown as UserMessage["source"])
    });
  }
}
