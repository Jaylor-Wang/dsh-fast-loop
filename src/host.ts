import type { Context } from "@deepseek-ai/cordis";
import * as localScope from "@deepseek-ai/dsh-scope";
import * as localAgent from "@deepseek-ai/dsh-agent";
import * as localTools from "@deepseek-ai/dsh-tools";

export interface HostServices {
  createScope: typeof localScope.createScope;
  scopeOf: typeof localScope.scopeOf;
  agentEvents: typeof localAgent.agentEvents;
  toolSchedulerSymbol?: symbol;
}

const hostCache = new WeakMap<object, HostServices>();

type RequireFn = (id: string) => Record<string, unknown>;

function getCreateRequire(): ((anchor: string) => RequireFn) | undefined {
  const g = globalThis as {
    process?: {
      getBuiltinModule?: (name: string) => { createRequire?: (anchor: string) => RequireFn };
    };
  };
  if (typeof g.process?.getBuiltinModule === "function") {
    try {
      return g.process.getBuiltinModule("node:module")?.createRequire;
    } catch {
      // ignore
    }
  }
  return undefined;
}

export function getHostServices(ctx?: Context): HostServices {
  if (!ctx) {
    return {
      createScope: localScope.createScope,
      scopeOf: localScope.scopeOf,
      agentEvents: localAgent.agentEvents,
      toolSchedulerSymbol: localTools.TOOL_RUNTIME_SCHEDULER,
    };
  }

  const extendedCtx = ctx as Context & {
    root?: Context;
    get?: (key: string) => unknown;
    profileContext?: { installAnchor?: string; dir?: string };
  };
  const root = extendedCtx.root ?? ctx;
  const cached = hostCache.get(root);
  if (cached) return cached;

  const createReq = getCreateRequire();
  if (createReq) {
    try {
      const profileContext =
        (extendedCtx.get?.("profileContext") as { installAnchor?: string; dir?: string } | undefined) ??
        extendedCtx.profileContext;
      const gProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
      const candidates = [
        profileContext?.installAnchor,
        profileContext?.dir ? `${profileContext.dir}/package.json` : undefined,
        gProcess?.env?.DSH_INSTALL_ANCHOR,
        "D:/nodejs/node_global/node_modules/@deepseek-ai/dsh/package.json",
      ].filter(Boolean) as string[];

      for (const anchor of candidates) {
        try {
          const req = createReq(anchor);
          const hostScope = req("@deepseek-ai/dsh-scope") as unknown as typeof localScope;
          const hostAgent = req("@deepseek-ai/dsh-agent") as unknown as typeof localAgent;
          let toolSchedulerSymbol: symbol | undefined;
          try {
            const hostTools = req("@deepseek-ai/dsh-tools") as unknown as { TOOL_RUNTIME_SCHEDULER?: symbol };
            toolSchedulerSymbol = hostTools?.TOOL_RUNTIME_SCHEDULER;
          } catch {
            // ignore
          }

          if (hostScope?.createScope && hostAgent?.agentEvents) {
            const services: HostServices = {
              createScope: (activeCtx, key, options) => {
                const scope = hostScope.createScope(activeCtx, key, options);
                try {
                  // Dual-tag with local scope symbol as well for full bi-directional compatibility
                  const dummy = localScope.createScope(activeCtx, key, options);
                  for (const sym of Object.getOwnPropertySymbols(dummy.ctx)) {
                    if (sym.toString() === "Symbol(dsh.scope)") {
                      (scope.ctx as unknown as Record<symbol, unknown>)[sym] = key;
                    }
                  }
                } catch {
                  // ignore
                }
                return scope;
              },
              scopeOf: hostScope.scopeOf,
              agentEvents: hostAgent.agentEvents,
              toolSchedulerSymbol: toolSchedulerSymbol ?? localTools.TOOL_RUNTIME_SCHEDULER,
            };
            hostCache.set(root, services);
            return services;
          }
        } catch {
          // try next candidate
        }
      }
    } catch {
      // fallback below
    }
  }

  const fallback: HostServices = {
    createScope: localScope.createScope,
    scopeOf: localScope.scopeOf,
    agentEvents: localAgent.agentEvents,
    toolSchedulerSymbol: localTools.TOOL_RUNTIME_SCHEDULER,
  };
  hostCache.set(root, fallback);
  return fallback;
}
