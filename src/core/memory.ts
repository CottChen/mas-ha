import { MasStore } from "../storage.js";
import type { MemoryArtifact } from "../types.js";

export function retrieveMemoryArtifacts(store: MasStore, input: { query: string; limit?: number }): MemoryArtifact[] {
  const nodes = store.listExperienceNodes({ query: input.query.slice(0, 80), limit: input.limit ?? 5 });
  return nodes.map((node) => ({
    kind: node.type === "eval_candidate" ? "test_candidate" : node.type === "signal" ? "risk" : "lesson",
    scope: "project",
    content: `${node.title}\n${node.summary}`.slice(0, 1200),
    confidence: node.type === "signal" || node.type === "eval_candidate" ? 0.75 : 0.55,
    sourceNodeIds: [node.nodeId],
    activationHints: [input.query.slice(0, 120), node.type],
  }));
}

export function renderMemoryArtifacts(artifacts: MemoryArtifact[]): string {
  if (artifacts.length === 0) return "";
  return [
    "相关历史经验候选如下。它们不是事实来源；必须被当前任务证据验证后才能采用：",
    ...artifacts.map((artifact, index) => `${index + 1}. [${artifact.kind}/${artifact.scope}/conf=${artifact.confidence}] ${artifact.content}`),
  ].join("\n");
}
