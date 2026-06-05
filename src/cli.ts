#!/usr/bin/env node
import { startAcpServer } from "./acp/server.js";
import { AutonomyLoop } from "./core/autonomy.js";
import { GoalCommandRouter } from "./core/goal-command-router.js";
import { normalizeOrchestrationMode, orchestrationModeList } from "./core/orchestration.js";
import { ReflectionScheduler } from "./core/reflection-scheduler.js";
import { MasRunner } from "./core/runner.js";
import { loadPiSdk } from "./pi/pi-sdk.js";
import { MasStore } from "./storage.js";
import type { ApprovalModePolicy, PermissionDecision, PermissionRequestInput, ReflectionStatus, StreamSink, ToolEventInput } from "./types.js";

async function main(): Promise<void> {
  const [rawCommand, ...rawArgs] = process.argv.slice(2);
  const [command, args] = normalizeCommand(rawCommand, rawArgs);
  const flags = parseFlags(args);
  const approvalMode = MasRunner.approvalModeFromFlags({
    approveAll: flags.has("approve-all"),
    denyWrites: flags.has("deny-writes"),
  });
  const maxIterations = Number(flags.get("max-iterations") ?? 3);
  const orchestrationMode = normalizeOrchestrationMode(flags.get("orchestration-mode") ?? flags.get("mode"));
  const approvalModePolicy = normalizeApprovalModePolicy(flags.get("approval-mode-policy") ?? flags.get("permission-policy"));
  const reflectionScheduler = flags.has("reflection-scheduler");
  const reflectionIntervalMs = Number(flags.get("reflection-interval") ?? 60_000);
  const reflectionDueLimit = Number(flags.get("reflection-due-limit") ?? 10);
  const reflectionDreamLimit = Number(flags.get("reflection-dream-limit") ?? 10);
  const reflectionSchedulerDream = !flags.has("no-reflection-dream");

  switch (command) {
    case "acp":
      startAcpServer({
        approvalMode,
        approvalModePolicy,
        maxIterations,
        orchestrationMode,
        reflectionScheduler,
        reflectionIntervalMs,
        reflectionDueLimit,
        reflectionDreamLimit,
        reflectionSchedulerDream,
      });
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
          orchestrationMode,
          maxIterations,
          goalId: typeof flags.get("goal-id") === "string" ? String(flags.get("goal-id")) : undefined,
        },
        new ConsoleSink(approvalMode),
      );
      return;
    }
    case "goal": {
      const router = new GoalCommandRouter();
      const result = router.handleGoal(goalCommandArgs(args, flags), {
        cwd: String(flags.get("cwd") ?? process.cwd()),
        goalId: typeof flags.get("goal-id") === "string" ? String(flags.get("goal-id")) : undefined,
        approvalMode,
        orchestrationMode,
        maxTurns: Number(flags.get("max-turns") ?? 20),
      });
      console.log(result.text);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "subgoal": {
      const router = new GoalCommandRouter();
      const result = router.handleSubgoal(subgoalCommandArgs(args, flags), {
        cwd: String(flags.get("cwd") ?? process.cwd()),
        goalId: typeof flags.get("goal-id") === "string" ? String(flags.get("goal-id")) : undefined,
        approvalMode,
        orchestrationMode,
        maxTurns: Number(flags.get("max-turns") ?? 20),
      });
      console.log(result.text);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "candidate": {
      await candidate(args, flags);
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
    case "reflect": {
      await reflect(args, flags);
      return;
    }
    case "autonomy": {
      await autonomy(args, flags);
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
  const modes = orchestrationModeList().map((mode) => `    ${mode.id} - ${mode.description}`).join("\n");
  console.log(`MAS MVP

用法：
  mas acp [--approve-all] [--approval-mode-policy fixed|mutable] [--reflection-scheduler] [--reflection-interval 60000] [--max-iterations 3] [--orchestration-mode ha-ego-superego]
  mas --experimental-acp [--approve-all] [--approval-mode-policy fixed|mutable] [--reflection-scheduler] [--reflection-interval 60000] [--max-iterations 3] [--orchestration-mode ha-ego-superego]
  mas run <task> [--cwd <dir>] [--approve-all] [--deny-writes] [--orchestration-mode ha-ego-superego]
  mas goal set <objective> [--cwd <dir>] [--max-turns 20]
  mas goal status|pause|resume|clear [--goal-id <id>] [--cwd <dir>]
  mas goal list [--status active,paused,blocked] [--cwd <dir>]
  mas subgoal add <criterion> [--goal-id <id>] [--cwd <dir>]
  mas subgoal list|confirm|reject|remove|clear [index|subgoal-id] [--goal-id <id>] [--cwd <dir>]
  mas candidate list|promote|reject|retire [candidate-id] [--goal-id <id>] [--status candidate]
  mas status [--limit 20]
  mas reflect due|list|dream [--limit 20]
  mas autonomy tick [--interval 60000] [--limit 20] [--run-id <runId>] [--job-id <jobId>]
  mas autonomy daemon|status [--interval 60000] [--limit 20]
  mas doctor

编排模式：
${modes}
`);
}

async function reflect(args: string[], flags: Map<string, string | boolean>): Promise<void> {
  const [subcommand = "due"] = positional(args);
  const limit = Number(flags.get("limit") ?? 20);
  const store = new MasStore();
  const loop = new AutonomyLoop(store, `manual-reflect-${process.pid}`);
  if (subcommand === "due") {
    console.log(JSON.stringify(loop.runDueReflections(limit), null, 2));
    return;
  }
  if (subcommand === "list") {
    const status = normalizeReflectionStatus(flags.get("status"));
    console.log(JSON.stringify(store.listReflectionTasks(status, limit), null, 2));
    return;
  }
  if (subcommand === "dream") {
    console.log(JSON.stringify(loop.dreamPrune(limit), null, 2));
    return;
  }
  throw new Error(`未知 reflect 子命令：${subcommand}`);
}

async function autonomy(args: string[], flags: Map<string, string | boolean>): Promise<void> {
  const [subcommand = "status"] = positional(args);
  const intervalMs = Number(flags.get("interval") ?? flags.get("reflection-interval") ?? 60_000);
  const limit = Number(flags.get("limit") ?? flags.get("reflection-due-limit") ?? 20);
  const dreamLimit = Number(flags.get("dream-limit") ?? flags.get("reflection-dream-limit") ?? 20);
  const runDream = !flags.has("no-dream") && !flags.has("no-reflection-dream");
  const store = new MasStore();
  if (subcommand === "tick") {
    const scheduler = new ReflectionScheduler(store, {
      intervalMs,
      dueLimit: limit,
      dreamLimit,
      runDream,
      runId: typeof flags.get("run-id") === "string" ? String(flags.get("run-id")) : undefined,
      jobId: typeof flags.get("job-id") === "string" ? String(flags.get("job-id")) : undefined,
      ownerId: `manual-autonomy-tick-${process.pid}`,
      unrefTimer: false,
    });
    console.log(JSON.stringify(scheduler.tick(), null, 2));
    return;
  }
  if (subcommand === "status") {
    console.log(
      JSON.stringify(
        {
          lease: store.getSchedulerLease("global-autonomy-scheduler"),
          scheduled: store.listReflectionTasks("scheduled", limit),
          running: store.listReflectionTasks("running", limit),
          autonomyJobs: {
            scheduled: store.listAutonomyJobs({ status: "scheduled", limit }),
            running: store.listAutonomyJobs({ status: "running", limit }),
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  if (subcommand === "daemon") {
    const scheduler = new ReflectionScheduler(store, {
      intervalMs,
      dueLimit: limit,
      dreamLimit,
      runDream,
      ownerId: `autonomy-daemon-${process.pid}`,
      unrefTimer: false,
    });
    scheduler.start();
    process.stderr.write(`MAS autonomy daemon started. owner=${scheduler.ownerId}, interval=${intervalMs}ms\n`);
    await new Promise<void>((resolve) => {
      const stop = () => {
        scheduler.stop();
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  throw new Error(`未知 autonomy 子命令：${subcommand}`);
}

async function candidate(args: string[], flags: Map<string, string | boolean>): Promise<void> {
  const [subcommand = "list", id] = positional(args);
  const store = new MasStore();
  if (subcommand === "list") {
    const rows = store.listEvalCandidates({
      goalId: typeof flags.get("goal-id") === "string" ? String(flags.get("goal-id")) : undefined,
      status: normalizeCandidateStatus(flags.get("status")),
      limit: Number(flags.get("limit") ?? 20),
    });
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const nextStatus =
    subcommand === "promote" ? "promoted" : subcommand === "reject" ? "rejected" : subcommand === "retire" ? "retired" : undefined;
  if (!nextStatus || !id) throw new Error("用法：mas candidate list|promote|reject|retire [candidate-id]");
  const updated = store.updateEvalCandidateStatus(id, nextStatus);
  if (!updated) throw new Error(`未知 candidate：${id}`);
  store.audit({ runId: updated.sourceRunId, actor: "ha", action: `eval_candidate_${nextStatus}`, target: id, payload: updated });
  console.log(JSON.stringify(updated, null, 2));
}

function normalizeCommand(command: string | undefined, args: string[]): [string | undefined, string[]] {
  if (command === "--experimental-acp") return ["acp", args];
  return [command, args];
}

function normalizeApprovalModePolicy(value: string | boolean | undefined): ApprovalModePolicy {
  return value === "mutable" ? "mutable" : "fixed";
}

function normalizeReflectionStatus(value: string | boolean | undefined): ReflectionStatus | undefined {
  if (value === "scheduled" || value === "running" || value === "completed" || value === "cancelled" || value === "pruned") return value;
  return undefined;
}

function normalizeCandidateStatus(value: string | boolean | undefined): "candidate" | "promoted" | "rejected" | "retired" | undefined {
  if (value === "candidate" || value === "promoted" || value === "rejected" || value === "retired") return value;
  return undefined;
}

function goalCommandArgs(args: string[], flags: Map<string, string | boolean>): string[] {
  const parts = positional(args);
  const subcommand = parts[0];
  if (subcommand === "list" && typeof flags.get("status") === "string") return [subcommand, String(flags.get("status"))];
  if (["status", "pause", "resume", "clear"].includes(subcommand ?? "") && typeof flags.get("goal-id") === "string") {
    return [subcommand!, String(flags.get("goal-id"))];
  }
  return parts;
}

function subgoalCommandArgs(args: string[], flags: Map<string, string | boolean>): string[] {
  const parts = positional(args);
  const subcommand = parts[0];
  if (["list", "clear"].includes(subcommand ?? "") && typeof flags.get("goal-id") === "string") {
    return [subcommand!, String(flags.get("goal-id"))];
  }
  return parts;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
