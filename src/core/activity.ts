import { MasStore } from "../storage.js";
import type { AgentRunRecord } from "../types.js";

interface StoredRunRow {
  run_id: string;
  session_id: string | null;
  cwd: string;
  status: string;
  prompt: string;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecentActivitySummary {
  globalRunCount: number;
  sessionRunCount: number;
  recentRoles: string[];
  rendered: string;
}

export function buildRecentActivitySummary(store: MasStore, input: { sessionId?: string; limit?: number; scope?: "current_session" | "global" | "all"; role?: string }): RecentActivitySummary {
  const limit = input.limit ?? 5;
  const runs = (store.listRuns(Math.max(limit * 2, limit)) as StoredRunRow[]).filter((run) => run.run_id);
  const globalRuns = runs.slice(0, limit);
  const sessionRuns = input.sessionId ? runs.filter((run) => run.session_id === input.sessionId).slice(0, limit) : [];
  const selectedRuns =
    input.scope === "current_session"
      ? sessionRuns
      : input.scope === "global"
      ? globalRuns
      : uniqueRuns([...sessionRuns, ...globalRuns]).slice(0, limit * 2);
  const runSummaries = selectedRuns.map((run) => summarizeRun(store, run, input.sessionId)).filter((run) => !input.role || run.roles.includes(input.role));
  const recentRoles = [...new Set(runSummaries.flatMap((run) => run.roles))];
  const rendered = renderRecentActivity(runSummaries, { hasSessionId: Boolean(input.sessionId), sessionRunCount: sessionRuns.length });
  return {
    globalRunCount: globalRuns.length,
    sessionRunCount: sessionRuns.length,
    recentRoles,
    rendered,
  };
}

function summarizeRun(store: MasStore, run: StoredRunRow, sessionId?: string): {
  runId: string;
  scope: "current_session" | "global";
  status: string;
  prompt: string;
  createdAt: string;
  roles: string[];
  roleSummaries: string[];
} {
  const agentRuns = store.listAgentRuns(run.run_id);
  return {
    runId: run.run_id,
    scope: sessionId && run.session_id === sessionId ? "current_session" : "global",
    status: run.status,
    prompt: run.prompt.replace(/\s+/g, " ").slice(0, 160),
    createdAt: run.created_at,
    roles: [...new Set(agentRuns.map((agentRun) => agentRun.role))],
    roleSummaries: summarizeAgentRuns(agentRuns),
  };
}

function summarizeAgentRuns(agentRuns: AgentRunRecord[]): string[] {
  return agentRuns.slice(-6).map((agentRun) => {
    const output = asRecord(agentRun.output);
    const result = asRecord(output.result);
    const decision = asRecord(output.decision);
    const critique = asRecord(output.critique);
    const summary =
      stringValue(result.summary) ??
      stringValue(decision.rationale) ??
      stringValue(critique.summary) ??
      stringValue(output.text)?.replace(/\s+/g, " ").slice(0, 120) ??
      "";
    return `${agentRun.role}[${agentRun.status}]${summary ? `: ${summary}` : ""}`;
  });
}

function renderRecentActivity(
  runs: Array<ReturnType<typeof summarizeRun>>,
  input: { hasSessionId: boolean; sessionRunCount: number },
): string {
  if (runs.length === 0) {
    return [
      "MAS 近期活动事实：",
      "- 当前 MAS 数据库中没有可用的历史 run 记录。",
      "- 如果用户询问最近状态，不能仅根据当前会话文本断言系统从未执行过任务；只能说明未检索到历史运行记录。",
    ].join("\n");
  }
  const lines = [
    "MAS 近期活动事实如下，来自本地 runs/agent_runs 表，是状态事实，不是 Experience Graph 经验候选：",
  ];
  if (input.hasSessionId && input.sessionRunCount === 0) {
    lines.push("- 当前 AionUI session 暂无更早 run；下面同时列出 MAS 全局最近 run，回答时请区分当前会话和全局历史。");
  }
  for (const run of runs) {
    lines.push(`- [${run.scope}] ${run.createdAt} run=${run.runId.slice(0, 8)} status=${run.status} prompt=${run.prompt}`);
    if (run.roleSummaries.length > 0) {
      lines.push(`  roles=${run.roleSummaries.join(" | ")}`);
    } else {
      lines.push("  roles=尚无 HA/Ego/Superego agent_run 记录");
    }
  }
  return lines.join("\n");
}

function uniqueRuns(runs: StoredRunRow[]): StoredRunRow[] {
  const seen = new Set<string>();
  const result: StoredRunRow[] = [];
  for (const run of runs) {
    if (seen.has(run.run_id)) continue;
    seen.add(run.run_id);
    result.push(run);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
