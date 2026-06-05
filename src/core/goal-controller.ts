import { MasStore } from "../storage.js";
import type { AutonomyJob, GoalJudgeResult, GoalRecord, GoalStatus } from "../types.js";
import { judgeGoal } from "./goal-judge.js";

export interface GoalContinuationResult {
  goalId: string;
  goalRunId?: string;
  decision: GoalJudgeResult["decision"] | "missing_goal";
  status?: GoalStatus;
  reason: string;
}

export class GoalController {
  constructor(
    private readonly store = new MasStore(),
    private readonly ownerId = `goal-controller-${process.pid}`,
  ) {}

  scheduleContinuation(goal: GoalRecord, triggerAt = goal.nextWakeAt ?? new Date().toISOString(), reason = "goal_control_update"): string {
    return this.store.addAutonomyJob({
      jobId: `goal-continuation:${goal.goalId}`,
      type: "goal_continuation",
      goalId: goal.goalId,
      triggerAt,
      budget: {
        depth: goal.turnsUsed,
        maxDepth: goal.maxTurns,
        wakeups: goal.turnsUsed,
        maxWakeups: goal.maxTurns,
        maxChildren: 1,
        allowNested: false,
      },
      payload: {
        reason,
        cwd: goal.cwd,
        objective: goal.objective,
        requestedApprovalMode: goal.requestedApprovalMode,
        orchestrationMode: goal.orchestrationMode,
      },
    });
  }

  processContinuation(job: AutonomyJob): GoalContinuationResult {
    if (!job.goalId) {
      this.store.updateAutonomyJob(job.jobId, { status: "blocked", payload: { reason: "missing_goal_id" }, incrementWakeups: true });
      return { goalId: "", decision: "missing_goal", reason: "goal_continuation job 缺少 goalId。" };
    }
    const goal = this.store.getGoal(job.goalId);
    if (!goal) {
      this.store.updateAutonomyJob(job.jobId, { status: "blocked", payload: { reason: "goal_not_found", goalId: job.goalId }, incrementWakeups: true });
      return { goalId: job.goalId, decision: "missing_goal", reason: "Goal 不存在。" };
    }
    if (goal.status !== "active") {
      this.store.updateAutonomyJob(job.jobId, { status: "cancelled", payload: { reason: `goal_status_${goal.status}` }, incrementWakeups: true });
      return { goalId: goal.goalId, decision: "pause", status: goal.status, reason: `Goal 当前状态为 ${goal.status}，不执行续跑。` };
    }

    const startedAt = new Date().toISOString();
    const goalRunId = this.store.addGoalRun({
      goalId: goal.goalId,
      ownerId: this.ownerId,
      status: "running",
      trigger: "scheduler",
      startedAt,
      payload: { jobId: job.jobId },
    });
    const subgoals = this.store.listSubgoals(goal.goalId);
    const latestLedger = this.store.listEntropyLedgers({ goalId: goal.goalId, limit: 1 })[0];
    const judge = judgeGoal({ goal, subgoals, latestLedger });
    const endedAt = new Date().toISOString();
    const next = mapJudgeToGoal(goal, judge);
    this.store.updateGoalRun(goalRunId, {
      status: judge.decision === "blocked" ? "failed" : "completed",
      endedAt,
      judgeResult: judge,
      payload: { jobId: job.jobId, mode: "control_plane_only" },
    });
    const updated = this.store.updateGoal({
      goalId: goal.goalId,
      status: next.status,
      lastGoalRunId: goalRunId,
      nextWakeAt: next.nextWakeAt,
      consecutiveFailures: judge.decision === "blocked" ? goal.consecutiveFailures + 1 : goal.consecutiveFailures,
      payload: { ...asRecord(goal.payload), latestJudge: judge },
    });
    this.store.updateAutonomyJob(job.jobId, {
      status: judge.decision === "continue" ? "scheduled" : judge.decision === "blocked" ? "blocked" : "completed",
      triggerAt: judge.decision === "continue" ? next.nextWakeAt ?? undefined : undefined,
      incrementWakeups: true,
      payload: { ...asRecord(job.payload), goalRunId, judge },
    });
    this.store.audit({
      runId: "system",
      actor: "superego",
      action: "goal_judged",
      target: goal.goalId,
      payload: { goalRunId, judge, nextStatus: updated?.status },
    });
    this.store.addEvent({
      runId: "system",
      sessionId: goal.sessionId,
      source: "mas",
      type: "mas.goal_judged",
      actor: "superego",
      payload: { goalId: goal.goalId, goalRunId, judge, nextStatus: updated?.status },
    });
    return {
      goalId: goal.goalId,
      goalRunId,
      decision: judge.decision,
      status: updated?.status,
      reason: judge.reason,
    };
  }
}

function mapJudgeToGoal(goal: GoalRecord, judge: GoalJudgeResult): { status: GoalStatus; nextWakeAt: string | null } {
  if (judge.decision === "done") return { status: "done", nextWakeAt: null };
  if (judge.decision === "pause") return { status: "paused", nextWakeAt: null };
  if (judge.decision === "blocked") return { status: "blocked", nextWakeAt: null };
  if (judge.decision === "expire") return { status: "expired", nextWakeAt: null };
  return { status: "active", nextWakeAt: new Date(Date.now() + backoffMs(goal.turnsUsed)).toISOString() };
}

function backoffMs(turnsUsed: number): number {
  return Math.min(60 * 60 * 1000, Math.max(60_000, (turnsUsed + 1) * 5 * 60_000));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
