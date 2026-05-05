import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureMasDirs, MAS_DATA_DIR } from "./config.js";
import type { ConversationContext, ConversationTurn, MasEvent, MasEventInput, RoleName } from "./types.js";

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
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        session_id TEXT,
        role TEXT,
        iteration INTEGER,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        tool_call_id TEXT,
        parent_event_id TEXT,
        correlation_id TEXT,
        payload_json TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON events (run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON events (session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_tool_call ON events (tool_call_id);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_context (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        summarized_message_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL
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

  addEvent(input: MasEventInput): MasEvent {
    const eventId = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO events (
          event_id, run_id, session_id, role, iteration, source, type, actor, tool_call_id,
          parent_event_id, correlation_id, payload_json, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.runId,
        input.sessionId ?? null,
        input.role ?? null,
        input.iteration ?? null,
        input.source,
        input.type,
        input.actor,
        input.toolCallId ?? null,
        input.parentEventId ?? null,
        input.correlationId ?? null,
        stringifyJson(input.payload),
        stringifyJson(input.raw),
        createdAt,
      );
    return {
      ...input,
      eventId,
      sequence: Number(result.lastInsertRowid),
      createdAt,
    };
  }

  listEvents(runId: string, limit = 200): MasEvent[] {
    const rows = this.db
      .prepare(
        `SELECT sequence, event_id, run_id, session_id, role, iteration, source, type, actor, tool_call_id,
          parent_event_id, correlation_id, payload_json, raw_json, created_at
         FROM events
         WHERE run_id = ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(runId, limit) as Array<{
      sequence: number;
      event_id: string;
      run_id: string;
      session_id: string | null;
      role: RoleName | null;
      iteration: number | null;
      source: MasEvent["source"];
      type: string;
      actor: MasEvent["actor"];
      tool_call_id: string | null;
      parent_event_id: string | null;
      correlation_id: string | null;
      payload_json: string | null;
      raw_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      eventId: row.event_id,
      runId: row.run_id,
      sessionId: row.session_id ?? undefined,
      role: row.role ?? undefined,
      iteration: row.iteration ?? undefined,
      source: row.source,
      type: row.type,
      actor: row.actor,
      toolCallId: row.tool_call_id ?? undefined,
      parentEventId: row.parent_event_id ?? undefined,
      correlationId: row.correlation_id ?? undefined,
      payload: parseJson(row.payload_json),
      raw: parseJson(row.raw_json),
      createdAt: row.created_at,
    }));
  }

  listRuns(limit = 20): unknown[] {
    return this.db
      .prepare("SELECT run_id, session_id, cwd, status, prompt, result, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }

  getConversationHistory(sessionId: string, limit = 12): ConversationTurn[] {
    const messageTurns = this.getMessageTurns(sessionId, limit);
    if (messageTurns.length > 0) return messageTurns;

    const rows = this.db
      .prepare(
        "SELECT prompt, result FROM runs WHERE session_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT ?",
      )
      .all(sessionId, limit) as Array<{ prompt: string; result: string | null }>;
    const turns: ConversationTurn[] = [];
    for (const row of rows.reverse()) {
      turns.push({ role: "user", content: row.prompt });
      const assistant = extractAssistantResult(row.result);
      if (assistant) turns.push({ role: "assistant", content: assistant });
    }
    return turns;
  }

  addMessage(input: { sessionId: string; role: ConversationTurn["role"]; content: string; metadata?: unknown }): number {
    const result = this.db
      .prepare("INSERT INTO messages (session_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        input.sessionId,
        input.role,
        input.content,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  getConversationContext(sessionId: string, limit = 12): ConversationContext {
    this.compactSessionContext(sessionId);
    const turns = this.getMessageTurns(sessionId, limit);
    return {
      summary: this.getSessionSummary(sessionId),
      turns: turns.length > 0 ? turns : this.getConversationHistory(sessionId, limit),
    };
  }

  compactSessionContext(sessionId: string, maxChars = 18000, keepTurns = 10): void {
    const rows = this.db
      .prepare("SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as Array<{ id: number; role: string; content: string }>;
    const totalChars = rows.reduce((sum, row) => sum + row.content.length, 0);
    if (totalChars <= maxChars || rows.length <= keepTurns) return;

    const keepStart = Math.max(0, rows.length - keepTurns);
    const toSummarize = rows.slice(0, keepStart);
    if (toSummarize.length === 0) return;

    const previous = this.getSessionSummary(sessionId);
    const summary = buildExtractiveSummary(previous, toSummarize);
    const summarizedMessageId = toSummarize[toSummarize.length - 1]?.id ?? 0;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO session_context (session_id, summary, summarized_message_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           summary = excluded.summary,
           summarized_message_id = excluded.summarized_message_id,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, summary, summarizedMessageId, now);
  }

  private getMessageTurns(sessionId: string, limit: number): ConversationTurn[] {
    const summaryRow = this.db
      .prepare("SELECT summarized_message_id FROM session_context WHERE session_id = ?")
      .get(sessionId) as { summarized_message_id: number } | undefined;
    const minId = summaryRow?.summarized_message_id ?? 0;
    const rows = this.db
      .prepare(
        "SELECT role, content FROM messages WHERE session_id = ? AND id > ? ORDER BY id DESC LIMIT ?",
      )
      .all(sessionId, minId, limit) as Array<{ role: string; content: string }>;
    return rows
      .reverse()
      .filter((row): row is { role: ConversationTurn["role"]; content: string } => row.role === "user" || row.role === "assistant")
      .map((row) => ({ role: row.role, content: row.content }));
  }

  private getSessionSummary(sessionId: string): string {
    const row = this.db.prepare("SELECT summary FROM session_context WHERE session_id = ?").get(sessionId) as
      | { summary: string }
      | undefined;
    return row?.summary ?? "";
  }
}

function extractAssistantResult(resultJson: string | null): string {
  if (!resultJson) return "";
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const result = (parsed as { result?: unknown }).result;
      if (typeof result === "string") return result;
    }
  } catch {
    return "";
  }
  return "";
}

function buildExtractiveSummary(previous: string, rows: Array<{ role: string; content: string }>): string {
  const parts: string[] = [];
  if (previous.trim()) {
    parts.push(previous.trim());
  }
  parts.push("## 已压缩的早期对话");
  for (const row of rows) {
    const role = row.role === "user" ? "用户" : "助手";
    parts.push(`- ${role}: ${row.content.replace(/\s+/g, " ").slice(0, 500)}`);
  }
  return parts.join("\n").slice(-12000);
}

function stringifyJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true, value: String(value) });
  }
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
