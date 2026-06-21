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

export interface RunManagementContext {
  hasOpenRuns: boolean;
  rendered: string;
}

export function buildRecentActivitySummary(store: MasStore, input: { sessionId?: string; limit?: number; scope?: "current_session" | "global" | "all"; role?: string; excludeRunId?: string }): RecentActivitySummary {
  const limit = input.limit ?? 5;
  const runs = (store.listRuns(Math.max(limit * 3, limit)) as StoredRunRow[]).filter((run) => run.run_id && run.run_id !== input.excludeRunId);
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

export function isRoleHealthCheckQuestion(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const asksToCheck = ["测试", "验证", "检查", "probe", "dry-run", "dry run", "health", "smoke"].some((item) => text.includes(item));
  const mentionsEgo = text.includes("ego") || /执行者|执行层/.test(text);
  const mentionsSuperego = text.includes("superego") || /评审者|评审层|审计层/.test(text);
  const asksHealth = ["正常", "可用", "通道", "工具调用", "结构化输出", "review", "评审"].some((item) => text.includes(item));
  return asksToCheck && mentionsEgo && mentionsSuperego && asksHealth;
}

export function buildRunManagementContext(
  store: MasStore,
  input: { currentRunId: string; sessionId?: string; cwd: string; limit?: number },
): RunManagementContext {
  const limit = input.limit ?? 20;
  const runs = (store.listRuns(Math.max(limit, 20)) as StoredRunRow[]).filter((run) => run.run_id && run.run_id !== input.currentRunId);
  const normalizedCwd = normalizePath(input.cwd);
  const candidates = runs.filter((run) => {
    if (run.status !== "running") return false;
    if (input.sessionId && run.session_id === input.sessionId) return true;
    return normalizePath(run.cwd) === normalizedCwd;
  });
  if (candidates.length === 0) {
    return { hasOpenRuns: false, rendered: "" };
  }
  const lines = [
    "MAS run 管理上下文（运行证据，不是路由结论）：",
    "- 检测到同一会话或工作目录存在未收口 running run 候选。",
    "- 这些事实只用于帮助 HA 判断用户目标在时间中的连续性：当前请求可能是在询问运行事实，也可能是在延续、纠偏或开启新任务。",
    "- running 状态本身不代表应回答、继续、重开或停止；需要结合用户语义、最后事件、更新时间和可执行下一步判断。",
  ];
  for (const run of candidates.slice(0, 3)) {
    const agentRuns = store.listAgentRuns(run.run_id);
    const approvals = store.listApprovals(run.run_id);
    const audits = store.listAuditLog(run.run_id, 500);
    const lastAudit = audits.at(-1);
    const lastApproval = approvals.at(-1);
    const idle = formatIdleAge(run.updated_at);
    lines.push(`- run=${run.run_id} status=${run.status} prompt=${run.prompt.replace(/\s+/g, " ").slice(0, 140)}`);
    lines.push(`  created=${run.created_at} updated=${run.updated_at}${idle ? ` idle=${idle}` : ""}`);
    if (agentRuns.length) {
      lines.push(`  roles=${summarizeAgentRuns(agentRuns, { limit: 4, summaryChars: 120 }).join(" | ")}`);
    } else {
      lines.push("  roles=尚无 HA/Ego/Superego agent_run 记录");
    }
    if (lastAudit) {
      lines.push(`  lastAudit=${lastAudit.createdAt} ${lastAudit.actor}.${lastAudit.action} ${summarizeUnknown(lastAudit.payload)}`);
    }
    if (lastApproval) {
      lines.push(`  lastApproval=${lastApproval.createdAt} ${lastApproval.toolName} decision=${lastApproval.decision} ${summarizeUnknown(lastApproval.rawInput)}`);
    }
  }
  return { hasOpenRuns: true, rendered: lines.join("\n") };
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

function summarizeAgentRuns(agentRuns: AgentRunRecord[], options: { limit?: number; summaryChars?: number } = {}): string[] {
  const limit = options.limit ?? 6;
  const summaryChars = options.summaryChars ?? 120;
  return agentRuns.slice(-limit).map((agentRun) => {
    const output = asRecord(agentRun.output);
    const result = asRecord(output.result);
    const decision = asRecord(output.decision);
    const critique = asRecord(output.critique);
    const intent = stringValue(decision.intent_type);
    const summary =
      stringValue(result.summary) ??
      stringValue(decision.rationale) ??
      stringValue(critique.summary) ??
      stringValue(output.text)?.replace(/\s+/g, " ").slice(0, summaryChars) ??
      "";
    return `${agentRun.role}[${agentRun.status}]${intent ? `[${intent}]` : ""}${summary ? `: ${summary}` : ""}`;
  });
}

function formatIdleAge(updatedAt: string): string | undefined {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return undefined;
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function summarizeUnknown(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, 300);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
