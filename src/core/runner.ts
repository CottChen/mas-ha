import { randomUUID } from "node:crypto";
import { MasStore } from "../storage.js";
import type { ApprovalMode, CritiqueResult, MasRunOptions, StreamSink } from "../types.js";
import { createPiSession } from "../pi/pi-sdk.js";
import { buildAcceptanceContract, buildEgoPrompt, buildSuperegoPrompt, parseCritique } from "./prompts.js";

export class MasRunner {
  constructor(private readonly store = new MasStore()) {}

  async run(prompt: string, options: MasRunOptions, sink: StreamSink, sessionId?: string): Promise<{ runId: string; result: string }> {
    const runId = randomUUID();
    this.store.createRun({ runId, sessionId, cwd: options.cwd, prompt });
    this.store.audit({ runId, actor: "ha", action: "run_started", payload: { cwd: options.cwd } });

    const contract = buildAcceptanceContract(prompt);
    sink.thought(`HA 已创建验收合同。\n${contract}\n`);
    this.store.addAgentRun({ runId, role: "ha", iteration: 0, status: "completed", input: { prompt }, output: { contract } });

    let critique: CritiqueResult | undefined;
    let finalEgoOutput = "";

    try {
      for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
        throwIfAborted(options.signal);
        sink.thought(`\nEgo 第 ${iteration} 轮开始。\n`);
        const ego = await createPiSession({
          cwd: options.cwd,
          runId,
          role: "ego",
          approvalMode: options.approvalMode,
          sink,
          recordApproval: (input) => this.store.addApproval({ runId, ...input }),
        });
        const abortEgo = () => void ego.abort();
        options.signal?.addEventListener("abort", abortEgo, { once: true });
        try {
          finalEgoOutput = await ego.prompt(buildEgoPrompt(prompt, contract, critique));
          this.store.addAgentRun({
            runId,
            role: "ego",
            iteration,
            status: "completed",
            input: { prompt, critique },
            output: { text: finalEgoOutput, messages: ego.messages() },
          });
        } finally {
          options.signal?.removeEventListener("abort", abortEgo);
          ego.dispose();
        }

        throwIfAborted(options.signal);
        sink.thought(`\nSuperego 第 ${iteration} 轮评审开始。\n`);
        const superego = await createPiSession({
          cwd: options.cwd,
          runId,
          role: "superego",
          approvalMode: "deny-writes",
          sink,
          recordApproval: (input) => this.store.addApproval({ runId, ...input }),
        });
        const abortSuperego = () => void superego.abort();
        options.signal?.addEventListener("abort", abortSuperego, { once: true });
        let reviewText = "";
        try {
          reviewText = await superego.prompt(buildSuperegoPrompt(prompt, contract, finalEgoOutput));
          critique = parseCritique(reviewText);
          this.store.addAgentRun({
            runId,
            role: "superego",
            iteration,
            status: "completed",
            input: { prompt, contract },
            output: { text: reviewText, critique },
          });
        } finally {
          options.signal?.removeEventListener("abort", abortSuperego);
          superego.dispose();
        }

        sink.thought(`\nSuperego 结论：${critique.summary || critique.next_action}\n`);
        if (critique.next_action === "accept" && critique.blocking_issues === 0) {
          const result = `HA 终验通过。\n\n${finalEgoOutput}`;
          this.store.updateRun(runId, "completed", { result, critique });
          sink.done(result);
          return { runId, result };
        }
      }

      const result = `HA 终验未通过：达到最大返工轮次。\n\n最后批注：${JSON.stringify(critique, null, 2)}\n\n最后 Ego 输出：\n${finalEgoOutput}`;
      this.store.updateRun(runId, "needs_attention", { result, critique });
      sink.done(result);
      return { runId, result };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.store.updateRun(runId, "failed", { message: err.message, stack: err.stack });
      sink.error(err);
      throw err;
    }
  }

  static approvalModeFromFlags(flags: { approveAll?: boolean; denyWrites?: boolean }): ApprovalMode {
    if (flags.approveAll) return "approve-all";
    if (flags.denyWrites) return "deny-writes";
    return "approve-reads";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("MAS run 已取消");
}
