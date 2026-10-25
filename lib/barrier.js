function normalizePosix(p) {
    const parts = p.split("/");
    const stack = [];
    for (const part of parts) {
        if (!part || part === ".")
            continue;
        if (part === "..") {
            if (stack.length > 0 && stack[stack.length - 1] !== "..") {
                stack.pop();
            }
            else {
                stack.push("..");
            }
        }
        else {
            stack.push(part);
        }
    }
    const prefix = p.startsWith("/") ? "/" : "";
    return prefix + stack.join("/");
}
export const TOOL_INTERRUPT_ABORT_REASON = Symbol.for("deepseek.tool-interrupt");
export function normalizeResourcePath(rawPath, cwd) {
    if (typeof rawPath !== "string")
        return "";
    let clean = rawPath.trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) ||
        (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1);
    }
    clean = clean.replace(/\\/g, "/");
    if (cwd) {
        const cleanCwd = cwd.replace(/\\/g, "/");
        if (!clean.startsWith("/") && !/^[a-zA-Z]:\//.test(clean)) {
            clean = `${cleanCwd.endsWith("/") ? cleanCwd : `${cleanCwd}/`}${clean}`;
        }
    }
    clean = normalizePosix(clean);
    const isWin32 = globalThis.process?.platform === "win32";
    if (isWin32) {
        clean = clean.toLowerCase();
    }
    return clean;
}
export function isInterruptibleWaitTool(name, args) {
    const lowerName = name.toLowerCase();
    if (lowerName === "wait" ||
        lowerName === "sleep" ||
        lowerName === "delay" ||
        lowerName === "pause" ||
        lowerName === "ask" ||
        lowerName === "ask_user" ||
        lowerName === "confirm" ||
        lowerName === "user_input") {
        return true;
    }
    if (args && typeof args === "object") {
        const rec = args;
        if (rec.interruptible === true)
            return true;
    }
    return false;
}
export function extractResourcePaths(args, cwd) {
    if (!args || typeof args !== "object")
        return [];
    const rec = args;
    const paths = [];
    const addPath = (val) => {
        if (typeof val === "string" && val.trim().length > 0) {
            const norm = normalizeResourcePath(val, cwd);
            if (norm && !paths.includes(norm))
                paths.push(norm);
        }
    };
    if ("file_path" in rec)
        addPath(rec.file_path);
    if ("filePath" in rec)
        addPath(rec.filePath);
    if ("path" in rec)
        addPath(rec.path);
    if ("file" in rec)
        addPath(rec.file);
    if ("target" in rec)
        addPath(rec.target);
    if ("filename" in rec)
        addPath(rec.filename);
    if (Array.isArray(rec.paths)) {
        for (const p of rec.paths)
            addPath(p);
    }
    if (Array.isArray(rec.files)) {
        for (const f of rec.files)
            addPath(f);
    }
    return paths;
}
const READ_TOOL_NAMES = {
    read: true,
    read_file: true,
    readfile: true,
    cat: true,
    glob: true,
    grep: true,
    search_files: true,
    find_by_name: true,
    list_dir: true,
    ls: true,
    view: true
};
const WRITE_TOOL_NAMES = {
    edit: true,
    edit_file: true,
    editfile: true,
    write: true,
    write_file: true,
    writefile: true,
    patch: true,
    create_file: true,
    delete_file: true,
    remove_file: true
};
const GLOBAL_BARRIER_TOOL_NAMES = {
    bash: true,
    sh: true,
    powershell: true,
    pwsh: true,
    cmd: true,
    terminal: true,
    exec: true,
    execute_command: true,
    run_code: true,
    reboot: true
};
export function analyzeToolAccess(exec, declaredExecutionModeKind, cwd) {
    const name = exec.name.toLowerCase();
    const isWait = isInterruptibleWaitTool(name, exec.arguments);
    if (GLOBAL_BARRIER_TOOL_NAMES[name]) {
        return { kind: "barrier", paths: [], isInterruptibleWait: isWait };
    }
    const paths = extractResourcePaths(exec.arguments, cwd);
    if (WRITE_TOOL_NAMES[name]) {
        if (paths.length > 0) {
            return { kind: "write", paths, isInterruptibleWait: isWait };
        }
        return { kind: "barrier", paths: [], isInterruptibleWait: isWait };
    }
    if (READ_TOOL_NAMES[name]) {
        return { kind: "read", paths, isInterruptibleWait: isWait };
    }
    if (declaredExecutionModeKind === "parallel") {
        if (paths.length > 0) {
            return { kind: "read", paths, isInterruptibleWait: isWait };
        }
        return { kind: "pure", paths: [], isInterruptibleWait: isWait };
    }
    if (paths.length > 0) {
        if (/edit|write|modify|update|save|create|delete|remove/i.test(name)) {
            return { kind: "write", paths, isInterruptibleWait: isWait };
        }
        if (/read|get|query|search|fetch|inspect|list|find/i.test(name)) {
            return { kind: "read", paths, isInterruptibleWait: isWait };
        }
    }
    return { kind: "barrier", paths: [], isInterruptibleWait: isWait };
}
export function hasResourceConflict(a, b) {
    if (a.kind === "barrier" || b.kind === "barrier")
        return true;
    if (a.kind === "pure" || b.kind === "pure")
        return false;
    if (a.kind === "read" && b.kind === "read")
        return false;
    for (const pa of a.paths) {
        for (const pb of b.paths) {
            if (pa === pb)
                return true;
            if (pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`))
                return true;
        }
    }
    return false;
}
//# sourceMappingURL=barrier.js.map