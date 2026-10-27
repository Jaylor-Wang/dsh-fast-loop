export declare const TOOL_INTERRUPT_ABORT_REASON: unique symbol;
export declare function isToolInterruptReason(reason: unknown): boolean;
export type ToolAccessKind = "read" | "write" | "barrier" | "pure";
export interface ToolAccessProfile {
    readonly kind: ToolAccessKind;
    readonly paths: readonly string[];
    readonly isInterruptibleWait: boolean;
}
export declare function normalizeResourcePath(rawPath: string, cwd?: string): string;
export declare function isInterruptibleWaitTool(name: string, args: unknown): boolean;
export declare function extractResourcePaths(args: unknown, cwd?: string): string[];
export declare function analyzeToolAccess(exec: {
    name: string;
    arguments?: unknown;
}, declaredExecutionModeKind: "parallel" | "exclusive" | undefined, cwd?: string): ToolAccessProfile;
export declare function hasResourceConflict(a: ToolAccessProfile, b: ToolAccessProfile): boolean;
//# sourceMappingURL=barrier.d.ts.map