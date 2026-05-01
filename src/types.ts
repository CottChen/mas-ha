export type RoleName = "ha" | "ego" | "superego";

export type ApprovalMode = "approve-reads" | "approve-all" | "deny-writes";

export interface MasRunOptions {
  cwd: string;
  approvalMode: ApprovalMode;
  maxIterations: number;
  model?: string;
  signal?: AbortSignal;
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
  kind: "read" | "edit" | "execute";
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
