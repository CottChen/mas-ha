import { AutonomyLoop } from "./autonomy.js";
import { MasStore } from "../storage.js";

export interface ReflectionSchedulerOptions {
  intervalMs: number;
  dueLimit: number;
  dreamLimit: number;
  runDream: boolean;
  ownerId?: string;
  leaseName?: string;
  leaseTtlMs?: number;
  unrefTimer?: boolean;
}

export class ReflectionScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  readonly ownerId: string;
  private readonly leaseName: string;
  private readonly leaseTtlMs: number;

  constructor(
    private readonly store = new MasStore(),
    private readonly options: ReflectionSchedulerOptions,
    private readonly autonomy = new AutonomyLoop(store, options.ownerId ?? `scheduler-${process.pid}`),
  ) {
    this.ownerId = options.ownerId ?? `scheduler-${process.pid}`;
    this.leaseName = options.leaseName ?? "global-autonomy-scheduler";
    this.leaseTtlMs = options.leaseTtlMs ?? Math.max(options.intervalMs * 3, 30_000);
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => {
      this.tick();
    }, this.options.intervalMs);
    if (this.options.unrefTimer !== false) this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): { leaseAcquired: boolean; due?: ReturnType<AutonomyLoop["runDueAutonomyJobs"]>; dream?: ReturnType<AutonomyLoop["dreamPrune"]> } {
    if (this.running) return { leaseAcquired: false };
    this.running = true;
    try {
      const leaseAcquired = this.store.acquireSchedulerLease({
        name: this.leaseName,
        ownerId: this.ownerId,
        ttlMs: this.leaseTtlMs,
        metadata: { pid: process.pid, intervalMs: this.options.intervalMs },
      });
      if (!leaseAcquired) return { leaseAcquired: false };
      const due = this.autonomy.runDueAutonomyJobs(this.options.dueLimit);
      const dream = this.options.runDream ? this.autonomy.dreamPrune(this.options.dreamLimit) : { pruned: 0 };
      if (due.processed > 0 || dream.pruned > 0) {
        this.store.audit({
          runId: "system",
          actor: "superego",
          action: "reflection_scheduler_tick",
          payload: { due, dream },
        });
      }
      return { leaseAcquired: true, due, dream };
    } catch (error) {
      this.store.audit({
        runId: "system",
        actor: "superego",
        action: "reflection_scheduler_failed",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    } finally {
      this.running = false;
    }
  }
}
