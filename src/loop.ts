import type { Agent } from "@deepseek-ai/dsh-agent";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
import {
  createAssistantMessage,
  createDeveloperMessage,
  createToolResultMessage,
  LlmError,
  markAgentLoopRequest,
  type LlmCallConfig,
  type ToolCallBlock,
  type UserMessage
} from "@deepseek-ai/dsh-llm";
import { canonicalHeader, headerEquals } from "@deepseek-ai/dsh-session";
import type { RequestContext } from "@deepseek-ai/dsh-session/types";
import {
  joinContextSections,
  renderContextSections,
  renderPrompt
} from "@deepseek-ai/dsh-system-prompt";
import {
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_RUNTIME_SCHEDULER
} from "@deepseek-ai/dsh-tools";
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
import type { FastAgent } from "./agent.js";
import { getCancelCause } from "./agent.js";
import { AssistantStreamAttempt } from "./stream.js";
import {
  SystemPromptProjection,
  RuntimeContextProjection
} from "./projections.js";

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class FastLoopDriver {
  private assistantStreamRevision = 0;
  private assistantAttemptCounter = 0;
  private requestHeaderLogged = false;
  private frozenMessages = new WeakSet<object>();
  private requestSurfaceGeneration = 0;
  private systemPrompt: SystemPromptProjection;
  private runtimeContext: RuntimeContextProjection;

  constructor(private readonly agent: FastAgent) {
    this.systemPrompt = new SystemPromptProjection(agent.session);
    this.runtimeContext = new RuntimeContextProjection(agent.ctx, agent.session);
  }

  async run(): Promise<void> {
    try {
      while (this.agent.inbox.hasPending) {
        if (this.agent.phase.kind !== "running") break;
        const signal = this.agent.phase.abort.signal;
        if (signal.aborted) break;

        const turn = ++this.agent.phase.turn;
        this.agent.session.append("turn/start", { turn });

        let step = 0;
        let turnConcluded = false;
        let target: "next-turn" | "next-step" = "next-turn";
        let turnEnds: any = { kind: "completed" };

        try {
          while (!turnConcluded && !signal.aborted) {
            step++;
            const stepPosition = { turn, step };

            // 1. Atomically claim inbox input for this proposed step
            const claimed = this.agent.inbox.claim(target, turn);

            // 2. Assemble system prompt with agent scope
            const assembly = await this.agent.loopCtx.systemPrompt.assemble(
              assembleContextFor(this.agent as unknown as Agent, signal)
            );
            signal.throwIfAborted();

            // 3. Dispatch agent/pre-step waterfall
            const decision = await this.agent.dispatch.waterfall(
              "agent/pre-step",
              {
                messages: claimed,
                ...stepPosition,
                signal
              },
              () => {
                const sections = renderContextSections(assembly);
                const context = this.runtimeContext.project(
                  joinContextSections(sections),
                  sections
                );
                return Promise.resolve({
                  kind: "enter" as const,
                  messages: context === undefined ? claimed : [...claimed, context]
                });
              }
            );

            signal.throwIfAborted();

            // If pre-step rejects, no step is opened; turn concludes cleanly as blocked
            if (decision.kind === "reject") {
              turnEnds = { kind: "blocked" };
              turnConcluded = true;
              break;
            }

            if (step === 1 && decision.messages.length === 0) {
              turnEnds = { kind: "completed" };
              turnConcluded = true;
              break;
            }

            // Step accepted: open durable step boundary
            target = "next-step";
            this.agent.phase.step = step;
            this.agent.session.append("step/start", stepPosition);

            let stepConcluded = false;
            try {
              stepConcluded = await this.runStep(turn, step, decision, assembly, signal);
            } finally {
              this.agent.session.append("step/end", stepPosition);
            }

            if (stepConcluded) {
              turnConcluded = true;
            }
          }
        } catch (error) {
          const cancelCause = signal.aborted ? getCancelCause(signal) : undefined;
          turnEnds = cancelCause !== undefined
            ? { kind: "aborted", reason: cancelCause }
            : {
                kind: "error",
                error: {
                  message: error instanceof Error ? error.message : String(error),
                  code: (error as any)?.code ?? "UNKNOWN"
                }
              };
          try {
            this.agent.loopCtx.logger("fast-loop").error(`FastLoopDriver error in turn ${turn}:`, error);
          } catch {
            console.error(`FastLoopDriver error in turn ${turn}:`, error);
          }
        } finally {
          const cancelCause = signal.aborted ? getCancelCause(signal) : undefined;
          this.agent.session.append("turn/end", {
            turn,
            reason: cancelCause !== undefined
              ? { kind: "aborted", reason: cancelCause }
              : turnEnds
          });
        }
      }
    } finally {
      if (this.agent.phase.kind === "running") {
        this.agent.setPhase({
          kind: "idle",
          lastTurn: this.agent.phase.turn
        });
      }
    }
  }

  private async runStep(
    turn: number,
    step: number,
    decision: { kind: "enter"; messages: readonly UserMessage[]; startsRequestSeries?: boolean },
    assembly: any,
    signal: AbortSignal
  ): Promise<boolean> {
    const renderedPrompt = renderPrompt(assembly);
    let firstAttempt = true;

    while (true) {
      signal.throwIfAborted();
      const { config, preparedCall } = await this.prepareRequest(turn, step, signal);

      // Refresh context sections after request resolution
      const refreshedSections = renderContextSections(
        this.agent.loopCtx.systemPrompt.refreshContext(
          assembly,
          assembleContextFor(this.agent as unknown as Agent, signal)
        )
      );
      const dynamicContext = this.runtimeContext.project(
        joinContextSections(refreshedSections),
        refreshedSections
      );

      signal.throwIfAborted();
      const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true;
      const commits = this.systemPrompt.project(renderedPrompt, {
        inHistory: preparedCall?.systemPromptUpdate === "in-history",
        startsSeries:
          startsRequestSeries ||
          this.requestSurfaceGeneration !== this.agent.session.surface.contentGeneration ||
          (preparedCall?.toolUpdate === undefined && this.toolsChanged(assembly.tools ?? []))
      });

      for (const { message, intent } of commits) {
        this.agent.session.append(
          "system/message",
          { turn, step, message },
          intent as any
        );
      }

      let contextAdmitted = false;
      if (firstAttempt) {
        for (const message of decision.messages) {
          if ((message.source as any)?.kind === "runtime-context") {
            if (dynamicContext !== undefined && !contextAdmitted) {
              this.agent.session.append("user/message", dynamicContext, { surfaceOp: "append" });
              contextAdmitted = true;
            }
          } else {
            this.agent.session.append("user/message", message, { surfaceOp: "append" });
          }
        }
      }
      if (dynamicContext !== undefined && !contextAdmitted) {
        this.agent.session.append("user/message", dynamicContext, { surfaceOp: "append" });
      }

      firstAttempt = false;

      // Build model request
      const tools = assembly.tools ?? [];
      const header = canonicalHeader({
        config,
        ...(preparedCall?.adapterDefaults ? { adapterDefaults: preparedCall.adapterDefaults } : {}),
        ...(tools.length > 0 ? { tools } : {})
      });

      const baseline = this.agent.session.requestHeader();
      const startsSeries =
        startsRequestSeries ||
        this.requestSurfaceGeneration !== this.agent.session.surface.contentGeneration;
      let headerSeq: any;
      if (!this.requestHeaderLogged) {
        headerSeq = this.agent.session.append("request/header", {
          header,
          reason: baseline === undefined ? "initial" : "resume",
          ...(startsSeries ? { startsSeries: true } : {})
        }).seq;
        this.requestHeaderLogged = true;
      } else if (baseline === undefined || !headerEquals(baseline, header)) {
        headerSeq = this.agent.session.append("request/header", {
          header,
          reason: "change",
          ...(startsSeries ? { startsSeries: true } : {})
        }).seq;
      } else if (startsSeries) {
        this.agent.session.append("request/header", {
          header,
          reason: "series"
        });
      }

      if (baseline !== undefined && headerSeq !== undefined) {
        const previousNames = new Set(baseline.tools?.map((tool: any) => tool.name));
        const currentNames = new Set(tools.map((tool: any) => tool.name));
        const additions = tools
          .filter((tool: any) => !previousNames.has(tool.name))
          .map((tool: any) => ({
            type: "tool-addition" as const,
            toolName: tool.name
          }));
        const removals = (baseline.tools ?? [])
          .filter((tool: any) => !currentNames.has(tool.name))
          .map((tool: any) => ({
            type: "tool-removal" as const,
            toolName: tool.name
          }));
        if (additions.length > 0 || removals.length > 0) {
          this.agent.session.append(
            "developer/message",
            {
              turn,
              step,
              message: createDeveloperMessage({
                source: { kind: "tool-registry" } as any,
                content: [...additions, ...removals] as any
              }),
              ...(additions.length > 0 ? { headerSeq } : {})
            },
            { surfaceOp: "append" }
          );
        }
      }

      this.requestSurfaceGeneration = this.agent.session.surface.contentGeneration;

      const contextWindow = preparedCall?.context?.contextWindow;
      const systemPromptUpdate = preparedCall?.systemPromptUpdate;
      const requestContext: RequestContext = {
        provider: config.provider,
        model: config.model,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(systemPromptUpdate !== undefined ? { systemPromptUpdate } : {})
      };
      const previousContext = this.agent.session.requestContext();
      if (
        previousContext?.provider !== requestContext.provider ||
        previousContext?.model !== requestContext.model ||
        previousContext?.contextWindow !== requestContext.contextWindow ||
        previousContext?.systemPromptUpdate !== requestContext.systemPromptUpdate
      ) {
        this.agent.session.append("request/context", requestContext);
      }

      const boundaryMessages = this.agent.session.deriveMessages();
      for (const m of boundaryMessages) {
        if (!this.frozenMessages.has(m)) {
          deepFreeze(m);
          this.frozenMessages.add(m);
        }
      }
      Object.freeze(boundaryMessages);

      const request = markAgentLoopRequest(
        Object.freeze({
          ...header.config,
          messages: boundaryMessages,
          toolHistory: this.agent.session.toolHistory(),
          ...(header.tools ? { tools: header.tools } : {}),
          sessionId: this.agent.session.id,
          signal
        })
      );

      const live = new AssistantStreamAttempt(
        this.agent.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        turn,
        step,
        (frame) => {
          this.agent.dispatch.emit("agent/assistant-stream", { frame });
        }
      );

      let started = false;
      try {
        const stream =
          preparedCall?.stream(request) ?? this.agent.loopCtx.llm.stream(request);
        signal.throwIfAborted();
        live.start();
        started = true;
        for await (const chunk of stream) {
          signal.throwIfAborted();
          live.push(chunk);
        }
        signal.throwIfAborted();
      } catch (error) {
        if (!started) throw error;
        if (signal.aborted) {
          const content = live.interruptedBlocks();
          if (content.length > 0) {
            live.settle("assistant/message", () =>
              this.agent.session.append(
                "assistant/message",
                {
                  turn,
                  step,
                  message: createAssistantMessage({
                    content: content as any,
                    source: {
                      provider: request.provider,
                      model: request.model,
                      ...(live.replayState !== undefined ? { replayState: live.replayState } : {})
                    }
                  }),
                  interrupted: true,
                  ...(live.usage ? { usage: live.usage } : {}),
                  stream: [...live.stream]
                },
                { surfaceOp: "append" }
              ).seq
            );
          } else {
            live.settle("assistant/attempt", () =>
              this.agent.session.append("assistant/attempt", {
                turn,
                step,
                stream: [...live.stream]
              }).seq
            );
          }
        } else {
          live.abandon();
        }
        throw error;
      }

      // Successful completion
      const blocks = live.blocks();
      live.settle("assistant/message", () =>
        this.agent.session.append(
          "assistant/message",
          {
            turn,
            step,
            message: createAssistantMessage({
              content: blocks as any,
              source: {
                provider: request.provider,
                model: request.model,
                ...(live.replayState !== undefined ? { replayState: live.replayState } : {})
              }
            }),
            ...(live.usage ? { usage: live.usage } : {}),
            stream: [...live.stream]
          },
          { surfaceOp: "append" }
        ).seq
      );

      const toolCalls = blocks.filter(
        (b: any): b is ToolCallBlock => b.type === "tool-call"
      );

      if (toolCalls.length > 0) {
        const { concluded } = await this.executeTools(
          turn,
          step,
          toolCalls,
          signal,
          (_additionalContext) => {
            // additional context callback if needed
          }
        );
        return concluded;
      }

      await this.agent.dispatch.serial("agent/turn-stopping", {
        turn,
        signal
      });

      return !this.agent.inbox.hasPending;
    }
  }

  private async prepareRequest(
    turn: number,
    step: number,
    signal: AbortSignal
  ): Promise<{ config: LlmCallConfig; preparedCall?: any }> {
    const { session } = this.agent;
    const persistedHeader = session.requestHeader();
    const persistedConfig = persistedHeader?.config;
    const route = {
      provider: this.agent.options.provider ?? persistedConfig?.provider ?? "",
      model: this.agent.options.model ?? persistedConfig?.model ?? ""
    };
    const persistedReasoningEffort =
      persistedConfig?.provider === route.provider &&
      persistedConfig?.model === route.model &&
      persistedHeader?.adapterDefaults?.reasoningEffort !== true
        ? persistedConfig.reasoningEffort
        : undefined;
    const reasoningEffort = this.agent.options.reasoningEffort ?? persistedReasoningEffort;
    const maxTokens = this.agent.options.maxTokens ?? persistedConfig?.maxTokens;

    const seedConfig = deepFreeze({
      ...route,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {})
    });

    const proposedConfig = await this.agent.dispatch.waterfall(
      "agent/request",
      {
        turn,
        step,
        signal
      },
      () => Promise.resolve(seedConfig)
    );

    signal.throwIfAborted();

    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(
        `agent "${this.agent.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`
      );
    }

    let config: LlmCallConfig;
    let preparedCall: any;
    try {
      preparedCall = await this.agent.loopCtx.llm.prepareCall(proposedConfig, signal);
      config = preparedCall.config;
    } catch (error) {
      if (!(error instanceof LlmError) || error.code !== "NO_ADAPTER") throw error;
      config = proposedConfig;
    }

    signal.throwIfAborted();
    return {
      config,
      ...(preparedCall !== undefined ? { preparedCall } : {})
    };
  }

  private toolsChanged(tools: readonly any[]): boolean {
    const baseline = this.agent.session.requestHeader();
    if (baseline === undefined) return false;
    return !headerEquals(baseline, canonicalHeader({
      ...baseline,
      tools: [...tools]
    }));
  }

  private async executeTools(
    turn: number,
    step: number,
    toolCalls: ToolCallBlock[],
    signal: AbortSignal,
    acceptContext: (context: unknown) => void
  ): Promise<{ concluded: boolean }> {
    const maxParallelToolCalls = this.agent.loopConfig?.maxParallelToolCalls ?? 10;
    const planned = toolCalls.map((block) => ({
      block,
      exec: {
        callId: block.id,
        name: block.name,
        arguments: parseToolArguments(block.arguments),
        agent: this.agent as unknown as Agent,
        signal
      }
    }));

    let next = 0;
    let concluded = false;

    while (next < planned.length) {
      const first = planned[next];
      const mode = this.agent.loopCtx.tools.executionMode(first.exec).kind;
      const group = mode === "parallel" ? planned.slice(next) : [first];
      const outcome = await this.runToolGroup(
        turn,
        step,
        group,
        mode,
        signal,
        maxParallelToolCalls,
        acceptContext
      );
      next += outcome.consumed;
      concluded = concluded || outcome.concluded;
      if (outcome.aborted) {
        for (const call of planned.slice(next)) {
          this.appendSkippedToolCall(turn, step, call.block);
        }
        return { concluded };
      }
    }
    return { concluded };
  }

  private appendSkippedToolCall(turn: number, step: number, block: ToolCallBlock): void {
    const callSeq = this.appendToolCall(turn, step, block);
    this.appendToolResult(
      turn,
      step,
      block,
      {
        content: [{ type: "text", text: "Error: tool call aborted before dispatch" }],
        isError: true,
        error: {
          message: "tool call aborted before dispatch",
          info: { name: "AbortError", code: TOOL_ABORTED_BEFORE_DISPATCH }
        }
      },
      callSeq
    );
  }

  private appendToolCall(turn: number, step: number, block: ToolCallBlock): number {
    return this.agent.session.append("tool/call", {
      turn,
      step,
      callId: block.id,
      name: block.name,
      arguments: block.arguments
    }).seq;
  }

  private appendToolResult(
    turn: number,
    step: number,
    block: ToolCallBlock,
    result: any,
    callSeq: number
  ): void {
    const message = createToolResultMessage({
      callId: block.id,
      content: result.content ?? [],
      isError: Boolean(result.isError)
    });
    this.agent.session.append(
      "tool/result",
      {
        turn,
        step,
        message,
        ...(result.error?.info ? { error: result.error.info } : {}),
        ...(result.meta !== undefined ? { meta: result.meta } : {})
      },
      { surfaceOp: "append", sourceEventSeqs: [callSeq as any] }
    );
  }

  private async runToolGroup(
    turn: number,
    step: number,
    group: { block: ToolCallBlock; exec: any }[],
    mode: "parallel" | "exclusive",
    signal: AbortSignal,
    maxParallelToolCalls: number,
    acceptContext: (context: unknown) => void
  ): Promise<{ consumed: number; aborted: boolean; concluded: boolean }> {
    const slots: any[] = group.map(() => undefined);
    const callSeqs: number[] = group.map(() => 0);
    let nextToStart = 0;
    let committed = 0;
    let started = 0;
    let aborted = signal.aborted;
    let concluded = false;
    let schedulerFailure: { error: unknown } | undefined;

    const throwSchedulerFailure = () => {
      if (schedulerFailure !== undefined) throw schedulerFailure.error;
    };

    const commitReady = async () => {
      while (committed < group.length) {
        const slot = slots[committed];
        if (slot === undefined) break;
        const call = group[committed];
        const scheduler = this.agent.loopCtx.tools[TOOL_RUNTIME_SCHEDULER];
        const result = slot.needsPost
          ? await scheduler.finalize(slot.exec, slot.result)
          : scheduler.finish(slot.exec, slot.result);
        this.appendToolResult(turn, step, call.block, result, callSeqs[committed]);
        for (const context of result.additionalContexts ?? []) {
          acceptContext(context);
        }
        concluded = concluded || (result.concludesTurn === true);
        committed++;
      }
    };

    const inFlight = new Map<number, Promise<number>>();
    const startCall = async (index: number) => {
      const call = group[index];
      callSeqs[index] = this.appendToolCall(turn, step, call.block);
      started++;
      const scheduler = this.agent.loopCtx.tools[TOOL_RUNTIME_SCHEDULER];
      const prepared = await scheduler.prepare(call.exec);
      throwSchedulerFailure();
      switch (prepared.kind) {
        case "dispatch": {
          const promise = scheduler.dispatch(prepared.exec).then(
            (outcome: any) => {
              slots[index] = {
                exec: prepared.exec,
                result: outcome.result,
                needsPost: outcome.kind === "post-result"
              };
              return index;
            },
            (error: unknown) => {
              schedulerFailure ??= { error };
              return index;
            }
          );
          inFlight.set(index, promise);
          break;
        }
        case "post-result":
          slots[index] = {
            exec: prepared.exec,
            result: prepared.result,
            needsPost: true
          };
          break;
        case "final-result":
          slots[index] = {
            exec: prepared.exec,
            result: prepared.result,
            needsPost: false
          };
          break;
      }
    };

    const fillPool = async () => {
      while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
        const nextCall = group[nextToStart];
        if (
          nextToStart > 0 &&
          mode === "parallel" &&
          this.agent.loopCtx.tools.executionMode(nextCall.exec).kind !== "parallel"
        ) {
          break;
        }
        await startCall(nextToStart);
        nextToStart++;
        throwSchedulerFailure();
        await commitReady();
        throwSchedulerFailure();
        if (signal.aborted) aborted = true;
      }
    };

    try {
      await fillPool();
      while (inFlight.size > 0) {
        const settledIndex = await Promise.race(inFlight.values());
        inFlight.delete(settledIndex);
        throwSchedulerFailure();
        await commitReady();
        throwSchedulerFailure();
        if (signal.aborted) aborted = true;
        await fillPool();
      }
    } catch (error) {
      schedulerFailure ??= { error };
      await Promise.allSettled(inFlight.values());
      throw schedulerFailure.error;
    }

    if (aborted) {
      for (const call of group.slice(started)) {
        this.appendSkippedToolCall(turn, step, call.block);
      }
      return {
        consumed: group.length,
        aborted: true,
        concluded
      };
    }

    return {
      consumed: started,
      aborted: false,
      concluded
    };
  }
}
