import type { CritiqueResult, EgoResult, HaDecision } from "../types.js";

const SHARED_AGENT_PRINCIPLES = [
  "共通原则：",
  "- 你是务实的人类助理，不是只会聊天的包装器；能完成就推进，不能安全完成才说明阻塞。",
  "- 先理解上下文，再行动；读文件、搜索、检查事实时要有证据，不要凭空猜测。",
  "- 内部工作可以主动，外部副作用必须谨慎；写文件、编辑文件、执行命令必须尊重 MAS 权限策略。",
  "- 对代码和命令保持严谨：说明关键假设，优先小范围改动，验证结果，避免无关重构。",
  "- 输出要简洁、直接、中文优先；不要暴露不必要的内部角色细节，除非用户询问架构。",
].join("\n");

export function buildHaDecisionPrompt(task: string): string {
  return [
    "你是 MAS 的 HA：直接面对用户的人类助理、编排者和协调者。",
    SHARED_AGENT_PRINCIPLES,
    "",
    "你的职责：",
    "- 判断用户请求是否应该直接由 HA 回答，还是需要交给 Ego 执行。",
    "- 简单问候、身份询问、概念解释、澄清类问题，应由你直接回答或追问。",
    "- 涉及读取项目、改代码、写文件、运行命令、验证结果、多步骤执行时，选择 execute，并生成验收合同。",
    "- 用户要求你安装依赖、安装技能、下载仓库、创建目录、复制文件、检查后修复或继续完成前序任务时，选择 execute；不要把可执行任务转成让用户手动操作的建议。",
    "- 只有确认当前工具和权限完全无法执行时才选择 clarify/answer，并必须说明已验证的阻塞事实。",
    "- 不要用固定关键词做机械判断；根据语义、风险和用户意图决策。",
    "",
    "必须调用 ha_decision 工具提交路由决策，并把它作为最终动作。",
    "不要输出普通文本、Markdown 代码块、解释、道歉或思考过程。",
    "ha_decision 参数：",
    '- next_action 只能是 "answer"、"execute" 或 "clarify"。',
    '- response：当 next_action=answer 或 clarify 时，填写直接给用户的中文回复；当 next_action=execute 时，填写空字符串。',
    '- acceptance_contract：当 next_action=execute 时，必须包含明确的完成目标、边界、证据和验证要求；当 next_action=answer 或 clarify 时，填写空字符串。',
    "- rationale：简短说明路由理由。",
    "当 next_action=answer 或 clarify 时，response 是直接给用户的中文回复；acceptance_contract 为空字符串。",
    "当 next_action=execute 时，response 为空字符串；acceptance_contract 必须包含明确的完成目标、边界、证据和验证要求。",
    "生成 acceptance_contract 时必须保留用户当前请求的真实对象和上下文。例如用户要求安装 Pi/browser 技能，就写安装该技能并验证技能可发现；不要改写成安装当前项目依赖。",
    "",
    `用户任务：${task}`,
  ].join("\n");
}

export function buildHaDecisionRepairPrompt(rawOutput: string, errorMessage: string): string {
  return [
    "上一条输出没有通过 MAS 路由 JSON 校验。",
    `错误：${errorMessage}`,
    "",
    "请把上一条意图重新改写为严格 JSON。不要解释，不要输出 Markdown 代码块，不要输出普通文本。",
    "JSON 格式：",
    '{"next_action":"answer","response":"","acceptance_contract":"","rationale":""}',
    "next_action 只能是 answer、execute 或 clarify。",
    "",
    "上一条输出：",
    rawOutput.slice(-8000),
  ].join("\n");
}

export function buildAcceptanceContract(task: string): string {
  return [
    "验收合同：",
    "1. 必须直接完成用户任务，不能只给建议。",
    "2. 需要保留关键操作证据：读取了什么、修改了什么、验证了什么。",
    "3. 如涉及代码或文件修改，必须尽量运行相关检查；无法运行时说明原因。",
    "4. 不做无关重构，不扩大任务边界。",
    "5. 如遇权限、环境、依赖、模型认证或外部系统阻塞，必须明确说明阻塞点和已验证事实。",
    "",
    `用户任务：${task}`,
  ].join("\n");
}

export function buildEgoPrompt(task: string, contract: string, critique?: CritiqueResult): string {
  const parts = [
    "你是 MAS 的 Ego 执行者，负责把 HA 的验收合同落到实际结果。",
    SHARED_AGENT_PRINCIPLES,
    "",
    "执行要求：",
    "- 对用户请求要有自主性：能通过读取、编辑、运行检查推进时，直接推进。",
    "- 改代码前先理解局部上下文；保持改动小而完整，不扩大边界。",
    "- 写文件、编辑文件、执行命令会由 MAS 权限系统审批；不要试图绕过审批。",
    "- 命令要可审计、可解释；危险或破坏性动作必须等待明确批准。",
    "- 完成后报告做了什么、验证了什么、还有什么风险。",
    "",
    "请按以下验收合同完成任务：",
    contract,
  ];
  if (critique) {
    parts.push("上一轮 Superego 批注如下，请针对阻塞问题返工：");
    parts.push(JSON.stringify(critique, null, 2));
  }
  parts.push(
    "请开始执行。执行过程中可以使用工具；所有必要操作完成后，最终输出必须是严格 JSON，不要输出 Markdown 代码块。",
    "最终 JSON 格式：",
    '{"status":"completed","summary":"","final_response":"","evidence":[],"changed_files":[],"verification":[{"command":"","result":"passed","notes":""}],"risks":[]}',
    "status 只能是 completed、needs_attention 或 blocked。",
    "final_response 是最终给用户看的中文回复，必须能独立说明结果。",
    "evidence 记录关键证据，例如读取了什么、修改了什么、验证了什么。",
    "changed_files 只列出实际修改过的文件路径；没有则为空数组。",
    "verification 每项必须包含 command、result、notes；result 只能是 passed、failed 或 not_run。",
    "risks 记录剩余风险或无法验证事项；没有则为空数组。",
  );
  return parts.join("\n\n");
}

export function buildEgoRepairPrompt(rawOutput: string, errorMessage: string): string {
  return [
    "上一条 Ego 最终输出没有通过 MAS 执行结果 JSON 校验。",
    `错误：${errorMessage}`,
    "",
    "请把上一条执行结果重新改写为严格 JSON。不要继续执行工具，不要解释，不要输出 Markdown 代码块，不要输出普通文本。",
    "JSON 格式：",
    '{"status":"completed","summary":"","final_response":"","evidence":[],"changed_files":[],"verification":[{"command":"","result":"passed","notes":""}],"risks":[]}',
    "status 只能是 completed、needs_attention 或 blocked。",
    "verification.result 只能是 passed、failed 或 not_run。",
    "如果无法确认已完成，status 使用 needs_attention 或 blocked，不要伪造成 completed。",
    "",
    "上一条输出：",
    rawOutput.slice(-12000),
  ].join("\n");
}

export function buildSuperegoPrompt(task: string, contract: string, egoOutput: string): string {
  return [
    "你是 MAS 的 Superego 评审者。请只评审，不要修改文件、不要执行命令。",
    SHARED_AGENT_PRINCIPLES,
    "根据用户任务、验收合同和 Ego 输出判断是否可以交给 HA 终验。",
    "重点评审：是否完成用户真实意图，是否越权，是否缺少验证，是否有不必要改动，是否把内部细节当用户价值。",
    "只输出严格 JSON，不要输出 Markdown 代码块。",
    "JSON 格式：",
    '{"blocking_issues":0,"quality_score":0.0,"summary":"","next_action":"accept","critique_items":[{"category":"","severity":"low","suggestion":""}]}',
    "next_action 只能是 accept、revise 或 escalate。",
    "不要使用 answer、execute、clarify、pass、complete、approve、reject、retry 等其他动作名。",
    "如果存在阻塞问题，next_action 必须是 revise 或 escalate，不能是 accept。",
    "critique_items 每一项必须包含 category、severity、suggestion；severity 只能是 low、medium 或 high。",
    "",
    `用户任务：${task}`,
    "",
    contract,
    "",
    "Ego 输出：",
    egoOutput.slice(-12000),
  ].join("\n");
}

export function buildSuperegoRepairPrompt(rawOutput: string, errorMessage: string): string {
  return [
    "上一条 Superego 输出没有通过 MAS 评审 JSON 校验。",
    `错误：${errorMessage}`,
    "",
    "请把上一条评审意图重新改写为严格 JSON。不要解释，不要输出 Markdown 代码块，不要输出普通文本。",
    "JSON 格式：",
    '{"blocking_issues":0,"quality_score":0.0,"summary":"","next_action":"accept","critique_items":[{"category":"","severity":"low","suggestion":""}]}',
    "next_action 只能是 accept、revise 或 escalate。",
    "如果原意是通过、approve、approved、pass、complete 或 ok，改写为 accept。",
    "如果原意是返工、retry、fix、rework、needs_revision 或 reject，改写为 revise。",
    "如果原意是阻塞、blocked、needs_attention 或需要人工介入，改写为 escalate。",
    "如果存在阻塞问题，blocking_issues 必须大于 0，next_action 必须是 revise 或 escalate。",
    "",
    "上一条输出：",
    rawOutput.slice(-8000),
  ].join("\n");
}

export function parseCritique(text: string): CritiqueResult {
  const jsonText = extractJson(text, "Superego");
  const parsed = JSON.parse(jsonText) as unknown;
  return validateCritique(parsed);
}

export function parseEgoResult(text: string): EgoResult {
  const jsonText = extractJson(text, "Ego");
  const parsed = JSON.parse(jsonText) as unknown;
  return validateEgoResult(parsed);
}

export function parseHaDecision(text: string): HaDecision {
  const jsonText = extractJson(text, "HA");
  const parsed = JSON.parse(jsonText) as unknown;
  return validateHaDecision(parsed);
}

function validateHaDecision(value: unknown): HaDecision {
  if (!value || typeof value !== "object") {
    throw new Error("HA JSON schema 校验失败：顶层必须是对象");
  }
  const parsed = value as Record<string, unknown>;
  const action = parsed.next_action;
  if (action !== "answer" && action !== "execute" && action !== "clarify") {
    throw new Error("HA JSON schema 校验失败：next_action 必须是 answer、execute 或 clarify");
  }
  const response = requireString(parsed.response, "response");
  const acceptanceContract = requireString(parsed.acceptance_contract, "acceptance_contract");
  const rationale = requireString(parsed.rationale, "rationale");
  if ((action === "answer" || action === "clarify") && !response.trim()) {
    throw new Error("HA JSON schema 校验失败：answer/clarify 必须提供 response");
  }
  if (action === "execute" && !acceptanceContract.trim()) {
    throw new Error("HA JSON schema 校验失败：execute 必须提供 acceptance_contract");
  }
  return {
    next_action: action,
    response,
    acceptance_contract: acceptanceContract,
    rationale,
  };
}

function validateEgoResult(value: unknown): EgoResult {
  if (!value || typeof value !== "object") {
    throw new Error("Ego JSON schema 校验失败：顶层必须是对象");
  }
  const parsed = value as Record<string, unknown>;
  const status = parsed.status;
  if (status !== "completed" && status !== "needs_attention" && status !== "blocked") {
    throw new Error("Ego JSON schema 校验失败：status 必须是 completed、needs_attention 或 blocked");
  }
  const summary = requireString(parsed.summary, "summary");
  const finalResponse = requireString(parsed.final_response, "final_response");
  if (!finalResponse.trim()) {
    throw new Error("Ego JSON schema 校验失败：final_response 不能为空");
  }
  const evidence = requireStringArray(parsed.evidence, "evidence");
  const changedFiles = requireStringArray(parsed.changed_files, "changed_files");
  if (!Array.isArray(parsed.verification)) {
    throw new Error("Ego JSON schema 校验失败：verification 必须是数组");
  }
  const risks = requireStringArray(parsed.risks, "risks");
  return {
    status,
    summary,
    final_response: finalResponse,
    evidence,
    changed_files: changedFiles,
    verification: parsed.verification.map((item, index) => validateVerification(item, index)),
    risks,
  };
}

function validateVerification(value: unknown, index: number): EgoResult["verification"][number] {
  if (!value || typeof value !== "object") {
    throw new Error(`Ego JSON schema 校验失败：verification[${index}] 必须是对象`);
  }
  const item = value as Record<string, unknown>;
  const command = requireString(item.command, `verification[${index}].command`);
  const result = item.result;
  if (result !== "passed" && result !== "failed" && result !== "not_run") {
    throw new Error(`Ego JSON schema 校验失败：verification[${index}].result 必须是 passed、failed 或 not_run`);
  }
  const notes = requireString(item.notes, `verification[${index}].notes`);
  return { command, result, notes };
}

function validateCritique(value: unknown): CritiqueResult {
  if (!value || typeof value !== "object") {
    throw new Error("Superego JSON schema 校验失败：顶层必须是对象");
  }
  const parsed = value as Record<string, unknown>;
  const blockingIssues = toFiniteNumber(parsed.blocking_issues, "blocking_issues");
  const qualityScore = toFiniteNumber(parsed.quality_score, "quality_score");
  const summary = requireString(parsed.summary, "summary");
  const nextAction = normalizeNextAction(parsed.next_action, blockingIssues);
  if (!Array.isArray(parsed.critique_items)) {
    throw new Error("Superego JSON schema 校验失败：critique_items 必须是数组");
  }

  return {
    blocking_issues: blockingIssues,
    quality_score: qualityScore,
    summary,
    next_action: nextAction,
    critique_items: parsed.critique_items.map((item, index) => validateCritiqueItem(item, index)),
  };
}

function validateCritiqueItem(value: unknown, index: number): CritiqueResult["critique_items"][number] {
  if (!value || typeof value !== "object") {
    throw new Error(`Superego JSON schema 校验失败：critique_items[${index}] 必须是对象`);
  }
  const item = value as Record<string, unknown>;
  const category = requireString(item.category, `critique_items[${index}].category`);
  const suggestion = requireString(item.suggestion, `critique_items[${index}].suggestion`);
  const severity = item.severity;
  if (severity !== "low" && severity !== "medium" && severity !== "high") {
    throw new Error(`Superego JSON schema 校验失败：critique_items[${index}].severity 必须是 low、medium 或 high`);
  }
  return { category, severity, suggestion };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`JSON schema 校验失败：${field} 必须是字符串`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`JSON schema 校验失败：${field} 必须是字符串数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`JSON schema 校验失败：${field}[${index}] 必须是字符串`);
    }
    return item;
  });
}

function toFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Superego JSON schema 校验失败：${field} 必须是数字`);
  }
  return value;
}

function normalizeNextAction(value: unknown, blockingIssues: number): CritiqueResult["next_action"] {
  if (typeof value !== "string") {
    throw new Error("Superego JSON schema 校验失败：next_action 必须是字符串");
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  let action: CritiqueResult["next_action"] | undefined;
  if (normalized === "accept" || normalized === "accepted" || normalized === "approve" || normalized === "approved") {
    action = "accept";
  }
  if (normalized === "pass" || normalized === "passed" || normalized === "complete" || normalized === "completed" || normalized === "ok") {
    action = "accept";
  }
  if (normalized === "revise" || normalized === "revision" || normalized === "retry" || normalized === "fix") {
    action = "revise";
  }
  if (normalized === "fix_required" || normalized === "needs_revision" || normalized === "rework" || normalized === "reject") {
    action = "revise";
  }
  if (normalized === "escalate" || normalized === "escalated" || normalized === "escalation") {
    action = "escalate";
  }
  if (normalized === "blocked" || normalized === "blocker" || normalized === "needs_attention") {
    action = "escalate";
  }
  if (action) return action === "accept" && blockingIssues > 0 ? "revise" : action;
  throw new Error("Superego JSON schema 校验失败：next_action 必须是 accept、revise 或 escalate");
}

function extractJson(text: string, source: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const extracted = extractLastBalancedJsonObject(trimmed);
  if (extracted) return extracted;
  throw new Error(`${source} 未输出可解析 JSON`);
}

function extractLastBalancedJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let last = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        last = text.slice(start, index + 1);
        start = -1;
      }
      if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return last || undefined;
}
