import { AiError } from '../ai/types.ts';
import type { AppContext } from '../context.ts';
import {
  addIncidentEvent,
  claimJob,
  completeJob,
  failJob,
  getIncident,
  nextJobDelay,
  requeueStaleJobs,
  retryJob,
  setIncidentBrief,
  type Job,
  type JobType,
} from '../db/repo.ts';
import { generateIncidentBrief } from './brief.ts';
import { finalizeRoute, triageTicket } from './triage.ts';

type Handler = (ctx: AppContext, refId: number) => Promise<void>;

const DEFAULT_HANDLERS: Record<JobType, Handler> = {
  triage: triageTicket,
  incident_brief: generateIncidentBrief,
};

export class Worker {
  private running = false;
  private inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ctx: AppContext,
    private readonly handlers: Record<JobType, Handler> = DEFAULT_HANDLERS,
  ) {}

  start(): void {
    const { requeued, failed } = requeueStaleJobs(this.ctx.db, this.ctx.now(), this.ctx.config.jobMaxAttempts);
    if (requeued) this.ctx.log.warn({ requeued }, 'requeued_stale_jobs');
    for (const job of failed) {
      this.ctx.log.error({ job_id: job.id, job_type: job.type, ref_id: job.refId }, 'job_failed');
      this.onFinalFailure(job, 'interrupted');
    }
    this.running = true;
    this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await Promise.allSettled([...this.inFlight]);
  }

  /** Wakes the worker immediately, e.g. after a new ticket is inserted. */
  poke(): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.tick();
  }

  private tick(): void {
    if (!this.running) return;
    let delay: number | undefined;
    // A database error here (e.g. SQLITE_BUSY) must not become an unhandled exception that stops the process.
    try {
      while (this.inFlight.size < this.ctx.config.workerConcurrency) {
        const job = claimJob(this.ctx.db, this.ctx.now());
        if (!job) break;
        const p = this.process(job)
          .catch((err) => this.ctx.log.error({ job_id: job.id, err: String(err) }, 'job_bookkeeping_failed'))
          .finally(() => {
            this.inFlight.delete(p);
            this.tick();
          });
        this.inFlight.add(p);
      }
      delay = nextJobDelay(this.ctx.db, this.ctx.now());
    } catch (err) {
      this.ctx.log.error({ err: String(err) }, 'worker_tick_failed');
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.min(delay ?? this.ctx.config.workerPollMs, this.ctx.config.workerPollMs));
  }

  /** Processes ready jobs until none are left, ignoring backoff delays. For tests and scripts. */
  async drain(maxJobs = 1000): Promise<number> {
    let processed = 0;
    while (processed < maxJobs) {
      const job = claimJob(this.ctx.db, Number.MAX_SAFE_INTEGER);
      if (!job) break;
      await this.process(job);
      processed++;
    }
    return processed;
  }

  private async process(job: Job): Promise<void> {
    const { ctx } = this;
    const log = ctx.log.child({ job_id: job.id, job_type: job.type, ref_id: job.refId, attempt: job.attempts });
    const started = ctx.now();
    try {
      await this.handlers[job.type](ctx, job.refId);
      completeJob(ctx.db, job.id, ctx.now());
      log.info({ duration_ms: ctx.now() - started }, 'job_done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient = err instanceof AiError && err.kind === 'transient';
      if (transient && job.attempts < ctx.config.jobMaxAttempts) {
        const backoff = ctx.config.jobBackoffMs * 2 ** (job.attempts - 1);
        retryJob(ctx.db, job.id, message, ctx.now() + backoff, ctx.now());
        log.warn({ err: message, retry_in_ms: backoff }, 'job_retry');
        return;
      }
      failJob(ctx.db, job.id, message, ctx.now());
      log.error({ err: message }, 'job_failed');
      this.onFinalFailure(job, transient ? 'retries_exhausted' : 'error');
    }
  }

  private onFinalFailure(job: Job, reason: string): void {
    const { ctx } = this;
    try {
      if (job.type === 'triage') {
        finalizeRoute(ctx, job.refId, reason);
      } else {
        setIncidentBrief(ctx.db, job.refId, 'failed', getIncident(ctx.db, job.refId)?.brief ?? null);
        addIncidentEvent(ctx.db, {
          incidentId: job.refId,
          source: 'ai',
          message: `Brief generation failed (${reason}). Use the runbook directly.`,
          createdAt: ctx.now(),
        });
      }
    } catch (err) {
      ctx.log.error({ job_id: job.id, err: String(err) }, 'final_failure_handler_failed');
    }
  }
}
