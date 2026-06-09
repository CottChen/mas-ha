import { randomUUID } from "node:crypto";
import { JsonRpcPeer } from "./json-rpc.js";
import { AcpStreamSink } from "./acp-sink.js";
import { GoalCommandRouter } from "../core/goal-command-router.js";
import { normalizeOrchestrationMode, orchestrationModeList } from "../core/orchestration.js";
import { ReflectionScheduler } from "../core/reflection-scheduler.js";
import { MasRunner } from "../core/runner.js";
import { discoverSkills } from "../core/skills.js";
import { getPiBackendModelSummary } from "../pi/pi-sdk.js";
import { MasStore } from "../storage.js";
import type { ApprovalMode, ApprovalModePolicy, ConversationContext, OrchestrationMode, SkillSummary } from "../types.js";
import type { PiBackendModelSummary, PiRoleModelSummary } from "../pi/pi-sdk.js";

type SessionState = {
  sessionId: string;
  cwd: string;
  approvalMode: ApprovalMode;
  orchestrationMode: OrchestrationMode;
  context: ConversationContext;
  skills: SkillSummary[];
  selectedModel?: string;
  abort?: AbortController;
};

export interface AcpServerOptions {
  approvalMode: ApprovalMode;
  approvalModePolicy: ApprovalModePolicy;
  maxIterations: number;
  orchestrationMode: OrchestrationMode;
  reflectionScheduler: boolean;
  reflectionIntervalMs: number;
  reflectionDueLimit: number;
  reflectionDreamLimit: number;
  reflectionSchedulerDream: boolean;
}

export function startAcpServer(options: AcpServerOptions): void {
  const peer = new JsonRpcPeer(process.stdin, process.stdout);
  const store = new MasStore();
  const runner = new MasRunner();
  const goalRouter = new GoalCommandRouter(store);
  const scheduler = options.reflectionScheduler
    ? new ReflectionScheduler(store, {
        intervalMs: options.reflectionIntervalMs,
        dueLimit: options.reflectionDueLimit,
        dreamLimit: options.reflectionDreamLimit,
        runDream: options.reflectionSchedulerDream,
      })
    : undefined;
  const sessions = new Map<string, SessionState>();
  scheduler?.start();

  peer.on("initialize", () => ({
    protocolVersion: 1,
    serverCapabilities: {
      streaming: true,
      sessionManagement: true,
      loadSession: true,
      fs: { readTextFile: false, writeTextFile: false },
    },
    capabilities: {
      loadSession: true,
      sessionCapabilities: {
        prompt: true,
        cancel: true,
        close: true,
      },
    },
    serverInfo: {
      name: "mas",
      version: "0.1.0",
    },
  }));

  peer.on("session/new", async (params) => {
    const sessionId = `mas-${randomUUID()}`;
    const orchestrationMode = normalizeOrchestrationMode(params?.orchestrationMode ?? options.orchestrationMode);
    const approvalMode = normalizeInitialApprovalMode(params, options.approvalMode);
    const cwd = normalizeCwd(params?.cwd);
    const skills = await safeDiscoverSkills(cwd);
    const selectedModel = extractModelId(params);
    sessions.set(sessionId, { sessionId, cwd, approvalMode, orchestrationMode, context: { summary: "", turns: [] }, skills, selectedModel });
    queueSessionUpdates(peer, sessionId, { summary: "", turns: [] }, skills, approvalMode, orchestrationMode, cwd, selectedModel);
    return sessionResponse(sessionId, cwd, approvalMode, orchestrationMode, skills, selectedModel);
  });

  peer.on("session/load", async (params) => {
    const sessionId = String(params?.sessionId ?? `mas-${randomUUID()}`);
    const orchestrationMode = normalizeOrchestrationMode(params?.orchestrationMode ?? options.orchestrationMode);
    const approvalMode = normalizeInitialApprovalMode(params, options.approvalMode);
    const cwd = normalizeCwd(params?.cwd);
    const skills = await safeDiscoverSkills(cwd);
    const context = store.getConversationContext(sessionId);
    const selectedModel = extractModelId(params);
    sessions.set(sessionId, {
      sessionId,
      cwd,
      approvalMode,
      orchestrationMode,
      context,
      skills,
      selectedModel,
    });
    queueSessionUpdates(peer, sessionId, context, skills, approvalMode, orchestrationMode, cwd, selectedModel);
    return sessionResponse(sessionId, cwd, approvalMode, orchestrationMode, skills, selectedModel);
  });

  peer.on("session/prompt", async (params) => {
    const sessionId = String(params?.sessionId ?? "");
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`未知 sessionId：${sessionId}`);
    const prompt = extractPrompt(params?.prompt);
    const sink = new AcpStreamSink(peer, sessionId);
    const abort = new AbortController();
    session.abort = abort;
    session.context = store.getConversationContext(sessionId);
    store.addMessage({ sessionId, role: "user", content: prompt, metadata: { source: "acp" } });

    if (isCompactCommand(prompt)) {
      store.compactSessionContext(sessionId, 0);
      session.context = store.getConversationContext(sessionId);
      const response = "已压缩当前 MAS 会话上下文；后续请求会携带压缩摘要和最近对话。";
      sink.text(response);
      store.addMessage({ sessionId, role: "assistant", content: response, metadata: { source: "mas", command: "compact" } });
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      };
    }

    const goalCommand = parseGoalSlashCommand(prompt);
    if (goalCommand) {
      const context = {
        cwd: session.cwd,
        sessionId,
        approvalMode: session.approvalMode,
        orchestrationMode: session.orchestrationMode,
        maxTurns: options.maxIterations,
      };
      const commandResult =
        goalCommand.name === "goal" ? goalRouter.handleGoal(goalCommand.args, context) : goalRouter.handleSubgoal(goalCommand.args, context);
      sink.text(commandResult.text);
      store.addMessage({
        sessionId,
        role: "assistant",
        content: commandResult.text,
        metadata: { source: "mas", command: goalCommand.name, ok: commandResult.ok },
      });
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      };
    }

    const cancelledGoalJobs = store.cancelGoalContinuationJobsForCwd({ cwd: session.cwd, reason: "user_prompt_preempts_goal_continuation" });
    if (cancelledGoalJobs > 0) {
      store.audit({
        runId: "system",
        actor: "ha",
        action: "goal_continuation_preempted",
        payload: { sessionId, cwd: session.cwd, cancelledGoalJobs },
      });
    }

    const activeGoal = store.listGoals({ cwd: session.cwd, statuses: ["active"], limit: 1 })[0];
    const result = await runner.run(
      prompt,
      {
        cwd: session.cwd,
        approvalMode: session.approvalMode,
        orchestrationMode: session.orchestrationMode,
        maxIterations: options.maxIterations,
        signal: abort.signal,
        goalId: activeGoal?.goalId,
        model: session.selectedModel,
        conversationHistory: session.context.turns,
        conversationSummary: session.context.summary,
        availableSkills: session.skills,
      },
      sink,
      sessionId,
    );
    store.addMessage({ sessionId, role: "assistant", content: result.result, metadata: { runId: result.runId, source: "mas" } });
    session.context = store.getConversationContext(sessionId);

    return {
      stopReason: "end_turn",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    };
  });

  peer.on("session/cancel", (params) => {
    const session = sessions.get(String(params?.sessionId ?? ""));
    session?.abort?.abort();
    return {};
  });

  peer.on("session/set_mode", (params) => {
    const session = sessions.get(String(params?.sessionId ?? ""));
    if (!session) return {};
    if (options.approvalModePolicy === "mutable") {
      session.approvalMode = approvalModeFromAcpMode(params?.modeId ?? params?.id ?? params?.mode ?? params?.value, session.approvalMode);
    }
    queueModeUpdate(peer, session.sessionId, session.approvalMode);
    return sessionResponse(session.sessionId, session.cwd, session.approvalMode, session.orchestrationMode, session.skills, session.selectedModel);
  });
  peer.on("session/set_model", async (params) => {
    const session = sessions.get(String(params?.sessionId ?? ""));
    if (!session) return {};
    session.selectedModel = extractModelId(params);
    return sessionResponse(session.sessionId, session.cwd, session.approvalMode, session.orchestrationMode, session.skills, session.selectedModel);
  });
  peer.on("session/set_config_option", (params) => {
    const session = sessions.get(String(params?.sessionId ?? ""));
    if (!session) return {};
    const optionId = String(params?.optionId ?? params?.id ?? "");
    if (optionId === "orchestrationMode") {
      session.orchestrationMode = normalizeOrchestrationMode(params?.value);
      queueConfigUpdate(peer, session.sessionId, session.approvalMode);
    }
    return sessionResponse(session.sessionId, session.cwd, session.approvalMode, session.orchestrationMode, session.skills, session.selectedModel);
  });
  peer.start();
}

async function sessionResponse(
  sessionId: string,
  cwd: string,
  approvalMode: ApprovalMode,
  orchestrationMode: OrchestrationMode,
  skills: SkillSummary[],
  selectedModel?: string,
): Promise<Record<string, unknown>> {
  const modelSummary = await getPiBackendModelSummary(cwd, selectedModel);
  const currentModelId = selectedModel && modelSummary.availableModels.some((model) => model.id === selectedModel) ? selectedModel : modelSummary.currentModelId;
  return {
    sessionId,
    modes: [
      { id: "default", name: "默认", description: "写文件和命令需要审批" },
      { id: "bypassPermissions", name: "免确认", description: "等价于 mas --approve-all" },
    ],
    currentModeId: acpModeFromApprovalMode(approvalMode),
    configOptions: [
      {
        id: "orchestrationMode",
        name: "编排模式",
        type: "select",
        value: orchestrationMode,
        options: orchestrationModeList(),
      },
    ],
    models: {
      currentModelId,
      availableModels: modelSummary.availableModels,
    },
    metadata: {
      modelConfig: {
        source: "pi-sdk",
        defaultThinkingLevel: modelSummary.defaultThinkingLevel,
        selectedModelId: currentModelId,
        roleModels: modelSummary.roleModels,
        warning: modelSummary.warning,
      },
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.path })),
    },
  };
}

function normalizeCwd(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : process.cwd();
}

function normalizeInitialApprovalMode(params: unknown, fallback: ApprovalMode): ApprovalMode {
  if (!params || typeof params !== "object") return fallback;
  const input = params as Record<string, unknown>;
  const requested = input.modeId ?? input.mode ?? input.currentModeId;
  if (fallback === "approve-all" && (requested === "default" || requested === "approve-reads")) return fallback;
  return approvalModeFromAcpMode(requested, fallback);
}

function extractModelId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const input = params as Record<string, unknown>;
  const model = input.model;
  const value =
    input.modelId ??
    input.currentModelId ??
    input.id ??
    input.value ??
    (model && typeof model === "object" ? (model as Record<string, unknown>).id : undefined) ??
    (typeof model === "string" ? model : undefined);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function approvalModeFromAcpMode(value: unknown, fallback: ApprovalMode): ApprovalMode {
  if (value === "bypassPermissions" || value === "approve-all") return "approve-all";
  if (value === "default" || value === "approve-reads") return "approve-reads";
  if (value === "deny-writes") return "deny-writes";
  return fallback;
}

function acpModeFromApprovalMode(approvalMode: ApprovalMode): string {
  return approvalMode === "approve-all" ? "bypassPermissions" : "default";
}

function extractPrompt(value: unknown): string {
  if (typeof value === "string") return extractUserRequest(value);
  if (!Array.isArray(value)) return "";
  const text = value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return extractUserRequest(text);
}

function extractUserRequest(text: string): string {
  const marker = "[User Request]";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return text.trim();
  return text.slice(markerIndex + marker.length).trim();
}

function isCompactCommand(prompt: string): boolean {
  return prompt.trim().startsWith("/compact");
}

function parseGoalSlashCommand(prompt: string): { name: "goal" | "subgoal"; args: string[] } | undefined {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/goal") && !trimmed.startsWith("/subgoal")) return undefined;
  const [head, ...args] = splitCommand(trimmed);
  if (head === "/goal") return { name: "goal", args };
  if (head === "/subgoal") return { name: "subgoal", args };
  return undefined;
}

function splitCommand(text: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if ((char === "\"" || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) result.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) result.push(current);
  return result;
}

async function safeDiscoverSkills(cwd: string): Promise<SkillSummary[]> {
  try {
    return await discoverSkills(cwd);
  } catch {
    return [];
  }
}

function queueSessionUpdates(
  peer: JsonRpcPeer,
  sessionId: string,
  context: ConversationContext,
  skills: SkillSummary[],
  approvalMode: ApprovalMode,
  orchestrationMode: OrchestrationMode,
  cwd: string,
  selectedModel?: string,
): void {
  setTimeout(() => {
    void (async () => {
      queueConfigUpdate(peer, sessionId, approvalMode);
      queueAvailableCommands(peer, sessionId, skills);
      await queueRoleModelSummary(peer, sessionId, cwd, selectedModel);
      replayHistory(peer, sessionId, context);
    })();
  }, 0);
}

async function queueRoleModelSummary(peer: JsonRpcPeer, sessionId: string, cwd: string, selectedModel?: string): Promise<void> {
  const summary = await getPiBackendModelSummary(cwd, selectedModel);
  peer.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: renderRoleModelSummary(summary, selectedModel) },
    },
  });
}

function renderRoleModelSummary(summary: PiBackendModelSummary, selectedModel?: string): string {
  const roleModels = summary.roleModels ?? {};
  const lines = ["MAS 角色模型配置："];
  lines.push(`- Pi 默认模型：${summary.currentModelId ?? "未解析"}`);
  if (selectedModel) lines.push(`- AionUI 当前选择：${selectedModel}（仅作用于 HA，除非 MAS_HA_MODEL 显式覆盖）`);
  lines.push(formatRoleModelLine("HA", roleModels.ha));
  lines.push(formatRoleModelLine("Ego", roleModels.ego));
  lines.push(formatRoleModelLine("Superego", roleModels.superego));
  if (summary.warning) lines.push(`- 警告：${summary.warning}`);
  return `${lines.filter(Boolean).join("\n")}\n`;
}

function formatRoleModelLine(label: string, model: PiRoleModelSummary | undefined): string {
  if (!model) return `- ${label}：未解析`;
  const requested = model.requestedModelId ? `requested=${model.requestedModelId}` : "requested=未配置";
  const resolved = model.resolvedModelId ? `resolved=${model.resolvedModelId}` : "resolved=Pi 默认/未解析";
  const thinking = model.thinkingLevel ? `thinking=${model.thinkingLevel}` : "thinking=默认";
  const warning = model.warning ? `；warning=${model.warning}` : "";
  return `- ${label}：${resolved}；source=${model.source}；${requested}；${thinking}；heterogeneity=${model.heterogeneity}${warning}`;
}

function queueConfigUpdate(peer: JsonRpcPeer, sessionId: string, approvalMode: ApprovalMode): void {
  queueModeUpdate(peer, sessionId, approvalMode);
}

function queueModeUpdate(peer: JsonRpcPeer, sessionId: string, approvalMode: ApprovalMode): void {
  peer.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: acpModeFromApprovalMode(approvalMode),
    },
  });
}

function queueAvailableCommands(peer: JsonRpcPeer, sessionId: string, skills: SkillSummary[]): void {
  const skillCommands = skills.slice(0, 50).map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description || `加载 ${skill.name} 技能`,
    input: { hint: "可选参数" },
  }));
  peer.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "compact", description: "压缩当前 MAS 会话上下文", input: { hint: "可选压缩重点" } },
        { name: "goal", description: "查看或设置当前 Goal 控制面", input: { hint: "status | pause | resume | clear | <objective>" } },
        { name: "subgoal", description: "管理当前 Goal 的验收子目标", input: { hint: "add/list/confirm/reject/remove" } },
        ...skillCommands,
      ],
    },
  });
}

function replayHistory(peer: JsonRpcPeer, sessionId: string, context: ConversationContext): void {
  if (context.summary.trim()) {
    peer.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: `已恢复压缩上下文摘要。\n${context.summary}` },
      },
    });
  }
  for (const turn of context.turns) {
    peer.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: turn.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content: { type: "text", text: turn.content },
      },
    });
  }
}
