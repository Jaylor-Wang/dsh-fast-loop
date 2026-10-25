import * as localScope from "@deepseek-ai/dsh-scope";
import * as localAgent from "@deepseek-ai/dsh-agent";
import * as localTools from "@deepseek-ai/dsh-tools";
const hostCache = new WeakMap();
function getCreateRequire() {
    const g = globalThis;
    if (typeof g.process?.getBuiltinModule === "function") {
        try {
            return g.process.getBuiltinModule("node:module")?.createRequire;
        }
        catch {
            // ignore
        }
    }
    return undefined;
}
export function getHostServices(ctx) {
    if (!ctx) {
        return {
            createScope: localScope.createScope,
            scopeOf: localScope.scopeOf,
            agentEvents: localAgent.agentEvents,
            toolSchedulerSymbol: localTools.TOOL_RUNTIME_SCHEDULER,
        };
    }
    const extendedCtx = ctx;
    const root = extendedCtx.root ?? ctx;
    const cached = hostCache.get(root);
    if (cached)
        return cached;
    const createReq = getCreateRequire();
    if (createReq) {
        try {
            const profileContext = extendedCtx.get?.("profileContext") ??
                extendedCtx.profileContext;
            const gProcess = globalThis.process;
            const candidates = [
                profileContext?.installAnchor,
                profileContext?.dir ? `${profileContext.dir}/package.json` : undefined,
                gProcess?.env?.DSH_INSTALL_ANCHOR,
                "D:/nodejs/node_global/node_modules/@deepseek-ai/dsh/package.json",
            ].filter(Boolean);
            for (const anchor of candidates) {
                try {
                    const req = createReq(anchor);
                    const hostScope = req("@deepseek-ai/dsh-scope");
                    const hostAgent = req("@deepseek-ai/dsh-agent");
                    let toolSchedulerSymbol;
                    try {
                        const hostTools = req("@deepseek-ai/dsh-tools");
                        toolSchedulerSymbol = hostTools?.TOOL_RUNTIME_SCHEDULER;
                    }
                    catch {
                        // ignore
                    }
                    if (hostScope?.createScope && hostAgent?.agentEvents) {
                        const services = {
                            createScope: (activeCtx, key, options) => {
                                const scope = hostScope.createScope(activeCtx, key, options);
                                try {
                                    // Dual-tag with local scope symbol as well for full bi-directional compatibility
                                    const dummy = localScope.createScope(activeCtx, key, options);
                                    for (const sym of Object.getOwnPropertySymbols(dummy.ctx)) {
                                        if (sym.toString() === "Symbol(dsh.scope)") {
                                            scope.ctx[sym] = key;
                                        }
                                    }
                                }
                                catch {
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
                }
                catch {
                    // try next candidate
                }
            }
        }
        catch {
            // fallback below
        }
    }
    const fallback = {
        createScope: localScope.createScope,
        scopeOf: localScope.scopeOf,
        agentEvents: localAgent.agentEvents,
        toolSchedulerSymbol: localTools.TOOL_RUNTIME_SCHEDULER,
    };
    hostCache.set(root, fallback);
    return fallback;
}
//# sourceMappingURL=host.js.map