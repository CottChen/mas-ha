import { AutonomyLoop } from "./autonomy.js";
import { MasStore } from "../storage.js";

export interface ReflectionSchedulerOptions {
  intervalMs: number;
  dueLimit: number;
  dreamLimit: number;
  runDream: boolean;
}

export class ReflectionScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly store = new MasStore(),
    private readonly options: ReflectionSchedulerOptions,
    private readonly autonomy = new AutonomyLoop(store),
  ) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => {
      this.tick();
    }, this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.autonomy.runDueReflections(this.options.dueLimit);
      const dream = this.options.runDream ? this.autonomy.dreamPrune(this.options.dreamLimit) : { pruned: 0 };
      if (due.processed > 0 || dream.pruned > 0) {
        this.store.audit({
          runId: "system",
          actor: "superego",
          action: "reflection_scheduler_tick",
          payload: { due, dream },
        });
      }
    } catch (error) {
      this.store.audit({
        runId: "system",
        actor: "superego",
        action: "reflection_scheduler_failed",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      this.running = false;
    }
  }
}
