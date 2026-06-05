import type { EntropyLedger, GoalJudgeResult, GoalRecord, GoalSubgoal } from "../types.js";

export interface GoalJudgeInput {
  goal: GoalRecord;
  subgoals: GoalSubgoal[];
  latestLedger?: EntropyLedger;
  permissionContextChanged?: boolean;
  now?: string;
}

export function judgeGoal(input: GoalJudgeInput): GoalJudgeResult {
  const now = input.now ?? new Date().toISOString();
  const deterministicGates: string[] = [];
  if (input.goal.expiresAt && input.goal.expiresAt <= now) deterministicGates.push("goal_expired");
  if (input.goal.turnsUsed >= input.goal.maxTurns) deterministicGates.push("turn_budget_exhausted");
  if (input.goal.consecutiveFailures >= input.goal.maxConsecutiveFailures) deterministicGates.push("consecutive_failure_budget_exhausted");
  if (input.permissionContextChanged) deterministicGates.push("permission_context_changed");
  for (const gate of input.latestLedger?.deterministicGates ?? []) deterministicGates.push(gate);

  const activeSubgoals = input.subgoals.filter((subgoal) => subgoal.status === "active");
  const satisfiedCriteria = activeSubgoals.filter((subgoal) => isSatisfied(subgoal, input.latestLedger)).map((subgoal) => subgoal.text);
  const unsatisfiedCriteria = activeSubgoals.filter((subgoal) => !satisfiedCriteria.includes(subgoal.text)).map((subgoal) => subgoal.text);
  const quality = input.latestLedger?.evidenceQuality ?? 0;
  const recommendation = input.latestLedger?.recommendation;

  if (deterministicGates.includes("goal_expired")) {
    return result("expire", "Goal 已超过 expiresAt。", satisfiedCriteria, unsatisfiedCriteria, 0.95, deterministicGates);
  }
  if (deterministicGates.includes("consecutive_failure_budget_exhausted")) {
    return result("blocked", "连续失败次数超过预算，停止自动续跑。", satisfiedCriteria, unsatisfiedCriteria, 0.9, deterministicGates);
  }
  if (deterministicGates.includes("turn_budget_exhausted")) {
    return result("pause", "Goal turn 预算已耗尽，等待用户补充预算或调整目标。", satisfiedCriteria, unsatisfiedCriteria, 0.85, deterministicGates);
  }
  if (deterministicGates.includes("permission_context_changed")) {
    return result("pause", "权限上下文发生变化，不能继承旧审批自动续跑。", satisfiedCriteria, unsatisfiedCriteria, 0.85, deterministicGates);
  }
  if (deterministicGates.some((gate) => gate === "validator_failed" || gate === "superego_blocking_issues")) {
    return result("blocked", "存在确定性验证或审计阻塞门禁。", satisfiedCriteria, unsatisfiedCriteria, 0.85, deterministicGates);
  }
  if (!input.latestLedger) {
    return result("pause", "缺少 EntropyLedger，不能判断 Goal 完成。", satisfiedCriteria, unsatisfiedCriteria, 0.65, ["missing_entropy_ledger", ...deterministicGates]);
  }
  if (quality < 0.55) {
    return {
      ...result("pause", "证据质量不足，等待新的低熵信号。", satisfiedCriteria, unsatisfiedCriteria, 0.7, deterministicGates),
      requiredNextSignal: input.latestLedger.nextBestObservation ?? "补充验证、审计或用户反馈信号。",
    };
  }
  if (unsatisfiedCriteria.length === 0 && activeSubgoals.length > 0 && recommendation === "continue" && quality >= 0.75) {
    return result("done", "所有 active Subgoal 均有证据支持，且证据质量足够。", satisfiedCriteria, unsatisfiedCriteria, quality, deterministicGates);
  }
  return {
    ...result("continue", "Goal 仍可继续推进，但当前证据不足以完成。", satisfiedCriteria, unsatisfiedCriteria, Math.max(0.55, quality), deterministicGates),
    requiredNextSignal: input.latestLedger.nextBestObservation,
  };
}

function isSatisfied(subgoal: GoalSubgoal, ledger?: EntropyLedger): boolean {
  if (!ledger) return false;
  const target = subgoal.text.toLowerCase();
  const evidenceText = JSON.stringify(ledger).toLowerCase();
  return ledger.evidenceQuality >= 0.7 && evidenceText.includes(target.slice(0, Math.min(12, target.length)));
}

function result(
  decision: GoalJudgeResult["decision"],
  reason: string,
  satisfiedCriteria: string[],
  unsatisfiedCriteria: string[],
  confidence: number,
  deterministicGates: string[],
): GoalJudgeResult {
  return {
    decision,
    reason,
    satisfiedCriteria,
    unsatisfiedCriteria,
    confidence,
    deterministicGates: Array.from(new Set(deterministicGates)),
  };
}
