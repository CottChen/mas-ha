import type { OrchestrationMode } from "./core/orchestration.js";

export type RoleName = "ha" | "ego" | "superego";

export type ApprovalMode = "approve-reads" | "approve-all" | "deny-writes";
export type ApprovalModePolicy = "fixed" | "mutable";
export type { OrchestrationMode } from "./core/orchestration.js";

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
