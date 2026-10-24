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
        this.emit({
            type: "start",
            attemptId: this.attemptId,
            revision: this.nextRevision(),
            turn: this.turn,
            step: this.step
        });
    }
    push(chunk) {
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
    settle(eventType, append) {
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
}
//# sourceMappingURL=stream.js.map