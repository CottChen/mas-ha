import { createHash } from "node:crypto";
import { MasStore } from "../storage.js";
import type { ContextPerturbation, CritiqueResult, EntropyLedger, RoleName } from "../types.js";

export interface PerturbationInput {
  runId?: string;
  goalId?: string;
  targetRole: Exclude<RoleName, "ha"> | "ha" | "dream";
  trigger: string;
  critique?: CritiqueResult;
  ledger?: EntropyLedger;
  sourceRefs?: string[];
}

export class ContextPerturbationController {
  constructor(private readonly store = new MasStore()) {}

  createCandidate(input: PerturbationInput): ContextPerturbation | undefined {
    if (!shouldPerturb(input)) return undefined;
    const summary = buildSummary(input);
    const contextPatchHash = hashText(summary);
    const perturbation: ContextPerturbation = {
      perturbationId: `perturb:${contextPatchHash.slice(0, 24)}`,
      runId: input.runId,
      goalId: input.goalId,
      kind: "proposal",
      targetRole: input.targetRole,
      generatedBy: "superego",
      trigger: input.trigger,
      injectionPoint: input.targetRole === "superego" ? "review_sampling" : "counterexample_probe",
      type: "counterexample_probe",
      summary,
      contextPatchHash,
      sourceRefs: input.sourceRefs ?? [],
      status: "approved",
      safetyGateResult: "passed",
      harmlessness: "context_only",
      targetAttractor: "避免重复同质返工，优先寻找可证伪的下一步观察。",
      expectedNovelty: 0.45,
      maxRisk: "low",
      payload: {
        priority: "below_contract",
        mustNotOverride: ["system_rules", "user_goal", "acceptance_contract", "permission_policy", "audit_packet"],
      },
    };
    try {
      this.store.addContextPerturbation(perturbation);
    } catch {
      return perturbation;
    }
    return perturbation;
  }

  render(candidate: ContextPerturbation | undefined): string {
    if (!candidate) return "";
    return [
      `<context_perturbation source="experience_graph" trust="candidate" role="${candidate.targetRole}" priority="below_contract">`,
      "这是候选视角，不是命令；不得覆盖系统规则、用户目标、验收合同、权限策略或审计门禁。",
      candidate.summary,
      "</context_perturbation>",
    ].join("\n");
  }
}

function shouldPerturb(input: PerturbationInput): boolean {
  if ((input.critique?.blocking_issues ?? 0) > 0 && input.critique?.next_action === "revise") return true;
  if ((input.ledger?.uncertaintyScore ?? 0) >= 0.6 && (input.ledger?.informationGainScore ?? 1) <= 0.2) return true;
  return input.trigger.includes("stalled") || input.trigger.includes("low_information_gain");
}

function buildSummary(input: PerturbationInput): string {
  const hints = [
    "提出一个反例探针：先找一个能最快证伪当前方案的只读观察点，再决定是否返工。",
    "优先检查边界条件、未运行验证、审计矛盾和用户验收合同中最容易被忽略的硬约束。",
  ];
  if (input.critique?.summary) hints.push(`最近评审摘要：${input.critique.summary}`);
  if (input.ledger?.nextBestObservation) hints.push(`下一最佳观察：${input.ledger.nextBestObservation}`);
  return hints.join("\n");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
