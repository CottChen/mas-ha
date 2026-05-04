import { delimiter } from "node:path";
import { existsSync } from "node:fs";
import { Type } from "@mariozechner/pi-ai";
import { textToolContent } from "../acp/acp-sink.js";
import type { ApprovalMode, CritiqueResult, EgoResult, HaDecision, PermissionDecision, StreamSink, ToolEventInput } from "../types.js";

type PiModule = Record<string, any>;

let cachedPi: PiModule | undefined;

export async function loadPiSdk(): Promise<PiModule> {
  if (cachedPi) return cachedPi;
  const pi = (await import("@mariozechner/pi-coding-agent")) as PiModule;
  cachedPi = pi;
  return pi;
}

export interface PiSessionOptions {
  cwd: string;
  runId: string;
  role: "ego" | "superego" | "ha";
  approvalMode: ApprovalMode;
  sink: StreamSink;
  recordApproval: (input: { toolCallId: string; toolName: string; decision: string; rawInput?: unknown }) => void;
}

export interface PiSessionHandle {
  prompt(text: string): Promise<string>;
  abort(): Promise<void>;
  dispose(): void;
  messages(): unknown[];
  haDecision(): HaDecision | undefined;
  structuredOutput<T>(toolName: string): T | undefined;
  clearStructuredOutput(toolName: string): void;
}

export async function createPiSession(options: PiSessionOptions): Promise<PiSessionHandle> {
  const pi = await loadPiSdk();
  const capturedStructuredOutputs = new Map<string, unknown>();
  const customTools = createRoleStructuredOutputTools(pi, options.role, (toolName, output) => {
    capturedStructuredOutputs.set(toolName, output);
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: pi.getAgentDir(),
    additionalSkillPaths: configuredSkillPaths(),
    extensionFactories: [createPermissionExtension(options)],
  });
  await resourceLoader.reload();

  const { session } = await pi.createAgentSession({
    cwd: options.cwd,
    tools:
      options.role === "ha"
        ? ["ha_decision"]
        : options.role === "ego"
        ? ["read", "grep", "find", "ls", "write", "edit", "bash", "ego_result"]
        : ["read", "grep", "find", "ls", "superego_review"],
    customTools,
    sessionManager: pi.SessionManager.inMemory(options.cwd),
    resourceLoader,
  });

  let text = "";
  session.subscribe((event: any) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        text += update.delta;
        options.sink.text(update.delta);
      }
      if (update?.type === "thinking_delta" && typeof update.delta === "string") {
        options.sink.thought(update.delta);
      }
    }
    if (event.type === "tool_execution_start") {
      if (isInternalTool(String(event.toolName ?? ""))) return;
      options.sink.toolStart(toToolEvent(event.toolCallId, event.toolName, event.args));
    }
    if (event.type === "tool_execution_update") {
      if (isInternalTool(String(event.toolName ?? ""))) return;
      options.sink.toolUpdate({
        ...toToolEvent(event.toolCallId, event.toolName, event.args),
        status: "in_progress",
        content: [textToolContent(String(event.partialResult ?? ""))],
      });
    }
    if (event.type === "tool_execution_end") {
      if (isInternalTool(String(event.toolName ?? ""))) return;
      options.sink.toolUpdate({
        ...toToolEvent(event.toolCallId, event.toolName, event.args),
        status: event.isError ? "failed" : "completed",
        content: [textToolContent(stringifyToolResult(event.result))],
      });
    }
  });

  return {
    async prompt(promptText: string) {
      text = "";
      await session.prompt(promptText);
      return text;
    },
    async abort() {
      await session.abort();
    },
    dispose() {
      session.dispose();
    },
    messages() {
      return session.messages ?? session.agent?.state?.messages ?? [];
    },
    haDecision() {
      return capturedStructuredOutputs.get("ha_decision") as HaDecision | undefined;
    },
    structuredOutput<T>(toolName: string) {
      return capturedStructuredOutputs.get(toolName) as T | undefined;
    },
    clearStructuredOutput(toolName: string) {
      capturedStructuredOutputs.delete(toolName);
    },
  };
}

function configuredSkillPaths(): string[] {
  const value = process.env.MAS_SKILL_PATHS;
  if (!value) return [];
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && existsSync(item));
}

function createPermissionExtension(options: PiSessionOptions): (api: any) => void {
  return (pi: any) => {
    pi.on("tool_call", async (event: any) => {
      const toolName = String(event.toolName ?? "");
      if (isReadOnlyTool(toolName) || isInternalTool(toolName)) return undefined;

      const tool = toToolEvent(event.toolCallId, toolName, event.input);
      if (options.approvalMode === "approve-all") {
        options.recordApproval({
          toolCallId: tool.id,
          toolName,
          decision: "allow_always",
          rawInput: event.input,
        });
        return undefined;
      }
      if (options.approvalMode === "deny-writes") {
        options.recordApproval({
          toolCallId: tool.id,
          toolName,
          decision: "reject_once",
          rawInput: event.input,
        });
        return { block: true, reason: `MAS 已拒绝工具调用：${toolName}` };
      }

      const decision: PermissionDecision = await options.sink.permission({
        ...tool,
        sessionId: options.runId,
      });
      options.recordApproval({
        toolCallId: tool.id,
        toolName,
        decision: decision.optionId,
        rawInput: event.input,
      });
      if (!decision.approved) {
        return { block: true, reason: `用户拒绝了工具调用：${toolName}` };
      }
      return undefined;
    });
  };
}

function isReadOnlyTool(toolName: string): boolean {
  return toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls";
}

function isInternalTool(toolName: string): boolean {
  return toolName === "ha_decision" || toolName === "ego_result" || toolName === "superego_review";
}

type StructuredOutputToolSpec<T> = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  resultText: string;
};

function createRoleStructuredOutputTools(
  pi: PiModule,
  role: PiSessionOptions["role"],
  capture: (toolName: string, output: unknown) => void,
): unknown[] {
  if (role === "ha") return [createStructuredOutputTool(pi, haDecisionToolSpec(), capture)];
  if (role === "ego") return [createStructuredOutputTool(pi, egoResultToolSpec(), capture)];
  return [createStructuredOutputTool(pi, superegoReviewToolSpec(), capture)];
}

function createStructuredOutputTool<T>(
  pi: PiModule,
  spec: StructuredOutputToolSpec<T>,
  capture: (toolName: string, output: T) => void,
): unknown {
  return pi.defineTool({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: spec.promptGuidelines,
    parameters: spec.parameters,
    async execute(_toolCallId: string, params: T) {
      capture(spec.name, params);
      return {
        content: [{ type: "text", text: spec.resultText }],
        details: params,
        terminate: true,
      };
    },
  });
}

function haDecisionToolSpec(): StructuredOutputToolSpec<HaDecision> {
  return {
    name: "ha_decision",
    label: "HA Decision",
    description: "提交 MAS HA 内部路由决策。必须作为最终动作调用，不要再输出普通文本。",
    promptSnippet: "提交 MAS HA 内部路由决策",
    promptGuidelines: ["HA 路由时必须调用 ha_decision 作为最终动作；调用后不要继续输出文本。"],
    parameters: Type.Object({
      next_action: Type.Union([Type.Literal("answer"), Type.Literal("execute"), Type.Literal("clarify")], {
        description: "下一步动作",
      }),
      response: Type.String({ description: "answer/clarify 时给用户的中文回复；execute 时为空字符串" }),
      acceptance_contract: Type.String({ description: "execute 时的验收合同；answer/clarify 时为空字符串" }),
      rationale: Type.String({ description: "简短说明路由理由" }),
    }),
    resultText: "HA decision captured",
  };
}

function egoResultToolSpec(): StructuredOutputToolSpec<EgoResult> {
  return {
    name: "ego_result",
    label: "Ego Result",
    description: "提交 MAS Ego 结构化执行结果。必须作为最终动作调用，不要再输出普通文本。",
    promptSnippet: "提交 MAS Ego 结构化执行结果",
    promptGuidelines: ["Ego 完成执行或确认阻塞后，必须调用 ego_result 作为最终动作；调用后不要继续输出文本。"],
    parameters: Type.Object({
      status: Type.Union([Type.Literal("completed"), Type.Literal("needs_attention"), Type.Literal("blocked")], {
        description: "执行状态",
      }),
      summary: Type.String({ description: "执行摘要" }),
      final_response: Type.String({ description: "最终给用户看的中文回复" }),
      evidence: Type.Array(Type.String({ description: "关键证据" }), { description: "读取、修改和验证证据" }),
      changed_files: Type.Array(Type.String({ description: "文件路径" }), { description: "实际修改过的文件路径" }),
      verification: Type.Array(
        Type.Object({
          command: Type.String({ description: "验证命令；未运行时为空字符串或说明项" }),
          result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")], {
            description: "验证结果",
          }),
          notes: Type.String({ description: "验证说明" }),
        }),
        { description: "验证记录" },
      ),
      risks: Type.Array(Type.String({ description: "剩余风险" }), { description: "剩余风险或无法验证事项" }),
    }),
    resultText: "Ego result captured",
  };
}

function superegoReviewToolSpec(): StructuredOutputToolSpec<CritiqueResult> {
  return {
    name: "superego_review",
    label: "Superego Review",
    description: "提交 MAS Superego 结构化评审结果。必须作为最终动作调用，不要再输出普通文本。",
    promptSnippet: "提交 MAS Superego 结构化评审结果",
    promptGuidelines: ["Superego 完成评审后，必须调用 superego_review 作为最终动作；调用后不要继续输出文本。"],
    parameters: Type.Object({
      blocking_issues: Type.Number({ description: "阻塞问题数量" }),
      quality_score: Type.Number({ description: "质量评分，0 到 1" }),
      summary: Type.String({ description: "评审摘要" }),
      next_action: Type.Union([Type.Literal("accept"), Type.Literal("revise"), Type.Literal("escalate")], {
        description: "下一步动作",
      }),
      critique_items: Type.Array(
        Type.Object({
          category: Type.String({ description: "问题类别" }),
          severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
            description: "严重程度",
          }),
          suggestion: Type.String({ description: "改进建议" }),
        }),
        { description: "评审问题列表" },
      ),
    }),
    resultText: "Superego review captured",
  };
}

function toToolEvent(id: string, toolName: string, rawInput: unknown): ToolEventInput {
  return {
    id,
    title: toolName,
    kind: toToolKind(toolName),
    rawInput,
    locations: extractLocations(rawInput),
  };
}

function toToolKind(toolName: string): ToolEventInput["kind"] {
  if (toolName === "write" || toolName === "edit") return "edit";
  if (toolName === "grep" || toolName === "find") return "search";
  if (isReadOnlyTool(toolName)) return "read";
  return "execute";
}

function extractLocations(rawInput: unknown): Array<{ path: string }> | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const obj = rawInput as Record<string, unknown>;
  const value = obj.path ?? obj.filePath ?? obj.file ?? obj.cwd;
  return typeof value === "string" ? [{ path: value }] : undefined;
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
