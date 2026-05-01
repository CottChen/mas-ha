import { randomUUID } from "node:crypto";
import { JsonRpcPeer } from "./json-rpc.js";
import { AcpStreamSink } from "./acp-sink.js";
import { MasRunner } from "../core/runner.js";
import type { ApprovalMode } from "../types.js";

type SessionState = {
  sessionId: string;
  cwd: string;
  abort?: AbortController;
};

export interface AcpServerOptions {
  approvalMode: ApprovalMode;
  maxIterations: number;
}

export function startAcpServer(options: AcpServerOptions): void {
  const peer = new JsonRpcPeer(process.stdin, process.stdout);
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

  peer.on("session/new", (params) => {
    const sessionId = `mas-${randomUUID()}`;
    sessions.set(sessionId, { sessionId, cwd: normalizeCwd(params?.cwd) });
    return sessionResponse(sessionId);
  });

  peer.on("session/load", (params) => {
    const sessionId = String(params?.sessionId ?? `mas-${randomUUID()}`);
    sessions.set(sessionId, { sessionId, cwd: normalizeCwd(params?.cwd) });
    return sessionResponse(sessionId);
  });

  peer.on("session/prompt", async (params) => {
    const sessionId = String(params?.sessionId ?? "");
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`未知 sessionId：${sessionId}`);
    const prompt = extractPrompt(params?.prompt);
    const sink = new AcpStreamSink(peer, sessionId);
    const abort = new AbortController();
    session.abort = abort;

    await runner.run(
      prompt,
      {
        cwd: session.cwd,
        approvalMode: options.approvalMode,
        maxIterations: options.maxIterations,
        signal: abort.signal,
      },
      sink,
      sessionId,
    );

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

  peer.on("session/set_mode", () => ({}));
  peer.on("session/set_model", () => ({}));
  peer.on("session/set_config_option", () => ({}));
  peer.start();
}

function sessionResponse(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    modes: [
      { id: "default", name: "默认", description: "写文件和命令需要审批" },
      { id: "bypassPermissions", name: "免确认", description: "等价于 mas --approve-all" },
    ],
    configOptions: [],
    models: {
      currentModelId: "pi-default",
      availableModels: [{ id: "pi-default", name: "Pi 默认模型" }],
    },
  };
}

function normalizeCwd(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : process.cwd();
}

function extractPrompt(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
