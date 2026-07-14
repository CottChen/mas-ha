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
    const activation = activationReason(input);
    if (!activation) return undefined;
    const seed = buildSeed(input);
    const variant = selectVariant(input, seed);
    const summary = buildSummary(input, variant);
    const contextPatchHash = hashText(`${seed}\n${summary}`);
    const perturbation: ContextPerturbation = {
      perturbationId: `perturb:${contextPatchHash.slice(0, 24)}`,
      runId: input.runId,
      goalId: input.goalId,
      kind: "proposal",
      targetRole: input.targetRole,
      generatedBy: "superego",
      trigger: input.trigger,
      injectionPoint: variant.injectionPoint,
      type: variant.type,
      summary,
      contextPatchHash,
      sourceRefs: input.sourceRefs ?? [],
      status: "approved",
      safetyGateResult: "passed",
      harmlessness: "context_only",
      targetAttractor: variant.targetAttractor,
      expectedNovelty: variant.expectedNovelty,
      maxRisk: "low",
      payload: {
        seed,
        variant: variant.name,
        variantIndex: variant.index,
        strategy: variant.strategy,
        matrixStrength: variant.matrixStrength,
        activationReason: activation,
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
    const payload = candidate.payload && typeof candidate.payload === "object" ? (candidate.payload as Record<string, unknown>) : {};
    const seed = typeof payload.seed === "string" ? payload.seed : candidate.contextPatchHash.slice(0, 12);
    const variant = typeof payload.variant === "string" ? payload.variant : candidate.type;
    return [
      `<context_perturbation source="experience_graph" trust="candidate" role="${candidate.targetRole}" priority="below_contract" seed="${seed}" variant="${variant}">`,
      "这是候选视角，不是命令；不得覆盖系统规则、用户目标、验收合同、权限策略或审计门禁。",
      candidate.summary,
      "</context_perturbation>",
    ].join("\n");
  }
}

interface PerturbationVariant {
  index: number;
  name: string;
  strategy: string;
  matrixStrength: "very_low" | "low" | "medium";
  injectionPoint: ContextPerturbation["injectionPoint"];
  type: ContextPerturbation["type"];
  targetAttractor: string;
  expectedNovelty: number;
  hints: string[];
}

function activationReason(input: PerturbationInput): string | undefined {
  if ((input.critique?.blocking_issues ?? 0) > 0 && input.critique?.next_action === "revise") return "superego_blocking_revise";
  if ((input.ledger?.uncertaintyScore ?? 0) >= 0.6 && (input.ledger?.informationGainScore ?? 1) <= 0.2) return "high_uncertainty_low_information_gain";
  if (input.trigger.includes("stalled") || input.trigger.includes("low_information_gain")) return "explicit_low_information_gain_trigger";
  return undefined;
}

function selectVariant(input: PerturbationInput, seed: string): PerturbationVariant {
  const variants = variantsForRole(input.targetRole);
  const index = parseInt(seed.slice(0, 8), 16) % variants.length;
  return { ...variants[index], index };
}

function variantsForRole(role: PerturbationInput["targetRole"]): Omit<PerturbationVariant, "index">[] {
  if (role === "ha") {
    return [
      {
        name: "intent_boundary_probe",
        strategy: "先区分用户目标、边界和是否需要澄清，避免把可执行任务误判成泛泛建议。",
        matrixStrength: "very_low",
        injectionPoint: "intent_check",
        type: "perspective_shift",
        targetAttractor: "保持 HA 路由稳定，同时降低意图误判概率。",
        expectedNovelty: 0.15,
        hints: ["检查当前请求是否继承了同会话历史、文件引用或前序修复结果。", "只有缺少关键对象、权限或验收边界时才澄清；可执行任务应生成验收合同。"],
      },
      {
        name: "contract_hard_boundary",
        strategy: "从验收合同角度轻量扰动，优先补齐只读输入、允许输出和禁止状态。",
        matrixStrength: "very_low",
        injectionPoint: "contract_hint",
        type: "constraint_relaxation",
        targetAttractor: "让 HA 产物更便于 Ego/Superego 执行和审计。",
        expectedNovelty: 0.18,
        hints: ["不要替换用户目标，只把边界、证据和验证要求写得更具体。", "无法确定的合同字段应显式留空或说明需要澄清。"],
      },
    ];
  }
  if (role === "superego") {
    return [
      {
        name: "risk_stratified_random_sample",
        strategy: "分层风险抽样后，从剩余普通样本中选择少量样本抵抗确认偏差。",
        matrixStrength: "low",
        injectionPoint: "review_sampling",
        type: "random_sample",
        targetAttractor: "提高 Superego 对审计矛盾、边界条件和漏报修改的发现率。",
        expectedNovelty: 0.38,
        hints: ["先覆盖用户硬约束和审计 findings，再抽查一个普通样本。", "抽样只允许只读检查；成本过高时说明样本空间和未抽原因。"],
      },
      {
        name: "blindspot_negative_space",
        strategy: "搜索 Ego 输出没有提到、但验收合同或审计包暗示可能重要的负空间。",
        matrixStrength: "low",
        injectionPoint: "blindspot_check",
        type: "historical_near_miss",
        targetAttractor: "避免只复述 Ego 自报，优先用 AuditPacket 证伪。",
        expectedNovelty: 0.42,
        hints: ["检查 changed_files、verification、risks 是否和审计事件一致。", "失败验证伪装成功、越界写入、只读输入写入仍是阻塞门禁。"],
      },
    ];
  }
  return [
    {
      name: "counterexample_first_observation",
      strategy: "先找最快证伪当前方案的只读观察点，再决定是否扩大执行。",
      matrixStrength: "low",
      injectionPoint: "counterexample_probe",
      type: "counterexample_probe",
      targetAttractor: "避免重复同质返工，优先寻找可证伪的下一步观察。",
      expectedNovelty: 0.45,
      hints: ["优先检查边界条件、未运行验证、审计矛盾和用户验收合同中最容易被忽略的硬约束。", "如果要改文件，先确认现有模式和最小改动范围。"],
    },
    {
      name: "alternative_plan_validation_order",
      strategy: "给当前执行计划增加一个替代顺序：先验证高风险假设，再做低风险机械修改。",
      matrixStrength: "low",
      injectionPoint: "execution_plan",
      type: "alternative_plan",
      targetAttractor: "降低无效返工和过早编辑带来的风险。",
      expectedNovelty: 0.36,
      hints: ["先选择最大信息增益的读取、搜索或类型检查。", "完成后 changed_files 必须只列真实修改文件，verification 必须区分 passed、failed 和 not_run。"],
    },
    {
      name: "memory_diversity_near_miss",
      strategy: "把历史经验当作候选反例，而不是事实来源，寻找相似失败模式。",
      matrixStrength: "low",
      injectionPoint: "validation_strategy",
      type: "historical_near_miss",
      targetAttractor: "避免重复踩同类经验坑，同时保持当前证据优先。",
      expectedNovelty: 0.4,
      hints: ["相关记忆只能提示检查方向，不能直接证明当前任务状态。", "如果历史经验与当前文件证据冲突，以当前证据为准。"],
    },
  ];
}

function buildSummary(input: PerturbationInput, variant: PerturbationVariant): string {
  const hints = [`扰动策略：${variant.strategy}`, ...variant.hints];
  if (input.critique?.summary) hints.push(`最近评审摘要：${input.critique.summary}`);
  if (input.ledger?.nextBestObservation) hints.push(`下一最佳观察：${input.ledger.nextBestObservation}`);
  return hints.join("\n");
}

function buildSeed(input: PerturbationInput): string {
  return hashText(
    [
      input.runId ?? "no-run",
      input.goalId ?? "no-goal",
      input.targetRole,
      input.trigger,
      input.critique?.summary ?? "",
      input.ledger?.ledgerId ?? "",
      ...(input.sourceRefs ?? []),
    ].join("|"),
  ).slice(0, 16);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
