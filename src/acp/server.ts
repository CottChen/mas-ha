import { randomUUID } from "node:crypto";
import { JsonRpcPeer } from "./json-rpc.js";
import { AcpStreamSink } from "./acp-sink.js";
import { normalizeOrchestrationMode, orchestrationModeList } from "../core/orchestration.js";
import { MasRunner } from "../core/runner.js";
import { discoverSkills } from "../core/skills.js";
import { MasStore } from "../storage.js";
import type { ApprovalMode, ConversationContext, OrchestrationMode, SkillSummary } from "../types.js";

type SessionState = {
  sessionId: string;
  cwd: string;
  approvalMode: ApprovalMode;
  orchestrationMode: OrchestrationMode;
  context: ConversationContext;
  skills: SkillSummary[];
  abort?: AbortController;
};

export interface AcpServerOptions {
  approvalMode: ApprovalMode;
  maxIterations: number;
  orchestrationMode: OrchestrationMode;
}

export function startAcpServer(options: AcpServerOptions): void {
  const peer = new JsonRpcPeer(process.stdin, process.stdout);
  const store = new MasStore();
  const runner = new MasRunner();
  const sessions = new Map<string, SessionState>();

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
    const approvalMode = normalizeSessionApprovalMode(params, options.approvalMode);
    const cwd = normalizeCwd(params?.cwd);
    const skills = await safeDiscoverSkills(cwd);
    sessions.set(sessionId, { sessionId, cwd, approvalMode, orchestrationMode, context: { summary: "", turns: [] }, skills });
    queueSessionUpdates(peer, sessionId, { summary: "", turns: [] }, skills, approvalMode, orchestrationMode);
    return sessionResponse(sessionId, approvalMode, orchestrationMode, skills);
  });

  peer.on("session/load", async (params) => {
    const sessionId = String(params?.sessionId ?? `mas-${randomUUID()}`);
    const orchestrationMode = normalizeOrchestrationMode(params?.orchestrationMode ?? options.orchestrationMode);
    const approvalMode = normalizeSessionApprovalMode(params, options.approvalMode);
    const cwd = normalizeCwd(params?.cwd);
    const skills = await safeDiscoverSkills(cwd);
    const context = store.getConversationContext(sessionId);
    sessions.set(sessionId, {
      sessionId,
      cwd,
      approvalMode,
      orchestrationMode,
      context,
      skills,
    });
    queueSessionUpdates(peer, sessionId, context, skills, approvalMode, orchestrationMode);
    return sessionResponse(sessionId, approvalMode, orchestrationMode, skills);
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

    const result = await runner.run(
      prompt,
      {
        cwd: session.cwd,
        approvalMode: session.approvalMode,
        orchestrationMode: session.orchestrationMode,
        maxIterations: options.maxIterations,
        signal: abort.signal,
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
    session.approvalMode = approvalModeFromAcpMode(params?.modeId ?? params?.id ?? params?.mode ?? params?.value, options.approvalMode);
    queueModeUpdate(peer, session.sessionId, session.approvalMode);
    return sessionResponse(session.sessionId, session.approvalMode, session.orchestrationMode, session.skills);
  });
  peer.on("session/set_model", () => ({}));
  peer.on("session/set_config_option", (params) => {
    const session = sessions.get(String(params?.sessionId ?? ""));
    if (!session) return {};
    const optionId = String(params?.optionId ?? params?.id ?? "");
    if (optionId === "orchestrationMode") {
      session.orchestrationMode = normalizeOrchestrationMode(params?.value);
      queueConfigUpdate(peer, session.sessionId, session.approvalMode, session.orchestrationMode);
    }
    return sessionResponse(session.sessionId, session.approvalMode, session.orchestrationMode, session.skills);
  });
  peer.start();
}

function sessionResponse(
  sessionId: string,
  approvalMode: ApprovalMode,
  orchestrationMode: OrchestrationMode,
  skills: SkillSummary[],
): Record<string, unknown> {
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
      currentModelId: "dashscope-anthropic/qwen3.6-plus",
      availableModels: [
        { id: "dashscope-anthropic/qwen3.6-plus", name: "DashScope qwen3.6-plus" },
        { id: "dashscope-anthropic/kimi-k2.5", name: "DashScope kimi-k2.5" },
        { id: "dashscope-anthropic/qwen3.5-plus", name: "DashScope qwen3.5-plus" },
      ],
    },
    metadata: {
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.path })),
    },
  };
}

function normalizeCwd(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : process.cwd();
}

function normalizeSessionApprovalMode(params: unknown, fallback: ApprovalMode): ApprovalMode {
  if (!params || typeof params !== "object") return fallback;
  const input = params as Record<string, unknown>;
  return approvalModeFromAcpMode(input.modeId ?? input.mode ?? input.currentModeId, fallback);
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
): void {
  setTimeout(() => {
    queueConfigUpdate(peer, sessionId, approvalMode, orchestrationMode);
    queueAvailableCommands(peer, sessionId, skills);
    replayHistory(peer, sessionId, context);
  }, 0);
}

function queueConfigUpdate(peer: JsonRpcPeer, sessionId: string, approvalMode: ApprovalMode, orchestrationMode: OrchestrationMode): void {
  peer.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions: sessionResponse(sessionId, approvalMode, orchestrationMode, []).configOptions,
    },
  });
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
