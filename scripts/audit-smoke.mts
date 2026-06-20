import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildAuditPacket, createBoundarySnapshot, enforceAuditGate } from "../src/core/audit.js";
import { MasStore } from "../src/storage.js";
import type { AuditFinding, AuditPacket, CritiqueResult, EgoResult } from "../src/types.js";

type CaseInput = {
  name: string;
  writePath: (cwd: string) => string;
  changedFiles: string[];
  expectedAction: "accept" | "revise" | "escalate";
  createCurrentFile?: boolean;
};

const tempRoot = mkdtempSync(join(tmpdir(), "mas-audit-smoke-"));
process.env.MAS_HOME = tempRoot;

try {
  const cases: CaseInput[] = [
    {
      name: "允许 output 内写入且 changed_files 对账一致",
      writePath: (cwd) => join(cwd, "output", "result.xlsx"),
      changedFiles: ["output/result.xlsx"],
      expectedAction: "accept",
      createCurrentFile: true,
    },
    {
      name: "changed_files 漏报时只留痕不强制 revise",
      writePath: (cwd) => join(cwd, "output", "result.xlsx"),
      changedFiles: [],
      expectedAction: "accept",
      createCurrentFile: true,
    },
    {
      name: "当前 output 外写入时强制 revise",
      writePath: (cwd) => join(cwd, "process.py"),
      changedFiles: ["process.py"],
      expectedAction: "revise",
      createCurrentFile: true,
    },
    {
      name: "历史 output 外写入已清理时只留痕不强制 revise",
      writePath: (cwd) => join(cwd, "old-process.py"),
      changedFiles: ["old-process.py"],
      expectedAction: "accept",
    },
    {
      name: "当前只读输入路径写入时强制 revise",
      writePath: (cwd) => join(cwd, "data", "source.xlsx"),
      changedFiles: ["data/source.xlsx"],
      expectedAction: "revise",
      createCurrentFile: true,
    },
  ];

  for (const [index, item] of cases.entries()) {
    const caseName = `${index}-${safeName(item.name)}`;
    const store = new MasStore(join(tempRoot, `${caseName}.sqlite`));
    try {
      const runId = `run-${caseName}`;
      const cwd = join(tempRoot, caseName);
      mkdirSync(join(cwd, "output"), { recursive: true });
      const writePath = item.writePath(cwd);
      if (item.createCurrentFile) {
        mkdirSync(dirname(writePath), { recursive: true });
        writeFileSync(writePath, "test");
      }
      store.addApproval({
        runId,
        toolCallId: "write-1",
        toolName: "write",
        decision: "allow_always",
        rawInput: { path: writePath, content: "test" },
      });
      const audit = buildAuditPacket(store, {
        runId,
        cwd,
        egoResult: egoResult(item.changedFiles),
        task: "生成数据表报告",
        contract: "所有结果必须写入 output/ 目录。",
      });
      const gated = enforceAuditGate(baseCritique(), audit);
      assert(
        gated.next_action === item.expectedAction,
        `${item.name}: expected ${item.expectedAction}, got ${gated.next_action}\n${JSON.stringify({ audit, gated }, null, 2)}`,
      );
      console.log(`OK ${item.name}`);
    } finally {
      store.close();
    }
  }

  {
    const name = "Superego accept 且仅剩 HA 责任审计问题时升级 HA";
    const gated = enforceAuditGate(baseCritique(), auditWithFindings([{ category: "framework_or_contract_conflict", severity: "high", gateOwner: "ha", message: "框架或合同问题", evidence: ["not ego fixable"] }]));
    assert(
      gated.next_action === "escalate",
      `${name}: expected escalate, got ${gated.next_action}\n${JSON.stringify(gated, null, 2)}`,
    );
    console.log(`OK ${name}`);
  }

  {
    const name = "Superego accept 且存在 Ego 责任审计问题时返工 Ego";
    const gated = enforceAuditGate(baseCritique(), auditWithFindings([{ category: "artifact_boundary_violation", severity: "high", gateOwner: "ego", message: "产物边界违规", evidence: ["ego can fix"] }]));
    assert(
      gated.next_action === "revise",
      `${name}: expected revise, got ${gated.next_action}\n${JSON.stringify(gated, null, 2)}`,
    );
    console.log(`OK ${name}`);
  }

  {
    const name = "命令副作用写入只读输入目录时强制 revise";
    const caseName = `boundary-${safeName(name)}`;
    const cwd = join(tempRoot, caseName);
    mkdirSync(join(cwd, "data"), { recursive: true });
    mkdirSync(join(cwd, "output"), { recursive: true });
    const store = new MasStore(join(tempRoot, `${caseName}.sqlite`));
    try {
      const runId = `run-${caseName}`;
      const task = `输入文件（只读）：${join(cwd, "data")}；输出写入 output。`;
      const contract = "只读输入边界为 data，允许输出边界为 output。";
      const baseline = createBoundarySnapshot({ cwd, task, contract });
      writeFileSync(join(cwd, "data", "debug.json"), "{}");
      const audit = buildAuditPacket(store, {
        runId,
        cwd,
        egoResult: egoResult(["output/result.xlsx"]),
        boundarySnapshot: baseline,
        task,
        contract,
      });
      const gated = enforceAuditGate(baseCritique(), audit);
      assert(
        gated.next_action === "revise",
        `${name}: expected revise, got ${gated.next_action}\n${JSON.stringify({ audit, gated }, null, 2)}`,
      );
      assert(
        audit.findings.some((finding) => finding.category === "readonly_input_boundary_diff"),
        `${name}: expected readonly_input_boundary_diff\n${JSON.stringify(audit, null, 2)}`,
      );
      console.log(`OK ${name}`);
    } finally {
      store.close();
    }
  }

  {
    const name = "同一路径同时声明只读和允许输出时升级给 HA";
    const caseName = `boundary-${safeName(name)}`;
    const cwd = join(tempRoot, caseName);
    const projectRoot = join(cwd, "project");
    mkdirSync(projectRoot, { recursive: true });
    const writePath = join(projectRoot, "src", "app.ts");
    mkdirSync(dirname(writePath), { recursive: true });
    writeFileSync(writePath, "test");
    const store = new MasStore(join(tempRoot, `${caseName}.sqlite`));
    try {
      const runId = `run-${caseName}`;
      store.addApproval({
        runId,
        toolCallId: "write-1",
        toolName: "write",
        decision: "allow_always",
        rawInput: { path: writePath, content: "test" },
      });
      const audit = buildAuditPacket(store, {
        runId,
        cwd,
        egoResult: egoResult(["project/src/app.ts"]),
        boundaryDeclarations: {
          readonlyInputPaths: [projectRoot],
          allowedOutputPaths: [projectRoot],
        },
      });
      const gated = enforceAuditGate(baseCritique(), audit);
      assert(
        gated.next_action === "escalate",
        `${name}: expected escalate, got ${gated.next_action}\n${JSON.stringify({ audit, gated }, null, 2)}`,
      );
      assert(
        audit.findings.some((finding) => finding.category === "boundary_declaration_conflict" && finding.gateOwner === "ha"),
        `${name}: expected boundary_declaration_conflict\n${JSON.stringify(audit, null, 2)}`,
      );
      assert(
        audit.currentWritesToReadOnlyInputs.length === 0,
        `${name}: exact same readonly/output path should not be treated as Ego-fixable readonly write\n${JSON.stringify(audit, null, 2)}`,
      );
      console.log(`OK ${name}`);
    } finally {
      store.close();
    }
  }

  {
    const name = "只读根目录下声明的输出子目录允许写入";
    const caseName = `boundary-${safeName(name)}`;
    const cwd = join(tempRoot, caseName);
    const projectRoot = join(cwd, "project");
    const outputRoot = join(projectRoot, "output");
    mkdirSync(outputRoot, { recursive: true });
    const writePath = join(outputRoot, "result.txt");
    writeFileSync(writePath, "test");
    const store = new MasStore(join(tempRoot, `${caseName}.sqlite`));
    try {
      const runId = `run-${caseName}`;
      store.addApproval({
        runId,
        toolCallId: "write-1",
        toolName: "write",
        decision: "allow_always",
        rawInput: { path: writePath, content: "test" },
      });
      const baseline = createBoundarySnapshot({
        cwd,
        boundaryDeclarations: {
          readonlyInputPaths: [projectRoot],
          allowedOutputPaths: [outputRoot],
        },
      });
      const audit = buildAuditPacket(store, {
        runId,
        cwd,
        egoResult: egoResult(["project/output/result.txt"]),
        boundarySnapshot: baseline,
        boundaryDeclarations: {
          readonlyInputPaths: [projectRoot],
          allowedOutputPaths: [outputRoot],
        },
      });
      const gated = enforceAuditGate(baseCritique(), audit);
      assert(
        gated.next_action === "accept",
        `${name}: expected accept, got ${gated.next_action}\n${JSON.stringify({ audit, gated }, null, 2)}`,
      );
      assert(
        audit.currentWritesToReadOnlyInputs.length === 0 && audit.boundaryDiff?.readonlyCreated.length === 0,
        `${name}: output child writes should be carved out from readonly checks\n${JSON.stringify(audit, null, 2)}`,
      );
      console.log(`OK ${name}`);
    } finally {
      store.close();
    }
  }

  {
    const name = "允许输出根内的只读子目录仍然受保护";
    const caseName = `boundary-${safeName(name)}`;
    const cwd = join(tempRoot, caseName);
    const projectRoot = join(cwd, "project");
    const dataRoot = join(projectRoot, "data");
    mkdirSync(dataRoot, { recursive: true });
    const writePath = join(dataRoot, "source.xlsx");
    writeFileSync(writePath, "test");
    const store = new MasStore(join(tempRoot, `${caseName}.sqlite`));
    try {
      const runId = `run-${caseName}`;
      store.addApproval({
        runId,
        toolCallId: "write-1",
        toolName: "write",
        decision: "allow_always",
        rawInput: { path: writePath, content: "test" },
      });
      const audit = buildAuditPacket(store, {
        runId,
        cwd,
        egoResult: egoResult(["project/data/source.xlsx"]),
        boundaryDeclarations: {
          readonlyInputPaths: [dataRoot],
          allowedOutputPaths: [projectRoot],
        },
      });
      const gated = enforceAuditGate(baseCritique(), audit);
      assert(
        gated.next_action === "revise",
        `${name}: expected revise, got ${gated.next_action}\n${JSON.stringify({ audit, gated }, null, 2)}`,
      );
      assert(
        audit.currentWritesToReadOnlyInputs.length === 1,
        `${name}: expected readonly child write violation\n${JSON.stringify(audit, null, 2)}`,
      );
      console.log(`OK ${name}`);
    } finally {
      store.close();
    }
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function egoResult(changedFiles: string[]): EgoResult {
  return {
    status: "completed",
    summary: "完成高风险结构化数据任务，并记录关键口径验证。",
    final_response: "已生成输出。",
    evidence: [],
    changed_files: changedFiles,
    verification: [{ command: "check", result: "passed", notes: "ok" }],
    risks: [],
  };
}

function baseCritique(): CritiqueResult {
  return {
    blocking_issues: 0,
    quality_score: 0.9,
    summary: "通过",
    next_action: "accept",
    critique_items: [],
  };
}

function auditWithFindings(findings: AuditFinding[]): AuditPacket {
  return {
    cwd: "",
    outputDir: "",
    boundaryDeclarations: { source: "ha_decision", readonlyInputPaths: [], allowedOutputPaths: [], conflicts: [] },
    outputBoundary: { mode: "workspace_root", reason: "test", allowedRoots: [""] },
    suggestedSamplingStrategy: { objective: "test", rules: [], taskHints: [], randomization: { seedHint: "test", strategy: "none" } },
    boundaryDiffPolicy: { mode: "lightweight_boundary_metadata", rules: [] },
    agentHealth: { observations: [], findings: [] },
    approvals: [],
    writes: [],
    commands: [],
    commandSideEffects: [],
    egoChangedFiles: [],
    unreportedWrites: [],
    writesOutsideOutput: [],
    currentWritesOutsideOutput: [],
    writesToReadOnlyInputs: [],
    currentWritesToReadOnlyInputs: [],
    findings,
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "case";
}
