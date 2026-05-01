#!/usr/bin/env node
import { existsSync } from "node:fs";
import { startAcpServer } from "./acp/server.js";
import { MasRunner } from "./core/runner.js";
import { AIONUI_BIN } from "./config.js";
import { loadPiSdk } from "./pi/pi-sdk.js";
import { MasStore } from "./storage.js";
import type { PermissionDecision, PermissionRequestInput, StreamSink, ToolEventInput } from "./types.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const flags = parseFlags(args);
  const approvalMode = MasRunner.approvalModeFromFlags({
    approveAll: flags.has("approve-all"),
    denyWrites: flags.has("deny-writes"),
  });
  const maxIterations = Number(flags.get("max-iterations") ?? 3);

  switch (command) {
    case "acp":
      startAcpServer({ approvalMode, maxIterations });
      return;
    case "run": {
      const prompt = positional(args).join(" ").trim();
      if (!prompt) throw new Error("用法：mas run <task>");
      const runner = new MasRunner();
      await runner.run(
        prompt,
        {
          cwd: String(flags.get("cwd") ?? process.cwd()),
          approvalMode,
          maxIterations,
        },
        new ConsoleSink(approvalMode),
      );
      return;
    }
    case "doctor":
      await doctor();
      return;
    case "status": {
      const store = new MasStore();
      console.log(JSON.stringify(store.listRuns(Number(flags.get("limit") ?? 20)), null, 2));
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`未知命令：${command}`);
  }
}

class ConsoleSink implements StreamSink {
  constructor(private readonly approvalMode: string) {}

  text(text: string): void {
    process.stdout.write(text);
  }

  thought(text: string): void {
    process.stderr.write(text);
  }

  toolStart(input: ToolEventInput): void {
    process.stderr.write(`\n[tool:start] ${input.title} ${JSON.stringify(input.rawInput ?? {})}\n`);
  }

  toolUpdate(input: ToolEventInput & { status?: string }): void {
    process.stderr.write(`[tool:${input.status ?? "update"}] ${input.title}\n`);
  }

  async permission(input: PermissionRequestInput): Promise<PermissionDecision> {
    if (this.approvalMode === "approve-all") return { approved: true, optionId: "allow_always" };
    process.stderr.write(`\n[permission] ${input.title} 需要审批，当前 CLI 默认拒绝。使用 --approve-all 可自动批准。\n`);
    return { approved: false, optionId: "reject_once" };
  }

  done(summary?: string): void {
    if (summary) process.stdout.write(`\n${summary}\n`);
  }

  error(error: Error): void {
    process.stderr.write(`\n[error] ${error.message}\n`);
  }
}

async function doctor(): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];
  checks.push(["AionUI 二进制", existsSync(AIONUI_BIN), AIONUI_BIN]);
  checks.push(["Pi SDK 公共包", true, "@mariozechner/pi-coding-agent"]);

  let sdkOk = false;
  try {
    await loadPiSdk();
    sdkOk = true;
  } catch (error) {
    checks.push(["Pi SDK 导入", false, error instanceof Error ? error.message : String(error)]);
  }
  if (sdkOk) checks.push(["Pi SDK 导入", true, "ok"]);

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "OK " : "FAIL"} ${name}: ${detail}`);
  }
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index++;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) index++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function printHelp(): void {
  console.log(`MAS MVP

用法：
  mas acp [--approve-all] [--max-iterations 3]
  mas run <task> [--cwd <dir>] [--approve-all] [--deny-writes]
  mas status [--limit 20]
  mas doctor
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
