import { randomUUID } from "node:crypto";
import { MasStore } from "../storage.js";
import type { ApprovalMode, BoundarySnapshot, ConversationTurn, CritiqueResult, EgoResult, HaDecision, MasRunOptions, StreamSink } from "../types.js";
import { createPiSession } from "../pi/pi-sdk.js";
import { buildAuditPacket, createBoundarySnapshot, enforceAuditGate } from "./audit.js";
import { AutonomyLoop } from "./autonomy.js";
import { ContextPerturbationController } from "./context-perturbation.js";
import { renderMemoryArtifacts, retrieveMemoryArtifacts } from "./memory.js";
import { ORCHESTRATION_MODES } from "./orchestration.js";
import {
  buildAcceptanceContract,
  buildEgoPrompt,
  buildEgoRepairPrompt,
  buildHaDecisionPrompt,
  buildHaDecisionRepairPrompt,
  buildSuperegoPrompt,
  buildSuperegoRepairPrompt,
  parseCritique,
  parseEgoResult,
  parseHaDecision,
} from "./prompts.js";

export class MasRunner {
  constructor(
    private readonly store = new MasStore(),
    private readonly autonomy = new AutonomyLoop(store),
    private readonly perturbations = new ContextPerturbationController(store),
  ) {}

  async run(prompt: string, options: MasRunOptions, sink: StreamSink, sessionId?: string): Promise<{ runId: string; result: string }> {
    const runId = randomUUID();
    const mode = ORCHESTRATION_MODES[options.orchestrationMode];
    const memoryContext = renderMemoryArtifacts(retrieveMemoryArtifacts(this.store, { query: prompt, limit: 5 }));
    const task = buildTaskWithConversation(prompt, options.conversationHistory, options.conversationSummary, options.availableSkills, memoryContext);
    this.store.createRun({ runId, sessionId, cwd: options.cwd, prompt });
    this.store.addEvent({
      runId,
      sessionId,
      source: "mas",
      type: "mas.run.started",
      actor: "ha",
      payload: {
        cwd: options.cwd,
        orchestrationMode: mode.id,
        approvalMode: options.approvalMode,
      },
    });
    this.store.audit({
      runId,
      actor: "ha",
      action: "run_started",
      payload: {
        cwd: options.cwd,
        approvalMode: options.approvalMode,
        orchestrationMode: mode.id,
        historyTurns: options.conversationHistory?.length ?? 0,
        hasConversationSummary: Boolean(options.conversationSummary?.trim()),
        skills: options.availableSkills?.map((skill) => skill.name) ?? [],
      },
    });

    let critique: CritiqueResult | undefined;
    let finalEgoOutput = "";
    let egoResult: EgoResult | undefined;

    try {
      const haDecision = await this.decideWithHa(task, prompt, options, sink, runId, sessionId, mode);
      if (haDecision.next_action === "answer" || haDecision.next_action === "clarify") {
        const result = haDecision.response;
        this.store.updateRun(runId, "completed", { result, orchestrationMode: mode.id, haDecision });
        this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "completed", result, reason: haDecision.next_action });
        this.store.addEvent({
          runId,
          sessionId,
          source: "mas",
          type: "mas.run.completed",
          actor: "ha",
          payload: { resultKind: haDecision.next_action, orchestrationMode: mode.id },
        });
        sink.done(result);
        return { runId, result };
      }

      const contract = haDecision.acceptance_contract.trim() || buildAcceptanceContract(task);
      sink.thought(`HA 已创建验收合同。编排模式：${mode.name}。\n${contract}\n`);
      const boundarySnapshot: BoundarySnapshot = createBoundarySnapshot({ cwd: options.cwd, task, contract });
      this.store.audit({ runId, actor: "system", action: "boundary_snapshot_baseline", payload: summarizeBoundarySnapshot(boundarySnapshot) });

      for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
        throwIfAborted(options.signal);
        sink.thought(`\nEgo 第 ${iteration} 轮开始。\n`);
        const ego = await createPiSession({
          cwd: options.cwd,
          runId,
          sessionId,
          role: "ego",
          iteration,
          approvalMode: options.approvalMode,
          sink,
          recordApproval: (input) => this.store.addApproval({ runId, ...input }),
          recordEvent: (input) => this.store.addEvent(input),
        });
        const abortEgo = () => void ego.abort();
        options.signal?.addEventListener("abort", abortEgo, { once: true });
        try {
          const perturbation = this.perturbations.render(
            this.perturbations.createCandidate({
              runId,
              goalId: options.goalId,
              targetRole: "ego",
              trigger: critique ? "superego_revise" : "execution_plan",
              critique,
              sourceRefs: critique ? [`run:${runId}:critique`] : [`run:${runId}:contract`],
            }),
          );
          const rawEgoOutput = await ego.prompt(buildEgoPrompt(task, contract, critique, perturbation));
          egoResult = await this.parseEgoWithRepair(rawEgoOutput, ego, prompt, task, critique, runId, iteration);
          finalEgoOutput = egoResult.final_response;
          this.store.addAgentRun({
            runId,
            role: "ego",
            iteration,
            status: "completed",
            input: { prompt, task, critique },
            output: { text: rawEgoOutput, result: egoResult, messages: ego.messages() },
          });
          this.store.addEvent({
            runId,
            sessionId,
            role: "ego",
            iteration,
            source: "mas",
            type: "mas.ego.iteration.completed",
            actor: "ego",
            payload: { outputChars: finalEgoOutput.length },
          });
        } finally {
          options.signal?.removeEventListener("abort", abortEgo);
          ego.dispose();
        }

        if (egoResult.status === "blocked" || egoResult.status === "needs_attention") {
          const result = `HA 终验未通过：Ego 未能完成执行。\n\n${egoResult.final_response}`;
          this.store.updateRun(runId, "needs_attention", { result, egoResult, orchestrationMode: mode.id });
          this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "needs_attention", result, egoResult, reason: egoResult.status });
          sink.done(result);
          return { runId, result };
        }

        if (!mode.usesSuperego) {
          const result = `HA 终验通过（${mode.name} 模式，未启用 Superego 评审）。\n\n${finalEgoOutput}`;
          this.store.updateRun(runId, "completed", { result, egoResult, orchestrationMode: mode.id });
          this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "completed", result, egoResult, reason: "superego_disabled" });
          this.store.addEvent({
            runId,
            sessionId,
            source: "mas",
            type: "mas.run.completed",
            actor: "ha",
            payload: { resultKind: "accepted", orchestrationMode: mode.id, usesSuperego: false, egoResult },
          });
          sink.done(result);
          return { runId, result };
        }

        throwIfAborted(options.signal);
        sink.thought(`\nSuperego 第 ${iteration} 轮评审开始。\n`);
        const superego = await createPiSession({
          cwd: options.cwd,
          runId,
          sessionId,
          role: "superego",
          iteration,
          approvalMode: "deny-writes",
          sink,
          recordApproval: (input) => this.store.addApproval({ runId, ...input }),
          recordEvent: (input) => this.store.addEvent(input),
        });
        const abortSuperego = () => void superego.abort();
        options.signal?.addEventListener("abort", abortSuperego, { once: true });
        let reviewText = "";
        try {
          const auditPacket = buildAuditPacket(this.store, { runId, cwd: options.cwd, egoResult, boundarySnapshot, task, contract });
          this.store.audit({ runId, actor: "superego", action: "audit_packet_built", payload: auditPacket });
          const latestLedger = options.goalId ? this.store.listEntropyLedgers({ goalId: options.goalId, limit: 1 })[0] : undefined;
          const perturbation = this.perturbations.render(
            this.perturbations.createCandidate({
              runId,
              goalId: options.goalId,
              targetRole: "superego",
              trigger: latestLedger ? "ledger_review_sampling" : "review_sampling",
              ledger: latestLedger,
              sourceRefs: [`run:${runId}:audit_packet`],
            }),
          );
          reviewText = await superego.prompt(buildSuperegoPrompt(task, contract, JSON.stringify(egoResult, null, 2), auditPacket, perturbation));
          critique = await this.parseSuperegoWithRepair(reviewText, superego, prompt, task, contract, runId, iteration);
          critique = enforceAuditGate(critique, auditPacket);
          this.store.addAgentRun({
            runId,
            role: "superego",
            iteration,
            status: "completed",
            input: { prompt, task, contract, auditPacket },
            output: { text: reviewText, critique },
          });
          this.store.addEvent({
            runId,
            sessionId,
            role: "superego",
            iteration,
            source: "mas",
            type: "mas.superego.review.completed",
            actor: "superego",
            payload: critique,
          });
        } finally {
          options.signal?.removeEventListener("abort", abortSuperego);
          superego.dispose();
        }

        sink.thought(`\nSuperego 结论：${critique.summary || critique.next_action}\n`);
        if (critique.next_action === "escalate") {
          const result = `HA 终验未通过：Superego 要求人工介入。\n\n最后批注：${JSON.stringify(critique, null, 2)}\n\n最后 Ego 输出：\n${finalEgoOutput}`;
          this.store.updateRun(runId, "needs_attention", { result, critique, egoResult });
          this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "needs_attention", result, egoResult, critique, reason: "superego_escalate" });
          sink.done(result);
          return { runId, result };
        }
        if (critique.next_action === "accept" && critique.blocking_issues === 0) {
          const result = `HA 终验通过。\n\n${finalEgoOutput}`;
          this.store.updateRun(runId, "completed", { result, critique, egoResult });
          this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "completed", result, egoResult, critique, reason: "superego_accept" });
          this.store.addEvent({
            runId,
            sessionId,
            source: "mas",
            type: "mas.run.completed",
            actor: "ha",
            payload: { resultKind: "accepted", orchestrationMode: mode.id, critique, egoResult },
          });
          sink.done(result);
          return { runId, result };
        }
      }

      const result = `HA 终验未通过：达到最大返工轮次。\n\n最后批注：${JSON.stringify(critique, null, 2)}\n\n最后 Ego 输出：\n${finalEgoOutput}`;
      this.store.updateRun(runId, "needs_attention", { result, critique, egoResult });
      this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "needs_attention", result, egoResult, critique, reason: "max_iterations" });
      this.store.addEvent({
        runId,
        sessionId,
        source: "mas",
        type: "mas.run.needs_attention",
        actor: "ha",
        payload: { reason: "max_iterations", critique, egoResult },
      });
      sink.done(result);
      return { runId, result };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.store.updateRun(runId, "failed", { message: err.message, stack: err.stack });
      if (egoResult || critique) {
        this.recordAutonomyClosure({
          runId,
          sessionId,
          goalId: options.goalId,
          prompt,
          status: "failed",
          result: err.message,
          egoResult,
          critique,
          reason: "run_failed",
        });
      }
      this.store.addEvent({
        runId,
        sessionId,
        source: "mas",
        type: "mas.run.failed",
        actor: "ha",
        payload: { message: err.message, stack: err.stack },
      });
      sink.error(err);
      throw err;
    }
  }

  private recordAutonomyClosure(input: {
    runId: string;
    sessionId?: string;
    goalId?: string;
    prompt: string;
    status: "completed" | "needs_attention" | "failed";
    result: string;
    egoResult?: EgoResult;
    critique?: CritiqueResult;
    reason?: string;
  }): void {
    try {
      this.autonomy.recordTaskClosure(input);
      if (input.goalId) {
        const goal = this.store.getGoal(input.goalId);
        if (goal) {
          this.store.updateGoal({
            goalId: input.goalId,
            lastRunId: input.runId,
            turnsUsed: goal.turnsUsed + 1,
            consecutiveFailures: input.status === "completed" ? 0 : goal.consecutiveFailures + 1,
          });
        }
      }
    } catch (error) {
      this.store.audit({
        runId: input.runId,
        actor: "superego",
        action: "autonomy_closure_failed",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async parseEgoWithRepair(
    rawOutput: string,
    ego: Awaited<ReturnType<typeof createPiSession>>,
    prompt: string,
    task: string,
    critique: CritiqueResult | undefined,
    runId: string,
    iteration: number,
  ): Promise<EgoResult> {
    try {
      return this.parseStructuredOutput("ego_result", rawOutput, ego, parseEgoResult, "Ego");
    } catch (error) {
      const firstError = error instanceof Error ? error : new Error(String(error));
      this.store.addAgentRun({
        runId,
        role: "ego",
        iteration,
        status: "failed",
        input: { prompt, task, critique, repair: false },
        output: { text: rawOutput, error: firstError.message },
      });
      this.store.audit({ runId, actor: "ego", action: "result_parse_failed", payload: { message: firstError.message } });
      ego.clearStructuredOutput("ego_result");
      const repairText = await ego.prompt(buildEgoRepairPrompt(rawOutput, firstError.message));
      try {
        return this.parseStructuredOutput("ego_result", repairText, ego, parseEgoResult, "Ego");
      } catch (repairError) {
        const err = repairError instanceof Error ? repairError : new Error(String(repairError));
        this.store.addAgentRun({
          runId,
          role: "ego",
          iteration,
          status: "failed",
          input: { prompt, task, critique, repair: true },
          output: { text: repairText, error: err.message },
        });
        this.store.audit({ runId, actor: "ego", action: "result_repair_failed", payload: { message: err.message } });
        return {
          status: "needs_attention",
          summary: `Ego 执行结果 JSON 解析失败且自修复失败：${err.message}`,
          final_response: `Ego 已返回执行内容，但 MAS 无法把它稳定解析为结构化结果。\n\n原始输出：\n${rawOutput}`,
          evidence: [],
          changed_files: [],
          verification: [{ command: "", result: "not_run", notes: "Ego 结构化输出解析失败，无法可靠提取验证结果。" }],
          risks: ["Ego 原始输出未通过结构化 schema 校验，需要人工检查执行结果。"],
        };
      }
    }
  }

  private async parseSuperegoWithRepair(
    rawOutput: string,
    superego: Awaited<ReturnType<typeof createPiSession>>,
    prompt: string,
    task: string,
    contract: string,
    runId: string,
    iteration: number,
  ): Promise<CritiqueResult> {
    try {
      return this.parseStructuredOutput("superego_review", rawOutput, superego, parseCritique, "Superego");
    } catch (error) {
      const firstError = error instanceof Error ? error : new Error(String(error));
      this.store.addAgentRun({
        runId,
        role: "superego",
        iteration,
        status: "failed",
        input: { prompt, task, contract, repair: false },
        output: { text: rawOutput, error: firstError.message },
      });
      this.store.audit({ runId, actor: "superego", action: "review_parse_failed", payload: { message: firstError.message } });
      superego.clearStructuredOutput("superego_review");
      const repairText = await superego.prompt(buildSuperegoRepairPrompt(rawOutput, firstError.message));
      try {
        return this.parseStructuredOutput("superego_review", repairText, superego, parseCritique, "Superego");
      } catch (repairError) {
        const err = repairError instanceof Error ? repairError : new Error(String(repairError));
        this.store.addAgentRun({
          runId,
          role: "superego",
          iteration,
          status: "failed",
          input: { prompt, task, contract, repair: true },
          output: { text: repairText, error: err.message },
        });
        this.store.audit({ runId, actor: "superego", action: "review_repair_failed", payload: { message: err.message } });
        return {
          blocking_issues: 1,
          quality_score: 0,
          summary: `Superego 评审结构化输出解析失败且自修复失败：${err.message}`,
          next_action: "escalate",
          critique_items: [
            {
              category: "schema",
              severity: "high",
              suggestion: "请检查 Superego 原始输出和 typed tool 调用，确保 superego_review 参数符合 CritiqueResult schema。",
            },
          ],
        };
      }
    }
  }

  private parseStructuredOutput<T>(
    toolName: string,
    rawOutput: string,
    session: Awaited<ReturnType<typeof createPiSession>>,
    parseText: (text: string) => T,
    source: string,
  ): T {
    const toolOutput = session.structuredOutput<T>(toolName);
    if (toolOutput !== undefined) return parseText(JSON.stringify(toolOutput));
    if (rawOutput.trim()) return parseText(rawOutput);
    throw new Error(`${source} 未提交 ${toolName} 工具调用，也未输出可解析 JSON`);
  }

  static approvalModeFromFlags(flags: { approveAll?: boolean; denyWrites?: boolean }): ApprovalMode {
    if (flags.approveAll) return "approve-all";
    if (flags.denyWrites) return "deny-writes";
    return "approve-reads";
  }

  private async decideWithHa(
    task: string,
    prompt: string,
    options: MasRunOptions,
    sink: StreamSink,
    runId: string,
    sessionId: string | undefined,
    mode: (typeof ORCHESTRATION_MODES)[keyof typeof ORCHESTRATION_MODES],
  ): Promise<HaDecision> {
    throwIfAborted(options.signal);
    this.store.audit({ runId, actor: "ha", action: "route_started", payload: { orchestrationMode: mode.id } });
    const ha = await createPiSession({
      cwd: options.cwd,
      runId,
      sessionId,
      role: "ha",
      iteration: 0,
      approvalMode: "deny-writes",
      sink: new InternalSink(sink),
      recordApproval: (input) => this.store.addApproval({ runId, ...input }),
      recordEvent: (input) => this.store.addEvent(input),
    });
    const abortHa = () => void ha.abort();
    options.signal?.addEventListener("abort", abortHa, { once: true });
    try {
      let reviewText = await ha.prompt(buildHaDecisionPrompt(task));
      let decision = ha.haDecision();
      if (!decision) {
        try {
          decision = parseHaDecision(reviewText);
        } catch (error) {
          const firstError = error instanceof Error ? error : new Error(String(error));
          this.store.addAgentRun({
            runId,
            role: "ha",
            iteration: 0,
            status: "failed",
            input: { prompt, task, historyTurns: options.conversationHistory?.length ?? 0, orchestrationMode: mode.id },
            output: { text: reviewText, error: firstError.message, orchestrationMode: mode },
          });
          this.store.audit({ runId, actor: "ha", action: "route_parse_failed", payload: { message: firstError.message } });
          reviewText = await ha.prompt(buildHaDecisionRepairPrompt(reviewText, firstError.message));
          decision = ha.haDecision();
          if (!decision) {
            try {
              decision = parseHaDecision(reviewText);
            } catch (repairError) {
              const err = repairError instanceof Error ? repairError : new Error(String(repairError));
              this.store.addAgentRun({
                runId,
                role: "ha",
                iteration: 0,
                status: "failed",
                input: { prompt, task, repair: true, orchestrationMode: mode.id },
                output: { text: reviewText, error: err.message, orchestrationMode: mode },
              });
              this.store.audit({ runId, actor: "ha", action: "route_repair_failed", payload: { message: err.message } });
              return {
                next_action: "clarify",
                response: "我没能稳定生成内部路由决策，当前请求没有开始执行。请重新发送一次任务；如果任务涉及安装、写文件或执行命令，我会发起可审批的操作。",
                acceptance_contract: "",
                rationale: `HA 路由 JSON 解析失败且自修复失败：${err.message}`,
              };
            }
          }
        }
      }
      decision = parseHaDecision(JSON.stringify(decision));
      this.store.addAgentRun({
        runId,
        role: "ha",
        iteration: 0,
        status: "completed",
        input: { prompt, task, historyTurns: options.conversationHistory?.length ?? 0, orchestrationMode: mode.id },
        output: { text: reviewText, decision, orchestrationMode: mode },
      });
      this.store.addEvent({
        runId,
        sessionId,
        role: "ha",
        iteration: 0,
        source: "mas",
        type: "mas.ha.decision.created",
        actor: "ha",
        payload: decision,
      });
      this.store.audit({ runId, actor: "ha", action: "route_decided", payload: decision });
      return decision;
    } finally {
      options.signal?.removeEventListener("abort", abortHa);
      ha.dispose();
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("MAS run 已取消");
}

function buildTaskWithConversation(
  prompt: string,
  history?: ConversationTurn[],
  summary?: string,
  availableSkills?: Array<{ name: string; description: string }>,
  memoryContext?: string,
): string {
  const recentHistory = trimHistory(history ?? []);
  const hasSummary = Boolean(summary?.trim());
  const hasSkills = Boolean(availableSkills?.length);
  const hasMemory = Boolean(memoryContext?.trim());
  if (recentHistory.length === 0 && !hasSummary && !hasSkills && !hasMemory) return prompt;
  const parts = [
    "以下是同一 AionUI 会话的历史对话。回答和执行当前请求时必须结合历史，不要把用户的后续补充当成孤立任务。",
    "",
  ];
  if (hasSummary) {
    parts.push("已压缩的早期上下文摘要：", summary!.trim(), "");
  }
  if (recentHistory.length > 0) {
    parts.push("最近历史对话：", ...recentHistory.map((turn) => `${turn.role === "user" ? "用户" : "助手"}：${turn.content}`), "");
  }
  if (hasSkills) {
    parts.push(
      "当前 Pi 可发现的技能摘要：",
      ...availableSkills!.map((skill) => `- ${skill.name}: ${skill.description}`),
      "如任务匹配某个技能，应按技能名主动加载或使用对应说明；不要声称没有检查过技能。",
      "",
    );
  }
  if (hasMemory) {
    parts.push(memoryContext!.trim(), "");
  }
  parts.push(`当前用户请求：${prompt}`);
  return parts.join("\n");
}

function trimHistory(history: ConversationTurn[]): ConversationTurn[] {
  const maxChars = 12000;
  const maxTurns = 12;
  const selected: ConversationTurn[] = [];
  let total = 0;
  for (const turn of history.slice(-maxTurns).reverse()) {
    const content = turn.content.trim();
    if (!content) continue;
    const nextTotal = total + content.length;
    if (nextTotal > maxChars && selected.length > 0) break;
    selected.push({ role: turn.role, content: content.slice(-maxChars) });
    total = Math.min(nextTotal, maxChars);
  }
  return selected.reverse();
}

function summarizeBoundarySnapshot(snapshot: BoundarySnapshot): unknown {
  return {
    createdAt: snapshot.createdAt,
    cwd: snapshot.cwd,
    scopes: snapshot.scopes.map((scope) => ({
      kind: scope.kind,
      path: scope.path,
      exists: scope.exists,
      depth: scope.depth,
      fileCount: scope.fileCount,
      dirCount: scope.dirCount,
      truncated: scope.truncated,
    })),
  };
}

class InternalSink implements StreamSink {
  constructor(private readonly delegate: StreamSink) {}

  text(): void {}

  thought(): void {}

  toolStart(): void {}

  toolUpdate(): void {}

  permission(input: Parameters<StreamSink["permission"]>[0]): Promise<Awaited<ReturnType<StreamSink["permission"]>>> {
    return this.delegate.permission(input);
  }

  done(): void {}

  error(error: Error): void {
    this.delegate.error(error);
  }
}
