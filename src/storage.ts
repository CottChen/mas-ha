import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ensureMasDirs, MAS_DATA_DIR } from "./config.js";
import type { RoleName } from "./types.js";

export class MasStore {
  private readonly db: DatabaseSync;

  constructor(path = join(MAS_DATA_DIR, "mas.sqlite")) {
    ensureMasDirs();
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        raw_input_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  createRun(input: { runId: string; sessionId?: string; cwd: string; prompt: string }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO runs (run_id, session_id, cwd, status, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(input.runId, input.sessionId ?? null, input.cwd, "running", input.prompt, now, now);
  }

  updateRun(runId: string, status: string, result?: unknown): void {
    this.db
      .prepare("UPDATE runs SET status = ?, result = ?, updated_at = ? WHERE run_id = ?")
      .run(status, result === undefined ? null : JSON.stringify(result), new Date().toISOString(), runId);
  }

  addAgentRun(input: {
    runId: string;
    role: RoleName;
    iteration: number;
    status: string;
    input: unknown;
    output?: unknown;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO agent_runs (run_id, role, iteration, status, input_json, output_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.runId,
        input.role,
        input.iteration,
        input.status,
        JSON.stringify(input.input),
        input.output === undefined ? null : JSON.stringify(input.output),
        now,
        now,
      );
  }

  addApproval(input: { runId: string; toolCallId: string; toolName: string; decision: string; rawInput?: unknown }): void {
    this.db
      .prepare(
        "INSERT INTO approvals (run_id, tool_call_id, tool_name, decision, raw_input_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.runId,
        input.toolCallId,
        input.toolName,
        input.decision,
        input.rawInput === undefined ? null : JSON.stringify(input.rawInput),
        new Date().toISOString(),
      );
  }

  audit(input: { runId: string; actor: string; action: string; target?: string; payload?: unknown }): void {
    this.db
      .prepare("INSERT INTO audit_log (run_id, actor, action, target, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        input.runId,
        input.actor,
        input.action,
        input.target ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        new Date().toISOString(),
      );
  }

  listRuns(limit = 20): unknown[] {
    return this.db
      .prepare("SELECT run_id, session_id, cwd, status, prompt, result, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }
}
