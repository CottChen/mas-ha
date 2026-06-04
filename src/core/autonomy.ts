import { MasStore } from "../storage.js";
import type { CritiqueResult, EgoResult, ReflectionTask } from "../types.js";
import { recordRunEntropy } from "./entropy.js";

type RunExperienceInput = {
  runId: string;
  sessionId?: string;
  goalId?: string;
  prompt: string;
  status: "completed" | "needs_attention" | "failed";
  result: string;
  egoResult?: EgoResult;
  critique?: CritiqueResult;
  reason?: string;
};

export class AutonomyLoop {
  constructor(
    private readonly store = new MasStore(),
    private readonly ownerId = `autonomy-${process.pid}`,
  ) {}

  recordTaskClosure(input: RunExperienceInput): void {
    const taskNodeId = this.store.addExperienceNode({
      type: "task",
      runId: input.runId,
      title: summarizeTitle(input.prompt),
      summary: input.prompt.slice(0, 1000),
      payload: { sessionId: input.sessionId, goalId: input.goalId },
    });
    const resultNodeId = this.store.addExperienceNode({
      type: "result",
      runId: input.runId,
      status: input.status,
      title: `任务结果：${input.status}`,
      summary: input.result.slice(0, 1200),
      payload: { egoResult: input.egoResult, critique: input.critique, reason: input.reason },
    });
    this.store.addExperienceEdge({ fromNodeId: taskNodeId, toNodeId: resultNodeId, type: "produced", weight: 1, confidence: 0.9 });

    const experienceNodeId = this.store.addExperienceNode({
      type: "experience",
      runId: input.runId,
      title: "任务后经验摘要",
      summary: buildExperienceSummary(input),
      payload: {
        changedFiles: input.egoResult?.changed_files ?? [],
        verification: input.egoResult?.verification ?? [],
        risks: input.egoResult?.risks ?? [],
      },
    });
    this.store.addExperienceEdge({ fromNodeId: resultNodeId, toNodeId: experienceNodeId, type: "generalized_to", weight: 0.7, confidence: 0.7 });

    const ledger = recordRunEntropy(this.store, input);
    const signals = this.store
      .listLowEntropySignals({ runId: input.runId, limit: 100 })
      .filter((signal) => ledger.signalIds.includes(signal.signalId));
    for (const signal of signals) {
      const signalNodeId = this.store.addExperienceNode({
        nodeId: signal.signalId,
        type: "signal",
        runId: input.runId,
        status: signal.type,
        title: `低熵信号：${signal.type}`,
        summary: signal.summary,
        payload: { signal, ledgerId: ledger.ledgerId },
      });
      this.store.addExperienceEdge({ fromNodeId: experienceNodeId, toNodeId: signalNodeId, type: "observed", weight: 0.8, confidence: signal.confidence });
    }
    this.store.audit({
      runId: input.runId,
      actor: "superego",
      action: "entropy_ledger_recorded",
      payload: { ledgerId: ledger.ledgerId, signalIds: ledger.signalIds, recommendation: ledger.recommendation },
    });

    const reflection = planReflection(input);
    const reflectionId = this.store.addReflectionTask({
      sourceRunId: input.runId,
      sourceNodeId: experienceNodeId,
      purpose: reflection.purpose,
      triggerAt: reflection.triggerAt,
      maxDepth: reflection.maxDepth,
      maxChildren: 1,
      maxWakeups: reflection.maxWakeups,
      allowNested: true,
      payload: {
        entropyReason: reflection.entropyReason,
        expectedSignal: reflection.expectedSignal,
        noNewSignalAction: "cancel",
        createdBy: "superego",
      },
    });
    this.store.addAutonomyJob({
      jobId: reflectionId,
      type: "reflection",
      sourceRunId: input.runId,
      goalId: input.goalId,
      triggerAt: reflection.triggerAt,
      budget: {
        depth: 0,
        maxDepth: reflection.maxDepth,
        maxChildren: 1,
        wakeups: 0,
        maxWakeups: reflection.maxWakeups,
        allowNested: true,
      },
      payload: {
        reflectionTaskCompat: true,
        entropyReason: reflection.entropyReason,
        expectedSignal: reflection.expectedSignal,
      },
    });
    const reflectionNodeId = this.store.addExperienceNode({
      nodeId: reflectionId,
      type: "reflection",
      runId: input.runId,
      status: "scheduled",
      title: "未来反思意图",
      summary: reflection.purpose,
      payload: reflection,
    });
    this.store.addExperienceEdge({ fromNodeId: experienceNodeId, toNodeId: reflectionNodeId, type: "scheduled", weight: 0.8, confidence: 0.8 });
    this.store.audit({
      runId: input.runId,
      actor: "superego",
      action: "reflection_scheduled",
      payload: { reflectionId, triggerAt: reflection.triggerAt, purpose: reflection.purpose },
    });
  }

  runDueReflections(limit = 20): { processed: number; completed: ReflectionTask[]; cancelled: ReflectionTask[] } {
    const due = this.store.claimDueReflectionTasks({ ownerId: this.ownerId, limit });
    const completed: ReflectionTask[] = [];
    const cancelled: ReflectionTask[] = [];
    for (const task of due) {
      const decision = reflect(task);
      this.store.updateReflectionTask(task.reflectionId, {
        status: decision.status,
        incrementWakeups: true,
        payload: { ...asRecord(task.payload), reflectionDecision: decision },
      });
      if (decision.status === "completed") completed.push(task);
      if (decision.status === "cancelled") cancelled.push(task);
      this.store.addExperienceNode({
        nodeId: `${task.reflectionId}:run:${task.wakeups + 1}`,
        type: "reflection",
        runId: task.sourceRunId,
        status: decision.status,
        title: "到期反思",
        summary: decision.summary,
        payload: { task, decision },
      });
      this.store.audit({
        runId: task.sourceRunId,
        actor: "superego",
        action: "reflection_completed",
        payload: { reflectionId: task.reflectionId, decision },
      });
    }
    return { processed: due.length, completed, cancelled };
  }

  dreamPrune(limit = 20): { pruned: number } {
    return { pruned: this.store.dreamPruneReflectionTasks(limit) };
  }
}

function planReflection(input: RunExperienceInput): { purpose: string; triggerAt: string; entropyReason: string; expectedSignal: string; maxDepth: number; maxWakeups: number } {
  const hasFailure = input.status !== "completed" || input.critique?.next_action === "escalate";
  const hasRisk = (input.egoResult?.risks.length ?? 0) > 0 || input.egoResult?.verification.some((item) => item.result !== "passed");
  const delayHours = hasFailure ? 12 : hasRisk ? 24 : 24 * 7;
  return {
    purpose: hasFailure
      ? "复盘未完成或需要人工介入的任务，判断是否已有新信息可以降低失败不确定性。"
      : hasRisk
      ? "复盘带风险或验证不足的任务，判断经验是否应固化或取消后续关注。"
      : "低频复盘已完成任务，抽取可复用经验并取消无价值后续反思。",
    triggerAt: new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString(),
    entropyReason: hasFailure ? "任务未稳定完成" : hasRisk ? "存在风险或验证不足" : "可能存在可泛化经验",
    expectedSignal: "用户反馈、后续相似任务、验证结果或新的项目约束。",
    maxDepth: hasFailure ? 2 : 1,
    maxWakeups: hasFailure ? 2 : 1,
  };
}

function reflect(task: ReflectionTask): { status: "completed" | "cancelled"; summary: string } {
  if (task.wakeups + 1 >= task.maxWakeups) {
    return { status: "completed", summary: "已达到反思唤醒预算，本轮抽取经验后关闭后续反思。" };
  }
  return { status: "cancelled", summary: "最小闭环当前没有检测到新的外部信号，按 noNewSignalAction 取消本次反思链。" };
}

function buildExperienceSummary(input: RunExperienceInput): string {
  const parts = [`状态：${input.status}`];
  if (input.egoResult?.summary) parts.push(`Ego：${input.egoResult.summary}`);
  if (input.critique?.summary) parts.push(`Superego：${input.critique.summary}`);
  if (input.reason) parts.push(`原因：${input.reason}`);
  return parts.join("\n");
}

function summarizeTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80) || "未命名任务";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
