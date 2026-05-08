import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureMasDirs, MAS_DATA_DIR } from "./config.js";
import type {
  ConversationContext,
  ConversationTurn,
  ExperienceEdgeType,
  ExperienceNodeInput,
  MasEvent,
  MasEventInput,
  ReflectionStatus,
  ReflectionTask,
  ReflectionTaskInput,
  RoleName,
} from "./types.js";

export class MasStore {
  private readonly db: DatabaseSync;

  constructor(path = join(MAS_DATA_DIR, "mas.sqlite")) {
    ensureMasDirs();
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000");
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
      CREATE TABLE IF NOT EXISTS experience_nodes (
        node_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_experience_nodes_run ON experience_nodes (run_id);
      CREATE INDEX IF NOT EXISTS idx_experience_nodes_type ON experience_nodes (type);
      CREATE TABLE IF NOT EXISTS experience_edges (
        edge_id TEXT PRIMARY KEY,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_experience_edges_from ON experience_edges (from_node_id);
      CREATE INDEX IF NOT EXISTS idx_experience_edges_to ON experience_edges (to_node_id);
      CREATE TABLE IF NOT EXISTS reflection_tasks (
        reflection_id TEXT PRIMARY KEY,
        source_run_id TEXT NOT NULL,
        source_node_id TEXT,
        parent_reflection_id TEXT,
        status TEXT NOT NULL,
        purpose TEXT NOT NULL,
        trigger_at TEXT NOT NULL,
        depth INTEGER NOT NULL,
        wakeups INTEGER NOT NULL,
        max_depth INTEGER NOT NULL,
        max_children INTEGER NOT NULL,
        max_wakeups INTEGER NOT NULL,
        allow_nested INTEGER NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reflection_tasks_due ON reflection_tasks (status, trigger_at);
      CREATE INDEX IF NOT EXISTS idx_reflection_tasks_source_run ON reflection_tasks (source_run_id);
    `);
  }

  close(): void {
    this.db.close();
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

  listApprovals(runId: string): Array<{
    toolCallId: string;
    toolName: string;
    decision: string;
    rawInput?: unknown;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare("SELECT tool_call_id, tool_name, decision, raw_input_json, created_at FROM approvals WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as Array<{
      tool_call_id: string;
      tool_name: string;
      decision: string;
      raw_input_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      decision: row.decision,
      rawInput: parseJson(row.raw_input_json),
      createdAt: row.created_at,
    }));
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

  addExperienceNode(input: ExperienceNodeInput): string {
    const now = new Date().toISOString();
    const nodeId = input.nodeId ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO experience_nodes (node_id, type, run_id, status, title, summary, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           status = excluded.status,
           title = excluded.title,
           summary = excluded.summary,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        nodeId,
        input.type,
        input.runId ?? null,
        input.status ?? "active",
        input.title,
        input.summary,
        stringifyJson(input.payload),
        now,
        now,
      );
    return nodeId;
  }

  addExperienceEdge(input: {
    fromNodeId: string;
    toNodeId: string;
    type: ExperienceEdgeType;
    weight?: number;
    confidence?: number;
  }): string {
    const edgeId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO experience_edges (edge_id, from_node_id, to_node_id, type, weight, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(edgeId, input.fromNodeId, input.toNodeId, input.type, input.weight ?? 1, input.confidence ?? 0.8, new Date().toISOString());
    return edgeId;
  }

  addReflectionTask(input: ReflectionTaskInput): string {
    const now = new Date().toISOString();
    const reflectionId = input.reflectionId ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO reflection_tasks (
          reflection_id, source_run_id, source_node_id, parent_reflection_id, status, purpose, trigger_at,
          depth, wakeups, max_depth, max_children, max_wakeups, allow_nested, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(reflection_id) DO UPDATE SET
          status = excluded.status,
          purpose = excluded.purpose,
          trigger_at = excluded.trigger_at,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        reflectionId,
        input.sourceRunId,
        input.sourceNodeId ?? null,
        input.parentReflectionId ?? null,
        "scheduled",
        input.purpose,
        input.triggerAt,
        input.depth ?? 0,
        0,
        input.maxDepth ?? 2,
        input.maxChildren ?? 2,
        input.maxWakeups ?? 2,
        input.allowNested === false ? 0 : 1,
        stringifyJson(input.payload),
        now,
        now,
      );
    return reflectionId;
  }

  listDueReflectionTasks(now = new Date().toISOString(), limit = 20): ReflectionTask[] {
    const rows = this.db
      .prepare(
        `SELECT reflection_id, source_run_id, source_node_id, parent_reflection_id, status, purpose, trigger_at,
          depth, wakeups, max_depth, max_children, max_wakeups, allow_nested, payload_json, created_at, updated_at
         FROM reflection_tasks
         WHERE status = 'scheduled' AND trigger_at <= ?
         ORDER BY trigger_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as ReflectionTaskRow[];
    return rows.map(toReflectionTask);
  }

  listReflectionTasks(status?: ReflectionStatus, limit = 20): ReflectionTask[] {
    const sql = status
      ? `SELECT reflection_id, source_run_id, source_node_id, parent_reflection_id, status, purpose, trigger_at,
          depth, wakeups, max_depth, max_children, max_wakeups, allow_nested, payload_json, created_at, updated_at
         FROM reflection_tasks WHERE status = ? ORDER BY trigger_at ASC LIMIT ?`
      : `SELECT reflection_id, source_run_id, source_node_id, parent_reflection_id, status, purpose, trigger_at,
          depth, wakeups, max_depth, max_children, max_wakeups, allow_nested, payload_json, created_at, updated_at
         FROM reflection_tasks ORDER BY trigger_at ASC LIMIT ?`;
    const rows = (status ? this.db.prepare(sql).all(status, limit) : this.db.prepare(sql).all(limit)) as ReflectionTaskRow[];
    return rows.map(toReflectionTask);
  }

  updateReflectionTask(
    reflectionId: string,
    input: { status: ReflectionStatus; payload?: unknown; triggerAt?: string; incrementWakeups?: boolean },
  ): void {
    const current = this.db.prepare("SELECT wakeups, payload_json FROM reflection_tasks WHERE reflection_id = ?").get(reflectionId) as
      | { wakeups: number; payload_json: string | null }
      | undefined;
    if (!current) return;
    this.db
      .prepare(
        `UPDATE reflection_tasks
         SET status = ?, trigger_at = COALESCE(?, trigger_at), wakeups = ?, payload_json = ?, updated_at = ?
         WHERE reflection_id = ?`,
      )
      .run(
        input.status,
        input.triggerAt ?? null,
        current.wakeups + (input.incrementWakeups ? 1 : 0),
        stringifyJson(input.payload ?? parseJson(current.payload_json)),
        new Date().toISOString(),
        reflectionId,
      );
  }

  dreamPruneReflectionTasks(limit = 20): number {
    const rows = this.db
      .prepare(
        `SELECT reflection_id
         FROM reflection_tasks
         WHERE status = 'scheduled' AND (wakeups >= max_wakeups OR depth >= max_depth)
         ORDER BY trigger_at ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{ reflection_id: string }>;
    for (const row of rows) {
      this.updateReflectionTask(row.reflection_id, { status: "pruned", payload: { prunedBy: "dream", reason: "budget_exhausted" } });
    }
    return rows.length;
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

type ReflectionTaskRow = {
  reflection_id: string;
  source_run_id: string;
  source_node_id: string | null;
  parent_reflection_id: string | null;
  status: ReflectionStatus;
  purpose: string;
  trigger_at: string;
  depth: number;
  wakeups: number;
  max_depth: number;
  max_children: number;
  max_wakeups: number;
  allow_nested: number;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
};

function toReflectionTask(row: ReflectionTaskRow): ReflectionTask {
  return {
    reflectionId: row.reflection_id,
    sourceRunId: row.source_run_id,
    sourceNodeId: row.source_node_id ?? undefined,
    parentReflectionId: row.parent_reflection_id ?? undefined,
    status: row.status,
    purpose: row.purpose,
    triggerAt: row.trigger_at,
    depth: row.depth,
    wakeups: row.wakeups,
    maxDepth: row.max_depth,
    maxChildren: row.max_children,
    maxWakeups: row.max_wakeups,
    allowNested: row.allow_nested === 1,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
