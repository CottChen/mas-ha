import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureMasDirs, MAS_DATA_DIR } from "./config.js";
import type {
  AutonomyJob,
  AutonomyJobInput,
  AutonomyJobStatus,
  ConversationContext,
  ConversationTurn,
  EntropyLedger,
  EntropyLedgerInput,
  ExperienceEdgeType,
  ExperienceNodeInput,
  GoalInput,
  GoalRecord,
  GoalStatus,
  GoalSubgoal,
  GoalSubgoalSource,
  GoalRunRecord,
  GoalRunStatus,
  GoalRunTrigger,
  LowEntropySignal,
  LowEntropySignalInput,
  MasEvent,
  MasEventInput,
  ReflectionStatus,
  ReflectionTask,
  ReflectionTaskInput,
  RoleName,
  SchedulerLease,
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
        owner_id TEXT,
        lease_until TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reflection_tasks_due ON reflection_tasks (status, trigger_at);
      CREATE INDEX IF NOT EXISTS idx_reflection_tasks_source_run ON reflection_tasks (source_run_id);
      CREATE TABLE IF NOT EXISTS autonomy_jobs (
        job_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        source_run_id TEXT,
        goal_id TEXT,
        trigger_at TEXT NOT NULL,
        owner_id TEXT,
        lease_until TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_autonomy_jobs_due ON autonomy_jobs (status, trigger_at, lease_until);
      CREATE TABLE IF NOT EXISTS goal_tasks (
        goal_id TEXT PRIMARY KEY,
        session_id TEXT,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_approval_mode TEXT NOT NULL,
        orchestration_mode TEXT NOT NULL,
        max_turns INTEGER NOT NULL,
        turns_used INTEGER NOT NULL,
        max_wall_clock_ms INTEGER,
        max_consecutive_failures INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        acceptance_contract_json TEXT NOT NULL,
        risk_budget_json TEXT NOT NULL,
        novelty_budget_json TEXT NOT NULL,
        entropy_budget_json TEXT NOT NULL,
        perturbation_budget_json TEXT NOT NULL,
        next_wake_at TEXT,
        expires_at TEXT,
        last_run_id TEXT,
        last_goal_run_id TEXT,
        owner_id TEXT,
        lease_until TEXT,
        permission_context_hash TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_tasks_due ON goal_tasks (status, next_wake_at, lease_until);
      CREATE INDEX IF NOT EXISTS idx_goal_tasks_cwd_status ON goal_tasks (cwd, status, updated_at);
      CREATE TABLE IF NOT EXISTS goal_runs (
        goal_run_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        mas_run_id TEXT,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        judge_result_json TEXT,
        payload_json TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_runs_goal ON goal_runs (goal_id, created_at);
      CREATE TABLE IF NOT EXISTS goal_subgoals (
        subgoal_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        requires_user_confirmation INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_subgoals_goal ON goal_subgoals (goal_id, status, created_at);
      CREATE TABLE IF NOT EXISTS entropy_ledgers (
        ledger_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        goal_id TEXT,
        score_version TEXT NOT NULL,
        open_questions_json TEXT NOT NULL,
        uncertainty_score REAL NOT NULL,
        evidence_score REAL NOT NULL,
        risk_score REAL NOT NULL,
        information_gain_score REAL NOT NULL,
        evidence_quality REAL NOT NULL,
        recommendation TEXT NOT NULL,
        signal_ids_json TEXT NOT NULL,
        deterministic_gates_json TEXT NOT NULL,
        next_best_observation TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entropy_ledgers_run ON entropy_ledgers (run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_entropy_ledgers_goal ON entropy_ledgers (goal_id, created_at);
      CREATE TABLE IF NOT EXISTS low_entropy_signals (
        signal_id TEXT PRIMARY KEY,
        run_id TEXT,
        goal_id TEXT,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        confidence REAL NOT NULL,
        freshness TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_uri TEXT,
        source_hash TEXT,
        captured_at TEXT NOT NULL,
        expires_at TEXT,
        retention_policy TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        redaction_status TEXT NOT NULL,
        secret_scan_status TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_low_entropy_signals_run ON low_entropy_signals (run_id, captured_at);
      CREATE INDEX IF NOT EXISTS idx_low_entropy_signals_goal ON low_entropy_signals (goal_id, captured_at);
      CREATE TABLE IF NOT EXISTS context_perturbations (
        perturbation_id TEXT PRIMARY KEY,
        run_id TEXT,
        goal_id TEXT,
        kind TEXT NOT NULL,
        target_role TEXT NOT NULL,
        generated_by TEXT NOT NULL,
        trigger TEXT NOT NULL,
        injection_point TEXT NOT NULL,
        type TEXT NOT NULL,
        context_patch_hash TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        status TEXT NOT NULL,
        safety_gate_result TEXT NOT NULL,
        harmlessness TEXT NOT NULL,
        target_attractor TEXT NOT NULL,
        expected_novelty REAL NOT NULL,
        max_risk TEXT NOT NULL,
        applied_run_id TEXT,
        produced_signal_id TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_perturbations_run ON context_perturbations (run_id, status);
      CREATE TABLE IF NOT EXISTS scheduler_leases (
        name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        metadata_json TEXT
      );
    `);
    this.ensureColumn("reflection_tasks", "owner_id", "TEXT");
    this.ensureColumn("reflection_tasks", "lease_until", "TEXT");
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

  claimDueReflectionTasks(input: { ownerId: string; now?: string; limit?: number; leaseMs?: number }): ReflectionTask[] {
    const now = input.now ?? new Date().toISOString();
    const leaseUntil = new Date(Date.parse(now) + (input.leaseMs ?? 5 * 60_000)).toISOString();
    const rows = this.db
      .prepare(
        `SELECT reflection_id
         FROM reflection_tasks
         WHERE status = 'scheduled' AND trigger_at <= ?
         ORDER BY trigger_at ASC
         LIMIT ?`,
      )
      .all(now, input.limit ?? 20) as Array<{ reflection_id: string }>;
    const claimed: ReflectionTask[] = [];
    for (const row of rows) {
      const result = this.db
        .prepare(
          `UPDATE reflection_tasks
           SET status = 'running', owner_id = ?, lease_until = ?, updated_at = ?
           WHERE reflection_id = ? AND status = 'scheduled' AND trigger_at <= ?`,
        )
        .run(input.ownerId, leaseUntil, now, row.reflection_id, now) as { changes?: number };
      if ((result.changes ?? 0) !== 1) continue;
      const task = this.getReflectionTask(row.reflection_id);
      if (task) claimed.push(task);
    }
    return claimed;
  }

  getReflectionTask(reflectionId: string): ReflectionTask | undefined {
    const row = this.db
      .prepare(
        `SELECT reflection_id, source_run_id, source_node_id, parent_reflection_id, status, purpose, trigger_at,
          depth, wakeups, max_depth, max_children, max_wakeups, allow_nested, owner_id, lease_until, payload_json, created_at, updated_at
         FROM reflection_tasks WHERE reflection_id = ?`,
      )
      .get(reflectionId) as ReflectionTaskRow | undefined;
    return row ? toReflectionTask(row) : undefined;
  }

  listDueReflectionTasks(now = new Date().toISOString(), limit = 20): ReflectionTask[] {
    const rows = this.db
      .prepare(
        `SELECT reflection_id, source_run_id, source_node_id, parent_reflection_id, status, purpose, trigger_at,
          depth, wakeups, max_depth, max_children, max_wakeups, allow_nested, owner_id, lease_until, payload_json, created_at, updated_at
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
          depth, wakeups, max_depth, max_children, max_wakeups, allow_nested, owner_id, lease_until, payload_json, created_at, updated_at
         FROM reflection_tasks WHERE status = ? ORDER BY trigger_at ASC LIMIT ?`
      : `SELECT reflection_id, source_run_id, source_node_id, parent_reflection_id, status, purpose, trigger_at,
          depth, wakeups, max_depth, max_children, max_wakeups, allow_nested, owner_id, lease_until, payload_json, created_at, updated_at
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
         SET status = ?, trigger_at = COALESCE(?, trigger_at), wakeups = ?, owner_id = NULL, lease_until = NULL, payload_json = ?, updated_at = ?
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

  acquireSchedulerLease(input: { name: string; ownerId: string; ttlMs: number; metadata?: unknown }): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    const current = this.db.prepare("SELECT owner_id, expires_at FROM scheduler_leases WHERE name = ?").get(input.name) as
      | { owner_id: string; expires_at: string }
      | undefined;
    if (!current) {
      this.db
        .prepare("INSERT INTO scheduler_leases (name, owner_id, heartbeat_at, expires_at, metadata_json) VALUES (?, ?, ?, ?, ?)")
        .run(input.name, input.ownerId, nowIso, expiresAt, stringifyJson(input.metadata));
      return true;
    }
    if (current.owner_id !== input.ownerId && current.expires_at > nowIso) return false;
    const result = this.db
      .prepare(
        `UPDATE scheduler_leases
         SET owner_id = ?, heartbeat_at = ?, expires_at = ?, metadata_json = ?
         WHERE name = ? AND (owner_id = ? OR expires_at <= ?)`,
      )
      .run(input.ownerId, nowIso, expiresAt, stringifyJson(input.metadata), input.name, input.ownerId, nowIso) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }

  getSchedulerLease(name: string): SchedulerLease | undefined {
    const row = this.db.prepare("SELECT name, owner_id, heartbeat_at, expires_at, metadata_json FROM scheduler_leases WHERE name = ?").get(name) as
      | { name: string; owner_id: string; heartbeat_at: string; expires_at: string; metadata_json: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      name: row.name,
      ownerId: row.owner_id,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      metadata: parseJson(row.metadata_json),
    };
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

  addAutonomyJob(input: AutonomyJobInput): string {
    const now = new Date().toISOString();
    const jobId = input.jobId ?? randomUUID();
    const budget = normalizeAutonomyBudget(input.budget);
    this.db
      .prepare(
        `INSERT INTO autonomy_jobs (
          job_id, type, status, source_run_id, goal_id, trigger_at, depth, wakeups, max_depth,
          max_children, max_wakeups, allow_nested, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          status = excluded.status,
          trigger_at = excluded.trigger_at,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        jobId,
        input.type,
        input.status ?? "scheduled",
        input.sourceRunId ?? null,
        input.goalId ?? null,
        input.triggerAt,
        budget.depth,
        budget.wakeups,
        budget.maxDepth,
        budget.maxChildren,
        budget.maxWakeups,
        budget.allowNested ? 1 : 0,
        stringifyJson(input.payload),
        now,
        now,
      );
    return jobId;
  }

  claimDueAutonomyJobs(input: { ownerId: string; now?: string; limit?: number; leaseMs?: number }): AutonomyJob[] {
    const now = input.now ?? new Date().toISOString();
    const leaseUntil = new Date(Date.parse(now) + (input.leaseMs ?? 5 * 60_000)).toISOString();
    const rows = this.db
      .prepare(
        `SELECT job_id
         FROM autonomy_jobs
         WHERE status = 'scheduled'
           AND trigger_at <= ?
           AND (lease_until IS NULL OR lease_until <= ?)
         ORDER BY trigger_at ASC
         LIMIT ?`,
      )
      .all(now, now, input.limit ?? 20) as Array<{ job_id: string }>;
    const claimed: AutonomyJob[] = [];
    for (const row of rows) {
      const result = this.db
        .prepare(
          `UPDATE autonomy_jobs
           SET status = 'running', owner_id = ?, lease_until = ?, updated_at = ?
           WHERE job_id = ?
             AND status = 'scheduled'
             AND trigger_at <= ?
             AND (lease_until IS NULL OR lease_until <= ?)`,
        )
        .run(input.ownerId, leaseUntil, now, row.job_id, now, now) as { changes?: number };
      if ((result.changes ?? 0) !== 1) continue;
      const job = this.getAutonomyJob(row.job_id);
      if (job) claimed.push(job);
    }
    return claimed;
  }

  getAutonomyJob(jobId: string): AutonomyJob | undefined {
    const row = this.db
      .prepare(
        `SELECT job_id, type, status, source_run_id, goal_id, trigger_at, owner_id, lease_until,
          depth, wakeups, max_depth, max_children, max_wakeups, allow_nested, payload_json, created_at, updated_at
         FROM autonomy_jobs WHERE job_id = ?`,
      )
      .get(jobId) as AutonomyJobRow | undefined;
    return row ? toAutonomyJob(row) : undefined;
  }

  updateAutonomyJob(jobId: string, input: { status: AutonomyJobStatus; payload?: unknown; triggerAt?: string }): void {
    const current = this.db.prepare("SELECT payload_json FROM autonomy_jobs WHERE job_id = ?").get(jobId) as
      | { payload_json: string | null }
      | undefined;
    if (!current) return;
    this.db
      .prepare(
        `UPDATE autonomy_jobs
         SET status = ?, trigger_at = COALESCE(?, trigger_at), owner_id = NULL, lease_until = NULL, payload_json = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(input.status, input.triggerAt ?? null, stringifyJson(input.payload ?? parseJson(current.payload_json)), new Date().toISOString(), jobId);
  }

  createGoal(input: GoalInput): GoalRecord {
    const now = new Date().toISOString();
    const goalId = input.goalId ?? randomUUID();
    const riskBudget = input.riskBudget ?? defaultGoalBudget(10, "risk_point");
    const noveltyBudget = input.noveltyBudget ?? defaultGoalBudget(5, "count");
    const entropyBudget = input.entropyBudget ?? defaultGoalBudget(10, "count");
    const perturbationBudget = input.perturbationBudget ?? defaultGoalBudget(3, "count");
    this.db
      .prepare(
        `INSERT INTO goal_tasks (
          goal_id, session_id, cwd, title, objective, status, requested_approval_mode, orchestration_mode,
          max_turns, turns_used, max_wall_clock_ms, max_consecutive_failures, consecutive_failures,
          acceptance_contract_json, risk_budget_json, novelty_budget_json, entropy_budget_json, perturbation_budget_json,
          next_wake_at, expires_at, permission_context_hash, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goalId,
        input.sessionId ?? null,
        input.cwd,
        input.title,
        input.objective,
        input.status ?? "active",
        input.requestedApprovalMode,
        input.orchestrationMode,
        input.maxTurns ?? 20,
        0,
        input.maxWallClockMs ?? null,
        input.maxConsecutiveFailures ?? 3,
        0,
        stringifyJson(input.acceptanceContract) ?? "{}",
        stringifyJson(riskBudget),
        stringifyJson(noveltyBudget),
        stringifyJson(entropyBudget),
        stringifyJson(perturbationBudget),
        input.nextWakeAt ?? null,
        input.expiresAt ?? null,
        input.permissionContextHash ?? null,
        stringifyJson(input.payload),
        now,
        now,
      );
    const goal = this.getGoal(goalId);
    if (!goal) throw new Error(`Goal 创建后无法读取：${goalId}`);
    return goal;
  }

  getGoal(goalId: string): GoalRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT goal_id, session_id, cwd, title, objective, status, requested_approval_mode, orchestration_mode,
          max_turns, turns_used, max_wall_clock_ms, max_consecutive_failures, consecutive_failures,
          acceptance_contract_json, risk_budget_json, novelty_budget_json, entropy_budget_json, perturbation_budget_json,
          next_wake_at, expires_at, last_run_id, last_goal_run_id, owner_id, lease_until, permission_context_hash,
          payload_json, created_at, updated_at
         FROM goal_tasks WHERE goal_id = ?`,
      )
      .get(goalId) as GoalRow | undefined;
    return row ? toGoal(row) : undefined;
  }

  listGoals(input: { cwd?: string; statuses?: GoalStatus[]; limit?: number } = {}): GoalRecord[] {
    const limit = input.limit ?? 20;
    const statuses = input.statuses;
    let sql =
      `SELECT goal_id, session_id, cwd, title, objective, status, requested_approval_mode, orchestration_mode,
        max_turns, turns_used, max_wall_clock_ms, max_consecutive_failures, consecutive_failures,
        acceptance_contract_json, risk_budget_json, novelty_budget_json, entropy_budget_json, perturbation_budget_json,
        next_wake_at, expires_at, last_run_id, last_goal_run_id, owner_id, lease_until, permission_context_hash,
        payload_json, created_at, updated_at
       FROM goal_tasks`;
    const params: Array<string | number> = [];
    const clauses: string[] = [];
    if (input.cwd) {
      clauses.push("cwd = ?");
      params.push(input.cwd);
    }
    if (statuses && statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as GoalRow[]).map(toGoal);
  }

  updateGoal(input: {
    goalId: string;
    status?: GoalStatus;
    lastRunId?: string;
    lastGoalRunId?: string;
    turnsUsed?: number;
    consecutiveFailures?: number;
    nextWakeAt?: string | null;
    payload?: unknown;
  }): GoalRecord | undefined {
    const current = this.getGoal(input.goalId);
    if (!current) return undefined;
    this.db
      .prepare(
        `UPDATE goal_tasks
         SET status = COALESCE(?, status),
             last_run_id = COALESCE(?, last_run_id),
             last_goal_run_id = COALESCE(?, last_goal_run_id),
             turns_used = COALESCE(?, turns_used),
             consecutive_failures = COALESCE(?, consecutive_failures),
             next_wake_at = ?,
             owner_id = NULL,
             lease_until = NULL,
             payload_json = COALESCE(?, payload_json),
             updated_at = ?
         WHERE goal_id = ?`,
      )
      .run(
        input.status ?? null,
        input.lastRunId ?? null,
        input.lastGoalRunId ?? null,
        input.turnsUsed ?? null,
        input.consecutiveFailures ?? null,
        input.nextWakeAt === undefined ? current.nextWakeAt ?? null : input.nextWakeAt,
        input.payload === undefined ? null : stringifyJson(input.payload),
        new Date().toISOString(),
        input.goalId,
      );
    return this.getGoal(input.goalId);
  }

  addGoalRun(input: {
    goalRunId?: string;
    goalId: string;
    masRunId?: string;
    ownerId: string;
    status?: GoalRunStatus;
    trigger: GoalRunTrigger;
    startedAt?: string;
    endedAt?: string;
    judgeResult?: unknown;
    payload?: unknown;
  }): string {
    const now = new Date().toISOString();
    const goalRunId = input.goalRunId ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO goal_runs (
          goal_run_id, goal_id, mas_run_id, owner_id, status, trigger, judge_result_json,
          payload_json, started_at, ended_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goalRunId,
        input.goalId,
        input.masRunId ?? null,
        input.ownerId,
        input.status ?? "scheduled",
        input.trigger,
        stringifyJson(input.judgeResult),
        stringifyJson(input.payload),
        input.startedAt ?? null,
        input.endedAt ?? null,
        now,
        now,
      );
    return goalRunId;
  }

  listGoalRuns(goalId: string, limit = 20): GoalRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT goal_run_id, goal_id, mas_run_id, owner_id, status, trigger, judge_result_json,
          payload_json, started_at, ended_at, created_at, updated_at
         FROM goal_runs WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(goalId, limit) as GoalRunRow[];
    return rows.map(toGoalRun);
  }

  addSubgoal(input: {
    subgoalId?: string;
    goalId: string;
    text: string;
    status: GoalSubgoal["status"];
    source: GoalSubgoalSource;
    requiresUserConfirmation: boolean;
  }): GoalSubgoal {
    const now = new Date().toISOString();
    const subgoalId = input.subgoalId ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO goal_subgoals (
          subgoal_id, goal_id, text, status, source, requires_user_confirmation, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(subgoalId, input.goalId, input.text, input.status, input.source, input.requiresUserConfirmation ? 1 : 0, now, now);
    const subgoal = this.getSubgoal(subgoalId);
    if (!subgoal) throw new Error(`Subgoal 创建后无法读取：${subgoalId}`);
    return subgoal;
  }

  getSubgoal(subgoalId: string): GoalSubgoal | undefined {
    const row = this.db
      .prepare("SELECT subgoal_id, goal_id, text, status, source, requires_user_confirmation, created_at, updated_at FROM goal_subgoals WHERE subgoal_id = ?")
      .get(subgoalId) as GoalSubgoalRow | undefined;
    return row ? toSubgoal(row) : undefined;
  }

  listSubgoals(goalId: string): GoalSubgoal[] {
    const rows = this.db
      .prepare(
        "SELECT subgoal_id, goal_id, text, status, source, requires_user_confirmation, created_at, updated_at FROM goal_subgoals WHERE goal_id = ? AND status != 'removed' ORDER BY created_at ASC",
      )
      .all(goalId) as GoalSubgoalRow[];
    return rows.map(toSubgoal);
  }

  updateSubgoalStatus(subgoalId: string, status: GoalSubgoal["status"]): GoalSubgoal | undefined {
    this.db.prepare("UPDATE goal_subgoals SET status = ?, updated_at = ? WHERE subgoal_id = ?").run(status, new Date().toISOString(), subgoalId);
    return this.getSubgoal(subgoalId);
  }

  addLowEntropySignal(input: LowEntropySignalInput): string {
    const now = new Date().toISOString();
    const signalId = input.signalId ?? randomUUID();
    const capturedAt = input.capturedAt ?? now;
    if (input.sensitivity === "secret" && input.payload !== undefined) {
      throw new Error("LowEntropySignal sensitivity=secret 时不能保存原始 payload");
    }
    this.db
      .prepare(
        `INSERT INTO low_entropy_signals (
          signal_id, run_id, goal_id, type, scope, confidence, freshness, source_kind, source_uri,
          source_hash, captured_at, expires_at, retention_policy, sensitivity, redaction_status,
          secret_scan_status, summary, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        signalId,
        input.runId ?? null,
        input.goalId ?? null,
        input.type,
        input.scope,
        clamp01(input.confidence),
        input.freshness,
        input.sourceKind,
        input.sourceUri ?? null,
        input.sourceHash ?? null,
        capturedAt,
        input.expiresAt ?? null,
        input.retentionPolicy,
        input.sensitivity,
        input.redactionStatus,
        input.secretScanStatus,
        input.summary,
        stringifyJson(input.payload),
        now,
      );
    return signalId;
  }

  listLowEntropySignals(input: { runId?: string; goalId?: string; limit?: number }): LowEntropySignal[] {
    const limit = input.limit ?? 50;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.runId) {
      clauses.push("run_id = ?");
      params.push(input.runId);
    }
    if (input.goalId) {
      clauses.push("goal_id = ?");
      params.push(input.goalId);
    }
    let sql =
      `SELECT signal_id, run_id, goal_id, type, scope, confidence, freshness, source_kind, source_uri,
        source_hash, captured_at, expires_at, retention_policy, sensitivity, redaction_status,
        secret_scan_status, summary, payload_json, created_at
       FROM low_entropy_signals`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY captured_at DESC LIMIT ?";
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as LowEntropySignalRow[]).map(toLowEntropySignal);
  }

  addEntropyLedger(input: EntropyLedgerInput): string {
    const now = new Date().toISOString();
    const ledgerId = input.ledgerId ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO entropy_ledgers (
          ledger_id, run_id, goal_id, score_version, open_questions_json, uncertainty_score,
          evidence_score, risk_score, information_gain_score, evidence_quality, recommendation,
          signal_ids_json, deterministic_gates_json, next_best_observation, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ledgerId,
        input.runId,
        input.goalId ?? null,
        input.scoreVersion ?? "entropy_score_v1",
        stringifyJson(input.openQuestions ?? []) ?? "[]",
        clamp01(input.uncertaintyScore),
        clamp01(input.evidenceScore),
        clamp01(input.riskScore),
        clamp01(input.informationGainScore),
        clamp01(input.evidenceQuality),
        input.recommendation,
        stringifyJson(input.signalIds) ?? "[]",
        stringifyJson(input.deterministicGates) ?? "[]",
        input.nextBestObservation ?? null,
        stringifyJson(input.payload),
        now,
      );
    return ledgerId;
  }

  listEntropyLedgers(input: { runId?: string; goalId?: string; limit?: number }): EntropyLedger[] {
    const limit = input.limit ?? 20;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.runId) {
      clauses.push("run_id = ?");
      params.push(input.runId);
    }
    if (input.goalId) {
      clauses.push("goal_id = ?");
      params.push(input.goalId);
    }
    let sql =
      `SELECT ledger_id, run_id, goal_id, score_version, open_questions_json, uncertainty_score,
        evidence_score, risk_score, information_gain_score, evidence_quality, recommendation,
        signal_ids_json, deterministic_gates_json, next_best_observation, payload_json, created_at
       FROM entropy_ledgers`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as EntropyLedgerRow[]).map(toEntropyLedger);
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

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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
  owner_id: string | null;
  lease_until: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
};

type AutonomyJobRow = {
  job_id: string;
  type: AutonomyJob["type"];
  status: AutonomyJobStatus;
  source_run_id: string | null;
  goal_id: string | null;
  trigger_at: string;
  owner_id: string | null;
  lease_until: string | null;
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

type GoalRow = {
  goal_id: string;
  session_id: string | null;
  cwd: string;
  title: string;
  objective: string;
  status: GoalStatus;
  requested_approval_mode: GoalRecord["requestedApprovalMode"];
  orchestration_mode: GoalRecord["orchestrationMode"];
  max_turns: number;
  turns_used: number;
  max_wall_clock_ms: number | null;
  max_consecutive_failures: number;
  consecutive_failures: number;
  acceptance_contract_json: string;
  risk_budget_json: string;
  novelty_budget_json: string;
  entropy_budget_json: string;
  perturbation_budget_json: string;
  next_wake_at: string | null;
  expires_at: string | null;
  last_run_id: string | null;
  last_goal_run_id: string | null;
  owner_id: string | null;
  lease_until: string | null;
  permission_context_hash: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
};

type GoalRunRow = {
  goal_run_id: string;
  goal_id: string;
  mas_run_id: string | null;
  owner_id: string;
  status: GoalRunStatus;
  trigger: GoalRunTrigger;
  judge_result_json: string | null;
  payload_json: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

type GoalSubgoalRow = {
  subgoal_id: string;
  goal_id: string;
  text: string;
  status: GoalSubgoal["status"];
  source: GoalSubgoalSource;
  requires_user_confirmation: number;
  created_at: string;
  updated_at: string;
};

type LowEntropySignalRow = {
  signal_id: string;
  run_id: string | null;
  goal_id: string | null;
  type: LowEntropySignal["type"];
  scope: LowEntropySignal["scope"];
  confidence: number;
  freshness: LowEntropySignal["freshness"];
  source_kind: LowEntropySignal["sourceKind"];
  source_uri: string | null;
  source_hash: string | null;
  captured_at: string;
  expires_at: string | null;
  retention_policy: LowEntropySignal["retentionPolicy"];
  sensitivity: LowEntropySignal["sensitivity"];
  redaction_status: LowEntropySignal["redactionStatus"];
  secret_scan_status: LowEntropySignal["secretScanStatus"];
  summary: string;
  payload_json: string | null;
  created_at: string;
};

type EntropyLedgerRow = {
  ledger_id: string;
  run_id: string;
  goal_id: string | null;
  score_version: EntropyLedger["scoreVersion"];
  open_questions_json: string;
  uncertainty_score: number;
  evidence_score: number;
  risk_score: number;
  information_gain_score: number;
  evidence_quality: number;
  recommendation: EntropyLedger["recommendation"];
  signal_ids_json: string;
  deterministic_gates_json: string;
  next_best_observation: string | null;
  payload_json: string | null;
  created_at: string;
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
    ownerId: row.owner_id ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAutonomyJob(row: AutonomyJobRow): AutonomyJob {
  return {
    jobId: row.job_id,
    type: row.type,
    status: row.status,
    sourceRunId: row.source_run_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    triggerAt: row.trigger_at,
    ownerId: row.owner_id ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    budget: {
      depth: row.depth,
      wakeups: row.wakeups,
      maxDepth: row.max_depth,
      maxChildren: row.max_children,
      maxWakeups: row.max_wakeups,
      allowNested: row.allow_nested === 1,
    },
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGoal(row: GoalRow): GoalRecord {
  return {
    goalId: row.goal_id,
    sessionId: row.session_id ?? undefined,
    cwd: row.cwd,
    title: row.title,
    objective: row.objective,
    status: row.status,
    requestedApprovalMode: row.requested_approval_mode,
    orchestrationMode: row.orchestration_mode,
    maxTurns: row.max_turns,
    turnsUsed: row.turns_used,
    maxWallClockMs: row.max_wall_clock_ms ?? undefined,
    maxConsecutiveFailures: row.max_consecutive_failures,
    consecutiveFailures: row.consecutive_failures,
    acceptanceContract: parseJson(row.acceptance_contract_json) as GoalRecord["acceptanceContract"],
    riskBudget: parseJson(row.risk_budget_json) as GoalRecord["riskBudget"],
    noveltyBudget: parseJson(row.novelty_budget_json) as GoalRecord["noveltyBudget"],
    entropyBudget: parseJson(row.entropy_budget_json) as GoalRecord["entropyBudget"],
    perturbationBudget: parseJson(row.perturbation_budget_json) as GoalRecord["perturbationBudget"],
    nextWakeAt: row.next_wake_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
    lastGoalRunId: row.last_goal_run_id ?? undefined,
    ownerId: row.owner_id ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    permissionContextHash: row.permission_context_hash ?? undefined,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGoalRun(row: GoalRunRow): GoalRunRecord {
  return {
    goalRunId: row.goal_run_id,
    goalId: row.goal_id,
    masRunId: row.mas_run_id ?? undefined,
    ownerId: row.owner_id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    judgeResult: parseJson(row.judge_result_json) as GoalRunRecord["judgeResult"],
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSubgoal(row: GoalSubgoalRow): GoalSubgoal {
  return {
    subgoalId: row.subgoal_id,
    goalId: row.goal_id,
    text: row.text,
    status: row.status,
    source: row.source,
    requiresUserConfirmation: row.requires_user_confirmation === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLowEntropySignal(row: LowEntropySignalRow): LowEntropySignal {
  return {
    signalId: row.signal_id,
    runId: row.run_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    type: row.type,
    summary: row.summary,
    confidence: row.confidence,
    scope: row.scope,
    freshness: row.freshness,
    sourceKind: row.source_kind,
    sourceUri: row.source_uri ?? undefined,
    sourceHash: row.source_hash ?? undefined,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at ?? undefined,
    retentionPolicy: row.retention_policy,
    sensitivity: row.sensitivity,
    redactionStatus: row.redaction_status,
    secretScanStatus: row.secret_scan_status,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function toEntropyLedger(row: EntropyLedgerRow): EntropyLedger {
  return {
    ledgerId: row.ledger_id,
    runId: row.run_id,
    goalId: row.goal_id ?? undefined,
    scoreVersion: row.score_version,
    openQuestions: parseStringArray(row.open_questions_json),
    signalIds: parseStringArray(row.signal_ids_json),
    uncertaintyScore: row.uncertainty_score,
    evidenceScore: row.evidence_score,
    riskScore: row.risk_score,
    informationGainScore: row.information_gain_score,
    evidenceQuality: row.evidence_quality,
    nextBestObservation: row.next_best_observation ?? undefined,
    recommendation: row.recommendation,
    deterministicGates: parseStringArray(row.deterministic_gates_json),
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function normalizeAutonomyBudget(input?: Partial<AutonomyJob["budget"]>): AutonomyJob["budget"] {
  return {
    depth: input?.depth ?? 0,
    wakeups: input?.wakeups ?? 0,
    maxDepth: input?.maxDepth ?? 2,
    maxChildren: input?.maxChildren ?? 2,
    maxWakeups: input?.maxWakeups ?? 2,
    allowNested: input?.allowNested ?? true,
  };
}

function defaultGoalBudget(max: number, unit: GoalRecord["riskBudget"]["unit"]): GoalRecord["riskBudget"] {
  return { max, used: 0, unit };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function parseStringArray(value: string): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
