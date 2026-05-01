import type { CritiqueResult } from "../types.js";

export function buildAcceptanceContract(task: string): string {
  return [
    "验收合同：",
    "1. 必须直接完成用户任务，不能只给建议。",
    "2. 需要保留关键操作证据：读取了什么、修改了什么、验证了什么。",
    "3. 如涉及代码或文件修改，必须尽量运行相关检查；无法运行时说明原因。",
    "4. 不做无关重构，不扩大任务边界。",
    "",
    `用户任务：${task}`,
  ].join("\n");
}

export function buildEgoPrompt(task: string, contract: string, critique?: CritiqueResult): string {
  const parts = [
    "你是 MAS 的 Ego 执行者。请按验收合同完成任务，必要时读取、编辑文件或运行命令。",
    contract,
  ];
  if (critique) {
    parts.push("上一轮 Superego 批注如下，请针对阻塞问题返工：");
    parts.push(JSON.stringify(critique, null, 2));
  }
  parts.push("请开始执行。");
  return parts.join("\n\n");
}

export function buildSuperegoPrompt(task: string, contract: string, egoOutput: string): string {
  return [
    "你是 MAS 的 Superego 评审者。请只评审，不要修改文件。",
    "根据用户任务、验收合同和 Ego 输出判断是否可以交给 HA 终验。",
    "只输出严格 JSON，不要输出 Markdown 代码块。",
    "JSON 格式：",
    '{"blocking_issues":0,"quality_score":0.0,"summary":"","next_action":"accept","critique_items":[]}',
    "next_action 只能是 accept、revise 或 escalate。",
    "",
    `用户任务：${task}`,
    "",
    contract,
    "",
    "Ego 输出：",
    egoOutput.slice(-12000),
  ].join("\n");
}

export function parseCritique(text: string): CritiqueResult {
  const jsonText = extractJson(text);
  const parsed = JSON.parse(jsonText) as Partial<CritiqueResult>;
  return {
    blocking_issues: Number(parsed.blocking_issues ?? 0),
    quality_score: Number(parsed.quality_score ?? 0),
    summary: String(parsed.summary ?? ""),
    next_action: parsed.next_action === "revise" || parsed.next_action === "escalate" ? parsed.next_action : "accept",
    critique_items: Array.isArray(parsed.critique_items) ? (parsed.critique_items as CritiqueResult["critique_items"]) : [],
  };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("Superego 未输出可解析 JSON");
}
