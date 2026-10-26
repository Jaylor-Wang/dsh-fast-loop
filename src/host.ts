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
function resolveDynamicAnchors(): string[] {
  const gProcess = (
    globalThis as {
      process?: {
        argv?: string[];
        execPath?: string;
        cwd?: () => string;
        env?: Record<string, string | undefined>;
      };
    }
  ).process;
  if (!gProcess) return [];

  const anchors: string[] = [];
  const env = gProcess.env ?? {};

  if (env.DSH_INSTALL_ANCHOR) {
    anchors.push(env.DSH_INSTALL_ANCHOR);
  }

  const entryScript = gProcess.argv?.[1];
  if (typeof entryScript === "string" && entryScript.length > 0) {
    const normEntry = entryScript.replace(/\\/g, "/");
    const dshIdx = normEntry.indexOf("/@deepseek-ai/dsh/");
    if (dshIdx >= 0) {
      anchors.push(`${normEntry.slice(0, dshIdx)}/@deepseek-ai/dsh/package.json`);
    }
    anchors.push(normEntry);
  }

  const prefixes = [
    env.NPM_CONFIG_PREFIX,
    env.npm_config_prefix,
    env.PREFIX,
    env.APPDATA ? `${env.APPDATA}/npm` : undefined,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  if (typeof gProcess.execPath === "string" && gProcess.execPath.length > 0) {
    const execDir = gProcess.execPath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
    if (execDir) {
      prefixes.push(execDir, `${execDir}/node_global`, `${execDir}/..`);
    }
  }

  for (const rawPrefix of prefixes) {
    const prefix = rawPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
    anchors.push(
      `${prefix}/node_modules/@deepseek-ai/dsh/package.json`,
      `${prefix}/lib/node_modules/@deepseek-ai/dsh/package.json`
    );
  }

  if (typeof gProcess.cwd === "function") {
    try {
      anchors.push(`${gProcess.cwd().replace(/\\/g, "/")}/package.json`);
    } catch {
      // ignore
    }
  }

  return anchors;
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
      const candidates = [
        profileContext?.installAnchor,
        profileContext?.dir ? `${profileContext.dir}/package.json` : undefined,
        ...resolveDynamicAnchors(),
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
