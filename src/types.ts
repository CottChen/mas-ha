import type { OrchestrationMode } from "./core/orchestration.js";

export type RoleName = "ha" | "ego" | "superego";

export type ApprovalMode = "approve-reads" | "approve-all" | "deny-writes";
export type ApprovalModePolicy = "fixed" | "mutable";
export type { OrchestrationMode } from "./core/orchestration.js";

export type MasEventSource = "mas" | "pi";
export type MasEventActor = RoleName | "system" | "user" | "tool" | "pi";
export type ExperienceNodeType = "task" | "execution_trace" | "result" | "experience" | "reflection" | "dream";
export type ExperienceEdgeType = "caused" | "produced" | "generalized_to" | "scheduled" | "reflected_on" | "dream_pruned";
export type ReflectionStatus = "scheduled" | "running" | "completed" | "cancelled" | "pruned";

export interface MasEventInput {
  runId: string;
  sessionId?: string;
  role?: RoleName;
  iteration?: number;
  source: MasEventSource;
  type: string;
  actor: MasEventActor;
  toolCallId?: string;
  parentEventId?: string;
  correlationId?: string;
  payload?: unknown;
  raw?: unknown;
  createdAt?: string;
}

export interface MasEvent extends MasEventInput {
  eventId: string;
  sequence: number;
  createdAt: string;
}

export interface ExperienceNodeInput {
  nodeId?: string;
  type: ExperienceNodeType;
  runId?: string;
  status?: string;
  title: string;
  summary: string;
  payload?: unknown;
}

export interface ReflectionTaskInput {
  reflectionId?: string;
  sourceRunId: string;
  sourceNodeId?: string;
  parentReflectionId?: string;
  purpose: string;
  triggerAt: string;
  depth?: number;
  maxDepth?: number;
  maxChildren?: number;
  maxWakeups?: number;
  allowNested?: boolean;
  payload?: unknown;
}

export interface ReflectionTask extends Required<Omit<ReflectionTaskInput, "sourceNodeId" | "parentReflectionId" | "payload">> {
  sourceNodeId?: string;
  parentReflectionId?: string;
  status: ReflectionStatus;
  wakeups: number;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface MasRunOptions {
  cwd: string;
  approvalMode: ApprovalMode;
  orchestrationMode: OrchestrationMode;
  maxIterations: number;
  model?: string;
  signal?: AbortSignal;
  conversationHistory?: ConversationTurn[];
  conversationSummary?: string;
  availableSkills?: SkillSummary[];
}

export interface StreamSink {
  text(text: string): void;
  thought(text: string): void;
  toolStart(input: ToolEventInput): void;
  toolUpdate(input: ToolEventInput & { status?: string; content?: unknown[] }): void;
  permission(input: PermissionRequestInput): Promise<PermissionDecision>;
  done(summary?: string): void;
  error(error: Error): void;
}

export interface ToolEventInput {
  id: string;
  title: string;
  kind: "read" | "edit" | "execute" | "search" | "delete" | "move" | "fetch" | "think" | "other";
  rawInput?: unknown;
  locations?: Array<{ path: string; range?: { startLine: number; endLine?: number } }>;
}

export interface PermissionRequestInput extends ToolEventInput {
  sessionId: string;
}

export interface PermissionDecision {
  approved: boolean;
  optionId: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface CritiqueResult {
  blocking_issues: number;
  quality_score: number;
  summary: string;
  next_action: "accept" | "revise" | "escalate";
  critique_items: Array<{
    category: string;
    severity: "low" | "medium" | "high";
    suggestion: string;
  }>;
}

export interface AuditFinding {
  category: string;
  severity: "low" | "medium" | "high";
  message: string;
  evidence: string[];
}

export type BoundaryScopeKind = "readonly_input" | "output" | "workspace_root";

export interface BoundaryFileMetadata {
  path: string;
  type: "file" | "dir";
  size: number;
  mtimeMs: number;
}

export interface BoundarySnapshotScope {
  kind: BoundaryScopeKind;
  path: string;
  exists: boolean;
  depth: number;
  fileCount: number;
  dirCount: number;
  truncated: boolean;
  entries: BoundaryFileMetadata[];
}

export interface BoundarySnapshot {
  createdAt: string;
  cwd: string;
  scopes: BoundarySnapshotScope[];
}

export interface BoundaryDiff {
  baselineAt: string;
  comparedAt: string;
  scopes: Array<{
    kind: BoundaryScopeKind;
    path: string;
    created: BoundaryFileMetadata[];
    modified: Array<{ before: BoundaryFileMetadata; after: BoundaryFileMetadata }>;
    deleted: BoundaryFileMetadata[];
    truncated: boolean;
  }>;
  readonlyCreated: string[];
  readonlyModified: string[];
  readonlyDeleted: string[];
  outputCreated: string[];
  outputModified: string[];
  outputDeleted: string[];
  suspiciousCreatedOutsideOutput: string[];
  suspiciousModifiedOutsideOutput: string[];
  suspiciousDeletedOutsideOutput: string[];
}

export interface AuditPacket {
  cwd: string;
  outputDir: string;
  suggestedSamplingStrategy: {
    objective: string;
    rules: string[];
    taskHints: string[];
    randomization: {
      seedHint: string;
      strategy: string;
    };
  };
  boundaryDiffPolicy: {
    mode: "lightweight_boundary_metadata";
    rules: string[];
  };
  approvals: Array<{
    toolCallId: string;
    toolName: string;
    decision: string;
    rawInput?: unknown;
    createdAt: string;
  }>;
  writes: Array<{
    toolCallId: string;
    toolName: string;
    path: string;
    inOutputDir: boolean;
    inCwd: boolean;
    inReadOnlyInput: boolean;
  }>;
  commands: Array<{
    toolCallId: string;
    command: unknown;
  }>;
  egoChangedFiles: string[];
  unreportedWrites: string[];
  writesOutsideOutput: string[];
  currentWritesOutsideOutput: string[];
  writesToReadOnlyInputs: string[];
  currentWritesToReadOnlyInputs: string[];
  boundaryDiff?: BoundaryDiff;
  findings: AuditFinding[];
}

export interface EgoResult {
  status: "completed" | "needs_attention" | "blocked";
  summary: string;
  final_response: string;
  evidence: string[];
  changed_files: string[];
  verification: Array<{
    command: string;
    result: "passed" | "failed" | "not_run";
    notes: string;
  }>;
  risks: string[];
}

export interface HaDecision {
  next_action: "answer" | "execute" | "clarify";
  response: string;
  acceptance_contract: string;
  rationale: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationContext {
  summary: string;
  turns: ConversationTurn[];
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}
