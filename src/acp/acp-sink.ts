import type { JsonRpcPeer } from "./json-rpc.js";
import type { PermissionDecision, PermissionRequestInput, StreamSink, ToolEventInput } from "../types.js";

export class AcpStreamSink implements StreamSink {
  constructor(
    private readonly peer: JsonRpcPeer,
    private readonly sessionId: string,
  ) {}

  text(text: string): void {
    this.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  }

  thought(text: string): void {
    this.update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    });
  }

  toolStart(input: ToolEventInput): void {
    this.update({
      sessionUpdate: "tool_call",
      toolCallId: input.id,
      status: "pending",
      title: input.title,
      kind: input.kind,
      rawInput: input.rawInput,
      locations: input.locations ?? [],
      content: [textToolContent(JSON.stringify(input.rawInput ?? {}))],
    });
  }

  toolUpdate(input: ToolEventInput & { status?: string; content?: unknown[] }): void {
    this.update({
      sessionUpdate: "tool_call_update",
      toolCallId: input.id,
      status: input.status ?? "running",
      title: input.title,
      kind: input.kind,
      rawInput: input.rawInput,
      locations: input.locations ?? [],
      content: input.content ?? [],
    });
  }

  async permission(input: PermissionRequestInput): Promise<PermissionDecision> {
    const result = await this.peer.request("session/request_permission", {
      sessionId: this.sessionId,
      options: [
        { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
        { optionId: "allow_always", name: "始终允许", kind: "allow_always" },
        { optionId: "reject_once", name: "拒绝一次", kind: "reject_once" },
        { optionId: "reject_always", name: "始终拒绝", kind: "reject_always" },
      ],
      toolCall: {
        toolCallId: input.id,
        title: input.title,
        kind: input.kind,
        rawInput: input.rawInput,
        status: "pending",
        locations: input.locations ?? [],
        content: [textToolContent(JSON.stringify(input.rawInput ?? {}))],
      },
    });
    const optionId = String(result?.outcome?.optionId ?? "reject_once");
    return {
      optionId,
      approved: result?.outcome?.outcome === "selected" && !optionId.includes("reject"),
    };
  }

  done(summary?: string): void {
    if (summary) {
      this.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n\n${summary}` },
      });
    }
  }

  error(error: Error): void {
    this.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `\n\nMAS 执行失败：${error.message}` },
    });
  }

  private update(update: Record<string, unknown>): void {
    this.peer.notify("session/update", {
      sessionId: this.sessionId,
      update,
    });
  }
}

export function textToolContent(text: string): Record<string, unknown> {
  return { type: "content", content: { type: "text", text } };
}
