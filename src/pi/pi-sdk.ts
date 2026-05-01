import type { ApprovalMode, PermissionDecision, StreamSink, ToolEventInput } from "../types.js";

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
}

export async function createPiSession(options: PiSessionOptions): Promise<PiSessionHandle> {
  const pi = await loadPiSdk();
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: pi.getAgentDir(),
    extensionFactories: [createPermissionExtension(options)],
  });
  await resourceLoader.reload();

  const { session } = await pi.createAgentSession({
    cwd: options.cwd,
    tools: options.role === "superego" ? ["read", "grep", "find", "ls"] : ["read", "grep", "find", "ls", "write", "edit", "bash"],
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
      options.sink.toolStart(toToolEvent(event.toolCallId, event.toolName, event.args));
    }
    if (event.type === "tool_execution_update") {
      options.sink.toolUpdate({
        ...toToolEvent(event.toolCallId, event.toolName, event.args),
        status: "running",
        content: [{ type: "content", content: String(event.partialResult ?? "") }],
      });
    }
    if (event.type === "tool_execution_end") {
      options.sink.toolUpdate({
        ...toToolEvent(event.toolCallId, event.toolName, event.args),
        status: event.isError ? "failed" : "completed",
        content: [{ type: "content", content: stringifyToolResult(event.result) }],
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
  };
}

function createPermissionExtension(options: PiSessionOptions): (api: any) => void {
  return (pi: any) => {
    pi.on("tool_call", async (event: any) => {
      const toolName = String(event.toolName ?? "");
      if (isReadOnlyTool(toolName)) return undefined;

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

function toToolEvent(id: string, toolName: string, rawInput: unknown): ToolEventInput {
  return {
    id,
    title: toolName,
    kind: toolName === "write" || toolName === "edit" ? "edit" : isReadOnlyTool(toolName) ? "read" : "execute",
    rawInput,
    locations: extractLocations(rawInput),
  };
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
