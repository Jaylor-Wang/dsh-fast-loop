import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  type AssistantStreamRecord,
  type ContentBlock,
  type StreamChunk,
  type TokenUsage
} from "@deepseek-ai/dsh-llm";
import type { AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import type { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";

export class AssistantStreamAttempt {
  private readonly accumulator = new AssistantStreamAccumulator();
  private readonly assembler = new BlockAssembler();
  private index = 0;
  private terminal = false;
  readonly attemptId: LlmAttemptId;

  constructor(
    sessionId: SessionId,
    attempt: number,
    private readonly nextRevision: () => number,
    private readonly turn: number,
    private readonly step: number,
    private readonly emit: (frame: AssistantStreamFrame) => void
  ) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`);
  }

  get ended(): boolean {
    return this.terminal;
  }

  start(): void {
    this.emit({
      type: "start",
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      turn: this.turn,
      step: this.step
    });
  }

  push(chunk: StreamChunk): void {
    if (this.terminal) return;
    const timed = this.accumulator.push({
      time: Date.now(),
      chunk
    });
    this.assembler.push(timed.chunk);
    this.emit({
      type: "chunk",
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk
    });
  }

  settle(eventType: "assistant/message" | "assistant/attempt", append: () => SessionSeq): void {
    if (this.terminal) return;
    let seq: SessionSeq;
    try {
      seq = append();
    } catch (error) {
      this.abandon();
      throw error;
    }
    this.terminal = true;
    this.emit({
      type: "end",
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: {
        kind: "committed",
        eventType,
        seq
      }
    });
  }

  abandon(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.emit({
      type: "end",
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: "abandoned" }
    });
  }

  get stream(): readonly AssistantStreamRecord[] {
    return this.accumulator.snapshot();
  }

  blocks(): readonly ContentBlock[] {
    return this.assembler.blocks();
  }

  interruptedBlocks(): readonly ContentBlock[] {
    return this.assembler.interruptedBlocks();
  }

  get usage(): TokenUsage | undefined {
    return this.assembler.usage;
  }

  get finish() {
    return this.assembler.finish;
  }

  get replayState() {
    return this.assembler.replayState;
  }
}
