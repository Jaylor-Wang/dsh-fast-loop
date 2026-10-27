import { AssistantStreamAccumulator, BlockAssembler, LlmAttemptId } from "@deepseek-ai/dsh-llm";
export class AssistantStreamAttempt {
    nextRevision;
    turn;
    step;
    emit;
    accumulator = new AssistantStreamAccumulator();
    assembler = new BlockAssembler();
    index = 0;
    terminal = false;
    startTime = 0;
    firstChunkTime = 0;
    endTime = 0;
    attemptId;
    constructor(sessionId, attempt, nextRevision, turn, step, emit) {
        this.nextRevision = nextRevision;
        this.turn = turn;
        this.step = step;
        this.emit = emit;
        this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`);
    }
    get ended() {
        return this.terminal;
    }
    start() {
        this.startTime = Date.now();
        this.emit({
            type: "start",
            attemptId: this.attemptId,
            revision: this.nextRevision(),
            turn: this.turn,
            step: this.step
        });
    }
    push(chunk) {
        if (this.terminal)
            return;
        const now = Date.now();
        if (!this.firstChunkTime) {
            this.firstChunkTime = now;
        }
        const timed = this.accumulator.push({
            time: now,
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
    settle(eventType, append) {
        if (this.terminal)
            return;
        if (!this.endTime) {
            this.endTime = Date.now();
        }
        let seq;
        try {
            seq = append();
        }
        catch (error) {
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
    abandon() {
        if (this.terminal)
            return;
        if (!this.endTime) {
            this.endTime = Date.now();
        }
        this.terminal = true;
        this.emit({
            type: "end",
            attemptId: this.attemptId,
            revision: this.nextRevision(),
            index: this.index,
            outcome: { kind: "abandoned" }
        });
    }
    get stream() {
        return this.accumulator.snapshot();
    }
    blocks() {
        return this.assembler.blocks();
    }
    interruptedBlocks() {
        return this.assembler.interruptedBlocks();
    }
    get usage() {
        return this.assembler.usage;
    }
    get finish() {
        return this.assembler.finish;
    }
    get replayState() {
        return this.assembler.replayState;
    }
    get ttftMs() {
        return this.firstChunkTime > 0 && this.startTime > 0
            ? Math.max(0, this.firstChunkTime - this.startTime)
            : undefined;
    }
    get durationMs() {
        if (this.startTime <= 0)
            return undefined;
        const end = this.endTime > 0 ? this.endTime : Date.now();
        return Math.max(0, end - this.startTime);
    }
}
//# sourceMappingURL=stream.js.map