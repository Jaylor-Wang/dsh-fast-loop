export function resolveMaxParallel(config) {
    const val = config?.maxParallelToolCalls;
    if (val != null && typeof val === "object" && "get" in val && typeof val.get === "function") {
        const num = val.get();
        return typeof num === "number" ? num : 10;
    }
    return typeof val === "number" ? val : 10;
}
//# sourceMappingURL=types.js.map