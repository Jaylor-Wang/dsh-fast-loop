import type { Context } from "@deepseek-ai/cordis";
import * as localScope from "@deepseek-ai/dsh-scope";
import * as localAgent from "@deepseek-ai/dsh-agent";
export interface HostServices {
    createScope: typeof localScope.createScope;
    scopeOf: typeof localScope.scopeOf;
    agentEvents: typeof localAgent.agentEvents;
}
export declare function getHostServices(ctx?: Context): HostServices;
//# sourceMappingURL=host.d.ts.map