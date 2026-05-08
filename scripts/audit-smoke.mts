import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildAuditPacket, createBoundarySnapshot, enforceAuditGate } from "../src/core/audit.js";
import { MasStore } from "../src/storage.js";
import type { CritiqueResult, EgoResult } from "../src/types.js";

type CaseInput = {
  name: string;
  writePath: (cwd: string) => string;
  changedFiles: string[];
  expectedAction: "accept" | "revise";
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
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function egoResult(changedFiles: string[]): EgoResult {
  return {
    status: "completed",
    summary: "完成数据表任务，包含省包和市场份额测算。",
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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "case";
}
