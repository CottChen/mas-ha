import type { OrchestrationMode } from "./core/orchestration.js";

export type RoleName = "ha" | "ego" | "superego";

export type ApprovalMode = "approve-reads" | "approve-all" | "deny-writes";
export type ApprovalModePolicy = "fixed" | "mutable";
export type { OrchestrationMode } from "./core/orchestration.js";

export type MasEventSource = "mas" | "pi";
export type MasEventActor = RoleName | "system" | "user" | "tool" | "pi";
export type ExperienceNodeType =
  | "task"
  | "execution_trace"
  | "result"
  | "experience"
  | "reflection"
  | "dream"
  | "goal"
  | "signal"
  | "eval_candidate";
export type ExperienceEdgeType =
  | "caused"
  | "produced"
  | "generalized_to"
  | "scheduled"
  | "reflected_on"
  | "dream_pruned"
  | "observed"
  | "controls"
  | "derived_candidate";
export type ReflectionStatus = "scheduled" | "running" | "completed" | "cancelled" | "pruned";
export type AutonomyJobType = "reflection" | "dream" | "prune" | "consolidation" | "goal_continuation";
export type AutonomyJobStatus = "scheduled" | "running" | "completed" | "cancelled" | "blocked" | "pruned";
export type AutonomyJobDecision = "complete" | "reschedule" | "cancel" | "escalate";
export type GoalStatus = "active" | "paused" | "done" | "blocked" | "expired" | "cleared";
export type GoalRunStatus = "scheduled" | "running" | "completed" | "failed" | "cancelled";
export type GoalRunTrigger = "user" | "scheduler" | "resume" | "retry";
export type SubgoalStatus = "candidate" | "active" | "satisfied" | "rejected" | "removed";
export type GoalSubgoalSource = "user" | "ha" | "superego";
export type LowEntropySignalType =
  | "test_result"
  | "typecheck_result"
  | "lint_result"
  | "schema_validation"
  | "audit_finding"
  | "user_feedback"
  | "approval_decision"
  | "production_trace"
  | "golden_sample"
  | "diff"
  | "policy_violation"
  | "external_fact";

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
  ownerId?: string;
  leaseUntil?: string;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ReflectionIntent {
  purpose: string;
  triggerAt: string;
  entropyReason: string;
  expectedSignal: string;
  noNewSignalAction: "cancel" | "complete" | "reschedule" | "abstract";
  informationGainScore: number;
  maxDepth: number;
  maxWakeups: number;
  expiresAt: string;
}

export interface AutonomyBudget {
  depth: number;
  maxDepth: number;
  wakeups: number;
  maxWakeups: number;
  maxChildren: number;
  allowNested: boolean;
}

export interface AutonomyJobInput {
  jobId?: string;
  type: AutonomyJobType;
  status?: AutonomyJobStatus;
  sourceRunId?: string;
  goalId?: string;
  triggerAt: string;
  budget?: Partial<AutonomyBudget>;
  payload?: unknown;
}

export interface AutonomyJobUpdate {
  status: AutonomyJobStatus;
  payload?: unknown;
  triggerAt?: string;
  incrementWakeups?: boolean;
}

export interface AutonomyJob {
  jobId: string;
  type: AutonomyJobType;
  status: AutonomyJobStatus;
  sourceRunId?: string;
  goalId?: string;
  triggerAt: string;
  ownerId?: string;
  leaseUntil?: string;
  budget: AutonomyBudget;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerLease {
  name: string;
  ownerId: string;
  heartbeatAt: string;
  expiresAt: string;
  metadata?: unknown;
}

export interface GoalBudget {
  max: number;
  used: number;
  unit: "turn" | "token" | "ms" | "count" | "risk_point";
}

export interface GoalAcceptanceContract {
  objective: string;
  readonlyInputs: string[];
  allowedOutputs: string[];
  forbiddenStates: string[];
  doneCriteria: string[];
  failureCriteria: string[];
  requiredEvidence: string[];
  validators: Array<{
    id: string;
    command?: string;
    kind: "test" | "typecheck" | "lint" | "schema" | "policy" | "manual";
    required: boolean;
  }>;
  riskNotes: string[];
  rawText: string;
}

export interface GoalRecord {
  goalId: string;
  sessionId?: string;
  cwd: string;
  title: string;
  objective: string;
  status: GoalStatus;
  requestedApprovalMode: ApprovalMode;
  orchestrationMode: OrchestrationMode;
  maxTurns: number;
  turnsUsed: number;
  maxWallClockMs?: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  acceptanceContract: GoalAcceptanceContract;
  riskBudget: GoalBudget;
  noveltyBudget: GoalBudget;
  entropyBudget: GoalBudget;
  perturbationBudget: GoalBudget;
  nextWakeAt?: string;
  expiresAt?: string;
  lastRunId?: string;
  lastGoalRunId?: string;
  ownerId?: string;
  leaseUntil?: string;
  permissionContextHash?: string;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface GoalInput {
  goalId?: string;
  sessionId?: string;
  cwd: string;
  title: string;
  objective: string;
  status?: GoalStatus;
  requestedApprovalMode: ApprovalMode;
  orchestrationMode: OrchestrationMode;
  maxTurns?: number;
  maxWallClockMs?: number;
  maxConsecutiveFailures?: number;
  acceptanceContract: GoalAcceptanceContract;
  riskBudget?: GoalBudget;
  noveltyBudget?: GoalBudget;
  entropyBudget?: GoalBudget;
  perturbationBudget?: GoalBudget;
  nextWakeAt?: string;
  expiresAt?: string;
  permissionContextHash?: string;
  payload?: unknown;
}

export interface GoalJudgeResult {
  decision: "done" | "continue" | "pause" | "blocked" | "expire";
  reason: string;
  satisfiedCriteria: string[];
  unsatisfiedCriteria: string[];
  requiredNextSignal?: string;
  confidence: number;
  deterministicGates: string[];
}

export interface GoalRunRecord {
  goalRunId: string;
  goalId: string;
  masRunId?: string;
  ownerId: string;
  status: GoalRunStatus;
  trigger: GoalRunTrigger;
  startedAt?: string;
  endedAt?: string;
  judgeResult?: GoalJudgeResult;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface GoalSubgoal {
  subgoalId: string;
  goalId: string;
  text: string;
  status: SubgoalStatus;
  source: GoalSubgoalSource;
  requiresUserConfirmation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LowEntropySignalInput {
  signalId?: string;
  runId?: string;
  goalId?: string;
  type: LowEntropySignalType;
  summary: string;
  confidence: number;
  scope: "run" | "goal" | "project" | "global";
  freshness: "current" | "recent" | "stale";
  sourceKind: "local_file" | "command_output" | "user_input" | "approval" | "trace" | "external_uri" | "derived";
  sourceUri?: string;
  sourceHash?: string;
  capturedAt?: string;
  expiresAt?: string;
  retentionPolicy: "ephemeral" | "project" | "long_term";
  sensitivity: "public" | "internal" | "confidential" | "secret";
  redactionStatus: "not_needed" | "redacted" | "blocked";
  secretScanStatus: "not_scanned" | "passed" | "blocked";
  payload?: unknown;
}

export interface LowEntropySignal extends Required<Omit<LowEntropySignalInput, "runId" | "goalId" | "sourceUri" | "sourceHash" | "expiresAt" | "payload">> {
  runId?: string;
  goalId?: string;
  sourceUri?: string;
  sourceHash?: string;
  expiresAt?: string;
  payload?: unknown;
  createdAt: string;
}

export interface EntropyLedgerInput {
  ledgerId?: string;
  runId: string;
  goalId?: string;
  scoreVersion?: "entropy_score_v1";
  openQuestions?: string[];
  signalIds: string[];
  uncertaintyScore: number;
  evidenceScore: number;
  riskScore: number;
  informationGainScore: number;
  evidenceQuality: number;
  nextBestObservation?: string;
  recommendation: "continue" | "revise" | "pause" | "escalate";
  deterministicGates: string[];
  payload?: unknown;
}

export interface EntropyLedger extends Required<Omit<EntropyLedgerInput, "ledgerId" | "goalId" | "scoreVersion" | "openQuestions" | "nextBestObservation" | "payload">> {
  ledgerId: string;
  goalId?: string;
  scoreVersion: "entropy_score_v1";
  openQuestions: string[];
  nextBestObservation?: string;
  payload?: unknown;
  createdAt: string;
}

export interface ContextPerturbation {
  perturbationId: string;
  runId?: string;
  goalId?: string;
  kind: "self" | "proposal";
  targetRole: "ha" | "ego" | "superego" | "dream";
  generatedBy: "ha" | "ego" | "superego" | "dream" | "goal_controller";
  trigger: string;
  injectionPoint:
    | "intent_check"
    | "contract_hint"
    | "execution_plan"
    | "tool_order"
    | "validation_strategy"
    | "counterexample_probe"
    | "review_sampling"
    | "blindspot_check"
    | "dream_candidate_library";
  type:
    | "perspective_shift"
    | "counterexample_probe"
    | "analogy"
    | "random_sample"
    | "constraint_relaxation"
    | "alternative_plan"
    | "mutation_prompt"
    | "historical_near_miss"
    | "cross_domain_pattern";
  summary: string;
  contextPatchHash: string;
  sourceRefs: string[];
  status: "candidate" | "approved" | "applied" | "rejected" | "retired";
  safetyGateResult: "passed" | "blocked" | "needs_review";
  harmlessness: "context_only";
  targetAttractor: string;
  expectedNovelty: number;
  maxRisk: "low" | "medium";
  appliedRunId?: string;
  producedSignalId?: string;
  payload?: unknown;
}

export interface EvalCandidate {
  candidateId: string;
  sourceRunId: string;
  goalId?: string;
  title: string;
  failureMode: string;
  inputFixture: unknown;
  expectedAssertions: string[];
  validatorCommand?: string;
  regressionScope: "unit" | "integration" | "e2e" | "policy" | "manual";
  confidence: number;
  status: "candidate" | "promoted" | "rejected" | "retired";
}

export interface EvalCandidateInput {
  candidateId?: string;
  sourceRunId: string;
  goalId?: string;
  title: string;
  failureMode: string;
  inputFixture: unknown;
  expectedAssertions: string[];
  validatorCommand?: string;
  regressionScope: "unit" | "integration" | "e2e" | "policy" | "manual";
  confidence: number;
  status?: EvalCandidate["status"];
}

export interface AgentRunRecord {
  id: number;
  runId: string;
  role: RoleName;
  iteration: number;
  status: string;
  input?: unknown;
  output?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: number;
  runId: string;
  actor: string;
  action: string;
  target?: string;
  payload?: unknown;
  createdAt: string;
}

export interface MemoryArtifact {
  kind: "lesson" | "risk" | "pattern" | "rule_candidate" | "test_candidate" | "doc_candidate" | "hypothesis";
  scope: "task" | "project" | "global";
  content: string;
  confidence: number;
  sourceNodeIds: string[];
  activationHints: string[];
}

export interface DreamGraphPatch {
  patchId: string;
  operation: "decay_edge" | "merge_nodes" | "abstract_pattern" | "prune_node" | "create_perturbation_seed";
  targetNodeIds: string[];
  targetEdgeIds: string[];
  summary: string;
  rationale: string;
  confidence: number;
  safety: {
    graphOnly: true;
    touchesUserWorkspace: false;
    createsNestedReflection: false;
  };
  payload?: unknown;
}

export interface AutonomyJobResult {
  jobId: string;
  type: AutonomyJobType;
  decision: AutonomyJobDecision;
  summary: string;
  graphOps: unknown[];
  memoryArtifacts: MemoryArtifact[];
  followupJobs: unknown[];
  confidence: number;
  evidence: string[];
}

export interface MasRunOptions {
  cwd: string;
  approvalMode: ApprovalMode;
  orchestrationMode: OrchestrationMode;
  maxIterations: number;
  goalId?: string;
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
  entropyDelta?: "increased" | "decreased" | "unchanged" | "unknown";
  evidenceQuality?: number;
  remainingUncertainty?: number;
  nextBestObservation?: string;
  reflectionIntent?: ReflectionIntent;
  critique_items: Array<{
    category: string;
    severity: "low" | "medium" | "high";
    suggestion: string;
  }>;
}

export interface AuditFinding {
  category: string;
  severity: "low" | "medium" | "high";
  gateOwner?: "ego" | "ha" | "none";
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
  boundaryDeclarations: {
    source: "ha_decision" | "contract_text_fallback";
    readonlyInputPaths: string[];
    allowedOutputPaths: string[];
    conflicts: Array<{
      readonlyInputPath: string;
      allowedOutputPath: string;
      reason: string;
    }>;
  };
  outputBoundary: {
    mode: "workspace_root" | "output_dir" | "declared_paths";
    reason: string;
    allowedRoots: string[];
  };
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
  agentHealth: {
    observations: Array<{
      role: RoleName;
      iteration: number;
      requestedModelId?: string;
      resolvedModelId?: string;
      thinkingLevel?: string;
      modelSource?: string;
      warning?: string;
      promptCompletions: Array<{ outputChars: number }>;
      latestOutputChars?: number;
      autoRetryCount: number;
      toolCalls: string[];
      structuredResultSubmitted: boolean;
      errorEvents: Array<{ type: string; message?: string }>;
      explicitError?: { code: string; message: string; status?: number; retryable?: boolean };
      diagnosis: "healthy" | "model_config_error" | "backend_error" | "stream_empty_after_retry" | "structured_output_missing" | "suspicious";
      reasons: string[];
    }>;
    findings: AuditFinding[];
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
  commandSideEffects: Array<{
    toolCallId: string;
    command: string;
    kind: "redirect" | "copy" | "move" | "mkdir" | "delete" | "unknown_write";
    path: string;
    inOutputDir: boolean;
    inCwd: boolean;
    inReadOnlyInput: boolean;
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
  intent_type: "conversation" | "status_query" | "read_only_analysis" | "execution_task";
  next_action: "answer" | "execute" | "clarify";
  response: string;
  acceptance_contract: string;
  readonly_input_paths: string[];
  allowed_output_paths: string[];
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
