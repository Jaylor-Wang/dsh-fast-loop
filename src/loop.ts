import type { Agent } from "@deepseek-ai/dsh-agent";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
import {
  createAssistantMessage,
  createDeveloperMessage,
  createToolResultMessage,
  createUserMessage,
  LlmError,
  markAgentLoopRequest,
  type LlmCallConfig,
  type ToolCallBlock,
  type UserMessage
} from "@deepseek-ai/dsh-llm";
import { ToolCallRecovery, canonicalHeader, headerEquals } from "@deepseek-ai/dsh-session";
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
import {
  analyzeToolAccess,
  hasResourceConflict,
  TOOL_INTERRUPT_ABORT_REASON
} from "./barrier.js";
import type { FastAgent } from "./agent.js";
import { getCancelCause } from "./agent.js";
import { AssistantStreamAttempt } from "./stream.js";
import {
  SystemPromptProjection,
  RuntimeContextProjection
} from "./projections.js";

export function resolveToolScheduler(ctxOrTools: any): any {
  const candidates = [
    ctxOrTools?.tools,
    ctxOrTools?.ctx?.tools,
    ctxOrTools?.loopCtx?.tools,
    ctxOrTools
  ];
  for (const target of candidates) {
    if (!target) continue;

    // 1. Direct local symbol check
    if (typeof TOOL_RUNTIME_SCHEDULER !== "undefined" && target[TOOL_RUNTIME_SCHEDULER]) {
      return target[TOOL_RUNTIME_SCHEDULER];
    }

    // 2. Cross-instance Symbol lookup via description
    const matchedSym = Object.getOwnPropertySymbols(target).find(
      s => s.description === "TOOL_RUNTIME_SCHEDULER" ||
           s.description?.includes("tool-runtime-scheduler") ||
           s.description?.includes("dsh-tools.scheduler") ||
           s.toString().includes("TOOL_RUNTIME_SCHEDULER") ||
           s.toString().includes("dsh-tools.scheduler")
    );
    if (matchedSym && target[matchedSym]) {
      return target[matchedSym];
    }

    // 3. Regular scheduler property
    if (target.scheduler?.prepare) {
      return target.scheduler;
    }

    // 4. Duck-typing
    if (typeof target.prepareScheduledExecution === "function") {
      return {
        prepare: (exec: any) => target.prepareScheduledExecution(exec),
        dispatch: (exec: any) => target.dispatchScheduledExecution(exec),
        finalize: (exec: any, result: any) => target.finalizeScheduledExecution(exec, result),
        finish: (exec: any, result: any) => target.finishScheduledExecution(exec, result)
      };
    }
  }
  return undefined;
}

const DSML_TAG_REGEX = /<\s*\/?\s*[｜|]{0,2}\s*(?:DSML\s*[｜|]{1,2}\s*)?(?:tool_calls|invoke|parameter|calls|tool[\s▁]*(?:calls|call)?[\s▁]*(?:begin|end|sep)?)\b[^<>]*>?/gi;

export interface NormalizedBlocksResult {
  blocks: any[];
  toolCalls: ToolCallBlock[];
  hasDsmlLeak: boolean;
}

export function stripDsmlFromText(text: string): { text: string; hasLeak: boolean } {
  const matches = Array.from(text.matchAll(DSML_TAG_REGEX));
  if (matches.length === 0) return { text, hasLeak: false };
  const first = matches[0];
  const last = matches[matches.length - 1];
  const before = text.slice(0, first.index).trimEnd();
  const after = text.slice(last.index! + last[0].length).trimStart();
  const cleaned = before.length > 0 && after.length > 0 ? `${before}\n\n${after}` : (before + after);
  return { text: cleaned, hasLeak: true };
}

export function normalizeAssistantBlocks(rawBlocks: readonly any[]): NormalizedBlocksResult {
  const blocks = rawBlocks.map((b) => ({ ...b }));
  const seenIds = new Set<string>();
  let idCounter = 0;
  let hasDsmlLeak = false;

  for (const block of blocks) {
    if (block.type === "tool-call") {
      const rawId = typeof block.id === "string" ? block.id.trim() : "";
      if (!rawId || seenIds.has(rawId)) {
        const base = rawId || "call";
        block.id = `${base}_${Date.now()}_${++idCounter}_${Math.random().toString(36).slice(2, 7)}`;
      }
      seenIds.add(block.id);
    } else if (block.type === "text" && typeof block.text === "string") {
      const stripped = stripDsmlFromText(block.text);
      if (stripped.hasLeak) {
        hasDsmlLeak = true;
        block.text = stripped.text;
      }
    }
  }

  const toolCalls = blocks.filter((b): b is ToolCallBlock => b.type === "tool-call");
  return { blocks, toolCalls, hasDsmlLeak };
}

function parseToolArguments(raw: unknown): any {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
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
                const sections = assembly?.contexts ? renderContextSections(assembly) : [];
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
            const toolRecovery = new ToolCallRecovery();
            const stopRecovery = typeof (this.agent.loopCtx as any)?.on === "function"
              ? (this.agent.loopCtx as any).on("session/event", (session: any, event: any) => {
                  if (session === this.agent.session) toolRecovery.observe(event);
                })
              : () => {};

            let stepConcluded = false;
            try {
              stepConcluded = await this.runStep(turn, step, decision, assembly, signal);
            } catch (error) {
              try {
                for (const event of toolRecovery.results()) {
                  this.agent.session.append("tool/result", event.data, {
                    surfaceOp: "append",
                    ...(event.sourceEventSeqs !== undefined ? { sourceEventSeqs: event.sourceEventSeqs } : {})
                  });
                }
              } catch (recoveryError) {
                throw new AggregateError(
                  [error, recoveryError],
                  "Step failed and its pending tool results could not be recorded",
                  { cause: error }
                );
              }
              throw error;
            } finally {
              stopRecovery();
              this.agent.session.append("step/end", stepPosition);
            }

            if (stepConcluded && this.agent.inbox.nextStep.length === 0) {
              await this.agent.dispatch.serial("agent/turn-stopping", {
                turn,
                signal
              });
              signal.throwIfAborted();
              if (this.agent.inbox.nextStep.length === 0) {
                turnConcluded = true;
              }
            } else if (stepConcluded) {
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
            this.agent.dispatch.emit("agent/error", {
              turn,
              step,
              error
            });
          } catch {
            // ignore dispatch failure
          }
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
    const renderedPrompt = assembly?.sections ? renderPrompt(assembly) : "";
    let firstAttempt = true;

    while (true) {
      signal.throwIfAborted();
      const { config, preparedCall } = await this.prepareRequest(turn, step, signal);

      // Refresh context sections after request resolution
      const refreshed = this.agent.loopCtx.systemPrompt.refreshContext(
        assembly,
        assembleContextFor(this.agent as unknown as Agent, signal)
      );
      const refreshedSections = refreshed?.contexts ? renderContextSections(refreshed) : [];
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
          typeof preparedCall?.stream === "function"
            ? preparedCall.stream(request)
            : this.agent.loopCtx.llm.stream(request);
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
          throw error;
        }

        // Non-abort stream error: settle attempt and dispatch agent/request-error waterfall
        live.settle("assistant/attempt", () =>
          this.agent.session.append("assistant/attempt", {
            turn,
            step,
            stream: [...live.stream]
          }).seq
        );

        const action = await this.agent.dispatch.waterfall(
          "agent/request-error",
          {
            turn,
            step,
            provider: request.provider,
            failure: {
              message: error instanceof Error ? error.message : String(error),
              code: (error as any)?.code ?? "STREAM_ERROR"
            },
            retryPolicy: preparedCall?.retryPolicy,
            signal
          },
          () => Promise.resolve(undefined)
        );

        signal.throwIfAborted();
        if ((action as any)?.kind === "retry") {
          continue;
        }
        throw error;
      }

      // Inspect live finish outcome
      const finish = live.finish;
      if (finish && (finish.kind === "error" || finish.kind === "aborted")) {
        live.settle("assistant/attempt", () =>
          this.agent.session.append("assistant/attempt", {
            turn,
            step,
            stream: [...live.stream]
          }).seq
        );

        const action = await this.agent.dispatch.waterfall(
          "agent/request-error",
          {
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
            signal
          },
          () => Promise.resolve(undefined)
        );

        signal.throwIfAborted();
        if ((action as any)?.kind === "retry") {
          continue;
        }
        throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
      }

      // Successful completion
      // Successful completion: normalize tool-call IDs & cleanse leaked DSML markup
      const { blocks, toolCalls, hasDsmlLeak } = normalizeAssistantBlocks(live.blocks());
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

      if (finish?.kind === "max-tokens") {
        return true;
      }

      // Model leaked raw DSML markup but no structured tool-call was emitted: inject nudge to self-heal
      if (hasDsmlLeak && toolCalls.length === 0) {
        this.agent.inbox.append(
          "next-step",
          createUserMessage({
            source: { kind: "fast-loop" } as unknown as UserMessage["source"],
            content: [
              {
                type: "text",
                text: "Tool call failed: your previous response tried to invoke a tool, but the tool-call markup was malformed into plain text, so no tool was executed. Please re-issue the intended tool call using standard tool call format."
              }
            ]
          })
        );
        return false;
      }

      if (toolCalls.length > 0) {
        const { concluded } = await this.executeTools(
          turn,
          step,
          toolCalls,
          signal,
          (context) => this.agent.inbox.append("next-step", context as any)
        );
        return concluded;
      }

      return true;
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

    const outcome = await this.runToolGroup(
      turn,
      step,
      planned,
      signal,
      maxParallelToolCalls,
      acceptContext
    );

    return { concluded: outcome.concluded };
  }

  private appendSkippedToolCall(
    turn: number,
    step: number,
    block: ToolCallBlock,
    customMessage?: string
  ): void {
    const callSeq = this.appendToolCall(turn, step, block);
    this.appendToolResult(
      turn,
      step,
      block,
      {
        content: [{
          type: "text",
          text: customMessage ?? "Error: tool call aborted before dispatch"
        }],
        isError: true,
        error: {
          message: customMessage ?? "tool call aborted before dispatch",
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
    signal: AbortSignal,
    maxParallelToolCalls: number,
    acceptContext: (context: unknown) => void
  ): Promise<{ consumed: number; aborted: boolean; concluded: boolean }> {
    const total = group.length;
    const slots: any[] = group.map(() => undefined);
    const callSeqs: number[] = group.map(() => 0);
    const started = new Set<number>();
    const settled = new Set<number>();
    const inFlight = new Map<number, Promise<number>>();
    const inFlightControllers = new Map<number, AbortController>();

    const sess = this.agent.session;
    const sessionCwd =
      sess && typeof sess === "object" && "cwd" in sess && typeof sess.cwd === "string"
        ? sess.cwd
        : (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? "/";
    const profiles = group.map((p) =>
      analyzeToolAccess(
        p.exec,
        this.agent.loopCtx.tools.executionMode(p.exec).kind,
        sessionCwd
      )
    );

    let committed = 0;
    let aborted = signal.aborted;
    let steerInterrupted = false;
    let concluded = false;
    let schedulerFailure: unknown;

    const commitReady = async () => {
      while (committed < total) {
        const slot = slots[committed];
        if (slot === undefined) break;
        const call = group[committed];
        const scheduler = resolveToolScheduler(this.agent.ctx?.tools ?? this.agent.loopCtx?.tools ?? this.agent.ctx ?? this.agent.loopCtx);
        const result = slot.needsPost && scheduler?.finalize
          ? await scheduler.finalize(slot.exec, slot.result)
          : (scheduler?.finish ? scheduler.finish(slot.exec, slot.result) : slot.result);
        this.appendToolResult(turn, step, call.block, result, callSeqs[committed]);
        for (const context of result.additionalContexts ?? []) {
          acceptContext(context);
        }
        concluded = concluded || (result.concludesTurn === true);
        committed++;
      }
    };

    const canStart = (idx: number): boolean => {
      if (started.has(idx) || aborted || steerInterrupted) return false;
      if (inFlight.size >= maxParallelToolCalls) return false;

      const profile = profiles[idx];

      if (profile.kind === "barrier") {
        for (let p = 0; p < idx; p++) {
          if (!settled.has(p)) return false;
        }
        return inFlight.size === 0;
      }

      for (let p = 0; p < idx; p++) {
        if (!settled.has(p) && profiles[p].kind === "barrier") {
          return false;
        }
      }

      for (let p = 0; p < idx; p++) {
        if (!settled.has(p) && hasResourceConflict(profiles[p], profile)) {
          return false;
        }
      }

      for (const runningIdx of inFlight.keys()) {
        if (hasResourceConflict(profiles[runningIdx], profile)) {
          return false;
        }
      }

      return true;
    };

    const startCall = async (idx: number) => {
      started.add(idx);
      const call = group[idx];
      callSeqs[idx] = this.appendToolCall(turn, step, call.block);

      const callCtrl = new AbortController();
      inFlightControllers.set(idx, callCtrl);

      const onParentAbort = () => callCtrl.abort(signal.reason);
      if (signal.aborted) {
        callCtrl.abort(signal.reason);
      } else {
        signal.addEventListener("abort", onParentAbort, { once: true });
      }

      const execWithSignal = {
        ...call.exec,
        signal: callCtrl.signal
      };

      const scheduler = resolveToolScheduler(this.agent.ctx?.tools ?? this.agent.loopCtx?.tools ?? this.agent.ctx ?? this.agent.loopCtx);
      let prepared: any;
      try {
        prepared = await scheduler.prepare(execWithSignal);
      } catch (prepError: any) {
        signal.removeEventListener("abort", onParentAbort);
        inFlightControllers.delete(idx);
        slots[idx] = {
          exec: execWithSignal,
          result: {
            content: [{
              type: "text",
              text: `Tool argument error: ${prepError instanceof Error ? prepError.message : String(prepError)}`
            }],
            isError: true,
            error: {
              name: prepError?.name ?? "ValidationError",
              message: prepError instanceof Error ? prepError.message : String(prepError)
            }
          },
          needsPost: false
        };
        settled.add(idx);
        return;
      }

      const cleanup = () => {
        signal.removeEventListener("abort", onParentAbort);
        inFlightControllers.delete(idx);
      };

      const onSoftAbort = () => {
        if (callCtrl.signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
          setTimeout(() => {
            if (!settled.has(idx)) {
              cleanup();
              slots[idx] = {
                exec: prepared.exec,
                result: {
                  content: [{
                    type: "text",
                    text: "Wait interrupted early by incoming user steering message."
                  }],
                  isError: false,
                  interrupted: true
                },
                needsPost: false
              };
              settled.add(idx);
              inFlight.delete(idx);
            }
          }, 20);
        }
      };
      callCtrl.signal.addEventListener("abort", onSoftAbort, { once: true });

      switch (prepared.kind) {
        case "dispatch": {
          const promise = scheduler.dispatch(prepared.exec).then(
            (outcome: any) => {
              cleanup();
              if (!settled.has(idx)) {
                slots[idx] = {
                  exec: prepared.exec,
                  result: outcome.result,
                  needsPost: outcome.kind === "post-result"
                };
                settled.add(idx);
              }
              return idx;
            },
            (error: unknown) => {
              cleanup();
              if (!settled.has(idx)) {
                const isSoftInterrupt =
                  callCtrl.signal.aborted &&
                  (callCtrl.signal.reason === TOOL_INTERRUPT_ABORT_REASON ||
                    String(callCtrl.signal.reason).includes("tool-interrupt") ||
                    String(error).includes("tool-interrupt") ||
                    String(error).includes("user steering"));

                slots[idx] = {
                  exec: prepared.exec,
                  result: isSoftInterrupt
                    ? {
                        content: [{
                          type: "text",
                          text: "Wait interrupted early by incoming user steering message."
                        }],
                        isError: false,
                        interrupted: true
                      }
                    : {
                        content: [{
                          type: "text",
                          text: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`
                        }],
                        isError: true,
                        error: {
                          name: (error as any)?.name ?? "ExecutionError",
                          message: error instanceof Error ? error.message : String(error)
                        }
                      },
                  needsPost: false
                };
                settled.add(idx);
              }
              return idx;
            }
          );
          inFlight.set(idx, promise);
          break;
        }
        case "post-result":
          cleanup();
          slots[idx] = {
            exec: prepared.exec,
            result: prepared.result,
            needsPost: true
          };
          settled.add(idx);
          break;
        case "final-result":
          cleanup();
          slots[idx] = {
            exec: prepared.exec,
            result: prepared.result,
            needsPost: false
          };
          settled.add(idx);
          break;
      }
    };

    const fillPool = async () => {
      let startedAny = false;
      do {
        startedAny = false;
        for (let i = 0; i < total; i++) {
          if (canStart(i)) {
            await startCall(i);
            startedAny = true;
            if (schedulerFailure !== undefined) throw schedulerFailure;
            await commitReady();
            if (schedulerFailure !== undefined) throw schedulerFailure;
            if (signal.aborted) aborted = true;
            if (inFlight.size >= maxParallelToolCalls || aborted || steerInterrupted) break;
          }
        }
      } while (startedAny && !aborted && !steerInterrupted && inFlight.size < maxParallelToolCalls);
    };

    const checkAndApplySteerInterrupt = () => {
      if (this.agent.loopConfig?.enableSteeringSoftInterrupt === false) return false;
      if (!this.agent.inbox?.hasPending) return false;

      let applied = false;
      for (const runningIdx of inFlight.keys()) {
        const profile = profiles[runningIdx];
        if (profile.isInterruptibleWait) {
          const ctrl = inFlightControllers.get(runningIdx);
          if (ctrl && !ctrl.signal.aborted) {
            ctrl.abort(TOOL_INTERRUPT_ABORT_REASON);
            applied = true;
          }
        }
      }

      steerInterrupted = true;
      return applied;
    };

    let wakeSteerWaiter: (() => void) | undefined;
    const unregisterSession = typeof (this.agent.loopCtx as any)?.on === "function"
      ? (this.agent.loopCtx as any).on("session/event", (session: any, event: any) => {
          if (session === this.agent.session && event.type === "agent/inbox/spliced") {
            wakeSteerWaiter?.();
          }
        })
      : () => {};

    try {
      await fillPool();

      while (inFlight.size > 0 || (started.size < total && !aborted && !steerInterrupted)) {
        checkAndApplySteerInterrupt();

        if (inFlight.size === 0) {
          if (started.size < total && !aborted && !steerInterrupted) {
            await fillPool();
          }
          if (inFlight.size === 0) break;
        }

        const { promise: steerRacePromise, resolve: resolveSteer } = Promise.withResolvers<number>();
        const steerTimer = setTimeout(() => resolveSteer(-1), 50);
        wakeSteerWaiter = () => {
          clearTimeout(steerTimer);
          resolveSteer(-1);
        };

        const settledIndex = await Promise.race([
          ...inFlight.values(),
          steerRacePromise
        ]);
        clearTimeout(steerTimer);

        if (settledIndex >= 0) {
          inFlight.delete(settledIndex);
        }

        if (schedulerFailure !== undefined) throw schedulerFailure;
        await commitReady();
        if (schedulerFailure !== undefined) throw schedulerFailure;

        if (signal.aborted) aborted = true;

        if (!aborted && !steerInterrupted) {
          await fillPool();
        }
      }
    } catch (error) {
      schedulerFailure ??= error;
      await Promise.allSettled(inFlight.values());
      throw schedulerFailure;
    } finally {
      unregisterSession?.();
    }

    if (aborted) {
      for (let i = 0; i < total; i++) {
        if (!started.has(i)) {
          this.appendSkippedToolCall(turn, step, group[i].block);
        }
      }
      return {
        consumed: total,
        aborted: true,
        concluded
      };
    }

    if (steerInterrupted) {
      for (let i = 0; i < total; i++) {
        if (!started.has(i)) {
          this.appendSkippedToolCall(
            turn,
            step,
            group[i].block,
            "Tool execution skipped to prioritize incoming user steering message"
          );
        }
      }
      await commitReady();
      return {
        consumed: total,
        aborted: false,
        concluded: false
      };
    }

    await commitReady();
    return {
      consumed: total,
      aborted: false,
      concluded
    };
  }
}
