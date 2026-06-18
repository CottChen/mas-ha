import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, normalize, resolve } from "node:path";
import { MAS_ARTIFACT_DIR } from "../config.js";
import type { AuditPacket } from "../types.js";

export type RunArtifactKind = "audit_packet";

export interface RunArtifactRef {
  artifactId: string;
  kind: RunArtifactKind;
  runId: string;
  iteration: number;
  path: string;
  summary: RunArtifactSummary;
}

export interface RunArtifactSummary {
  title: string;
  sections: string[];
  counts: Record<string, number>;
  highlights: string[];
}

export interface ReadRunArtifactResult {
  artifactId: string;
  section: string;
  content: unknown;
  truncated: boolean;
  note?: string;
}

const MAX_ARTIFACT_READ_CHARS = 24000;

export function writeAuditPacketArtifact(input: { runId: string; iteration: number; auditPacket: AuditPacket }): RunArtifactRef {
  const artifactId = `audit-packet-i${input.iteration}`;
  const path = artifactPath(input.runId, artifactId);
  mkdirSync(runArtifactDir(input.runId), { recursive: true });
  writeFileSync(path, JSON.stringify(input.auditPacket, null, 2), { encoding: "utf8" });
  return {
    artifactId,
    kind: "audit_packet",
    runId: input.runId,
    iteration: input.iteration,
    path,
    summary: summarizeAuditPacket(input.auditPacket),
  };
}

export function readRunArtifact(input: { runId: string; artifactId: string; section?: string; maxChars?: number }): ReadRunArtifactResult {
  const artifactId = safeArtifactId(input.artifactId);
  const path = artifactPath(input.runId, artifactId);
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const section = input.section?.trim() || "summary";
  const content = selectSection(data, section);
  const maxChars = Math.max(1000, Math.min(input.maxChars ?? MAX_ARTIFACT_READ_CHARS, MAX_ARTIFACT_READ_CHARS));
  const serialized = JSON.stringify(content, null, 2);
  if (serialized.length <= maxChars) {
    return { artifactId, section, content, truncated: false };
  }
  return {
    artifactId,
    section,
    content: `${serialized.slice(0, Math.floor(maxChars / 2))}\n... 已截断 ${serialized.length - maxChars} 字符，可指定更小 section 继续读取 ...\n${serialized.slice(-Math.ceil(maxChars / 2))}`,
    truncated: true,
    note: "内容过大，返回首尾片段。请优先读取 findings、approvals_tail、commands_tail、boundaryDiff 等具体 section。",
  };
}

export function renderRunArtifactPrompt(ref: RunArtifactRef): string {
  return [
    `MAS run artifact: ${ref.artifactId}`,
    `类型：${ref.kind}`,
    `用途：完整审计证据已持久化，不默认塞入 prompt；需要核对时调用 mas_read_run_artifact。`,
    `可读 section：${ref.summary.sections.join(", ")}`,
    `计数：${Object.entries(ref.summary.counts).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    "高价值摘要：",
    ...ref.summary.highlights.map((item) => `- ${item}`),
    "建议：先基于上面的摘要判断风险；如需要证据，优先读取 findings、approvals_tail、commands_tail、writes_tail、boundaryDiff，而不是直接读取 full。",
  ].join("\n");
}

function summarizeAuditPacket(audit: AuditPacket): RunArtifactSummary {
  const highlights = [
    `outputBoundary=${audit.outputBoundary.mode}: ${audit.outputBoundary.reason}`,
    `findings=${audit.findings.length}${audit.findings.length ? ` (${audit.findings.map((finding) => `${finding.severity}/${finding.category}`).join(", ")})` : ""}`,
  ];
  if (audit.currentWritesOutsideOutput.length > 0) highlights.push(`当前允许输出边界外写入：${audit.currentWritesOutsideOutput.slice(0, 5).join("; ")}`);
  if (audit.currentWritesToReadOnlyInputs.length > 0) highlights.push(`当前只读输入路径写入：${audit.currentWritesToReadOnlyInputs.slice(0, 5).join("; ")}`);
  if (audit.unreportedWrites.length > 0) highlights.push(`Ego 未报告写入：${audit.unreportedWrites.slice(0, 5).join("; ")}`);
  if (audit.commandSideEffects.length > 0) highlights.push(`命令副作用候选：${audit.commandSideEffects.slice(-5).map((item) => `${item.kind}:${item.path}`).join("; ")}`);
  return {
    title: "AuditPacket",
    sections: [
      "summary",
      "findings",
      "outputBoundary",
      "approvals_tail",
      "writes_tail",
      "commands_tail",
      "commandSideEffects",
      "boundaryDiff",
      "full",
    ],
    counts: {
      approvals: audit.approvals.length,
      writes: audit.writes.length,
      commands: audit.commands.length,
      commandSideEffects: audit.commandSideEffects.length,
      findings: audit.findings.length,
      currentWritesOutsideOutput: audit.currentWritesOutsideOutput.length,
      currentWritesToReadOnlyInputs: audit.currentWritesToReadOnlyInputs.length,
      unreportedWrites: audit.unreportedWrites.length,
    },
    highlights,
  };
}

function selectSection(data: unknown, section: string): unknown {
  const audit = data as AuditPacket;
  switch (section) {
    case "summary":
      return summarizeAuditPacket(audit);
    case "findings":
      return audit.findings;
    case "outputBoundary":
      return audit.outputBoundary;
    case "approvals_tail":
      return audit.approvals.slice(-30);
    case "writes_tail":
      return audit.writes.slice(-30);
    case "commands_tail":
      return audit.commands.slice(-30);
    case "commandSideEffects":
      return audit.commandSideEffects;
    case "boundaryDiff":
      return audit.boundaryDiff ?? null;
    case "full":
      return audit;
    default:
      if (data && typeof data === "object" && section in (data as Record<string, unknown>)) return (data as Record<string, unknown>)[section];
      return { error: `未知 section: ${section}`, availableSections: summarizeAuditPacket(audit).sections };
  }
}

function runArtifactDir(runId: string): string {
  return join(MAS_ARTIFACT_DIR, "runs", safePathSegment(runId));
}

function artifactPath(runId: string, artifactId: string): string {
  const dir = runArtifactDir(runId);
  const path = resolve(dir, `${safeArtifactId(artifactId)}.json`);
  const normalizedDir = normalize(dir);
  if (!normalize(path).startsWith(normalizedDir)) throw new Error(`非法 artifact 路径：${artifactId}`);
  return path;
}

function safeArtifactId(value: string): string {
  return safePathSegment(basename(value).replace(/\.json$/i, ""));
}

function safePathSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!normalized || normalized === "." || normalized === "..") throw new Error(`非法路径片段：${value}`);
  return normalized;
}
