import { createHash } from "node:crypto";
import { MasStore } from "../storage.js";
import type { CritiqueResult, EgoResult, EntropyLedger, LowEntropySignalInput } from "../types.js";

export interface RunEntropyInput {
  runId: string;
  goalId?: string;
  status: "completed" | "needs_attention" | "failed";
  result: string;
  egoResult?: EgoResult;
  critique?: CritiqueResult;
  reason?: string;
}

export function recordRunEntropy(store: MasStore, input: RunEntropyInput): EntropyLedger {
  const signals = collectSignals(store, input);
  const signalIds = signals.map((signal) => store.addLowEntropySignal(signal));
  const ledgerInput = scoreLedger(input, signalIds);
  const ledgerId = store.addEntropyLedger(ledgerInput);
  const ledger = store.listEntropyLedgers({ runId: input.runId, limit: 1 })[0];
  if (!ledger || ledger.ledgerId !== ledgerId) {
    throw new Error(`EntropyLedger 写入后无法读取：${ledgerId}`);
  }
  return ledger;
}

function collectSignals(store: MasStore, input: RunEntropyInput): LowEntropySignalInput[] {
  const signals: LowEntropySignalInput[] = [];
  for (const item of input.egoResult?.verification ?? []) {
    const type = verificationSignalType(item.command);
    signals.push(baseSignal(input, {
      type,
      summary: `${item.result}: ${item.command || "未声明命令"} - ${item.notes}`,
      confidence: item.result === "passed" ? 0.85 : item.result === "failed" ? 0.9 : 0.35,
      sourceKind: "command_output",
      payload: item,
    }));
  }

  const approvals = store.listApprovals(input.runId);
  for (const approval of approvals) {
    signals.push(baseSignal(input, {
      type: "approval_decision",
      summary: `${approval.decision}: ${approval.toolName}`,
      confidence: 0.8,
      sourceKind: "approval",
      payload: approval,
    }));
  }

  for (const audit of store.listAuditLog(input.runId, 300)) {
    if (audit.action === "audit_packet_built") {
      const payload = asRecord(audit.payload);
      const findings = Array.isArray(payload.findings) ? payload.findings : [];
      if (findings.length === 0) {
        signals.push(baseSignal(input, {
          type: "audit_finding",
          summary: "AuditPacket built with no findings.",
          confidence: 0.7,
          sourceKind: "derived",
          payload: { action: audit.action, findingCount: 0 },
        }));
      }
      for (const finding of findings) {
        const item = asRecord(finding);
        signals.push(baseSignal(input, {
          type: "audit_finding",
          summary: `AuditPacket finding: ${[item.severity, item.category, item.message].filter(Boolean).map(String).join(" - ").slice(0, 700)}`,
          confidence: item.severity === "high" ? 0.85 : 0.75,
          sourceKind: "derived",
          payload: { action: audit.action, finding },
        }));
      }
    }
    if (audit.action === "audit_packet_artifact_written") {
      const payload = asRecord(audit.payload);
      const summary = asRecord(payload.summary);
      const counts = asRecord(summary.counts);
      const findingCount = numberValue(counts.findings) ?? 0;
      if (findingCount === 0) {
        signals.push(baseSignal(input, {
          type: "audit_finding",
          summary: "AuditPacket artifact written with no findings.",
          confidence: 0.75,
          sourceKind: "derived",
          payload: { action: audit.action, artifactId: payload.artifactId, findingCount: 0 },
        }));
      }
      const highlights = Array.isArray(summary.highlights) ? summary.highlights : [];
      for (const highlight of highlights) {
        signals.push(baseSignal(input, {
          type: "audit_finding",
          summary: `AuditPacket artifact: ${String(highlight).slice(0, 700)}`,
          confidence: findingCount > 0 ? 0.85 : 0.65,
          sourceKind: "derived",
          payload: { action: audit.action, artifactId: payload.artifactId, highlight, counts },
        }));
      }
    }
    if (audit.action === "boundary_snapshot_baseline") {
      signals.push(baseSignal(input, {
        type: "schema_validation",
        summary: "Boundary baseline snapshot captured before Ego execution.",
        confidence: 0.55,
        sourceKind: "derived",
        payload: audit.payload,
      }));
    }
  }

  for (const file of input.egoResult?.changed_files ?? []) {
    signals.push(baseSignal(input, {
      type: "diff",
      summary: `Ego reported changed file: ${file}`,
      confidence: 0.55,
      sourceKind: "derived",
      sourceUri: file,
      payload: { path: file },
    }));
  }

  for (const item of input.critique?.critique_items ?? []) {
    if (item.severity === "high" || input.critique?.blocking_issues) {
      signals.push(baseSignal(input, {
        type: "audit_finding",
        summary: `${item.severity}: ${item.category} - ${item.suggestion}`,
        confidence: item.severity === "high" ? 0.85 : 0.7,
        sourceKind: "derived",
        payload: item,
      }));
    }
  }

  if (signals.length === 0) {
    signals.push(baseSignal(input, {
      type: "schema_validation",
      summary: `run ${input.status}: ${input.reason ?? "no_structured_signal"}`,
      confidence: input.status === "completed" ? 0.4 : 0.65,
      sourceKind: "derived",
      payload: { status: input.status, reason: input.reason, resultHash: hashText(input.result) },
    }));
  }
  return signals;
}

function scoreLedger(input: RunEntropyInput, signalIds: string[]): Parameters<MasStore["addEntropyLedger"]>[0] {
  const verification = input.egoResult?.verification ?? [];
  const requiredFailures = verification.filter((item) => item.result === "failed");
  const notRun = verification.filter((item) => item.result === "not_run");
  const approvalsRejected = input.reason?.includes("reject") ? 1 : 0;
  const blockingIssues = input.critique?.blocking_issues ?? 0;
  const deterministicGates: string[] = [];
  if (requiredFailures.length > 0) deterministicGates.push("validator_failed");
  if (blockingIssues > 0) deterministicGates.push("superego_blocking_issues");
  if (input.status !== "completed") deterministicGates.push("run_not_completed");
  if (notRun.length > 0) deterministicGates.push("verification_not_run");

  const passed = verification.filter((item) => item.result === "passed").length;
  const evidenceScore = clamp01(passed * 0.25 + (input.critique?.next_action === "accept" ? 0.2 : 0) + signalIds.length * 0.05);
  const modelEvidenceQuality = input.critique?.evidenceQuality;
  const remainingUncertainty = input.critique?.remainingUncertainty;
  const riskScore = clamp01(requiredFailures.length * 0.35 + notRun.length * 0.15 + blockingIssues * 0.3 + approvalsRejected * 0.3);
  const totalCriteria = Math.max(verification.length, 1);
  const unresolved = input.status === "completed" ? requiredFailures.length + notRun.length : totalCriteria;
  const uncertaintyScore = remainingUncertainty ?? clamp01(unresolved / totalCriteria);
  const evidenceQuality = modelEvidenceQuality ?? clamp01(evidenceScore - riskScore * 0.5 - uncertaintyScore * 0.3);
  const recommendation =
    input.status !== "completed" || blockingIssues > 0
      ? "revise"
      : riskScore >= 0.7
      ? "escalate"
      : uncertaintyScore > 0.5
      ? "pause"
      : "continue";

  return {
    runId: input.runId,
    goalId: input.goalId,
    openQuestions: buildOpenQuestions(input, notRun),
    signalIds,
    uncertaintyScore,
    evidenceScore,
    riskScore,
    informationGainScore: informationGain(input.critique?.entropyDelta, evidenceScore, riskScore),
    evidenceQuality,
    nextBestObservation: input.critique?.nextBestObservation || nextBestObservation(input, deterministicGates),
    recommendation,
    deterministicGates,
    payload: {
      status: input.status,
      reason: input.reason,
      critiqueNextAction: input.critique?.next_action,
    },
  };
}

function baseSignal(
  input: RunEntropyInput,
  patch: Pick<LowEntropySignalInput, "type" | "summary" | "confidence" | "sourceKind" | "sourceUri" | "payload">,
): LowEntropySignalInput {
  return {
    runId: input.runId,
    goalId: input.goalId,
    type: patch.type,
    summary: patch.summary.slice(0, 1000),
    confidence: patch.confidence,
    scope: input.goalId ? "goal" : "run",
    freshness: "current",
    sourceKind: patch.sourceKind,
    sourceUri: patch.sourceUri,
    sourceHash: hashText(JSON.stringify(patch.payload ?? patch.summary)),
    retentionPolicy: "project",
    sensitivity: "internal",
    redactionStatus: "not_needed",
    secretScanStatus: "not_scanned",
    payload: patch.payload,
  };
}

function verificationSignalType(command: string): LowEntropySignalInput["type"] {
  const lower = command.toLowerCase();
  if (lower.includes("typecheck") || lower.includes("tsc")) return "typecheck_result";
  if (lower.includes("lint")) return "lint_result";
  if (lower.includes("schema")) return "schema_validation";
  return "test_result";
}

function buildOpenQuestions(input: RunEntropyInput, notRun: EgoResult["verification"]): string[] {
  const questions: string[] = [];
  if (notRun.length > 0) questions.push("存在未运行的验证，需要后续补证。");
  if ((input.critique?.blocking_issues ?? 0) > 0) questions.push("Superego 仍有阻塞项，需要返工或人工判断。");
  if (input.status !== "completed") questions.push("本轮 run 未完成，任务结果不能作为完成证据。");
  return questions;
}

function nextBestObservation(input: RunEntropyInput, gates: string[]): string {
  if (gates.includes("validator_failed")) return "优先修复失败 validator 并重新运行同一检查。";
  if (gates.includes("verification_not_run")) return "补跑最小必要验证，记录命令、退出状态和摘要。";
  if (input.status !== "completed") return "获取用户反馈、环境状态或失败命令详情来降低不确定性。";
  return "等待用户反馈或后续相似任务验证经验是否可复用。";
}

function informationGain(delta: CritiqueResult["entropyDelta"], evidenceScore: number, riskScore: number): number {
  if (delta === "decreased") return clamp01(0.7 + evidenceScore * 0.2 - riskScore * 0.2);
  if (delta === "increased") return clamp01(0.2 - riskScore * 0.1);
  if (delta === "unchanged") return clamp01(0.15 + evidenceScore * 0.1 - riskScore * 0.1);
  return clamp01(evidenceScore - riskScore * 0.2);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
