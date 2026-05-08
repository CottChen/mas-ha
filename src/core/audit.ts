import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, normalize, resolve } from "node:path";
import { MasStore } from "../storage.js";
import type { AuditFinding, AuditPacket, BoundaryDiff, BoundaryFileMetadata, BoundaryScopeKind, BoundarySnapshot, BoundarySnapshotScope, EgoResult } from "../types.js";

const MAX_SNAPSHOT_ENTRIES_PER_SCOPE = 2000;

export function buildAuditPacket(
  store: MasStore,
  input: { runId: string; cwd: string; egoResult: EgoResult; boundarySnapshot?: BoundarySnapshot; task?: string; contract?: string },
): AuditPacket {
  const cwd = normalizePath(input.cwd);
  const outputDir = normalizePath(resolve(input.cwd, "output"));
  const approvals = store.listApprovals(input.runId);
  const writes = approvals.flatMap((approval) =>
    extractWritePaths(approval.rawInput).map((path) => {
      const normalized = normalizeTaskPath(path, input.cwd);
      return {
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        path: normalized,
        inOutputDir: isSubPath(normalized, outputDir),
        inCwd: isSubPath(normalized, cwd),
        inReadOnlyInput: isReadOnlyInputPath(normalized),
      };
    }),
  );
  const commands = approvals
    .map((approval) => ({ toolCallId: approval.toolCallId, command: extractCommand(approval.rawInput) }))
    .filter((item): item is { toolCallId: string; command: unknown } => item.command !== undefined);
  const egoChangedFiles = input.egoResult.changed_files.map((path) => normalizeTaskPath(path, input.cwd));
  const unreportedWrites = writes.map((write) => write.path).filter((path) => !egoChangedFiles.some((changed) => samePath(changed, path)));
  const writesOutsideOutput = writes.filter((write) => !write.inOutputDir).map((write) => write.path);
  const currentWritesOutsideOutput = writes.filter((write) => !write.inOutputDir && existsSync(write.path)).map((write) => write.path);
  const writesToReadOnlyInputs = writes.filter((write) => write.inReadOnlyInput).map((write) => write.path);
  const currentWritesToReadOnlyInputs = writes.filter((write) => write.inReadOnlyInput && existsSync(write.path)).map((write) => write.path);
  const boundaryDiff = input.boundarySnapshot
    ? diffBoundarySnapshot(input.boundarySnapshot, createBoundarySnapshot({ cwd: input.cwd, task: input.task ?? "", contract: input.contract ?? "" }))
    : undefined;
  const findings = buildFindings({
    unreportedWrites,
    writesOutsideOutput,
    currentWritesOutsideOutput,
    writesToReadOnlyInputs,
    currentWritesToReadOnlyInputs,
    boundaryDiff,
  });

  return {
    cwd,
    outputDir,
    suggestedSamplingStrategy: buildSuggestedSamplingStrategy(input.egoResult),
    boundaryDiffPolicy: {
      mode: "lightweight_boundary_metadata",
      rules: [
        "默认不做全量工作区重审计，也不读取全部文件内容。",
        "优先对用户声明的只读输入边界、output 输出边界和已知写入路径做轻量元数据对账。",
        "只有出现命令副作用、审计矛盾、返工失败或高风险数据任务时，才触发更深的 hash 或内容级检查。",
      ],
    },
    approvals,
    writes,
    commands,
    egoChangedFiles,
    unreportedWrites: unique(unreportedWrites),
    writesOutsideOutput: unique(writesOutsideOutput),
    currentWritesOutsideOutput: unique(currentWritesOutsideOutput),
    writesToReadOnlyInputs: unique(writesToReadOnlyInputs),
    currentWritesToReadOnlyInputs: unique(currentWritesToReadOnlyInputs),
    boundaryDiff,
    findings,
  };
}

export function enforceAuditGate(critique: import("../types.js").CritiqueResult, audit: AuditPacket): import("../types.js").CritiqueResult {
  const blockingFindings = audit.findings.filter((finding) => finding.severity === "high");
  if (blockingFindings.length === 0 || critique.next_action !== "accept") return critique;
  return {
    ...critique,
    blocking_issues: Math.max(critique.blocking_issues, blockingFindings.length),
    quality_score: Math.min(critique.quality_score, 0.5),
    next_action: "revise",
    summary: `${critique.summary}\n\nMAS 审计门禁发现 ${blockingFindings.length} 个阻塞性审计问题，已将 Superego 结论改为 revise。`,
    critique_items: [
      ...critique.critique_items,
      ...blockingFindings.map((finding) => ({
        category: finding.category,
        severity: finding.severity,
        suggestion: `${finding.message} 证据：${finding.evidence.join("; ")}`,
      })),
    ],
  };
}

function buildFindings(input: {
  unreportedWrites: string[];
  writesOutsideOutput: string[];
  currentWritesOutsideOutput: string[];
  writesToReadOnlyInputs: string[];
  currentWritesToReadOnlyInputs: string[];
  boundaryDiff?: BoundaryDiff;
}): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (input.unreportedWrites.length > 0) {
    findings.push({
      category: "changed_files_mismatch",
      severity: "medium",
      message: "Ego changed_files 未覆盖 MAS 审计记录中的历史写入/编辑路径，应作为历史事实留痕并要求 Ego 修正自报。",
      evidence: unique(input.unreportedWrites),
    });
  }
  if (input.currentWritesOutsideOutput.length > 0) {
    findings.push({
      category: "output_boundary",
      severity: "high",
      message: "当前文件系统仍存在 output 目录外写入，违反当前工作目录 output 子目录输出边界。",
      evidence: unique(input.currentWritesOutsideOutput),
    });
  }
  if (input.writesOutsideOutput.length > input.currentWritesOutsideOutput.length) {
    findings.push({
      category: "historical_output_boundary",
      severity: "medium",
      message: "历史审计记录中存在 output 目录外写入，但当前状态可能已清理；默认留痕，不作为当前状态门禁的唯一阻塞证据。",
      evidence: unique(input.writesOutsideOutput.filter((path) => !input.currentWritesOutsideOutput.some((current) => samePath(current, path)))),
    });
  }
  if (input.currentWritesToReadOnlyInputs.length > 0) {
    findings.push({
      category: "readonly_input_boundary",
      severity: "high",
      message: "当前文件系统仍存在 data/template 等只读输入路径写入。",
      evidence: unique(input.currentWritesToReadOnlyInputs),
    });
  }
  if (input.writesToReadOnlyInputs.length > input.currentWritesToReadOnlyInputs.length) {
    findings.push({
      category: "historical_readonly_input_boundary",
      severity: "medium",
      message: "历史审计记录中存在只读输入路径写入，但当前状态可能已清理；默认留痕，Superego 必须结合当前状态和任务风险判断。",
      evidence: unique(input.writesToReadOnlyInputs.filter((path) => !input.currentWritesToReadOnlyInputs.some((current) => samePath(current, path)))),
    });
  }
  if (input.boundaryDiff) {
    if (input.boundaryDiff.readonlyCreated.length > 0 || input.boundaryDiff.readonlyModified.length > 0 || input.boundaryDiff.readonlyDeleted.length > 0) {
      findings.push({
        category: "readonly_input_boundary_diff",
        severity: "high",
        message: "边界目录轻量元数据 diff 发现只读输入目录发生新增、修改或删除。",
        evidence: unique([...input.boundaryDiff.readonlyCreated, ...input.boundaryDiff.readonlyModified, ...input.boundaryDiff.readonlyDeleted]),
      });
    }
    if (input.boundaryDiff.suspiciousCreatedOutsideOutput.length > 0 || input.boundaryDiff.suspiciousModifiedOutsideOutput.length > 0) {
      findings.push({
        category: "workspace_boundary_diff",
        severity: "high",
        message: "边界目录轻量元数据 diff 发现工作目录根层存在 output 外新增或修改。",
        evidence: unique([...input.boundaryDiff.suspiciousCreatedOutsideOutput, ...input.boundaryDiff.suspiciousModifiedOutsideOutput]),
      });
    }
    if (input.boundaryDiff.suspiciousDeletedOutsideOutput.length > 0) {
      findings.push({
        category: "workspace_boundary_deleted",
        severity: "medium",
        message: "边界目录轻量元数据 diff 发现工作目录根层存在 output 外删除，默认留痕并交由 Superego 判断风险。",
        evidence: unique(input.boundaryDiff.suspiciousDeletedOutsideOutput),
      });
    }
  }
  return findings;
}

export function createBoundarySnapshot(input: { cwd: string; task: string; contract: string }): BoundarySnapshot {
  const cwd = normalizePath(input.cwd);
  const scopes = discoverBoundaryScopes(input).map((scope) => snapshotScope(scope));
  return {
    createdAt: new Date().toISOString(),
    cwd,
    scopes,
  };
}

function discoverBoundaryScopes(input: { cwd: string; task: string; contract: string }): Array<{ kind: BoundaryScopeKind; path: string; depth: number }> {
  const cwd = normalizePath(input.cwd);
  const scopes: Array<{ kind: BoundaryScopeKind; path: string; depth: number }> = [
    { kind: "workspace_root", path: cwd, depth: 1 },
    { kind: "output", path: normalizePath(resolve(input.cwd, "output")), depth: 4 },
  ];
  for (const candidate of [resolve(input.cwd, "data"), resolve(input.cwd, "template"), ...extractAbsolutePaths(`${input.task}\n${input.contract}`)]) {
    const normalized = normalizePath(candidate);
    const name = basename(normalized);
    if ((name === "data" || name === "template" || normalized.includes("/data/") || normalized.includes("/template/")) && !scopes.some((scope) => samePath(scope.path, normalized))) {
      scopes.push({ kind: "readonly_input", path: normalized, depth: 4 });
    }
  }
  return scopes;
}

function snapshotScope(scope: { kind: BoundaryScopeKind; path: string; depth: number }): BoundarySnapshotScope {
  const entries: BoundaryFileMetadata[] = [];
  let truncated = false;
  if (!existsSync(scope.path)) {
    return { ...scope, exists: false, fileCount: 0, dirCount: 0, truncated: false, entries };
  }
  const visit = (path: string, depth: number) => {
    if (entries.length >= MAX_SNAPSHOT_ENTRIES_PER_SCOPE) {
      truncated = true;
      return;
    }
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    entries.push({
      path: normalizePath(path),
      type: stat.isDirectory() ? "dir" : "file",
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    });
    if (!stat.isDirectory() || depth <= 0) return;
    let children;
    try {
      children = readdirSync(path);
    } catch {
      return;
    }
    for (const child of children) visit(resolve(path, child), depth - 1);
  };
  visit(scope.path, scope.depth);
  return {
    ...scope,
    exists: true,
    fileCount: entries.filter((entry) => entry.type === "file").length,
    dirCount: entries.filter((entry) => entry.type === "dir").length,
    truncated,
    entries,
  };
}

function diffBoundarySnapshot(before: BoundarySnapshot, after: BoundarySnapshot): BoundaryDiff {
  const scopes = after.scopes.map((afterScope) => {
    const beforeScope = before.scopes.find((scope) => scope.kind === afterScope.kind && samePath(scope.path, afterScope.path));
    const beforeMap = new Map((beforeScope?.entries ?? []).map((entry) => [entry.path, entry]));
    const afterMap = new Map(afterScope.entries.map((entry) => [entry.path, entry]));
    const created = afterScope.entries.filter((entry) => !beforeMap.has(entry.path));
    const modified = afterScope.entries
      .map((entry) => {
        const old = beforeMap.get(entry.path);
        if (!old || (old.type === entry.type && old.size === entry.size && old.mtimeMs === entry.mtimeMs)) return undefined;
        return { before: old, after: entry };
      })
      .filter((entry): entry is { before: BoundaryFileMetadata; after: BoundaryFileMetadata } => Boolean(entry));
    const deleted = [...beforeMap.values()].filter((entry) => !afterMap.has(entry.path));
    return {
      kind: afterScope.kind,
      path: afterScope.path,
      created,
      modified,
      deleted,
      truncated: afterScope.truncated || Boolean(beforeScope?.truncated),
    };
  });
  const readonlyScopes = scopes.filter((scope) => scope.kind === "readonly_input");
  const outputScopes = scopes.filter((scope) => scope.kind === "output");
  const workspaceScopes = scopes.filter((scope) => scope.kind === "workspace_root");
  const outputPaths = outputScopes.map((scope) => scope.path);
  const isOutsideOutput = (path: string) => !outputPaths.some((outputPath) => isSubPath(path, outputPath));
  return {
    baselineAt: before.createdAt,
    comparedAt: after.createdAt,
    scopes,
    readonlyCreated: readonlyScopes.flatMap((scope) => scope.created.map((entry) => entry.path)),
    readonlyModified: readonlyScopes.flatMap((scope) => scope.modified.map((entry) => entry.after.path)),
    readonlyDeleted: readonlyScopes.flatMap((scope) => scope.deleted.map((entry) => entry.path)),
    outputCreated: outputScopes.flatMap((scope) => scope.created.map((entry) => entry.path)),
    outputModified: outputScopes.flatMap((scope) => scope.modified.map((entry) => entry.after.path)),
    outputDeleted: outputScopes.flatMap((scope) => scope.deleted.map((entry) => entry.path)),
    suspiciousCreatedOutsideOutput: workspaceScopes.flatMap((scope) => scope.created.map((entry) => entry.path).filter((path) => path !== scope.path && isOutsideOutput(path))),
    suspiciousModifiedOutsideOutput: workspaceScopes.flatMap((scope) =>
      scope.modified.map((entry) => entry.after.path).filter((path) => path !== scope.path && isOutsideOutput(path)),
    ),
    suspiciousDeletedOutsideOutput: workspaceScopes.flatMap((scope) => scope.deleted.map((entry) => entry.path).filter((path) => path !== scope.path && isOutsideOutput(path))),
  };
}

function extractAbsolutePaths(text: string): string[] {
  const matches = text.match(/[a-zA-Z]:[\\/][^\r\n"'`<>|?*]+/g) ?? [];
  return matches.map((path) => path.trim().replace(/[，。,；;：:）)\]}]+$/g, ""));
}

function buildSuggestedSamplingStrategy(egoResult: EgoResult): AuditPacket["suggestedSamplingStrategy"] {
  const text = `${egoResult.summary}\n${egoResult.final_response}\n${egoResult.evidence.join("\n")}\n${egoResult.risks.join("\n")}`;
  const taskHints: string[] = [];
  if (/excel|xlsx|sheet|表|单元格|省包|市场份额|奖金包/i.test(text)) {
    taskHints.push("数据表任务：优先抽样复算关键公式、空值/0值/异常值、输出行列结构和模板字段一致性。");
  }
  if (/市场份额|share|分母|分子|pdot|省包|工分|潜力/i.test(text)) {
    taskHints.push("指标测算任务：优先抽样检查分子分母、存量/增量拆分、总量等式和高风险业务规则。");
  }
  if (/代码|测试|typecheck|doctor|编译/i.test(text)) {
    taskHints.push("代码任务：优先抽样检查改动文件、测试覆盖、失败命令和用户可见行为。");
  }
  return {
    objective: "由 Superego 根据任务类型自主选择分层风险抽样 + 少量随机扰动的低成本、高信息增益只读复核策略。",
    rules: [
      "不要全量重做 Ego 工作；样本应由必查样本、风险样本和少量随机样本组成。",
      "必查样本覆盖用户明确强调的关键指标、边界条件和验收合同硬约束。",
      "风险样本覆盖 Ego 风险项、审计发现、异常值、空值、0 值、极大/极小值和历史容易出错的位置。",
      "随机样本从剩余普通样本空间中选择少量点，用于抵抗只查高风险点带来的确认偏差。",
      "抽样策略、样本空间、样本数和随机扰动依据必须在 critique_items 或 summary 中说明。",
      "只允许只读检查；不得写文件、编辑文件或执行有外部副作用的命令。",
      "如果没有执行抽样，必须说明原因，并降低质量分或提出改进建议。",
      "发现抽样失败、审计矛盾或关键要求未验证时，不能 accept。",
    ],
    taskHints,
    randomization: {
      seedHint: "优先使用 runId、任务摘要或输出文件路径派生稳定 seed；如果无法获得 seed，应在评审中说明随机扰动不可复现。",
      strategy: "由 Superego 决定具体随机扰动比例；默认随机样本只占少量，用于补充分层风险抽样，不替代风险抽样。",
    },
  };
}

function extractWritePaths(rawInput: unknown): string[] {
  if (!rawInput || typeof rawInput !== "object") return [];
  const input = rawInput as Record<string, unknown>;
  const paths: string[] = [];
  if (typeof input.path === "string") paths.push(input.path);
  if (Array.isArray(input.paths)) {
    for (const path of input.paths) {
      if (typeof path === "string") paths.push(path);
    }
  }
  return paths;
}

function extractCommand(rawInput: unknown): unknown {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  return (rawInput as Record<string, unknown>).command;
}

function normalizeTaskPath(path: string, cwd: string): string {
  return normalizePath(isAbsolute(path) ? path : resolve(cwd, path));
}

function normalizePath(path: string): string {
  return normalize(path).replace(/\\/g, "/").toLowerCase();
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isSubPath(path: string, parent: string): boolean {
  const normalized = normalizePath(path);
  const normalizedParent = normalizePath(parent);
  return normalized === normalizedParent || normalized.startsWith(`${normalizedParent}/`);
}

function isReadOnlyInputPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.includes("/data/") || normalized.includes("/template/");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
