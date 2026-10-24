import { LlmAttemptId, type AssistantStreamRecord, type ContentBlock, type StreamChunk, type TokenUsage } from "@deepseek-ai/dsh-llm";
import type { AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import type { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
export declare class AssistantStreamAttempt {
    private readonly nextRevision;
    private readonly turn;
    private readonly step;
    private readonly emit;
    private readonly accumulator;
    private readonly assembler;
    private index;
    private terminal;
    readonly attemptId: LlmAttemptId;
    constructor(sessionId: SessionId, attempt: number, nextRevision: () => number, turn: number, step: number, emit: (frame: AssistantStreamFrame) => void);
    get ended(): boolean;
    start(): void;
    push(chunk: StreamChunk): void;
    settle(eventType: "assistant/message" | "assistant/attempt", append: () => SessionSeq): void;
    abandon(): void;
    get stream(): readonly AssistantStreamRecord[];
    blocks(): readonly ContentBlock[];
    interruptedBlocks(): readonly ContentBlock[];
    get usage(): TokenUsage | undefined;
    get finish(): import("@deepseek-ai/dsh-llm").FinishReason;
    get replayState(): import("@deepseek-ai/dsh-llm").ReplayEnvelope | undefined;
}
//# sourceMappingURL=stream.d.ts.map