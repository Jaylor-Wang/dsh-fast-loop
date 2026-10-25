#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function toggleFastLoop(content, enable, options = {}) {
  let updated = content;
  const maxParallel = options.maxParallel ?? 10;

  // 1. Toggle agent-loop disabled state
  const agentLoopDisabledMatch = updated.match(
    /(-\s*id:\s*agent-loop\b[\s\S]*?)([ \t]+disabled:\s*)(true|false)\b/
  );
  if (agentLoopDisabledMatch) {
    const desired = enable ? "true" : "false";
    updated = updated.replace(
      /(-\s*id:\s*agent-loop\b[\s\S]*?)([ \t]+disabled:\s*)(true|false)\b/,
      `$1$2${desired}`
    );
  } else if (/-\s*id:\s*agent-loop\b/.test(updated)) {
    const desired = enable ? "true" : "false";
    updated = updated.replace(
      /(-\s*id:\s*agent-loop\b[^\n]*)/,
      `$1\n  disabled: ${desired}`
    );
  } else {
    updated =
      updated.trimEnd() +
      `\n\n- id: agent-loop\n  disabled: ${enable ? "true" : "false"}\n`;
  }

  // 2. Toggle fast-loop
  const hasFastLoop = /id:\s*fast-loop\b/.test(updated);
  if (enable) {
    if (hasFastLoop) {
      updated = updated.replace(
        /(id:\s*fast-loop\b[\s\S]*?)([ \t]+disabled:\s*)true\b/,
        "$1$2false"
      );
    } else {
      updated =
        updated.trimEnd() +
        `\n\n- insert:\n  - id: fast-loop\n    name: dsh-fast-loop\n    config:\n      maxParallelToolCalls: ${maxParallel}\n      enableStreamingTools: true\n      enablePathAwareBarrier: true\n      enableSteeringSoftInterrupt: true\n`;
    }
  } else {
    if (hasFastLoop) {
      const fastLoopDisabledMatch = updated.match(
        /(id:\s*fast-loop\b[\s\S]*?)([ \t]+disabled:\s*)(true|false)\b/
      );
      if (fastLoopDisabledMatch) {
        updated = updated.replace(
          /(id:\s*fast-loop\b[\s\S]*?)([ \t]+disabled:\s*)(true|false)\b/,
          "$1$2true"
        );
      } else {
        updated = updated.replace(
          /(-\s*id:\s*fast-loop\b[^\n]*)/,
          "$1\n    disabled: true"
        );
      }
    }
  }

  return updated;
}

export function inspectFastLoopStatus(content) {
  const agentLoopDisabled =
    /-\s*id:\s*agent-loop\b[\s\S]*?[ \t]+disabled:\s*true\b/.test(content);
  const fastLoopPresent = /id:\s*fast-loop\b/.test(content);
  const fastLoopDisabled =
    /id:\s*fast-loop\b[\s\S]*?[ \t]+disabled:\s*true\b/.test(content);

  const active = agentLoopDisabled && fastLoopPresent && !fastLoopDisabled;
  return {
    active,
    agentLoopDisabled,
    fastLoopPresent,
    fastLoopDisabled
  };
}

function resolvePatchPath(customPath, profileName = "web") {
  if (customPath) {
    return path.resolve(process.cwd(), customPath);
  }
  const dshHome =
    process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "profiles", profileName, "cordis.patch.yml");
}

function printHelp() {
  console.log(`
dsh-fast-loop CLI - Effortless Switcher between Fast Loop & Official Loop

Usage:
  dsh-fast-loop <command> [options]
  npx dsh-fast-loop <command> [options]
Commands:
  enable, on, start     Enable dsh-fast-loop and disable official agent-loop
  disable, off, stop    Disable dsh-fast-loop and restore official agent-loop
  status, check         Display current active loop status in cordis.patch.yml
  help, --help, -h      Display this help message

Options:
  --profile <name>      Target profile name (default: "web")
  --path <file_path>    Direct path to cordis.patch.yml
  --max-parallel <num>  Maximum parallel tool calls when enabling (default: 10)

Examples:
  dsh-fast-loop enable
  dsh-fast-loop disable
  dsh-fast-loop status
`);
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h") || args.includes("help")) {
    printHelp();
    return;
  }

  const command = args[0].toLowerCase();

  let profile = "web";
  let customPath;
  let maxParallel = 10;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--profile" && args[i + 1]) {
      profile = args[++i];
    } else if (args[i] === "--path" && args[i + 1]) {
      customPath = args[++i];
    } else if (args[i] === "--max-parallel" && args[i + 1]) {
      maxParallel = Number.parseInt(args[++i], 10) || 10;
    }
  }

  const patchFile = resolvePatchPath(customPath, profile);

  if (!fs.existsSync(patchFile)) {
    console.error(`\x1b[31m[Error]\x1b[0m Cannot find patch file: ${patchFile}`);
    console.error(`Please verify that the DSH profile "${profile}" exists.`);
    process.exit(1);
  }

  const originalContent = fs.readFileSync(patchFile, "utf-8");

  if (command === "status" || command === "check") {
    const status = inspectFastLoopStatus(originalContent);
    console.log(`\nTarget File: \x1b[36m${patchFile}\x1b[0m`);
    if (status.active) {
      console.log(`Current Mode: \x1b[32m✔ ACTIVE [dsh-fast-loop]\x1b[0m`);
      console.log(`  - dsh-fast-loop: \x1b[32menabled\x1b[0m`);
      console.log(`  - official agent-loop: \x1b[33mdisabled\x1b[0m`);
    } else {
      console.log(`Current Mode: \x1b[33m✔ FALLBACK [Official agent-loop]\x1b[0m`);
      console.log(`  - official agent-loop: \x1b[32menabled\x1b[0m`);
      console.log(`  - dsh-fast-loop: ${status.fastLoopPresent ? "\x1b[31mdisabled\x1b[0m" : "\x1b[90mnot configured\x1b[0m"}`);
    }
    console.log();
    return;
  }

  if (command === "enable" || command === "on" || command === "start") {
    const updated = toggleFastLoop(originalContent, true, { maxParallel });
    if (updated === originalContent) {
      console.log(`\x1b[32m✔ dsh-fast-loop is already ACTIVE in ${patchFile}\x1b[0m`);
    } else {
      fs.writeFileSync(patchFile, updated, "utf-8");
      console.log(`\x1b[32m✔ Successfully ENABLED dsh-fast-loop in ${patchFile}!\x1b[0m`);
      console.log(`  - Official agent-loop: disabled`);
      console.log(`  - dsh-fast-loop: enabled (maxParallelToolCalls: ${maxParallel})`);
      console.log(`\x1b[90m(DSH with live reload will apply this change seamlessly)\x1b[0m\n`);
    }
    return;
  }

  if (command === "disable" || command === "off" || command === "stop") {
    const updated = toggleFastLoop(originalContent, false);
    if (updated === originalContent) {
      console.log(`\x1b[33m✔ Official agent-loop is already ACTIVE (dsh-fast-loop disabled) in ${patchFile}\x1b[0m`);
    } else {
      fs.writeFileSync(patchFile, updated, "utf-8");
      console.log(`\x1b[33m✔ Successfully DISABLED dsh-fast-loop and restored official agent-loop in ${patchFile}!\x1b[0m`);
      console.log(`  - Official agent-loop: enabled`);
      console.log(`  - dsh-fast-loop: disabled`);
      console.log(`\x1b[90m(DSH with live reload will apply this change seamlessly)\x1b[0m\n`);
    }
    return;
  }

  console.error(`\x1b[31m[Error]\x1b[0m Unknown command: "${command}"`);
  printHelp();
  process.exit(1);
}

// Only execute if invoked as a CLI directly
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  runCli();
}
