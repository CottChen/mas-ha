import { MasStore } from "../storage.js";
import type { ApprovalMode, GoalAcceptanceContract, GoalRecord, GoalStatus, OrchestrationMode } from "../types.js";
import { GoalController } from "./goal-controller.js";

export interface GoalCommandContext {
  cwd: string;
  sessionId?: string;
  goalId?: string;
  approvalMode: ApprovalMode;
  orchestrationMode: OrchestrationMode;
  maxTurns?: number;
}

export interface GoalCommandResult {
  ok: boolean;
  text: string;
  data?: unknown;
}

export class GoalCommandRouter {
  private readonly controller: GoalController;

  constructor(private readonly store = new MasStore()) {
    this.controller = new GoalController(store);
  }

  handleGoal(args: string[], context: GoalCommandContext): GoalCommandResult {
    const [rawSubcommand, ...rest] = args;
    const subcommand = normalizeGoalSubcommand(rawSubcommand);
    if (subcommand === "set") return this.setGoal(rest.join(" ").trim(), context);
    if (subcommand === "status") return this.goalStatus(rest[0], context);
    if (subcommand === "pause") return this.transitionGoal(rest[0], context, "paused", "暂停");
    if (subcommand === "resume") return this.transitionGoal(rest[0], context, "active", "恢复");
    if (subcommand === "clear") return this.transitionGoal(rest[0], context, "cleared", "清除");
    if (subcommand === "list") return this.listGoals(context, parseStatusList(rest[0]));
    if (!rawSubcommand) return this.goalStatus(undefined, context);
    return this.setGoal(args.join(" ").trim(), context);
  }

  handleSubgoal(args: string[], context: GoalCommandContext): GoalCommandResult {
    const [rawSubcommand, ...rest] = args;
    const subcommand = normalizeSubgoalSubcommand(rawSubcommand);
    if (subcommand === "add") return this.addSubgoal(rest.join(" ").trim(), context);
    if (subcommand === "list") return this.listSubgoals(rest[0], context);
    if (subcommand === "confirm") return this.transitionSubgoal(rest[0], context, "active", "确认");
    if (subcommand === "reject") return this.transitionSubgoal(rest[0], context, "rejected", "拒绝");
    if (subcommand === "remove") return this.transitionSubgoal(rest[0], context, "removed", "移除");
    if (subcommand === "clear") return this.clearSubgoals(rest[0], context);
    if (!rawSubcommand) return this.listSubgoals(undefined, context);
    return this.addSubgoal(args.join(" ").trim(), context);
  }

  private setGoal(objective: string, context: GoalCommandContext): GoalCommandResult {
    if (!objective) return { ok: false, text: "用法：mas goal set <objective>" };
    const existing = this.store.listGoals({ cwd: context.cwd, statuses: ["active", "paused"], limit: 5 });
    if (existing.length > 0) {
      return {
        ok: false,
        text: [
          "当前工作区已有未完成 Goal，不能静默覆盖。",
          ...existing.map((goal, index) => `${index + 1}. [${goal.status}] ${goal.title} (${goal.goalId})`),
          "请先执行 `mas goal clear --goal-id <id>`，或在后续版本中选择创建并行 Goal。",
        ].join("\n"),
        data: existing,
      };
    }
    const goal = this.store.createGoal({
      sessionId: context.sessionId,
      cwd: context.cwd,
      title: summarizeTitle(objective),
      objective,
      requestedApprovalMode: context.approvalMode,
      orchestrationMode: context.orchestrationMode,
      maxTurns: context.maxTurns ?? 20,
      acceptanceContract: buildGoalAcceptanceContract(objective, context.cwd),
      payload: { createdBy: "goal_command_router" },
    });
    const nodeId = this.store.addExperienceNode({
      nodeId: goal.goalId,
      type: "goal",
      status: goal.status,
      title: goal.title,
      summary: goal.objective,
      payload: { goal },
    });
    const jobId = this.controller.scheduleContinuation(goal, goal.nextWakeAt ?? new Date().toISOString(), "goal_created");
    this.auditGoal(goal, "goal_created", { nodeId });
    this.auditGoal(goal, "goal_continuation_scheduled", { jobId });
    return { ok: true, text: formatGoal(goal, "已创建 Goal"), data: goal };
  }

  private goalStatus(goalId: string | undefined, context: GoalCommandContext): GoalCommandResult {
    const goal = this.resolveGoal(goalId, context);
    if (!goal) return { ok: false, text: "当前工作区没有 active / paused / blocked Goal。" };
    const subgoals = this.store.listSubgoals(goal.goalId);
    const ledgers = this.store.listEntropyLedgers({ goalId: goal.goalId, limit: 1 });
    const signals = this.store.listLowEntropySignals({ goalId: goal.goalId, limit: 5 });
    return {
      ok: true,
      text: [
        formatGoal(goal, "当前 Goal"),
        subgoals.length > 0 ? "\nSubgoal：\n" + formatSubgoals(subgoals) : "",
        ledgers[0]
          ? `\n最新证据账本：evidence=${ledgers[0].evidenceScore.toFixed(2)}, risk=${ledgers[0].riskScore.toFixed(2)}, uncertainty=${ledgers[0].uncertaintyScore.toFixed(2)}, recommendation=${ledgers[0].recommendation}`
          : "\n最新证据账本：暂无",
        signals.length > 0 ? "\n最近信号：\n" + signals.map((signal) => `- ${signal.type}: ${signal.summary}`).join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n"),
      data: { goal, subgoals, latestLedger: ledgers[0], signals },
    };
  }

  private listGoals(context: GoalCommandContext, statuses?: GoalStatus[]): GoalCommandResult {
    const goals = this.store.listGoals({ cwd: context.cwd, statuses, limit: 20 });
    if (goals.length === 0) return { ok: true, text: "没有匹配的 Goal。", data: [] };
    return {
      ok: true,
      text: goals.map((goal, index) => `${index + 1}. [${goal.status}] ${goal.title} (${goal.goalId}) turns=${goal.turnsUsed}/${goal.maxTurns}`).join("\n"),
      data: goals,
    };
  }

  private transitionGoal(goalId: string | undefined, context: GoalCommandContext, status: GoalStatus, label: string): GoalCommandResult {
    const goal = this.resolveGoal(goalId, context);
    if (!goal) return { ok: false, text: `没有可${label}的 Goal。` };
    const updated = this.store.updateGoal({ goalId: goal.goalId, status, nextWakeAt: status === "active" ? new Date().toISOString() : null });
    if (!updated) return { ok: false, text: `Goal ${label}失败：${goal.goalId}` };
    if (status === "active") {
      const jobId = this.controller.scheduleContinuation(updated, updated.nextWakeAt ?? new Date().toISOString(), "goal_resumed");
      this.auditGoal(updated, "goal_continuation_scheduled", { jobId });
    }
    this.auditGoal(updated, `goal_${status}`, { previousStatus: goal.status });
    return { ok: true, text: formatGoal(updated, `已${label} Goal`), data: updated };
  }

  private addSubgoal(text: string, context: GoalCommandContext): GoalCommandResult {
    if (!text) return { ok: false, text: "用法：mas subgoal add <criterion>" };
    const goal = this.resolveGoal(undefined, context);
    if (!goal) return { ok: false, text: "当前工作区没有可追加 Subgoal 的 Goal。" };
    const subgoal = this.store.addSubgoal({
      goalId: goal.goalId,
      text,
      status: "active",
      source: "user",
      requiresUserConfirmation: false,
    });
    this.auditGoal(goal, "subgoal_added", { subgoal });
    return { ok: true, text: `已追加 Subgoal：${subgoal.text}\n${subgoal.subgoalId}`, data: subgoal };
  }

  private listSubgoals(goalId: string | undefined, context: GoalCommandContext): GoalCommandResult {
    const goal = this.resolveGoal(goalId, context);
    if (!goal) return { ok: false, text: "当前工作区没有 Goal。" };
    const subgoals = this.store.listSubgoals(goal.goalId);
    return {
      ok: true,
      text: subgoals.length > 0 ? formatSubgoals(subgoals) : "当前 Goal 没有 Subgoal。",
      data: subgoals,
    };
  }

  private transitionSubgoal(selector: string | undefined, context: GoalCommandContext, status: "active" | "rejected" | "removed", label: string): GoalCommandResult {
    const goal = this.resolveGoal(undefined, context);
    if (!goal) return { ok: false, text: "当前工作区没有 Goal。" };
    const subgoal = this.resolveSubgoal(goal.goalId, selector);
    if (!subgoal) return { ok: false, text: `没有找到要${label}的 Subgoal。` };
    const updated = this.store.updateSubgoalStatus(subgoal.subgoalId, status);
    if (!updated) return { ok: false, text: `Subgoal ${label}失败：${subgoal.subgoalId}` };
    this.auditGoal(goal, `subgoal_${status}`, { subgoalId: subgoal.subgoalId, previousStatus: subgoal.status });
    return { ok: true, text: `已${label} Subgoal：${updated.text}`, data: updated };
  }

  private clearSubgoals(goalId: string | undefined, context: GoalCommandContext): GoalCommandResult {
    const goal = this.resolveGoal(goalId, context);
    if (!goal) return { ok: false, text: "当前工作区没有 Goal。" };
    const subgoals = this.store.listSubgoals(goal.goalId);
    for (const subgoal of subgoals) this.store.updateSubgoalStatus(subgoal.subgoalId, "removed");
    this.auditGoal(goal, "subgoals_cleared", { count: subgoals.length });
    return { ok: true, text: `已清除 ${subgoals.length} 个 Subgoal。`, data: { count: subgoals.length } };
  }

  private resolveGoal(goalId: string | undefined, context: GoalCommandContext): GoalRecord | undefined {
    const explicitGoalId = goalId && !isSubcommandNoise(goalId) ? goalId : context.goalId;
    if (explicitGoalId) return this.store.getGoal(explicitGoalId);
    return this.store.listGoals({ cwd: context.cwd, statuses: ["active", "paused", "blocked"], limit: 1 })[0];
  }

  private resolveSubgoal(goalId: string, selector: string | undefined): ReturnType<MasStore["getSubgoal"]> {
    if (!selector) return undefined;
    const subgoals = this.store.listSubgoals(goalId);
    const index = Number(selector);
    if (Number.isInteger(index) && index >= 1) return subgoals[index - 1];
    return subgoals.find((subgoal) => subgoal.subgoalId === selector);
  }

  private auditGoal(goal: GoalRecord, action: string, payload?: unknown): void {
    this.store.audit({ runId: "system", actor: "ha", action, target: goal.goalId, payload });
    this.store.addEvent({
      runId: "system",
      sessionId: goal.sessionId,
      source: "mas",
      type: `mas.${action}`,
      actor: "ha",
      payload: { goalId: goal.goalId, status: goal.status, ...asRecord(payload) },
    });
  }
}

function normalizeGoalSubcommand(value: string | undefined): string {
  if (!value) return "status";
  if (["set", "status", "pause", "resume", "clear", "list"].includes(value)) return value;
  return "set";
}

function normalizeSubgoalSubcommand(value: string | undefined): string {
  if (!value) return "list";
  if (["add", "list", "confirm", "reject", "remove", "clear"].includes(value)) return value;
  return "add";
}

function buildGoalAcceptanceContract(objective: string, cwd: string): GoalAcceptanceContract {
  return {
    objective,
    readonlyInputs: [],
    allowedOutputs: [cwd],
    forbiddenStates: ["不得继承过期审批", "不得把模型自报当作完成证据", "不得静默替换 Goal"],
    doneCriteria: [objective],
    failureCriteria: ["预算耗尽", "连续失败超过阈值", "权限或审计门禁阻塞"],
    requiredEvidence: ["Ego 验证结果", "AuditPacket 或低熵信号", "必要时的用户反馈"],
    validators: [],
    riskNotes: ["第一阶段保存结构化合同骨架；缺少 validators 时 GoalJudge 不能仅凭自报判定 done。"],
    rawText: `Goal objective: ${objective}\nWorkspace: ${cwd}`,
  };
}

function formatGoal(goal: GoalRecord, prefix: string): string {
  return [
    `${prefix}: ${goal.title}`,
    `id: ${goal.goalId}`,
    `status: ${goal.status}`,
    `cwd: ${goal.cwd}`,
    `turns: ${goal.turnsUsed}/${goal.maxTurns}`,
    `approval: ${goal.requestedApprovalMode}`,
    `orchestration: ${goal.orchestrationMode}`,
    `objective: ${goal.objective}`,
    goal.nextWakeAt ? `nextWakeAt: ${goal.nextWakeAt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatSubgoals(subgoals: Array<{ subgoalId: string; status: string; text: string }>): string {
  return subgoals.map((subgoal, index) => `${index + 1}. [${subgoal.status}] ${subgoal.text} (${subgoal.subgoalId})`).join("\n");
}

function summarizeTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80) || "未命名 Goal";
}

function parseStatusList(value: string | undefined): GoalStatus[] | undefined {
  if (!value) return undefined;
  const statuses = value.split(",").filter((item): item is GoalStatus =>
    ["active", "paused", "done", "blocked", "expired", "cleared"].includes(item),
  );
  return statuses.length > 0 ? statuses : undefined;
}

function isSubcommandNoise(value: string): boolean {
  return value.startsWith("--") || value.trim() === "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
