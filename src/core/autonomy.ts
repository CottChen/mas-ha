import { MasStore } from "../storage.js";
import type { AutonomyJob, CritiqueResult, DreamGraphPatch, EgoResult, EvalCandidate, ReflectionIntent, ReflectionTask } from "../types.js";
import { recordRunEntropy } from "./entropy.js";
import { GoalController } from "./goal-controller.js";

const MAX_ACTIVE_REFLECTION_TASKS = 200;

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

type RunDueAutonomyJobsInput = {
  limit?: number;
  runId?: string;
  jobId?: string;
};

export class AutonomyLoop {
  constructor(
    private readonly store = new MasStore(),
    private readonly ownerId = `autonomy-${process.pid}`,
    private readonly goalController = new GoalController(store, ownerId),
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

    const traceNodeId = this.store.addExperienceNode({
      nodeId: `trace:${input.runId}`,
      type: "execution_trace",
      runId: input.runId,
      status: input.status,
      title: "执行轨迹",
      summary: buildTraceSummary(this.store, input.runId, input.egoResult),
      payload: {
        events: this.store.listEvents(input.runId, 500),
        agentRuns: this.store.listAgentRuns(input.runId),
        verification: input.egoResult?.verification ?? [],
      },
    });
    this.store.addExperienceEdge({ fromNodeId: taskNodeId, toNodeId: traceNodeId, type: "caused", weight: 0.8, confidence: 0.8 });
    this.store.addExperienceEdge({ fromNodeId: traceNodeId, toNodeId: resultNodeId, type: "produced", weight: 0.8, confidence: 0.8 });

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
    const candidate = maybeCreateEvalCandidate(this.store, input);
    if (candidate) {
      const candidateNodeId = this.store.addExperienceNode({
        nodeId: candidate.candidateId,
        type: "eval_candidate",
        runId: input.runId,
        status: candidate.status,
        title: candidate.title,
        summary: candidate.failureMode,
        payload: candidate,
      });
      this.store.addExperienceEdge({ fromNodeId: experienceNodeId, toNodeId: candidateNodeId, type: "derived_candidate", weight: 0.75, confidence: candidate.confidence });
    }
    this.store.audit({
      runId: input.runId,
      actor: "superego",
      action: "entropy_ledger_recorded",
      payload: { ledgerId: ledger.ledgerId, signalIds: ledger.signalIds, recommendation: ledger.recommendation },
    });

    const reflection = input.critique?.reflectionIntent ?? planReflection(input);
    const activeReflections = this.store.listReflectionTasks("scheduled", MAX_ACTIVE_REFLECTION_TASKS + 1).length;
    let scheduledReflectionId: string | undefined;
    if (activeReflections < MAX_ACTIVE_REFLECTION_TASKS) {
      const reflectionId = this.store.addReflectionTask({
        reflectionId: `reflection:${input.runId}`,
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
          noNewSignalAction: reflection.noNewSignalAction,
          informationGainScore: reflection.informationGainScore,
          expiresAt: reflection.expiresAt,
          createdBy: "superego",
        },
      });
      scheduledReflectionId = reflectionId;
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
          informationGainScore: reflection.informationGainScore,
          expiresAt: reflection.expiresAt,
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
    }
    this.store.addAutonomyJob({
      jobId: `consolidation:${input.runId}`,
      type: "consolidation",
      sourceRunId: input.runId,
      goalId: input.goalId,
      triggerAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      budget: { maxWakeups: 1, allowNested: false },
      payload: { sourceExperienceNodeId: experienceNodeId, signalIds: ledger.signalIds, evidenceQuality: ledger.evidenceQuality },
    });
    const graphIsComplex = this.store.listExperienceNodes({ limit: 501 }).length >= 500;
    if (ledger.informationGainScore < 0.2 || input.status !== "completed" || graphIsComplex) {
      this.store.addAutonomyJob({
        jobId: `dream:${input.runId}`,
        type: "dream",
        sourceRunId: input.runId,
        goalId: input.goalId,
        triggerAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        budget: { maxWakeups: 1, allowNested: false },
        payload: { sourceExperienceNodeId: experienceNodeId, reason: graphIsComplex ? "graph_complexity_threshold" : "low_information_gain_or_failure" },
      });
    }
    this.store.audit({
      runId: input.runId,
      actor: "superego",
      action: scheduledReflectionId ? "reflection_scheduled" : "reflection_budget_exhausted",
      payload: { reflectionId: scheduledReflectionId, triggerAt: reflection.triggerAt, purpose: reflection.purpose, activeReflections },
    });
  }

  runDueReflections(limit = 20): { processed: number; completed: ReflectionTask[]; cancelled: ReflectionTask[] } {
    const due = this.store.claimDueReflectionTasks({ ownerId: this.ownerId, limit });
    const completed: ReflectionTask[] = [];
    const cancelled: ReflectionTask[] = [];
    for (const task of due) {
      const neighborhood = this.store.listExperienceNodes({ runId: task.sourceRunId, limit: 20 });
      const decision = reflect(task, neighborhood);
      this.store.updateReflectionTask(task.reflectionId, {
        status: reflectionDecisionStatus(decision.decision),
        incrementWakeups: true,
        payload: { ...asRecord(task.payload), sourceRunNeighborhood: neighborhood, reflectionDecision: decision },
      });
      this.store.updateExperienceNode(task.reflectionId, {
        status: reflectionDecisionStatus(decision.decision),
        payload: { ...asRecord(task.payload), sourceRunNeighborhood: neighborhood, reflectionDecision: decision },
      });
      const finalTask = this.store.getReflectionTask(task.reflectionId) ?? task;
      if (finalTask.status === "completed") completed.push(finalTask);
      if (finalTask.status === "cancelled") cancelled.push(finalTask);
      this.store.addExperienceNode({
        nodeId: `${task.reflectionId}:run:${task.wakeups + 1}`,
        type: "reflection",
        runId: task.sourceRunId,
        status: reflectionDecisionStatus(decision.decision),
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

  runDueAutonomyJobs(input: number | RunDueAutonomyJobsInput = 20): {
    processed: number;
    completed: AutonomyJob[];
    cancelled: AutonomyJob[];
    blocked: AutonomyJob[];
    goalContinuations: ReturnType<GoalController["processContinuation"]>[];
  } {
    const options = typeof input === "number" ? { limit: input } : input;
    const due = this.store.claimDueAutonomyJobs({
      ownerId: this.ownerId,
      limit: options.limit,
      sourceRunId: options.runId,
      jobId: options.jobId,
    });
    const completed: AutonomyJob[] = [];
    const cancelled: AutonomyJob[] = [];
    const blocked: AutonomyJob[] = [];
    const goalContinuations: ReturnType<GoalController["processContinuation"]>[] = [];
    for (const job of due) {
      if (job.type === "reflection") {
        const neighborhood = job.sourceRunId ? this.store.listExperienceNodes({ runId: job.sourceRunId, limit: 20 }) : [];
        const decision = reflectJob(job, neighborhood);
        this.store.updateAutonomyJob(job.jobId, {
          status: reflectionDecisionStatus(decision.decision),
          incrementWakeups: true,
          payload: { ...asRecord(job.payload), sourceRunNeighborhood: neighborhood, reflectionDecision: decision },
        });
        if (asRecord(job.payload).reflectionTaskCompat) {
          this.store.updateReflectionTask(job.jobId, {
            status: reflectionDecisionStatus(decision.decision),
            incrementWakeups: true,
            payload: { ...asRecord(job.payload), sourceRunNeighborhood: neighborhood, reflectionDecision: decision },
          });
        }
        this.store.updateExperienceNode(job.jobId, {
          status: reflectionDecisionStatus(decision.decision),
          payload: { ...asRecord(job.payload), sourceRunNeighborhood: neighborhood, reflectionDecision: decision },
        });
        pushFinalJob(this.store, job, { completed, cancelled, blocked });
        this.store.audit({
          runId: job.sourceRunId ?? "system",
          actor: "superego",
          action: "autonomy_job_reflection_completed",
          target: job.jobId,
          payload: { decision },
        });
        continue;
      }
      if (job.type === "dream" || job.type === "prune") {
        const patch = createDreamPatch(job);
        const patchNodeId = this.store.addExperienceNode({
          nodeId: patch.patchId,
          type: "dream",
          runId: job.sourceRunId,
          status: "candidate",
          title: "Dream 图补丁候选",
          summary: patch.summary,
          payload: patch,
        });
        const pruned = this.store.dreamPruneReflectionTasks(20);
        const decayedEdges = this.store.decayExperienceEdges({ factor: 0.97, limit: 100 });
        const prunedNodes = this.store.pruneLowValueExperienceNodes({ limit: 50 });
        const loopCount = Number(asRecord(job.payload).loopCount ?? 0) + 1;
        this.store.updateAutonomyJob(job.jobId, {
          status: "completed",
          incrementWakeups: true,
          payload: { ...asRecord(job.payload), pruned, prunedNodes, decayedEdges, patchNodeId, loopCount },
        });
        this.store.audit({
          runId: job.sourceRunId ?? "system",
          actor: "superego",
          action: "dream_graph_patch_created",
          target: job.jobId,
          payload: { patch, patchNodeId, pruned, prunedNodes, decayedEdges, loopCount },
        });
        pushFinalJob(this.store, job, { completed, cancelled, blocked });
        continue;
      }
      if (job.type === "consolidation") {
        this.store.updateAutonomyJob(job.jobId, {
          status: "completed",
          incrementWakeups: true,
          payload: { ...asRecord(job.payload), mode: "candidate_only" },
        });
        pushFinalJob(this.store, job, { completed, cancelled, blocked });
        continue;
      }
      if (job.type === "goal_continuation") {
        const result = this.goalController.processContinuation(job);
        goalContinuations.push(result);
        pushFinalJob(this.store, job, { completed, cancelled, blocked });
      }
    }
    return { processed: due.length, completed, cancelled, blocked, goalContinuations };
  }

  dreamPrune(limit = 20): { pruned: number } {
    return { pruned: this.store.dreamPruneReflectionTasks(limit) };
  }
}

function buildTraceSummary(store: MasStore, runId: string, egoResult?: EgoResult): string {
  const events = store.listEvents(runId, 500);
  const agentRuns = store.listAgentRuns(runId);
  const verification = egoResult?.verification ?? [];
  return [
    `事件数：${events.length}`,
    `角色运行数：${agentRuns.length}`,
    verification.length > 0 ? `验证：${verification.map((item) => `${item.result}:${item.command || "未声明命令"}`).join("；")}` : "验证：无",
  ].join("\n");
}

function maybeCreateEvalCandidate(store: MasStore, input: RunExperienceInput): EvalCandidate | undefined {
  const failedVerification = input.egoResult?.verification.find((item) => item.result === "failed");
  const hasBlocking = (input.critique?.blocking_issues ?? 0) > 0;
  const shouldCreate = input.status !== "completed" || failedVerification || hasBlocking;
  if (!shouldCreate) return undefined;
  const candidateId = `eval:${input.runId}`;
  store.addEvalCandidate({
    candidateId,
    sourceRunId: input.runId,
    goalId: input.goalId,
    title: summarizeTitle(input.prompt),
    failureMode: failedVerification?.notes ?? input.critique?.summary ?? input.reason ?? input.status,
    inputFixture: { prompt: input.prompt, reason: input.reason },
    expectedAssertions: buildExpectedAssertions(input),
    validatorCommand: failedVerification?.command || undefined,
    regressionScope: failedVerification?.command ? "integration" : "manual",
    confidence: failedVerification ? 0.75 : hasBlocking ? 0.7 : 0.55,
  });
  return store.listEvalCandidates({ sourceRunId: input.runId, limit: 1 })[0];
}

function pushFinalJob(
  store: MasStore,
  claimed: AutonomyJob,
  buckets: { completed: AutonomyJob[]; cancelled: AutonomyJob[]; blocked: AutonomyJob[] },
): void {
  const finalJob = store.getAutonomyJob(claimed.jobId) ?? claimed;
  if (finalJob.status === "completed") buckets.completed.push(finalJob);
  else if (finalJob.status === "cancelled" || finalJob.status === "pruned") buckets.cancelled.push(finalJob);
  else if (finalJob.status === "blocked") buckets.blocked.push(finalJob);
}

function createDreamPatch(job: AutonomyJob): DreamGraphPatch {
  return {
    patchId: `dream-patch:${job.jobId}`,
    operation: "abstract_pattern",
    targetNodeIds: typeof asRecord(job.payload).sourceExperienceNodeId === "string" ? [String(asRecord(job.payload).sourceExperienceNodeId)] : [],
    targetEdgeIds: [],
    summary: "Dream 发现低信息增益或失败任务，建议抽象为候选经验或扰动种子。",
    rationale: "该补丁只操作 Experience Graph，不执行外部工具，不写用户工作区，也不创建嵌套反思。",
    confidence: 0.55,
    safety: {
      graphOnly: true,
      touchesUserWorkspace: false,
      createsNestedReflection: false,
    },
    payload: {
      jobId: job.jobId,
      reason: asRecord(job.payload).reason,
      protectedNodeTypes: ["goal", "signal"],
      protectedFacts: ["user_explicit_rule", "audit_record", "safety_boundary"],
    },
  };
}

function buildExpectedAssertions(input: RunExperienceInput): string[] {
  const assertions = ["后续同类任务不得重复该失败模式。"];
  if (input.egoResult?.verification.some((item) => item.result === "failed")) assertions.push("相关 validator 必须通过后才能完成。");
  if ((input.critique?.blocking_issues ?? 0) > 0) assertions.push("Superego 阻塞项必须清零。");
  return assertions;
}

function planReflection(input: RunExperienceInput): ReflectionIntent {
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
    noNewSignalAction: "cancel",
    informationGainScore: hasFailure ? 0.75 : hasRisk ? 0.55 : 0.25,
    expiresAt: new Date(Date.now() + (hasFailure ? 14 : hasRisk ? 21 : 45) * 24 * 60 * 60 * 1000).toISOString(),
    maxDepth: hasFailure ? 2 : 1,
    maxWakeups: hasFailure ? 2 : 1,
  };
}

type ReflectionDecision = { decision: "complete" | "cancel" | "reschedule" | "abstract"; summary: string };

function reflect(task: ReflectionTask, neighborhood: unknown[]): ReflectionDecision {
  if (task.wakeups + 1 >= task.maxWakeups) {
    return { decision: "complete", summary: "已达到反思唤醒预算，本轮抽取经验后关闭后续反思。" };
  }
  if (neighborhood.length >= 8) {
    return { decision: "abstract", summary: "source run 邻域已有足够经验节点，本轮抽象为经验候选。" };
  }
  return { decision: "cancel", summary: "最小闭环当前没有检测到新的外部信号，按 noNewSignalAction 取消本次反思链。" };
}

function reflectJob(job: AutonomyJob, neighborhood: unknown[]): ReflectionDecision {
  if (job.budget.wakeups + 1 >= job.budget.maxWakeups) {
    return { decision: "complete", summary: "已达到统一 AutonomyJob 反思唤醒预算，本轮抽取经验后关闭后续反思。" };
  }
  if (neighborhood.length >= 8) {
    return { decision: "abstract", summary: "统一 AutonomyJob 发现 source run 邻域足够丰富，本轮转为经验抽象。" };
  }
  return { decision: "cancel", summary: "统一 AutonomyJob 当前没有检测到新的外部信号，取消本次反思链。" };
}

function reflectionDecisionStatus(decision: ReflectionDecision["decision"]): "completed" | "cancelled" {
  return decision === "complete" || decision === "abstract" ? "completed" : "cancelled";
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
