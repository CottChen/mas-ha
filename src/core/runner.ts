import { randomUUID } from "node:crypto";
import { MasStore } from "../storage.js";
import type {
  AgentRunRecord,
  ApprovalMode,
  BoundarySnapshot,
  ContextPerturbation,
  ConversationTurn,
  CritiqueResult,
  EgoResult,
  HaDecision,
  MasRunOptions,
  StreamSink,
} from "../types.js";
import { classifyAgentBackendError, createPiSession } from "../pi/pi-sdk.js";
import { buildAuditPacket, createBoundarySnapshot, enforceAuditGate } from "./audit.js";
import { buildRecentActivitySummary, buildStalledRunDiagnosis, isRoleHealthCheckQuestion, isRunStatusQuestion } from "./activity.js";
import { AutonomyLoop } from "./autonomy.js";
import { ContextPerturbationController } from "./context-perturbation.js";
import { retrieveMemoryArtifacts } from "./memory.js";
import { ORCHESTRATION_MODES } from "./orchestration.js";
import { readRunArtifact, renderRunArtifactPrompt, writeAuditPacketArtifact, type RunArtifactRef } from "./run-artifacts.js";
import {
  buildAcceptanceContract,
  buildEgoPrompt,
  buildEgoRepairPrompt,
  buildHaDecisionPrompt,
  buildHaDecisionRepairPrompt,
  buildHaFinalReviewPrompt,
  buildHaFinalReviewRepairPrompt,
  buildSuperegoPrompt,
  buildSuperegoRepairPrompt,
  parseCritique,
  parseEgoResult,
  parseHaDecision,
} from "./prompts.js";

function emitStage(sink: StreamSink, text: string): void {
  sink.text(`\n\n${text}\n`);
}

const EGO_STRUCTURED_FAILURE_HA_THRESHOLD = 3;

export class MasRunner {
  constructor(
    private readonly store = new MasStore(),
    private readonly autonomy = new AutonomyLoop(store),
    private readonly perturbations = new ContextPerturbationController(store),
  ) {}

  async run(prompt: string, options: MasRunOptions, sink: StreamSink, sessionId?: string): Promise<{ runId: string; result: string }> {
    const runId = randomUUID();
    const mode = ORCHESTRATION_MODES[options.orchestrationMode];
    const contextInjection = summarizeContextInjection(options);
    const task = buildTaskWithConversation(prompt, options.conversationHistory, options.conversationSummary, options.availableSkills);
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
    this.store.audit({ runId, actor: "system", action: "context_injection_prepared", payload: contextInjection });
    this.store.addEvent({
      runId,
      sessionId,
      source: "mas",
      type: "mas.context.injection.prepared",
      actor: "system",
      payload: contextInjection,
    });

    let critique: CritiqueResult | undefined;
    let finalEgoOutput = "";
    let egoResult: EgoResult | undefined;
    let consecutiveEgoStructuredFailures = 0;

    try {
      const haDecision = await this.decideWithHa(task, prompt, options, sink, runId, sessionId, mode, contextInjection);
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
          payload: { resultKind: haDecision.next_action, intentType: haDecision.intent_type, orchestrationMode: mode.id },
        });
        sink.done(result);
        return { runId, result };
      }

      const contract = haDecision.acceptance_contract.trim() || buildAcceptanceContract(task);
      emitStage(sink, `HA 已创建验收合同。编排模式：${mode.name}。`);
      const boundaryDeclarations = {
        readonlyInputPaths: haDecision.readonly_input_paths,
        allowedOutputPaths: haDecision.allowed_output_paths,
      };
      const boundarySnapshot: BoundarySnapshot = createBoundarySnapshot({ cwd: options.cwd, task, contract, boundaryDeclarations });
      this.store.audit({ runId, actor: "system", action: "boundary_snapshot_baseline", payload: summarizeBoundarySnapshot(boundarySnapshot) });

      for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
        throwIfAborted(options.signal);
        emitStage(sink, `Ego 第 ${iteration} 轮开始。`);
        const ego = await createPiSession({
          cwd: options.cwd,
          runId,
          sessionId,
          role: "ego",
          phase: "execute",
          iteration,
          approvalMode: options.approvalMode,
          sink,
          recordApproval: (input) => this.store.addApproval({ runId, ...input }),
          recordEvent: (input) => this.store.addEvent(input),
          memoryTools: this.createMemoryToolProvider(sessionId, runId),
        });
        const abortEgo = () => void ego.abort();
        options.signal?.addEventListener("abort", abortEgo, { once: true });
        try {
          const perturbation = this.createAndRecordPerturbation({
            runId,
            sessionId,
            goalId: options.goalId,
            targetRole: "ego",
            iteration,
            trigger: critique ? "superego_revise" : "execution_plan",
            critique,
            sourceRefs: critique ? [`run:${runId}:critique`] : [`run:${runId}:contract`],
          });
          const egoSessionContext = this.buildEgoSessionContext(sessionId, runId);
          let rawEgoOutput = "";
          try {
            rawEgoOutput = await ego.prompt(buildEgoPrompt(task, contract, critique, this.perturbations.render(perturbation), egoSessionContext));
            egoResult = await this.parseEgoWithRepair(rawEgoOutput, ego, prompt, task, critique, runId, iteration);
          } catch (error) {
            const diagnostic = classifyAgentBackendError(error);
            egoResult = agentBackendFailureEgoResult("Ego", diagnostic);
            this.store.audit({ runId, actor: "ego", action: "prompt_failed", payload: { iteration, error: diagnostic } });
          }
          finalEgoOutput = egoResult.final_response;
          this.store.addAgentRun({
            runId,
            role: "ego",
            iteration,
            status: egoResult.status === "completed" ? "completed" : "failed",
            input: { prompt, task, critique, contextInjection, egoSessionContext, perturbation: summarizePerturbation(perturbation) },
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

        const egoBackendFailure = isAgentBackendFailureEgoResult(egoResult);
        const egoStructuredFailure = isEgoStructuredOutputFailure(egoResult);
        if (egoStructuredFailure) {
          consecutiveEgoStructuredFailures += 1;
        } else {
          consecutiveEgoStructuredFailures = 0;
        }

        if (egoResult.status === "blocked" || egoResult.status === "needs_attention") {
          const attentionCritique = egoBackendFailure
            ? routeAgentBackendFailureToCritique("Ego", egoResult, iteration)
            : egoStructuredFailure
            ? routeEgoStructuredFailureToCritique(egoResult, iteration, consecutiveEgoStructuredFailures, EGO_STRUCTURED_FAILURE_HA_THRESHOLD)
            : routeEgoAttentionToCritique(egoResult, iteration);
          this.store.audit({
            runId,
            actor: "system",
            action: "ego_attention_routed_to_review",
            payload: {
              iteration,
              egoStatus: egoResult.status,
              egoBackendFailure,
              egoStructuredFailure,
              consecutiveEgoStructuredFailures,
              summary: egoResult.summary,
              internalCritique: attentionCritique,
            },
          });
          critique = attentionCritique;
        }

        if (egoBackendFailure) {
          emitStage(sink, `Ego 第 ${iteration} 轮模型/后端接口失败，跳过 Superego 审计，交给 HA 判断。`);
          this.store.audit({
            runId,
            actor: "system",
            action: "ego_backend_failure_sent_to_ha",
            payload: { iteration, critique },
          });
          const { auditArtifact } = this.createAuditArtifact({ runId, iteration, cwd: options.cwd, egoResult, boundarySnapshot, task, contract, boundaryDeclarations });
          const haFinalReview = await this.reviewFinalWithHa(task, prompt, contract, egoResult, critique, options, sink, runId, sessionId, iteration, contextInjection, auditArtifact);
          emitStage(sink, `HA 终验结论：${haFinalReview.summary || haFinalReview.next_action}`);
          if (haFinalReview.next_action === "escalate") {
            const result = formatNeedsAttentionResult({
              headline: "HA 终验未通过：需要人工介入。",
              haFinalReview,
              superegoReview: critique,
              egoOutput: finalEgoOutput,
            });
            this.store.updateRun(runId, "needs_attention", { result, critique, egoResult, haFinalReview, orchestrationMode: mode.id });
            this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "needs_attention", result, egoResult, critique: haFinalReview, reason: "ha_final_escalate_after_ego_backend_failure" });
            sink.done(result);
            return { runId, result };
          }
          critique = haFinalReview;
          continue;
        }

        if (egoStructuredFailure) {
          if (consecutiveEgoStructuredFailures < EGO_STRUCTURED_FAILURE_HA_THRESHOLD) {
            emitStage(
              sink,
              `Ego 第 ${iteration} 轮未提交可解析结构化结果，跳过 Superego 审计，直接打回 Ego（连续 ${consecutiveEgoStructuredFailures}/${EGO_STRUCTURED_FAILURE_HA_THRESHOLD}）。`,
            );
            this.store.audit({
              runId,
              actor: "system",
              action: "ego_structured_failure_direct_revise",
              payload: { iteration, consecutiveEgoStructuredFailures, threshold: EGO_STRUCTURED_FAILURE_HA_THRESHOLD, critique },
            });
            this.store.addEvent({
              runId,
              sessionId,
              role: "ego",
              iteration,
              source: "mas",
              type: "mas.ego.structured_failure.direct_revise",
              actor: "system",
              payload: { consecutiveEgoStructuredFailures, threshold: EGO_STRUCTURED_FAILURE_HA_THRESHOLD, critique },
            });
            continue;
          }

          emitStage(sink, `Ego 连续 ${consecutiveEgoStructuredFailures} 轮未提交可解析结构化结果，跳过 Superego 审计，交给 HA 判断是否需要人工介入。`);
          this.store.audit({
            runId,
            actor: "system",
            action: "ego_structured_failure_escalated_to_ha",
            payload: { iteration, consecutiveEgoStructuredFailures, threshold: EGO_STRUCTURED_FAILURE_HA_THRESHOLD, critique },
          });
          const { auditArtifact } = this.createAuditArtifact({ runId, iteration, cwd: options.cwd, egoResult, boundarySnapshot, task, contract, boundaryDeclarations });
          const haFinalReview = await this.reviewFinalWithHa(task, prompt, contract, egoResult, critique, options, sink, runId, sessionId, iteration, contextInjection, auditArtifact);
          emitStage(sink, `HA 终验结论：${haFinalReview.summary || haFinalReview.next_action}`);
          if (haFinalReview.next_action === "escalate") {
            const result = formatNeedsAttentionResult({
              headline: "HA 终验未通过：需要人工介入。",
              haFinalReview,
              superegoReview: critique,
              egoOutput: finalEgoOutput,
            });
            this.store.updateRun(runId, "needs_attention", { result, critique, egoResult, haFinalReview, orchestrationMode: mode.id });
            this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "needs_attention", result, egoResult, critique: haFinalReview, reason: "ha_final_escalate_after_ego_structured_failures" });
            sink.done(result);
            return { runId, result };
          }
          critique = haFinalReview;
          consecutiveEgoStructuredFailures = 0;
          continue;
        }

        let { auditPacket, auditArtifact } = this.createAuditArtifact({ runId, iteration, cwd: options.cwd, egoResult, boundarySnapshot, task, contract, boundaryDeclarations });

        if (!mode.usesSuperego) {
          const haFinalReview = await this.reviewFinalWithHa(task, prompt, contract, egoResult, undefined, options, sink, runId, sessionId, iteration, contextInjection, auditArtifact);
          emitStage(sink, `HA 终验结论：${haFinalReview.summary || haFinalReview.next_action}`);
          if (haFinalReview.next_action === "accept" && haFinalReview.blocking_issues === 0) {
            const result = `HA 终验通过（${mode.name} 模式，未启用 Superego 评审）。\n\n${finalEgoOutput}`;
            this.store.updateRun(runId, "completed", { result, egoResult, haFinalReview, orchestrationMode: mode.id });
            this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "completed", result, egoResult, critique: haFinalReview, reason: "ha_final_accept" });
            this.store.addEvent({
              runId,
              sessionId,
              source: "mas",
              type: "mas.run.completed",
              actor: "ha",
              payload: { resultKind: "accepted", orchestrationMode: mode.id, usesSuperego: false, egoResult, haFinalReview },
            });
            sink.done(result);
            return { runId, result };
          }
          if (haFinalReview.next_action === "escalate") {
            const result = formatNeedsAttentionResult({
              headline: "HA 终验未通过：需要人工介入。",
              haFinalReview,
              egoOutput: finalEgoOutput,
            });
            this.store.updateRun(runId, "needs_attention", { result, egoResult, haFinalReview, orchestrationMode: mode.id });
            this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "needs_attention", result, egoResult, critique: haFinalReview, reason: "ha_final_escalate" });
            sink.done(result);
            return { runId, result };
          }
          critique = haFinalReview;
          continue;
        }

        throwIfAborted(options.signal);
        emitStage(sink, `Superego 第 ${iteration} 轮评审开始。`);
        const superego = await createPiSession({
          cwd: options.cwd,
          runId,
          sessionId,
          role: "superego",
          phase: "review",
          iteration,
          approvalMode: options.approvalMode,
          sink,
          recordApproval: (input) => this.store.addApproval({ runId, ...input }),
          recordEvent: (input) => this.store.addEvent(input),
          memoryTools: this.createMemoryToolProvider(sessionId, runId),
        });
        const abortSuperego = () => void superego.abort();
        options.signal?.addEventListener("abort", abortSuperego, { once: true });
        let reviewText = "";
        try {
          this.store.audit({ runId, actor: "superego", action: "audit_packet_ready", payload: { artifactId: auditArtifact.artifactId, summary: auditArtifact.summary } });
          const latestLedger = options.goalId ? this.store.listEntropyLedgers({ goalId: options.goalId, limit: 1 })[0] : undefined;
          const perturbation = this.createAndRecordPerturbation({
            runId,
            sessionId,
            goalId: options.goalId,
            targetRole: "superego",
            iteration,
            trigger: latestLedger ? "ledger_review_sampling" : "review_sampling",
            ledger: latestLedger,
            sourceRefs: [`run:${runId}:audit_packet`],
          });
          reviewText = await superego.prompt(
            buildSuperegoPrompt(
              task,
              compactTextForReview(contract, 9000),
              JSON.stringify(compactEgoResultForReview(egoResult), null, 2),
              renderRunArtifactPrompt(auditArtifact),
              this.perturbations.render(perturbation),
            ),
          );
          const rawCritique = await this.parseSuperegoWithRepair(reviewText, superego, prompt, task, contract, runId, iteration, options, sink, sessionId);
          critique = routeSuperegoReviewForOrchestration(enforceAuditGate(rawCritique, auditPacket), egoResult);
          if (critique.next_action !== rawCritique.next_action || critique.summary !== rawCritique.summary) {
            this.store.audit({
              runId,
              actor: "system",
              action: "superego_accept_routed_to_revise",
              payload: { iteration, rawCritique, routedCritique: critique },
            });
          }
          this.store.addAgentRun({
            runId,
            role: "superego",
            iteration,
            status: "completed",
            input: { prompt, task, contract, auditPacket, contextInjection, perturbation: summarizePerturbation(perturbation) },
            output: { text: reviewText, critique, rawCritique },
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
        } catch (error) {
          const diagnostic = classifyAgentBackendError(error);
          critique = agentBackendFailureCritique("Superego", diagnostic, iteration);
          this.store.addAgentRun({
            runId,
            role: "superego",
            iteration,
            status: "failed",
            input: { prompt, task, contract, auditPacket, contextInjection },
            output: { text: reviewText, error: diagnostic, critique },
          });
          this.store.audit({ runId, actor: "superego", action: "prompt_failed", payload: { iteration, error: diagnostic, critique } });
          this.store.addEvent({
            runId,
            sessionId,
            role: "superego",
            iteration,
            source: "mas",
            type: "mas.superego.review.failed",
            actor: "superego",
            payload: { error: diagnostic, critique },
          });
          ({ auditPacket, auditArtifact } = this.createAuditArtifact({ runId, iteration, cwd: options.cwd, egoResult, boundarySnapshot, task, contract, boundaryDeclarations }));
        } finally {
          options.signal?.removeEventListener("abort", abortSuperego);
          superego.dispose();
        }

        emitStage(sink, `Superego 结论：${critique.summary || critique.next_action}`);
        if (critique.next_action === "escalate") {
          this.store.audit({
            runId,
            actor: "system",
            action: "superego_escalation_sent_to_ha",
            payload: { iteration, critique },
          });
          const haFinalReview = await this.reviewFinalWithHa(task, prompt, contract, egoResult, critique, options, sink, runId, sessionId, iteration, contextInjection, auditArtifact);
          emitStage(sink, `HA 终验结论：${haFinalReview.summary || haFinalReview.next_action}`);
          if (haFinalReview.next_action === "escalate") {
            const result = formatNeedsAttentionResult({
              headline: "HA 终验未通过：需要人工介入。",
              haFinalReview,
              superegoReview: critique,
              egoOutput: finalEgoOutput,
            });
            this.store.updateRun(runId, "needs_attention", { result, critique, egoResult, haFinalReview });
            this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "needs_attention", result, egoResult, critique: haFinalReview, reason: "ha_final_escalate" });
            sink.done(result);
            return { runId, result };
          }
          if (haFinalReview.next_action === "accept" && haFinalReview.blocking_issues === 0) {
            const result = `HA 终验通过。\n\n${finalEgoOutput}`;
            this.store.updateRun(runId, "completed", { result, critique, egoResult, haFinalReview });
            this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "completed", result, egoResult, critique: haFinalReview, reason: "ha_final_accept" });
            sink.done(result);
            return { runId, result };
          }
          critique = haFinalReview;
          continue;
        }
        if (critique.next_action === "accept" && critique.blocking_issues === 0) {
          const haFinalReview = await this.reviewFinalWithHa(task, prompt, contract, egoResult, critique, options, sink, runId, sessionId, iteration, contextInjection, auditArtifact);
          emitStage(sink, `HA 终验结论：${haFinalReview.summary || haFinalReview.next_action}`);
          if (haFinalReview.next_action === "escalate") {
            const result = formatNeedsAttentionResult({
              headline: "HA 终验未通过：需要人工介入。",
              haFinalReview,
              superegoReview: critique,
              egoOutput: finalEgoOutput,
            });
            this.store.updateRun(runId, "needs_attention", { result, critique, egoResult, haFinalReview });
            this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "needs_attention", result, egoResult, critique: haFinalReview, reason: "ha_final_escalate" });
            sink.done(result);
            return { runId, result };
          }
          if (haFinalReview.next_action !== "accept" || haFinalReview.blocking_issues > 0) {
            critique = haFinalReview;
            continue;
          }
          const result = `HA 终验通过。\n\n${finalEgoOutput}`;
          this.store.updateRun(runId, "completed", { result, critique, egoResult, haFinalReview });
          this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "completed", result, egoResult, critique: haFinalReview, reason: "ha_final_accept" });
          this.store.addEvent({
            runId,
            sessionId,
            source: "mas",
            type: "mas.run.completed",
            actor: "ha",
            payload: { resultKind: "accepted", orchestrationMode: mode.id, critique, egoResult, haFinalReview },
          });
          sink.done(result);
          return { runId, result };
        }
      }

      const haFinalReview = egoResult
        ? await this.reviewFinalWithHa(task, prompt, contract, egoResult, critique, options, sink, runId, sessionId, options.maxIterations, contextInjection)
        : undefined;
      if (haFinalReview?.next_action === "accept" && haFinalReview.blocking_issues === 0) {
        const result = `HA 终验通过。\n\n${finalEgoOutput}`;
        this.store.updateRun(runId, "completed", { result, critique, egoResult, haFinalReview });
        this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "completed", result, egoResult, critique: haFinalReview, reason: "ha_final_accept_after_max_iterations" });
        sink.done(result);
        return { runId, result };
      }
      const result = formatNeedsAttentionResult({
        headline: "HA 终验未通过：达到最大返工轮次。",
        haFinalReview,
        superegoReview: critique,
        egoOutput: finalEgoOutput,
      });
      this.store.updateRun(runId, "needs_attention", { result, critique, egoResult, haFinalReview });
      this.recordAutonomyClosure({ runId, sessionId, goalId: options.goalId, prompt, status: "needs_attention", result, egoResult, critique: haFinalReview ?? critique, reason: "max_iterations" });
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

  private createAuditArtifact(input: {
    runId: string;
    iteration: number;
    cwd: string;
    egoResult: EgoResult;
    boundarySnapshot: BoundarySnapshot;
    task: string;
    contract: string;
    boundaryDeclarations: { readonlyInputPaths: string[]; allowedOutputPaths: string[] };
  }): { auditPacket: ReturnType<typeof buildAuditPacket>; auditArtifact: RunArtifactRef } {
    const auditPacket = buildAuditPacket(this.store, {
      runId: input.runId,
      cwd: input.cwd,
      egoResult: input.egoResult,
      boundarySnapshot: input.boundarySnapshot,
      task: input.task,
      contract: input.contract,
      boundaryDeclarations: input.boundaryDeclarations,
    });
    const auditArtifact = writeAuditPacketArtifact({ runId: input.runId, iteration: input.iteration, auditPacket });
    this.store.audit({
      runId: input.runId,
      actor: "system",
      action: "audit_packet_artifact_written",
      payload: { artifactId: auditArtifact.artifactId, path: auditArtifact.path, summary: auditArtifact.summary },
    });
    return { auditPacket, auditArtifact };
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
        const finalResponse = rawOutput.trim()
          ? `Ego 已返回执行内容，但 MAS 无法把它稳定解析为结构化结果。\n\n原始输出：\n${rawOutput}`
          : "Ego 没有提交 ego_result，也没有返回可见文本；MAS 无法判断它是否完成了任务。";
        return {
          status: "needs_attention",
          summary: `Ego 执行结果 JSON 解析失败且自修复失败：${err.message}`,
          final_response: finalResponse,
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
    options: MasRunOptions,
    sink: StreamSink,
    sessionId: string | undefined,
  ): Promise<CritiqueResult> {
    try {
      return this.parseStructuredOutput("superego_review", rawOutput, superego, (text) => parseCritique(text, "Superego"), "Superego");
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
      const repairSuperego = await createPiSession({
        cwd: options.cwd,
        runId,
        sessionId,
        role: "superego",
        phase: "review",
        iteration,
        approvalMode: options.approvalMode,
        sink,
        recordApproval: (input) => this.store.addApproval({ runId, ...input }),
        recordEvent: (input) => this.store.addEvent(input),
        memoryTools: this.createMemoryToolProvider(sessionId, runId),
      });
      const abortRepair = () => void repairSuperego.abort();
      options.signal?.addEventListener("abort", abortRepair, { once: true });
      let repairText = "";
      try {
        repairText = await repairSuperego.prompt(buildSuperegoRepairPrompt(rawOutput, firstError.message));
        const repaired = this.parseStructuredOutput("superego_review", repairText, repairSuperego, (text) => parseCritique(text, "Superego"), "Superego");
        this.store.audit({ runId, actor: "superego", action: "review_repair_succeeded", payload: { outputChars: repairText.length } });
        return repaired;
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
      } finally {
        options.signal?.removeEventListener("abort", abortRepair);
        repairSuperego.dispose();
      }
    }
  }

  private async parseHaFinalReviewWithRepair(
    rawOutput: string,
    ha: Awaited<ReturnType<typeof createPiSession>>,
    prompt: string,
    task: string,
    contract: string,
    runId: string,
    iteration: number,
  ): Promise<CritiqueResult> {
    try {
      return this.parseStructuredOutput("ha_final_review", rawOutput, ha, (text) => parseCritique(text, "HA 终验"), "HA 终验");
    } catch (error) {
      const firstError = error instanceof Error ? error : new Error(String(error));
      this.store.addAgentRun({
        runId,
        role: "ha",
        iteration,
        status: "failed",
        input: { prompt, task, contract, stage: "final_review", repair: false },
        output: { text: rawOutput, error: firstError.message },
      });
      this.store.audit({ runId, actor: "ha", action: "final_review_parse_failed", payload: { message: firstError.message } });
      ha.clearStructuredOutput("ha_final_review");
      const repairText = await ha.prompt(buildHaFinalReviewRepairPrompt(rawOutput, firstError.message));
      try {
        return this.parseStructuredOutput("ha_final_review", repairText, ha, (text) => parseCritique(text, "HA 终验"), "HA 终验");
      } catch (repairError) {
        const err = repairError instanceof Error ? repairError : new Error(String(repairError));
        this.store.addAgentRun({
          runId,
          role: "ha",
          iteration,
          status: "failed",
          input: { prompt, task, contract, stage: "final_review", repair: true },
          output: { text: repairText, error: err.message },
        });
        this.store.audit({ runId, actor: "ha", action: "final_review_repair_failed", payload: { message: err.message } });
        return {
          blocking_issues: 1,
          quality_score: 0,
          summary: `HA 终验结构化输出解析失败且自修复失败：${err.message}`,
          next_action: "escalate",
          critique_items: [
            {
              category: "schema",
              severity: "high",
              suggestion: "请检查 HA 终验原始输出和 typed tool 调用，确保 ha_final_review 参数符合 CritiqueResult schema。",
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
    contextInjection: ReturnType<typeof summarizeContextInjection>,
  ): Promise<HaDecision> {
    throwIfAborted(options.signal);
    this.store.audit({ runId, actor: "ha", action: "route_started", payload: { orchestrationMode: mode.id } });
    emitStage(sink, "HA 路由开始。");
    const stalledRunDiagnosis = isRunStatusQuestion(prompt)
      ? buildStalledRunDiagnosis(this.store, { currentRunId: runId, sessionId, cwd: options.cwd })
      : undefined;
    if (stalledRunDiagnosis?.hasStalledRun) {
      const recent = buildRecentActivitySummary(this.store, { sessionId, limit: 6, scope: "all", excludeRunId: runId });
      const response = [
        "我先按运行状态诊断，而不是重新生成执行合同。",
        "",
        stalledRunDiagnosis.rendered,
        "",
        recent.rendered,
        "",
        "结论：当前问题不是新任务缺少验收合同，而是已有 run 没有正常收口。应先看上面最后的 audit/approval 事件处理卡点，再决定是否重跑或清理旧 run。",
      ].join("\n");
      const decision: HaDecision = {
        intent_type: "status_query",
        next_action: "answer",
        response,
        acceptance_contract: "",
        readonly_input_paths: [],
        allowed_output_paths: [],
        rationale: "用户询问运行状态，且同一会话或工作目录存在未收口 running run；优先返回本地审计诊断，避免重复进入 execute。",
      };
      this.store.addAgentRun({
        runId,
        role: "ha",
        iteration: 0,
        status: "completed",
        input: { prompt, task, contextInjection, orchestrationMode: mode.id, statusDiagnosis: true },
        output: { decision, statusDiagnosis: stalledRunDiagnosis.rendered, recentActivity: recent.rendered, orchestrationMode: mode },
      });
      this.store.audit({ runId, actor: "ha", action: "route_decided", payload: decision });
      return decision;
    }
    if (isRoleHealthCheckQuestion(prompt)) {
      const decision: HaDecision = {
        intent_type: "execution_task",
        next_action: "execute",
        response: "",
        acceptance_contract: [
          "## objective",
          "执行一个最小 MAS 角色健康检查，必须真实进入 Ego 和 Superego，而不是只查询历史状态。",
          "",
          "## readonlyInputs",
          "- 当前用户请求：测试 Ego 和 Superego 是否正常。",
          "- 当前工作目录和 MAS 本地运行记录仅作上下文，不得修改用户业务产物。",
          "",
          "## allowedOutputs",
          "- 可在 MAS 审计记录中产生本次 dry-run 的 agent_runs/events/approvals。",
          "- 不要求写文件；如必须写临时文件，必须写入当前 workspace 的 output/mas-health-check/ 并说明原因。",
          "",
          "## forbiddenStates",
          "- 禁止用历史 Superego 失败或成功直接替代本次测试结论。",
          "- 禁止执行全局杀进程命令，例如 taskkill /F /IM node.exe、Stop-Process -Name node、pkill node。",
          "- 禁止修改用户项目源码、业务数据或 AionUI 配置。",
          "",
          "## doneCriteria",
          "- Ego 必须提交 ego_result，报告本次 dry-run 做了什么、是否无需写文件、验证结果。",
          "- Superego 必须提交 superego_review；若 Superego 仍失败，必须在本 run 的 agent_runs/audit 中留下新的失败证据。",
          "- HA 终验必须基于本 run 的 Ego/Superego 结果回答角色链路是否正常。",
          "",
          "## validators",
          "- 检查本 run 是否出现 ego completed agent_run。",
          "- 检查本 run 是否出现 superego completed agent_run 或明确的 superego parse/repair 失败记录。",
        ].join("\n"),
        readonly_input_paths: [],
        allowed_output_paths: [options.cwd],
        rationale: "用户显式要求测试 Ego 和 Superego 是否正常，应触发最小 dry-run 真实经过 Ego/Superego，而不是 HA 只查历史状态。",
      };
      this.store.addAgentRun({
        runId,
        role: "ha",
        iteration: 0,
        status: "completed",
        input: { prompt, task, contextInjection, orchestrationMode: mode.id, roleHealthCheck: true },
        output: { decision, orchestrationMode: mode },
      });
      this.store.audit({ runId, actor: "ha", action: "route_decided", payload: decision });
      return decision;
    }
    let ha: Awaited<ReturnType<typeof createPiSession>>;
    try {
      ha = await createPiSession({
        cwd: options.cwd,
        runId,
        sessionId,
        role: "ha",
        phase: "route",
        iteration: 0,
        approvalMode: "deny-writes",
        model: options.model,
        sink,
        recordApproval: (input) => this.store.addApproval({ runId, ...input }),
        recordEvent: (input) => this.store.addEvent(input),
        memoryTools: this.createMemoryToolProvider(sessionId, runId),
      });
    } catch (error) {
      const diagnostic = classifyAgentBackendError(error);
      this.store.audit({ runId, actor: "ha", action: "route_session_failed", payload: { error: diagnostic } });
      return haFrameworkFailureDecision("路由", diagnostic);
    }
    const abortHa = () => void ha.abort();
    options.signal?.addEventListener("abort", abortHa, { once: true });
    try {
      const perturbation = this.createAndRecordPerturbation({
        runId,
        sessionId,
        goalId: options.goalId,
        targetRole: "ha",
        iteration: 0,
        trigger: "intent_check",
        sourceRefs: [`run:${runId}:user_task`],
      });
      let reviewText: string;
      try {
        reviewText = await ha.prompt(buildHaDecisionPrompt(task, this.perturbations.render(perturbation), options.cwd));
      } catch (error) {
        const diagnostic = classifyAgentBackendError(error);
        this.store.addAgentRun({
          runId,
          role: "ha",
          iteration: 0,
          status: "failed",
          input: { prompt, task, contextInjection, perturbation: summarizePerturbation(perturbation), orchestrationMode: mode.id },
          output: { error: diagnostic, stage: "route" },
        });
        this.store.audit({ runId, actor: "ha", action: "route_prompt_failed", payload: { error: diagnostic } });
        return haFrameworkFailureDecision("路由", diagnostic);
      }
      let capturedDecision = ha.haDecision();
      let decision: HaDecision;
      try {
        decision = capturedDecision ? parseHaDecision(JSON.stringify(capturedDecision)) : parseHaDecision(reviewText);
      } catch (error) {
        const firstError = error instanceof Error ? error : new Error(String(error));
        const failedOutput = capturedDecision ? JSON.stringify(capturedDecision, null, 2) : reviewText;
        this.store.addAgentRun({
          runId,
          role: "ha",
          iteration: 0,
          status: "failed",
          input: { prompt, task, contextInjection, perturbation: summarizePerturbation(perturbation), orchestrationMode: mode.id },
          output: { text: failedOutput, error: firstError.message, orchestrationMode: mode },
        });
        this.store.audit({ runId, actor: "ha", action: "route_parse_failed", payload: { message: firstError.message } });
        ha.clearStructuredOutput("ha_decision");
        try {
          reviewText = await ha.prompt(buildHaDecisionRepairPrompt(failedOutput, firstError.message));
        } catch (error) {
          const diagnostic = classifyAgentBackendError(error);
          this.store.addAgentRun({
            runId,
            role: "ha",
            iteration: 0,
            status: "failed",
            input: { prompt, task, repair: true, contextInjection, perturbation: summarizePerturbation(perturbation), orchestrationMode: mode.id },
            output: { error: diagnostic, stage: "route_repair" },
          });
          this.store.audit({ runId, actor: "ha", action: "route_repair_prompt_failed", payload: { error: diagnostic } });
          return haFrameworkFailureDecision("路由修复", diagnostic);
        }
        capturedDecision = ha.haDecision();
        try {
          decision = capturedDecision ? parseHaDecision(JSON.stringify(capturedDecision)) : parseHaDecision(reviewText);
        } catch (repairError) {
          const err = repairError instanceof Error ? repairError : new Error(String(repairError));
          const repairedOutput = capturedDecision ? JSON.stringify(capturedDecision, null, 2) : reviewText;
          this.store.addAgentRun({
            runId,
            role: "ha",
            iteration: 0,
            status: "failed",
            input: { prompt, task, repair: true, contextInjection, perturbation: summarizePerturbation(perturbation), orchestrationMode: mode.id },
            output: { text: repairedOutput, error: err.message, orchestrationMode: mode },
          });
          this.store.audit({ runId, actor: "ha", action: "route_repair_failed", payload: { message: err.message } });
          return {
            intent_type: "conversation",
            next_action: "clarify",
            response: "我没能稳定生成内部路由决策，当前请求没有开始执行。请重新发送一次任务；如果任务涉及安装、写文件或执行命令，我会发起可审批的操作。",
            acceptance_contract: "",
            readonly_input_paths: [],
            allowed_output_paths: [],
            rationale: `HA 路由 JSON 解析失败且自修复失败：${err.message}`,
          };
        }
      }
      this.store.addAgentRun({
        runId,
        role: "ha",
        iteration: 0,
        status: "completed",
        input: { prompt, task, contextInjection, perturbation: summarizePerturbation(perturbation), orchestrationMode: mode.id },
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

  private async reviewFinalWithHa(
    task: string,
    prompt: string,
    contract: string,
    egoResult: EgoResult,
    superegoCritique: CritiqueResult | undefined,
    options: MasRunOptions,
    sink: StreamSink,
    runId: string,
    sessionId: string | undefined,
    iteration: number,
    contextInjection: ReturnType<typeof summarizeContextInjection>,
    auditArtifact?: RunArtifactRef,
  ): Promise<CritiqueResult> {
    throwIfAborted(options.signal);
    this.store.audit({ runId, actor: "ha", action: "final_review_started", payload: { iteration, hasSuperego: Boolean(superegoCritique) } });
    emitStage(sink, "HA 终验开始。");
    let ha: Awaited<ReturnType<typeof createPiSession>>;
    try {
      ha = await createPiSession({
        cwd: options.cwd,
        runId,
        sessionId,
        role: "ha",
        phase: "final_review",
        iteration,
        approvalMode: "deny-writes",
        model: options.model,
        sink,
        recordApproval: (input) => this.store.addApproval({ runId, ...input }),
        recordEvent: (input) => this.store.addEvent(input),
        memoryTools: this.createMemoryToolProvider(sessionId, runId),
      });
    } catch (error) {
      const diagnostic = classifyAgentBackendError(error);
      this.store.audit({ runId, actor: "ha", action: "final_review_session_failed", payload: { iteration, error: diagnostic } });
      return haFrameworkFailureReview("终验", diagnostic);
    }
    const abortHa = () => void ha.abort();
    options.signal?.addEventListener("abort", abortHa, { once: true });
    try {
      const perturbation = this.createAndRecordPerturbation({
        runId,
        sessionId,
        goalId: options.goalId,
        targetRole: "ha",
        iteration,
        trigger: "final_review",
        critique: superegoCritique,
        sourceRefs: [`run:${runId}:ego_result`, superegoCritique ? `run:${runId}:superego_review` : `run:${runId}:contract`],
      });
      let reviewText = "";
      let review: CritiqueResult;
      try {
        reviewText = await ha.prompt(
          buildHaFinalReviewPrompt(task, contract, JSON.stringify(egoResult, null, 2), superegoCritique, this.perturbations.render(perturbation), auditArtifact ? renderRunArtifactPrompt(auditArtifact) : ""),
        );
        review = enforceHaFinalReviewGate(await this.parseHaFinalReviewWithRepair(reviewText, ha, prompt, task, contract, runId, iteration), { egoResult });
      } catch (error) {
        const diagnostic = classifyAgentBackendError(error);
        review = haFrameworkFailureReview("终验", diagnostic);
        this.store.addAgentRun({
          runId,
          role: "ha",
          iteration,
          status: "failed",
          input: { prompt, task, contract, stage: "final_review", superegoCritique, auditArtifact, contextInjection },
          output: { text: reviewText, error: diagnostic, review },
        });
        this.store.audit({ runId, actor: "ha", action: "final_review_prompt_failed", payload: { iteration, error: diagnostic, review } });
        return review;
      }
      this.store.addAgentRun({
        runId,
        role: "ha",
        iteration,
        status: "completed",
        input: {
          prompt,
          task,
          contract,
          egoResult,
          superegoCritique,
          auditArtifact,
          contextInjection,
          stage: "final_review",
          perturbation: summarizePerturbation(perturbation),
        },
        output: { text: reviewText, review },
      });
      this.store.addEvent({
        runId,
        sessionId,
        role: "ha",
        iteration,
        source: "mas",
        type: "mas.ha.final_review.completed",
        actor: "ha",
        payload: review,
      });
      this.store.audit({ runId, actor: "ha", action: "final_review_completed", payload: review });
      return review;
    } finally {
      options.signal?.removeEventListener("abort", abortHa);
      ha.dispose();
    }
  }

  private createAndRecordPerturbation(input: {
    runId: string;
    sessionId?: string;
    goalId?: string;
    targetRole: "ha" | "ego" | "superego";
    iteration: number;
    trigger: string;
    critique?: CritiqueResult;
    ledger?: Parameters<ContextPerturbationController["createCandidate"]>[0]["ledger"];
    sourceRefs?: string[];
  }): ContextPerturbation | undefined {
    const candidate = this.perturbations.createCandidate(input);
    const summary = summarizePerturbation(candidate);
    this.store.audit({
      runId: input.runId,
      actor: input.targetRole,
      action: "context_perturbation_injected",
      payload: { iteration: input.iteration, trigger: input.trigger, ...summary },
    });
    this.store.addEvent({
      runId: input.runId,
      sessionId: input.sessionId,
      role: input.targetRole,
      iteration: input.iteration,
      source: "mas",
      type: "mas.context.perturbation.injected",
      actor: input.targetRole,
      payload: { trigger: input.trigger, ...summary },
    });
    return candidate;
  }

  private createMemoryToolProvider(sessionId: string | undefined, currentRunId?: string): Parameters<typeof createPiSession>[0]["memoryTools"] {
    return {
      queryMemory: (input) => {
        const artifacts = retrieveMemoryArtifacts(this.store, { query: input.query, limit: input.limit });
        return {
          query: input.query,
          count: artifacts.length,
          artifacts,
          note: "这些是 Experience Graph 历史经验候选，不是事实来源；采用前必须用当前任务证据验证。",
        };
      },
      queryRecentActivity: (input) => buildRecentActivitySummary(this.store, { sessionId, limit: input.limit, scope: input.scope, role: input.role, excludeRunId: currentRunId }),
      readRunArtifact: (input) => {
        if (!currentRunId) return { error: "当前 runId 不可用，无法读取 MAS run artifact。" };
        try {
          return readRunArtifact({ runId: currentRunId, artifactId: input.artifactId, section: input.section, maxChars: input.maxChars });
        } catch (error) {
          return { error: `读取 MAS run artifact 失败：${error instanceof Error ? error.message : String(error)}` };
        }
      },
    };
  }

  private buildEgoSessionContext(sessionId: string | undefined, currentRunId: string): string {
    const previousSessionRuns = sessionId
      ? this.store.listSessionAgentRuns({ sessionId, role: "ego", limit: 4, beforeRunId: currentRunId })
      : [];
    const currentRunRuns = this.store
      .listAgentRuns(currentRunId)
      .filter((run) => run.role === "ego")
      .slice(-6);
    return renderEgoSessionContext([...previousSessionRuns, ...currentRunRuns]);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("MAS run 已取消");
}

type AgentBackendDiagnostic = ReturnType<typeof classifyAgentBackendError>;

function agentBackendFailureEgoResult(role: "Ego", diagnostic: AgentBackendDiagnostic): EgoResult {
  return {
    status: diagnostic.retryable ? "needs_attention" : "blocked",
    summary: `${role} 模型/后端调用失败：${diagnostic.code}`,
    final_response: `${role} 没有完成执行，因为模型/后端接口返回错误：${diagnostic.code}。${diagnostic.message}`,
    evidence: [
      `errorCode=${diagnostic.code}`,
      `retryable=${diagnostic.retryable}`,
      diagnostic.status !== undefined ? `httpStatus=${diagnostic.status}` : "httpStatus=未提供",
    ],
    changed_files: [],
    verification: [{ command: "", result: "not_run", notes: "模型/后端接口失败，未进入可验证执行结果。" }],
    risks: ["这是执行层模型/后端健康问题，不是用户业务口径问题；需要 HA 判断是否重试、切换模型或提示用户处理配置/额度/服务可用性。"],
  };
}

function isAgentBackendFailureEgoResult(egoResult: EgoResult): boolean {
  return egoResult.summary.startsWith("Ego 模型/后端调用失败：");
}

function routeAgentBackendFailureToCritique(role: "Ego", egoResult: EgoResult, iteration: number): CritiqueResult {
  return {
    blocking_issues: 1,
    quality_score: 0,
    summary: `${role} 第 ${iteration} 轮模型/后端调用失败，不能交给 Superego 做业务审计：${egoResult.summary}`,
    next_action: "escalate",
    entropyDelta: "unknown",
    evidenceQuality: 0,
    remainingUncertainty: 1,
    nextBestObservation: "交给 HA 判断是否重试、切换模型、恢复 provider 配置/认证/额度，或直接向用户显示后端健康问题。",
    critique_items: [
      {
        category: "agent_backend_error",
        severity: "high",
        suggestion: egoResult.final_response,
      },
    ],
  };
}

function agentBackendFailureCritique(role: "Superego", diagnostic: AgentBackendDiagnostic, iteration: number): CritiqueResult {
  return {
    blocking_issues: 1,
    quality_score: 0,
    summary: `${role} 第 ${iteration} 轮模型/后端调用失败：${diagnostic.code}。该问题已交给 HA 判断。`,
    next_action: "escalate",
    entropyDelta: "unknown",
    evidenceQuality: 0,
    remainingUncertainty: 1,
    nextBestObservation: "HA 应基于 Ego 结果、AuditPacket 和 Superego 失败诊断判断是否可跳过 Superego、重试、切换模型，或提示用户处理后端配置。",
    critique_items: [
      {
        category: "agent_backend_error",
        severity: "high",
        suggestion: `${role} 模型/后端接口失败：code=${diagnostic.code}, retryable=${diagnostic.retryable}, status=${diagnostic.status ?? "未提供"}, message=${diagnostic.message}`,
      },
    ],
  };
}

function haFrameworkFailureDecision(stage: string, diagnostic: AgentBackendDiagnostic): HaDecision {
  return {
    intent_type: "conversation",
    next_action: "answer",
    response: formatHaFrameworkFailureText(stage, diagnostic),
    acceptance_contract: "",
    readonly_input_paths: [],
    allowed_output_paths: [],
    rationale: `HA ${stage}阶段模型/后端失败：${diagnostic.code}`,
  };
}

function haFrameworkFailureReview(stage: string, diagnostic: AgentBackendDiagnostic): CritiqueResult {
  return {
    blocking_issues: 1,
    quality_score: 0,
    summary: formatHaFrameworkFailureText(stage, diagnostic),
    next_action: "escalate",
    entropyDelta: "unknown",
    evidenceQuality: 0,
    remainingUncertainty: 1,
    nextBestObservation: diagnostic.retryable ? "可在恢复 provider 后重试，或切换 HA 模型后重跑终验。" : "需要修复 HA 模型配置、认证、模型名或 provider 后再继续。",
    critique_items: [
      {
        category: "ha_backend_error",
        severity: "high",
        suggestion: `HA ${stage}阶段无法完成：code=${diagnostic.code}, retryable=${diagnostic.retryable}, status=${diagnostic.status ?? "未提供"}, message=${diagnostic.message}`,
      },
    ],
  };
}

function formatHaFrameworkFailureText(stage: string, diagnostic: AgentBackendDiagnostic): string {
  const retry = diagnostic.retryable ? "这个错误可能是临时性的，可以稍后重试或切换模型。" : "这个错误通常需要修复模型配置、认证、模型名或 provider。";
  const status = diagnostic.status !== undefined ? `HTTP 状态：${diagnostic.status}。` : "";
  return `HA ${stage}阶段无法正常运行，MAS 已直接显示框架诊断。\n\n错误码：${diagnostic.code}\n${status}\n错误信息：${diagnostic.message}\n${retry}`;
}

export function enforceHaFinalReviewGate(review: CritiqueResult, context?: { egoResult?: EgoResult }): CritiqueResult {
  if (review.next_action === "accept" && context?.egoResult && context.egoResult.status !== "completed") {
    return {
      ...review,
      blocking_issues: Math.max(review.blocking_issues, 1),
      quality_score: Math.min(review.quality_score, 0.4),
      summary: review.summary.trim() || `Ego 当前状态为 ${context.egoResult.status}，HA 不能把未完成执行验收为通过。`,
      next_action: "revise",
      evidenceQuality: review.evidenceQuality ?? 0,
      remainingUncertainty: Math.max(review.remainingUncertainty ?? 0, 0.7),
      nextBestObservation: review.nextBestObservation?.trim() || "要求 Ego 基于当前阻塞说明继续推进；只有 HA 确认确实需要用户输入时才升级人工介入。",
      critique_items: [
        ...review.critique_items,
        {
          category: "ha_final_review_gate",
          severity: "high",
          suggestion: "Ego/Superego 的 needs_attention 或 blocked 只是内部状态信号；HA 必须从用户视角判断应返工还是确实需要用户介入，不能直接 accept 未完成结果。",
        },
      ],
    };
  }
  if (review.next_action !== "accept") return review;
  const evidenceQuality = review.evidenceQuality ?? 0;
  const hasSummary = review.summary.trim().length > 0;
  if (review.quality_score > 0 && evidenceQuality > 0 && hasSummary) return review;
  return {
    ...review,
    blocking_issues: Math.max(review.blocking_issues, 1),
    quality_score: Math.min(review.quality_score, 0.2),
    summary: hasSummary ? review.summary : "HA 终验未提供有效摘要或独立验收证据，不能接受空壳 accept。",
    next_action: "escalate",
    evidenceQuality,
    remainingUncertainty: Math.max(review.remainingUncertainty ?? 0, 0.8),
    nextBestObservation: review.nextBestObservation?.trim() || "重新执行 HA 终验：使用只读本地检查、必要的只读 Python 复算或外部证据核对后，再提交 ha_final_review。",
    critique_items: [
      ...review.critique_items,
      {
        category: "ha_final_review_gate",
        severity: "high",
        suggestion: "HA 终验 accept 必须包含非空摘要、正向质量评分和正向证据质量；空壳 accept 应升级人工或返工。",
      },
    ],
  };
}

export function routeEgoAttentionToCritique(egoResult: EgoResult, iteration: number): CritiqueResult {
  return {
    blocking_issues: 1,
    quality_score: 0,
    summary: `Ego 第 ${iteration} 轮上报 ${egoResult.status}：${egoResult.summary || "未提供摘要"}。该信号只作为内部返工依据，不等同于用户需要人工介入。`,
    next_action: "revise",
    entropyDelta: "unknown",
    evidenceQuality: 0,
    remainingUncertainty: 1,
    nextBestObservation: "让 Ego 继续推进可自动处理的部分，并把真正需要用户确认的外部缺口具体化；最终是否人工介入由 HA 终验决定。",
    critique_items: [
      {
        category: "ego_attention_signal",
        severity: "high",
        suggestion: `Ego 状态为 ${egoResult.status}。如果缺口不是用户输入、外部凭据、审批拒绝或硬环境限制，应继续执行而不是停止。`,
      },
      ...egoResult.risks.slice(0, 6).map((risk) => ({
        category: "ego_reported_risk",
        severity: "medium" as const,
        suggestion: risk,
      })),
    ],
  };
}

export function isEgoStructuredOutputFailure(egoResult: EgoResult): boolean {
  return (
    egoResult.status === "needs_attention" &&
    egoResult.summary.startsWith("Ego 执行结果 JSON 解析失败且自修复失败：") &&
    egoResult.evidence.length === 0 &&
    egoResult.changed_files.length === 0 &&
    egoResult.verification.length === 1 &&
    egoResult.verification[0]?.result === "not_run" &&
    egoResult.verification[0]?.notes.includes("Ego 结构化输出解析失败")
  );
}

export function routeEgoStructuredFailureToCritique(egoResult: EgoResult, iteration: number, consecutiveFailures: number, threshold: number): CritiqueResult {
  const reachedThreshold = consecutiveFailures >= threshold;
  return {
    blocking_issues: 1,
    quality_score: 0,
    summary: `Ego 第 ${iteration} 轮未提交可解析结构化结果（连续 ${consecutiveFailures}/${threshold}）。这是执行层通信/结构化输出失败，不能交给 Superego 重新审计空结果。`,
    next_action: reachedThreshold ? "escalate" : "revise",
    entropyDelta: "unknown",
    evidenceQuality: 0,
    remainingUncertainty: 1,
    nextBestObservation: reachedThreshold
      ? "交给 HA 从用户代理视角判断：是否存在可自动恢复路径，还是需要向用户报告 Ego 后端/模型连续空响应。"
      : "直接打回 Ego：下一轮必须先完成任务或明确真实阻塞，并调用 ego_result 提交结构化结果。",
    critique_items: [
      {
        category: "ego_structured_output_failure",
        severity: "high",
        suggestion: "Ego 没有形成可审计交付物。Superego 不应审计空结果；应由框架把该失败作为下一轮 Ego 的返工输入。",
      },
      {
        category: "recovery_instruction",
        severity: reachedThreshold ? "high" : "medium",
        suggestion: reachedThreshold
          ? "Ego 连续结构化失败达到阈值，交给 HA 判断是否需要人工介入或更换/恢复执行后端。"
          : "下一轮 Ego 必须调用 ego_result；如果工具调用不可用，需要在可见文本中输出完整 JSON 结构，不能静默结束。",
      },
      ...egoResult.risks.slice(0, 4).map((risk) => ({
        category: "ego_reported_risk",
        severity: "medium" as const,
        suggestion: risk,
      })),
    ],
  };
}

export function routeSuperegoReviewForOrchestration(review: CritiqueResult, egoResult?: EgoResult): CritiqueResult {
  if (review.next_action === "accept" && egoResult && egoResult.status !== "completed") {
    return {
      ...review,
      blocking_issues: Math.max(review.blocking_issues, 1),
      quality_score: Math.min(review.quality_score, 0.3),
      summary: `Superego 不能接受 Ego 的未完成状态：${egoResult.status}。${review.summary}`.trim(),
      next_action: "revise",
      evidenceQuality: Math.min(review.evidenceQuality ?? 0, 0.3),
      remainingUncertainty: Math.max(review.remainingUncertainty ?? 0, 0.8),
      nextBestObservation: review.nextBestObservation?.trim() || "要求 Ego 继续完成缺失交付并补充验证证据。",
      critique_items: [
        ...review.critique_items,
        {
          category: "non_completed_ego_accept",
          severity: "high",
          suggestion: "Ego 仍处于 blocked/needs_attention 时，Superego 不能把内部求助信号升级成通过；应转为返工要求。",
        },
      ],
    };
  }
  return review;
}

export function formatNeedsAttentionResult(input: {
  headline: string;
  haFinalReview?: CritiqueResult;
  superegoReview?: CritiqueResult;
  egoOutput?: string;
}): string {
  const sections = [input.headline.trim()];
  if (input.haFinalReview) sections.push(formatCritiqueForUser("HA 终验批注", input.haFinalReview));
  if (input.superegoReview) sections.push(formatCritiqueForUser("Superego 批注", input.superegoReview));
  const egoOutput = input.egoOutput?.trim();
  if (egoOutput) sections.push(`最后 Ego 输出：\n${egoOutput}`);
  return sections.filter(Boolean).join("\n\n");
}

function formatCritiqueForUser(title: string, critique: CritiqueResult): string {
  const lines = [
    `${title}：`,
    `- 结论：${formatAction(critique.next_action, title)}`,
    `- 阻塞问题：${critique.blocking_issues}`,
    `- 质量分：${formatScore(critique.quality_score)}`,
    `- 证据质量：${formatScore(critique.evidenceQuality)}`,
    `- 剩余不确定性：${formatScore(critique.remainingUncertainty)}`,
    `- 摘要：${cleanReviewText(critique.summary) || "未提供有效摘要"}`,
  ];
  const nextBestObservation = cleanReviewText(critique.nextBestObservation);
  if (nextBestObservation) lines.push(`- 下一步观察：${nextBestObservation}`);
  critique.critique_items.slice(0, 8).forEach((item, index) => {
    lines.push(`- 批注 ${index + 1} [${item.severity}/${item.category}]：${cleanReviewText(item.suggestion) || "未提供建议"}`);
  });
  if (critique.critique_items.length > 8) lines.push(`- 其余批注：${critique.critique_items.length - 8} 条已省略`);
  return lines.join("\n");
}

function formatAction(action: CritiqueResult["next_action"], title = ""): string {
  if (action === "accept") return "通过";
  if (action === "revise") return "需要返工";
  if (!title.startsWith("HA")) return "升级给 HA 裁决";
  return "需要人工介入";
}

function formatScore(score: number | undefined): string {
  return typeof score === "number" && Number.isFinite(score) ? String(score) : "未提供";
}

function cleanReviewText(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function compactEgoResultForReview(egoResult: EgoResult): unknown {
  return {
    status: egoResult.status,
    summary: egoResult.summary,
    final_response: compactTextForReview(egoResult.final_response, 4000),
    evidence: egoResult.evidence.slice(-20).map((item) => compactTextForReview(item, 800)),
    changed_files: egoResult.changed_files,
    verification: egoResult.verification.slice(-20).map((item) => ({
      command: compactTextForReview(item.command, 500),
      result: item.result,
      notes: compactTextForReview(item.notes, 800),
    })),
    risks: egoResult.risks.slice(-20).map((item) => compactTextForReview(item, 800)),
  };
}

function compactTextForReview(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.floor(maxChars / 2))}\n... 已压缩 ${normalized.length - maxChars} 字符 ...\n${normalized.slice(-Math.ceil(maxChars / 2))}`;
}

function buildTaskWithConversation(
  prompt: string,
  history?: ConversationTurn[],
  summary?: string,
  availableSkills?: Array<{ name: string; description: string }>,
): string {
  const recentHistory = trimHistory(history ?? []);
  const hasSummary = Boolean(summary?.trim());
  const hasSkills = Boolean(availableSkills?.length);
  if (recentHistory.length === 0 && !hasSummary && !hasSkills) return prompt;
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
  parts.push(`当前用户请求：${prompt}`);
  return parts.join("\n");
}

function renderEgoSessionContext(runs: AgentRunRecord[]): string {
  const unique = new Map<number, AgentRunRecord>();
  for (const run of runs) unique.set(run.id, run);
  const selected = Array.from(unique.values()).slice(-8);
  if (selected.length === 0) return "";
  const parts = [
    "以下是同一 AionUI 会话中 Ego 之前的执行上下文摘要。它只用于保持连续性和避免重复返工，不是新用户指令；若与当前用户目标、HA 验收合同、Superego/HA 批注或当前文件证据冲突，以后者为准。",
  ];
  for (const run of selected) {
    parts.push(`- run=${run.runId} iteration=${run.iteration} status=${run.status}: ${summarizeEgoRun(run)}`);
  }
  return parts.join("\n").slice(-6000);
}

function summarizeEgoRun(run: AgentRunRecord): string {
  const output = asRecord(run.output);
  const result = asRecord(output.result);
  const pieces = [
    stringField(result.status) ? `result=${stringField(result.status)}` : "",
    stringField(result.summary) ?? stringField(output.error) ?? stringField(output.text),
  ].filter(Boolean);
  const changedFiles = stringArrayField(result.changed_files).slice(0, 5);
  if (changedFiles.length > 0) pieces.push(`changed_files=${changedFiles.join(", ")}`);
  const risks = stringArrayField(result.risks).slice(0, 3);
  if (risks.length > 0) pieces.push(`risks=${risks.join(" | ")}`);
  return normalizeInline(pieces.join("；")).slice(0, 700) || "无可用摘要。";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

function summarizeContextInjection(options: MasRunOptions): {
  historyTurns: number;
  hasConversationSummary: boolean;
  memoryToolsAvailable: boolean;
  availableSkills: string[];
} {
  return {
    historyTurns: options.conversationHistory?.length ?? 0,
    hasConversationSummary: Boolean(options.conversationSummary?.trim()),
    memoryToolsAvailable: true,
    availableSkills: options.availableSkills?.map((skill) => skill.name) ?? [],
  };
}

function summarizePerturbation(candidate: ContextPerturbation | undefined): {
  perturbationId?: string;
  targetRole?: ContextPerturbation["targetRole"];
  trigger?: string;
  injectionPoint?: ContextPerturbation["injectionPoint"];
  type?: ContextPerturbation["type"];
  contextPatchHash?: string;
  summary?: string;
  payload?: unknown;
} {
  if (!candidate) return {};
  return {
    perturbationId: candidate.perturbationId,
    targetRole: candidate.targetRole,
    trigger: candidate.trigger,
    injectionPoint: candidate.injectionPoint,
    type: candidate.type,
    contextPatchHash: candidate.contextPatchHash,
    summary: candidate.summary.slice(0, 800),
    payload: candidate.payload,
  };
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
