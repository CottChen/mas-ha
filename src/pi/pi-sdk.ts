import { delimiter } from "node:path";
import { existsSync } from "node:fs";
import { Type } from "@mariozechner/pi-ai";
import { textToolContent } from "../acp/acp-sink.js";
import { MAS_BASH_DEFAULT_TIMEOUT_ENV, getMasBashDefaultTimeoutSeconds } from "../core/tool-policy.js";
import type {
  ApprovalMode,
  CritiqueResult,
  EgoResult,
  HaDecision,
  MasEventInput,
  PermissionDecision,
  RoleName,
  StreamSink,
  ToolEventInput,
} from "../types.js";

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
  sessionId?: string;
  role: RoleName;
  phase?: "route" | "execute" | "review" | "final_review";
  iteration: number;
  approvalMode: ApprovalMode;
  model?: string;
  sink: StreamSink;
  recordApproval: (input: { toolCallId: string; toolName: string; decision: string; rawInput?: unknown }) => void;
  recordEvent: (input: MasEventInput) => void;
  memoryTools?: MasMemoryTools;
}

export interface MasMemoryTools {
  queryMemory: (input: { query: string; limit?: number }) => unknown;
  queryRecentActivity: (input: { scope?: "current_session" | "global" | "all"; role?: string; limit?: number }) => unknown;
}

export function roleToolNames(role: RoleName, phase?: PiSessionOptions["phase"]): string[] {
  if (role === "ha" && phase === "final_review") {
    return [
      "mas_query_memory",
      "mas_query_recent_activity",
      "mas_external_search",
      "mas_external_read",
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "ha_final_review",
    ];
  }
  if (role === "ha") {
    return ["mas_query_memory", "mas_query_recent_activity", "mas_external_search", "mas_external_read", "read", "grep", "find", "ls", "bash", "ha_decision"];
  }
  if (role === "ego") return ["mas_query_memory", "read", "grep", "find", "ls", "write", "edit", "bash", "ego_result"];
  return ["mas_query_memory", "mas_query_recent_activity", "read", "grep", "find", "ls", "bash", "superego_review"];
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

export interface PiBackendModelSummary {
  currentModelId?: string;
  availableModels: Array<{ id: string; name: string }>;
  defaultThinkingLevel?: string;
  warning?: string;
  roleModels?: Record<string, PiRoleModelSummary>;
}

export interface PiRoleModelSummary {
  role: RoleName;
  requestedModelId?: string;
  resolvedModelId?: string;
  thinkingLevel?: string;
  source: "env" | "session_selection" | "pi_default";
  heterogeneity: "same_as_default" | "different_from_default" | "unknown";
  warning?: string;
}

export async function getPiBackendModelSummary(cwd = process.cwd(), runModel?: string): Promise<PiBackendModelSummary> {
  try {
    const pi = await loadPiSdk();
    const agentDir = pi.getAgentDir();
    const settingsManager = pi.SettingsManager.create(cwd, agentDir);
    const authStorage = pi.AuthStorage.create();
    const modelRegistry = pi.ModelRegistry.create(authStorage);
    const defaultProvider = settingsManager.getDefaultProvider();
    const defaultModel = settingsManager.getDefaultModel();
    const defaultThinkingLevel = settingsManager.getDefaultThinkingLevel();
    const configuredModel =
      typeof defaultProvider === "string" && typeof defaultModel === "string" ? modelRegistry.find(defaultProvider, defaultModel) : undefined;
    const availableModels = await modelRegistry.getAvailable();
    const currentModel = configuredModel ?? availableModels[0];
    const models = new Map<string, { id: string; name: string }>();
    if (currentModel) models.set(modelAcpId(currentModel), modelAcpSummary(currentModel));
    for (const model of availableModels) {
      models.set(modelAcpId(model), modelAcpSummary(model));
    }
    return {
      currentModelId: currentModel ? modelAcpId(currentModel) : undefined,
      availableModels: Array.from(models.values()),
      defaultThinkingLevel,
      roleModels: roleModelSummaries({
        availableModels,
        defaultModelId: currentModel ? modelAcpId(currentModel) : undefined,
        runModel,
        defaultThinkingLevel,
      }),
      warning: configuredModel
        ? undefined
        : defaultProvider && defaultModel
        ? `Pi 默认模型未在模型注册表中找到：${defaultProvider}/${defaultModel}`
        : "Pi 未配置默认模型，已回退到首个可用模型。",
    };
  } catch (error) {
    return {
      availableModels: [],
      warning: `读取 Pi 模型配置失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function createPiSession(options: PiSessionOptions): Promise<PiSessionHandle> {
  const pi = await loadPiSdk();
  const agentDir = pi.getAgentDir();
  const authStorage = pi.AuthStorage.create();
  const modelRegistry = pi.ModelRegistry.create(authStorage);
  const settingsManager = pi.SettingsManager.create(options.cwd, agentDir);
  const roleModel = resolveRoleModel({
    role: options.role,
    runModel: options.model,
    modelRegistry,
    defaultProvider: settingsManager.getDefaultProvider(),
    defaultModel: settingsManager.getDefaultModel(),
    defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
  });
  const capturedStructuredOutputs = new Map<string, unknown>();
  const customTools = createRoleCustomTools(pi, options, settingsManager, (toolName, output) => {
    capturedStructuredOutputs.set(toolName, output);
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    additionalSkillPaths: configuredSkillPaths(),
    extensionFactories: [createPermissionExtension(options)],
  });
  await resourceLoader.reload();

  const { session } = await pi.createAgentSession({
    cwd: options.cwd,
    tools: roleToolNames(options.role, options.phase),
    customTools,
    authStorage,
    modelRegistry,
    settingsManager,
    model: roleModel.model,
    thinkingLevel: roleModel.thinkingLevel,
    sessionManager: pi.SessionManager.inMemory(options.cwd),
    resourceLoader,
  });

  let text = "";
  const literalThinkRouter = createLiteralThinkRouter({
    onText: (delta) => {
      text += delta;
      options.sink.text(delta);
    },
    onThought: (delta) => {
      options.sink.thought(delta);
    },
  });
  recordMasEvent(options, "mas.agent_session.created", {
    cwd: options.cwd,
    approvalMode: options.approvalMode,
    model: roleModel.summary,
  });
  if (roleModel.summary.warning) {
    recordMasEvent(options, "mas.agent_model.warning", roleModel.summary);
  }
  const unsubscribe = session.subscribe((event: any) => {
    recordPiEvent(options, event);
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        literalThinkRouter.write(update.delta);
      }
      if (update?.type === "thinking_delta" && typeof update.delta === "string") {
        options.sink.thought(update.delta);
      }
    }
    if (event.type === "tool_execution_start") {
      if (isInternalTool(String(event.toolName ?? ""))) return;
      options.sink.toolStart(toToolEvent(event.toolCallId, event.toolName, effectiveToolInput(String(event.toolName ?? ""), event.args), options.role));
    }
    if (event.type === "tool_execution_update") {
      if (isInternalTool(String(event.toolName ?? ""))) return;
      options.sink.toolUpdate({
        ...toToolEvent(event.toolCallId, event.toolName, effectiveToolInput(String(event.toolName ?? ""), event.args), options.role),
        status: "in_progress",
        content: [textToolContent(String(event.partialResult ?? ""))],
      });
    }
    if (event.type === "tool_execution_end") {
      if (isInternalTool(String(event.toolName ?? ""))) return;
      options.sink.toolUpdate({
        ...toToolEvent(event.toolCallId, event.toolName, effectiveToolInput(String(event.toolName ?? ""), event.args), options.role),
        status: event.isError ? "failed" : "completed",
        content: [textToolContent(stringifyToolResult(event.result))],
      });
    }
  });
  return {
    async prompt(promptText: string) {
      text = "";
      literalThinkRouter.reset();
      recordMasEvent(options, "mas.agent_prompt.started", { promptChars: promptText.length });
      await session.prompt(promptText);
      literalThinkRouter.flush();
      recordMasEvent(options, "mas.agent_prompt.completed", { outputChars: text.length });
      return text;
    },
    async abort() {
      await session.abort();
    },
    dispose() {
      recordMasEvent(options, "mas.agent_session.disposed", {});
      unsubscribe();
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

interface LiteralThinkRouter {
  write(delta: string): void;
  flush(): void;
  reset(): void;
}

export function routeLiteralThinkTextDeltasForTest(chunks: string[]): { text: string; thought: string } {
  let text = "";
  let thought = "";
  const router = createLiteralThinkRouter({
    onText: (delta) => {
      text += delta;
    },
    onThought: (delta) => {
      thought += delta;
    },
  });
  for (const chunk of chunks) router.write(chunk);
  router.flush();
  return { text, thought };
}

function createLiteralThinkRouter(handlers: { onText: (delta: string) => void; onThought: (delta: string) => void }): LiteralThinkRouter {
  const openTag = "<think>";
  const closeTag = "</think>";
  let buffer = "";
  let inThink = false;

  const emit = (delta: string): void => {
    if (!delta) return;
    if (inThink) handlers.onThought(delta);
    else handlers.onText(delta);
  };

  const drain = (flush: boolean): void => {
    while (buffer) {
      const lower = buffer.toLowerCase();
      if (inThink) {
        const closeIndex = lower.indexOf(closeTag);
        if (closeIndex >= 0) {
          handlers.onThought(buffer.slice(0, closeIndex));
          buffer = buffer.slice(closeIndex + closeTag.length);
          inThink = false;
          continue;
        }
        const keep = flush ? 0 : longestTagPrefixSuffix(lower, closeTag);
        const emitLength = buffer.length - keep;
        if (emitLength <= 0) break;
        handlers.onThought(buffer.slice(0, emitLength));
        buffer = buffer.slice(emitLength);
        continue;
      }

      const openIndex = lower.indexOf(openTag);
      if (openIndex >= 0) {
        handlers.onText(buffer.slice(0, openIndex));
        buffer = buffer.slice(openIndex + openTag.length);
        inThink = true;
        continue;
      }
      const keep = flush ? 0 : longestTagPrefixSuffix(lower, openTag);
      const emitLength = buffer.length - keep;
      if (emitLength <= 0) break;
      emit(buffer.slice(0, emitLength));
      buffer = buffer.slice(emitLength);
    }
  };

  return {
    write(delta: string) {
      buffer += delta;
      drain(false);
    },
    flush() {
      drain(true);
    },
    reset() {
      buffer = "";
      inThink = false;
    },
  };
}

function longestTagPrefixSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let length = max; length > 0; length--) {
    if (tag.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

function modelAcpId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function modelAcpSummary(model: { provider: string; id: string; name?: string }): { id: string; name: string } {
  const id = modelAcpId(model);
  return { id, name: model.name || id };
}

function roleModelSummaries(input: {
  availableModels: Array<{ provider: string; id: string; name?: string }>;
  defaultModelId?: string;
  runModel?: string;
  defaultThinkingLevel?: string;
}): Record<string, PiRoleModelSummary> {
  const roles: RoleName[] = ["ha", "ego", "superego"];
  return Object.fromEntries(
    roles.map((role) => {
      const summary = resolveRoleModelFromAvailable({
        role,
        runModel: input.runModel,
        availableModels: input.availableModels,
        defaultModelId: input.defaultModelId,
        defaultThinkingLevel: input.defaultThinkingLevel,
      }).summary;
      return [role, summary];
    }),
  );
}

function resolveRoleModel(input: {
  role: RoleName;
  runModel?: string;
  modelRegistry: { getAvailable(): Array<{ provider: string; id: string; name?: string }>; find(provider: string, modelId: string): unknown };
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
}): { model?: unknown; thinkingLevel?: string; summary: PiRoleModelSummary } {
  const availableModels = input.modelRegistry.getAvailable();
  const defaultModelId = input.defaultProvider && input.defaultModel ? `${input.defaultProvider}/${input.defaultModel}` : undefined;
  const resolved = resolveRoleModelFromAvailable({
    role: input.role,
    runModel: input.runModel,
    availableModels,
    defaultModelId,
    defaultThinkingLevel: input.defaultThinkingLevel,
  });
  if (!resolved.modelRef) return { summary: resolved.summary };
  const [provider, modelId] = splitModelRef(resolved.modelRef);
  const model = provider && modelId ? input.modelRegistry.find(provider, modelId) : undefined;
  if (!model) return { summary: { ...resolved.summary, warning: `角色模型未在 Pi 模型注册表中找到：${resolved.modelRef}` } };
  return { model, thinkingLevel: resolved.thinkingLevel, summary: resolved.summary };
}

function resolveRoleModelFromAvailable(input: {
  role: RoleName;
  runModel?: string;
  availableModels: Array<{ provider: string; id: string; name?: string }>;
  defaultModelId?: string;
  defaultThinkingLevel?: string;
}): { modelRef?: string; thinkingLevel?: string; summary: PiRoleModelSummary } {
  const requested = roleModelPreference(input.role, input.runModel);
  const modelRef = requested.modelRef ? findAvailableModelRef(requested.modelRef, input.availableModels) : undefined;
  const warning = requested.modelRef && !modelRef ? `角色模型不可用或未配置认证：${requested.modelRef}` : undefined;
  const resolvedModelId = modelRef ?? (!requested.modelRef ? input.defaultModelId : undefined);
  const summary: PiRoleModelSummary = {
    role: input.role,
    requestedModelId: requested.modelRef,
    resolvedModelId,
    thinkingLevel: requested.thinkingLevel ?? (resolvedModelId ? input.defaultThinkingLevel : undefined),
    source: requested.source,
    heterogeneity: !resolvedModelId || !input.defaultModelId ? "unknown" : resolvedModelId === input.defaultModelId ? "same_as_default" : "different_from_default",
    warning,
  };
  return { modelRef, thinkingLevel: requested.thinkingLevel, summary };
}

function roleModelPreference(role: RoleName, runModel?: string): { modelRef?: string; thinkingLevel?: string; source: PiRoleModelSummary["source"] } {
  const envValue = process.env[`MAS_${role.toUpperCase()}_MODEL`];
  const envThinking = process.env[`MAS_${role.toUpperCase()}_THINKING_LEVEL`];
  if (envValue?.trim()) {
    const parsed = parseModelPreference(envValue.trim());
    return { modelRef: parsed.modelRef, thinkingLevel: parsed.thinkingLevel ?? envThinking, source: "env" };
  }
  if (role === "ha" && runModel?.trim()) {
    const parsed = parseModelPreference(runModel.trim());
    return { modelRef: parsed.modelRef, thinkingLevel: parsed.thinkingLevel ?? envThinking, source: "session_selection" };
  }
  return { thinkingLevel: envThinking, source: "pi_default" };
}

function parseModelPreference(value: string): { modelRef: string; thinkingLevel?: string } {
  const parts = value.split(":");
  const maybeThinking = parts.length > 1 ? parts[parts.length - 1] : undefined;
  if (maybeThinking && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(maybeThinking)) {
    return { modelRef: parts.slice(0, -1).join(":"), thinkingLevel: maybeThinking };
  }
  return { modelRef: value };
}

function findAvailableModelRef(modelRef: string, models: Array<{ provider: string; id: string; name?: string }>): string | undefined {
  const normalized = modelRef.trim();
  const exact = models.find((model) => modelAcpId(model) === normalized);
  if (exact) return modelAcpId(exact);
  const bare = models.filter((model) => model.id === normalized || model.name === normalized);
  return bare.length === 1 ? modelAcpId(bare[0]) : undefined;
}

function splitModelRef(modelRef: string): [string | undefined, string | undefined] {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash >= modelRef.length - 1) return [undefined, undefined];
  return [modelRef.slice(0, slash), modelRef.slice(slash + 1)];
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
    pi.on("tool_result", (event: any) => {
      recordPiEvent(options, { type: "tool_result", ...event });
    });
    pi.on("tool_call", async (event: any) => {
      const toolName = String(event.toolName ?? "");
      const input = effectiveToolInput(toolName, event.input);
      const tool = toToolEvent(event.toolCallId, toolName, input);
      recordPiEvent(options, {
        type: "tool_call",
        toolCallId: tool.id,
        toolName,
        input,
      });
      if (isReadOnlyTool(toolName) || isInternalTool(toolName)) return undefined;

      if (isAutoApprovedReviewTool(options, toolName)) {
        options.recordApproval({
          toolCallId: tool.id,
          toolName,
          decision: "allow_always",
          rawInput: input,
        });
        recordApprovalDecision(options, tool, toolName, "allow_always", true);
        return undefined;
      }

      if (options.approvalMode === "approve-all") {
        options.recordApproval({
          toolCallId: tool.id,
          toolName,
          decision: "allow_always",
          rawInput: input,
        });
        recordApprovalDecision(options, tool, toolName, "allow_always", true);
        return undefined;
      }
      if (options.approvalMode === "deny-writes") {
        options.recordApproval({
          toolCallId: tool.id,
          toolName,
          decision: "reject_once",
          rawInput: input,
        });
        recordApprovalDecision(options, tool, toolName, "reject_once", false);
        return { block: true, reason: `MAS 已拒绝工具调用：${toolName}` };
      }

      const decision: PermissionDecision = await options.sink.permission({
        ...tool,
        sessionId: options.sessionId ?? options.runId,
      });
      options.recordApproval({
        toolCallId: tool.id,
        toolName,
        decision: decision.optionId,
        rawInput: input,
      });
      recordApprovalDecision(options, tool, toolName, decision.optionId, decision.approved);
      if (!decision.approved) {
        return { block: true, reason: `用户拒绝了工具调用：${toolName}` };
      }
      return undefined;
    });
  };
}

export function isAutoApprovedReviewTool(options: Pick<PiSessionOptions, "role" | "phase">, toolName: string): boolean {
  if (toolName !== "bash") return false;
  return (
    (options.role === "ha" && (options.phase === "route" || options.phase === "final_review")) ||
    (options.role === "superego" && options.phase === "review")
  );
}

function recordPiEvent(options: PiSessionOptions, event: any): void {
  const type = typeof event?.type === "string" ? event.type : "unknown";
  options.recordEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    role: options.role,
    iteration: options.iteration,
    source: "pi",
    type: `pi.${type}`,
    actor: options.role,
    toolCallId: typeof event?.toolCallId === "string" ? event.toolCallId : undefined,
    payload: summarizePiEvent(event),
    raw: rawPiEventForStorage(type, event),
  });
}

function recordMasEvent(options: PiSessionOptions, type: string, payload: unknown): void {
  options.recordEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    role: options.role,
    iteration: options.iteration,
    source: "mas",
    type,
    actor: options.role,
    payload,
  });
}

function recordApprovalDecision(
  options: PiSessionOptions,
  tool: ToolEventInput,
  toolName: string,
  decision: string,
  approved: boolean,
): void {
  options.recordEvent({
    runId: options.runId,
    sessionId: options.sessionId,
    role: options.role,
    iteration: options.iteration,
    source: "mas",
    type: "mas.approval.decided",
    actor: "system",
    toolCallId: tool.id,
    payload: {
      toolName,
      decision,
      approved,
      kind: tool.kind,
      locations: tool.locations ?? [],
    },
    raw: tool.rawInput,
  });
}

function summarizePiEvent(event: any): Record<string, unknown> {
  const type = typeof event?.type === "string" ? event.type : "unknown";
  const summary: Record<string, unknown> = { type };
  if (typeof event?.toolCallId === "string") summary.toolCallId = event.toolCallId;
  if (typeof event?.toolName === "string") summary.toolName = event.toolName;
  if (event?.assistantMessageEvent?.type) summary.assistantMessageEventType = event.assistantMessageEvent.type;
  if (event?.isError !== undefined) summary.isError = Boolean(event.isError);
  if (event?.turnIndex !== undefined) summary.turnIndex = event.turnIndex;
  return summary;
}

function rawPiEventForStorage(type: string, event: any): unknown {
  if (type === "message_update") return undefined;
  if (type === "message_start" || type === "message_end") return undefined;
  if (type === "agent_end" || type === "turn_end") return undefined;
  return event;
}

export function isReadOnlyTool(toolName: string): boolean {
  return (
    toolName === "read" ||
    toolName === "grep" ||
    toolName === "find" ||
    toolName === "ls" ||
    toolName === "mas_query_memory" ||
    toolName === "mas_query_recent_activity" ||
    toolName === "mas_external_search" ||
    toolName === "mas_external_read"
  );
}

export function isInternalTool(toolName: string): boolean {
  return toolName === "ha_decision" || toolName === "ha_final_review" || toolName === "ego_result" || toolName === "superego_review";
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

function createRoleCustomTools(
  pi: PiModule,
  options: PiSessionOptions,
  settingsManager: any,
  capture: (toolName: string, output: unknown) => void,
): unknown[] {
  const tools = [createDefaultTimeoutBashTool(pi, options, settingsManager), ...createMasMemoryTools(pi, options)];
  if (options.role === "ha") {
    return [...tools, createStructuredOutputTool(pi, haDecisionToolSpec(), capture), createStructuredOutputTool(pi, haFinalReviewToolSpec(), capture)];
  }
  if (options.role === "ego") return [...tools, createStructuredOutputTool(pi, egoResultToolSpec(), capture)];
  return [...tools, createStructuredOutputTool(pi, superegoReviewToolSpec(), capture)];
}

function createMasMemoryTools(pi: PiModule, options: PiSessionOptions): unknown[] {
  const tools = [
    pi.defineTool({
      name: "mas_query_memory",
      label: "MAS Query Memory",
      description: "只读查询 MAS Experience Graph 中的历史经验候选、风险、规则候选和测试候选。结果不是事实来源，采用前必须用当前任务证据验证。",
      promptSnippet: "查询 MAS 历史经验候选",
      promptGuidelines: [
        "当用户询问历史经验、过去踩过的坑、可复用规则、类似失败、长期记忆，或当前任务需要参考既有项目经验时使用。",
        "不要在每个任务中机械调用；只有历史经验能降低不确定性时才调用。",
        "查询结果只是候选视角，不能覆盖用户目标、当前文件证据、验收合同或审计包。",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "检索关键词或问题，优先使用当前任务中的具体对象、错误、文件、模块或用户问题。" }),
        limit: Type.Optional(Type.Number({ description: "最大返回条数，默认 5，建议 3 到 8。" })),
      }),
      async execute(_toolCallId: string, params: { query: string; limit?: number }) {
        const result = options.memoryTools?.queryMemory({ query: params.query, limit: params.limit });
        return {
          content: [{ type: "text", text: JSON.stringify(result ?? { count: 0, artifacts: [] }, null, 2) }],
          details: result,
        };
      },
    }),
    pi.defineTool({
      name: "mas_query_recent_activity",
      label: "MAS Query Recent Activity",
      description: "只读查询 MAS runs/agent_runs 中的近期运行事实，用于回答最近在做什么、某个角色最近是否执行过、当前会话或全局最近 run 状态。",
      promptSnippet: "查询 MAS 近期运行事实",
      promptGuidelines: [
        "当用户询问“最近在做什么”“Ego 最近做了什么”“当前是否有任务”“上次执行结果”等状态问题时必须优先使用。",
        "需要区分 current_session 和 global；如果当前会话为空，可以查询 global 后明确说明范围差异。",
        "不要把当前会话没有历史消息误说成 MAS 没有历史运行记录。",
      ],
      parameters: Type.Object({
        scope: Type.Optional(
          Type.Union([Type.Literal("current_session"), Type.Literal("global"), Type.Literal("all")], {
            description: "查询范围；current_session 仅当前 AionUI 会话，global 为全局最近 run，all 同时返回二者。",
          }),
        ),
        role: Type.Optional(Type.String({ description: "可选角色过滤，例如 ha、ego、superego。" })),
        limit: Type.Optional(Type.Number({ description: "最大返回条数，默认 5。" })),
      }),
      async execute(_toolCallId: string, params: { scope?: "current_session" | "global" | "all"; role?: string; limit?: number }) {
        const result = options.memoryTools?.queryRecentActivity({
          scope: params.scope ?? "all",
          role: params.role,
          limit: params.limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result ?? { rendered: "MAS 近期活动工具未配置。" }, null, 2) }],
          details: result,
        };
      },
    }),
  ];
  if (options.role === "ha") {
    tools.push(createExternalSearchTool(pi, options));
    tools.push(createExternalReadTool(pi, options));
  }
  return tools;
}

function createDefaultTimeoutBashTool(pi: PiModule, options: PiSessionOptions, settingsManager: any): unknown {
  const defaultTimeout = getMasBashDefaultTimeoutSeconds();
  const base = pi.createBashToolDefinition(options.cwd, {
    commandPrefix: typeof settingsManager?.getShellCommandPrefix === "function" ? settingsManager.getShellCommandPrefix() : undefined,
    shellPath: typeof settingsManager?.getShellPath === "function" ? settingsManager.getShellPath() : undefined,
  });
  return {
    ...base,
    description: [
      base.description,
      `MAS applies a default timeout of ${defaultTimeout} seconds when timeout is omitted or invalid.`,
      `Set timeout explicitly in seconds when a command should run longer or shorter than the default.`,
      `Override the MAS default with ${MAS_BASH_DEFAULT_TIMEOUT_ENV}.`,
    ].join(" "),
    promptSnippet: `${base.promptSnippet ?? "Execute bash commands"}（默认 ${defaultTimeout} 秒超时，可显式设置 timeout）`,
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(
        Type.Number({
          description: `Timeout in seconds. MAS applies ${defaultTimeout}s when omitted or invalid; set a positive value to run longer or shorter.`,
        }),
      ),
    }),
    async execute(toolCallId: string, params: { command: string; timeout?: number }, signal: AbortSignal, onUpdate: unknown, ctx: unknown) {
      const effectiveInput = effectiveBashInput(params);
      if (effectiveInput.timeout !== params.timeout) {
        recordMasEvent(options, "mas.bash.default_timeout_applied", {
          toolCallId,
          defaultTimeoutSeconds: defaultTimeout,
          command: summarizeCommandForAudit(params.command),
        });
      }
      return base.execute(toolCallId, effectiveInput, signal, onUpdate, ctx);
    },
  };
}

function createExternalSearchTool(pi: PiModule, options: PiSessionOptions): unknown {
  return pi.defineTool({
    name: "mas_external_search",
    label: "MAS External Search",
    description: "只读外部检索工具，用于从 MAS 当前会话、Experience Graph、工作区和 AuditPacket 之外获取公开证据候选。结果不是权威结论，采用前必须交叉验证。",
    promptSnippet: "检索外部公开证据候选",
    promptGuidelines: [
      "HA 在回答或终验依赖外部事实、当前信息、公开文档、第三方项目行为、论文/标准/版本信息时使用。",
      "不要在纯本地代码改动、已有审计证据充分或用户明确不需要外部信息时机械调用。",
      "外部检索结果只是候选证据；必须结合用户目标、当前仓库证据、Ego 输出和 Superego 结论交叉验证。",
      "引用外部结果时保留 title、url/source 和检索时间；检索失败时明确说明，不得编造。",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "外部检索问题，使用具体对象、版本、错误、论文、库名或用户声称。" }),
      limit: Type.Optional(Type.Number({ description: "最大返回条数，默认 5，建议 3 到 8。" })),
    }),
    async execute(_toolCallId: string, params: { query: string; limit?: number }) {
      const result = await runExternalSearch(params.query, params.limit);
      recordMasEvent(options, "mas.external_search.completed", {
        query: params.query,
        count: result.results.length,
        provider: result.provider,
        warning: result.warning,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}

function createExternalReadTool(pi: PiModule, options: PiSessionOptions): unknown {
  return pi.defineTool({
    name: "mas_external_read",
    label: "MAS External Read",
    description: "只读读取外部 URL 内容，用于在外部搜索后核对候选证据原文。结果不是权威结论，采用前必须交叉验证。",
    promptSnippet: "读取外部 URL 内容候选",
    promptGuidelines: [
      "HA 在 mas_external_search 返回候选结果后，如果需要核对原文、摘要不足或最终验收依赖该来源时使用。",
      "只读取用户任务相关、搜索结果相关或用户明确给出的公开 URL；不要批量抓取无关链接。",
      "读取结果只是候选证据；必须结合用户目标、当前仓库证据、Ego 输出和 Superego 结论交叉验证。",
      "引用读取结果时保留 url、retrievedAt 和 provider；读取失败时明确说明，不得编造。",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "要读取的公开 URL。" }),
      format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("json")], { description: "读取格式，默认 markdown。" })),
    }),
    async execute(_toolCallId: string, params: { url: string; format?: "markdown" | "json" }) {
      const result = await runExternalRead(params.url, params.format ?? "markdown");
      recordMasEvent(options, "mas.external_read.completed", {
        url: params.url,
        provider: result.provider,
        contentChars: result.content.length,
        warning: result.warning,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}

export async function runExternalSearch(query: string, limit = 5): Promise<{
  query: string;
  provider: string;
  retrievedAt: string;
  results: Array<{ title: string; url?: string; snippet: string; source?: string }>;
  warning?: string;
}> {
  const normalizedLimit = Math.max(1, Math.min(10, Math.trunc(limit || 5)));
  const retrievedAt = new Date().toISOString();
  const mcpUrl = process.env.MAS_EXTERNAL_SEARCH_MCP_URL?.trim();
  const endpoint = process.env.MAS_EXTERNAL_SEARCH_ENDPOINT?.trim();
  try {
    if (mcpUrl) {
      return normalizeMcpSearchResponse(
        query,
        "mcp",
        retrievedAt,
        await callMcpTool(mcpUrl, process.env.MAS_EXTERNAL_SEARCH_MCP_TOOL?.trim() || "metaso_web_search", mcpSearchArguments(query, normalizedLimit)),
        normalizedLimit,
      );
    }
    if (endpoint) {
      const url = endpoint.replaceAll("{query}", encodeURIComponent(query)).replaceAll("{limit}", String(normalizedLimit));
      return normalizeExternalSearchResponse(query, "configured_endpoint", retrievedAt, await fetchJsonWithTimeout(url), normalizedLimit);
    }
    return normalizeDuckDuckGoResponse(query, retrievedAt, await fetchJsonWithTimeout(duckDuckGoUrl(query)), normalizedLimit);
  } catch (error) {
    return {
      query,
      provider: mcpUrl ? "mcp" : endpoint ? "configured_endpoint" : "duckduckgo_instant_answer",
      retrievedAt,
      results: [],
      warning: `外部检索失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function runExternalRead(url: string, format: "markdown" | "json" = "markdown"): Promise<{
  url: string;
  provider: string;
  retrievedAt: string;
  format: "markdown" | "json";
  title?: string;
  content: string;
  warning?: string;
}> {
  const normalizedUrl = url.trim();
  const retrievedAt = new Date().toISOString();
  const mcpUrl = process.env.MAS_EXTERNAL_SEARCH_MCP_URL?.trim();
  try {
    if (mcpUrl) {
      return normalizeMcpReadResponse(
        normalizedUrl,
        "mcp",
        retrievedAt,
        format,
        await callMcpTool(mcpUrl, process.env.MAS_EXTERNAL_READ_MCP_TOOL?.trim() || "metaso_web_reader", { url: normalizedUrl, format }),
      );
    }
    return normalizeHttpReadResponse(normalizedUrl, "http_fetch", retrievedAt, format, await fetchTextWithTimeout(normalizedUrl));
  } catch (error) {
    return {
      url: normalizedUrl,
      provider: mcpUrl ? "mcp" : "http_fetch",
      retrievedAt,
      format,
      content: "",
      warning: `外部读取失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function mcpSearchArguments(query: string, limit: number): Record<string, unknown> {
  const scope = process.env.MAS_EXTERNAL_SEARCH_MCP_SCOPE?.trim() || "webpage";
  return {
    q: query,
    size: limit,
    scope,
    includeSummary: true,
    includeRawContent: false,
  };
}

async function callMcpTool(url: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetchJsonRpcWithTimeout(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args,
    },
  });
  const message = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  if (message.error) throw new Error(`MCP ${toolName} 调用失败：${JSON.stringify(message.error).slice(0, 500)}`);
  return message.result ?? response;
}

async function fetchJsonRpcWithTimeout(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: mcpHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseJsonOrSse(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

function mcpHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "user-agent": "mas-ha-orchestration/0.1",
  };
  const headerJson = process.env.MAS_EXTERNAL_SEARCH_MCP_HEADERS_JSON?.trim();
  if (headerJson) {
    const parsed = JSON.parse(headerJson) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) headers[key] = value.trim();
    }
  }
  const authorization = process.env.MAS_EXTERNAL_SEARCH_MCP_AUTHORIZATION?.trim();
  if (authorization) headers.Authorization = authorization;
  return headers;
}

function parseJsonOrSse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line && line !== "[DONE]");
    const last = dataLines.at(-1);
    if (!last) throw new Error("响应不是 JSON，且未包含 SSE data。");
    return JSON.parse(last);
  }
}

async function fetchJsonWithTimeout(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "mas-ha-orchestration/0.1" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithTimeout(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/html, text/plain, application/json", "user-agent": "mas-ha-orchestration/0.1" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function duckDuckGoUrl(query: string): string {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("no_html", "1");
  return url.toString();
}

function normalizeDuckDuckGoResponse(
  query: string,
  retrievedAt: string,
  value: unknown,
  limit: number,
): { query: string; provider: string; retrievedAt: string; results: Array<{ title: string; url?: string; snippet: string; source?: string }>; warning?: string } {
  const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const results: Array<{ title: string; url?: string; snippet: string; source?: string }> = [];
  const abstractText = typeof data.AbstractText === "string" ? data.AbstractText.trim() : "";
  if (abstractText) {
    results.push({
      title: typeof data.Heading === "string" && data.Heading.trim() ? data.Heading.trim() : query,
      url: typeof data.AbstractURL === "string" && data.AbstractURL.trim() ? data.AbstractURL.trim() : undefined,
      snippet: abstractText,
      source: typeof data.AbstractSource === "string" && data.AbstractSource.trim() ? data.AbstractSource.trim() : "DuckDuckGo",
    });
  }
  collectDuckDuckGoTopics(data.RelatedTopics, results, limit);
  return {
    query,
    provider: "duckduckgo_instant_answer",
    retrievedAt,
    results: results.slice(0, limit),
    warning: results.length ? undefined : "外部检索没有返回可用摘要；可配置 MAS_EXTERNAL_SEARCH_ENDPOINT 接入更稳定的搜索/RAG 服务。",
  };
}

function collectDuckDuckGoTopics(value: unknown, results: Array<{ title: string; url?: string; snippet: string; source?: string }>, limit: number): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (results.length >= limit) return;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.Topics)) {
      collectDuckDuckGoTopics(record.Topics, results, limit);
      continue;
    }
    const text = typeof record.Text === "string" ? record.Text.trim() : "";
    if (!text) continue;
    results.push({
      title: text.split(" - ")[0]?.slice(0, 120) || text.slice(0, 120),
      url: typeof record.FirstURL === "string" && record.FirstURL.trim() ? record.FirstURL.trim() : undefined,
      snippet: text,
      source: "DuckDuckGo",
    });
  }
}

function normalizeExternalSearchResponse(
  query: string,
  provider: string,
  retrievedAt: string,
  value: unknown,
  limit: number,
): { query: string; provider: string; retrievedAt: string; results: Array<{ title: string; url?: string; snippet: string; source?: string }>; warning?: string } {
  const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawResults = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.webpages)
    ? data.webpages
    : Array.isArray(data.documents)
    ? data.documents
    : Array.isArray(data.papers)
    ? data.papers
    : [];
  const results = rawResults
    .map((item) => {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const title = firstString(record.title, record.name, record.heading) || "Untitled";
      const url = firstString(record.url, record.link, record.sourceUrl);
      const snippet = firstString(record.snippet, record.summary, record.text, record.content) || "";
      const source = firstString(record.source, record.provider, record.domain);
      return { title, url, snippet, source };
    })
    .filter((item) => item.snippet.trim().length > 0 || item.url)
    .slice(0, limit);
  return { query, provider, retrievedAt, results, warning: results.length ? undefined : "外部检索端点没有返回可用 results/items。" };
}

function normalizeMcpSearchResponse(
  query: string,
  provider: string,
  retrievedAt: string,
  value: unknown,
  limit: number,
): { query: string; provider: string; retrievedAt: string; results: Array<{ title: string; url?: string; snippet: string; source?: string }>; warning?: string } {
  const result = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const candidates: unknown[] = [];
  if (result.structuredContent) candidates.push(result.structuredContent);
  if (result.content && Array.isArray(result.content)) {
    for (const item of result.content) {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!text) continue;
      try {
        candidates.push(JSON.parse(text));
      } catch {
        candidates.push({ results: [{ title: query, snippet: text, source: "MCP text" }] });
      }
    }
  }
  for (const candidate of candidates) {
    const normalized = normalizeExternalSearchResponse(query, provider, retrievedAt, candidate, limit);
    if (normalized.results.length) return normalized;
  }
  return { query, provider, retrievedAt, results: [], warning: "MCP 搜索工具没有返回可用内容。" };
}

function normalizeMcpReadResponse(
  url: string,
  provider: string,
  retrievedAt: string,
  format: "markdown" | "json",
  value: unknown,
): { url: string; provider: string; retrievedAt: string; format: "markdown" | "json"; title?: string; content: string; warning?: string } {
  const result = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (result.structuredContent) {
    const normalized = normalizeReadObject(url, provider, retrievedAt, format, result.structuredContent);
    if (normalized.content) return normalized;
  }
  if (Array.isArray(result.content)) {
    const parts: string[] = [];
    let title: string | undefined;
    for (const item of result.content) {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!text) continue;
      try {
        const normalized = normalizeReadObject(url, provider, retrievedAt, format, JSON.parse(text));
        if (normalized.title && !title) title = normalized.title;
        if (normalized.content) parts.push(normalized.content);
      } catch {
        parts.push(text);
      }
    }
    const content = parts.join("\n\n").slice(0, 60_000);
    return { url, provider, retrievedAt, format, title, content, warning: content ? undefined : "MCP 读取工具没有返回可用内容。" };
  }
  return { url, provider, retrievedAt, format, content: "", warning: "MCP 读取工具没有返回可用内容。" };
}

function normalizeHttpReadResponse(
  url: string,
  provider: string,
  retrievedAt: string,
  format: "markdown" | "json",
  text: string,
): { url: string; provider: string; retrievedAt: string; format: "markdown" | "json"; title?: string; content: string; warning?: string } {
  return { url, provider, retrievedAt, format, content: text.trim().slice(0, 60_000), warning: text.trim() ? undefined : "HTTP 读取没有返回可用内容。" };
}

function normalizeReadObject(
  url: string,
  provider: string,
  retrievedAt: string,
  format: "markdown" | "json",
  value: unknown,
): { url: string; provider: string; retrievedAt: string; format: "markdown" | "json"; title?: string; content: string; warning?: string } {
  const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const title = firstString(data.title, data.name, data.heading);
  const content =
    firstString(data.content, data.markdown, data.text, data.rawContent, data.raw_content, data.summary, data.snippet) ??
    (Object.keys(data).length ? JSON.stringify(data, null, 2) : "");
  return {
    url: firstString(data.url, data.link) ?? url,
    provider,
    retrievedAt,
    format,
    title,
    content: content.trim().slice(0, 60_000),
    warning: content.trim() ? undefined : "读取结果没有返回可用内容。",
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
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

function haFinalReviewToolSpec(): StructuredOutputToolSpec<CritiqueResult> {
  return {
    name: "ha_final_review",
    label: "HA Final Review",
    description: "提交 MAS HA 代表用户视角的最终验收结论。必须作为最终动作调用，不要再输出普通文本。",
    promptSnippet: "提交 MAS HA 最终验收结论",
    promptGuidelines: ["HA 终验时必须调用 ha_final_review 作为最终动作；调用后不要继续输出文本。"],
    parameters: reviewParameters("HA 最终验收"),
    resultText: "HA final review captured",
  };
}

function superegoReviewToolSpec(): StructuredOutputToolSpec<CritiqueResult> {
  return {
    name: "superego_review",
    label: "Superego Review",
    description: "提交 MAS Superego 结构化评审结果。必须作为最终动作调用，不要再输出普通文本。",
    promptSnippet: "提交 MAS Superego 结构化评审结果",
    promptGuidelines: ["Superego 完成评审后，必须调用 superego_review 作为最终动作；调用后不要继续输出文本。"],
    parameters: reviewParameters("Superego 评审"),
    resultText: "Superego review captured",
  };
}

function reviewParameters(label: string): unknown {
  return Type.Object({
    blocking_issues: Type.Number({ description: `${label}阻塞问题数量` }),
    quality_score: Type.Number({ description: "质量评分，0 到 1" }),
    summary: Type.String({ description: `${label}摘要` }),
    next_action: Type.Union([Type.Literal("accept"), Type.Literal("revise"), Type.Literal("escalate")], {
      description: "下一步动作",
    }),
    entropyDelta: Type.Optional(Type.Union([Type.Literal("decreased"), Type.Literal("increased"), Type.Literal("unchanged"), Type.Literal("unknown")])),
    evidenceQuality: Type.Optional(Type.Number({ description: "证据质量，0 到 1" })),
    remainingUncertainty: Type.Optional(Type.Number({ description: "剩余不确定性，0 到 1" })),
    nextBestObservation: Type.Optional(Type.String({ description: "下一步最能降低不确定性的观察或验证" })),
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
  });
}

function toToolEvent(id: string, toolName: string, rawInput: unknown, role?: RoleName): ToolEventInput {
  return {
    id,
    title: role ? `${roleDisplayName(role)}: ${toolName}` : toolName,
    kind: toToolKind(toolName),
    rawInput,
    locations: extractLocations(rawInput),
  };
}

function effectiveToolInput(toolName: string, rawInput: unknown): unknown {
  return toolName === "bash" ? effectiveBashInput(rawInput) : rawInput;
}

function effectiveBashInput(rawInput: unknown): { command: string; timeout: number } {
  const input = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  return {
    ...input,
    command: typeof input.command === "string" ? input.command : "",
    timeout: normalizeBashTimeout(input.timeout),
  };
}

function normalizeBashTimeout(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return getMasBashDefaultTimeoutSeconds();
}

function summarizeCommandForAudit(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, 300);
}

function roleDisplayName(role: RoleName): string {
  if (role === "ha") return "HA";
  if (role === "ego") return "Ego";
  return "Superego";
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
