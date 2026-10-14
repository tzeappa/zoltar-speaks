import type { AppContext } from '../context.ts';
import { transaction } from '../db/index.ts';
import {
  addIncidentEvent,
  addIncidentSource,
  clusterCandidates,
  findActiveIncident,
  insertPlatformCheck,
  lastPlatformResolvedAt,
  linkTicketsToIncident,
  prunePlatformChecks,
  recentPlatformChecks,
  setIncidentRecovered,
  wasOperationalSince,
  lastKnownStatusBefore,
  type PlatformCheck,
} from '../db/repo.ts';
import {
  COMPONENT_CATEGORY,
  COMPONENTS,
  MONITORED_PLATFORMS,
  type Component,
  type MonitoredPlatform,
  type PlatformStatus,
} from '../domain.ts';
import { openPlatformIncident } from '../pipeline/incidents.ts';
import { evaluateChecks, formatDuration, JITTER_MS, type MonitorAction } from './rules.ts';
import { HttpProbeSource, SimulatedSource, StatuspageSource, type StatusResult, type StatusSource } from './sources.ts';

const HISTORY = 20;
const RETENTION_MS = 24 * 60 * 60_000;

export interface BoardEntry {
  platform: MonitoredPlatform;
  component: Component;
  source: string;
  latest: PlatformCheck | null;
  since: number | null;
  history: PlatformStatus[];
}

export function sourcesFromConfig(ctx: AppContext, fetchFn: typeof fetch = fetch): Map<MonitoredPlatform, StatusSource> {
  const simulated = new SimulatedSource(ctx.db);
  const map = new Map<MonitoredPlatform, StatusSource>();
  for (const platform of MONITORED_PLATFORMS) {
    const cfg = ctx.config.monitorSources[platform];
    if (cfg?.type === 'statuspage') map.set(platform, new StatuspageSource(cfg.url, fetchFn));
    else if (cfg?.type === 'http_probe') map.set(platform, new HttpProbeSource(cfg.url, cfg.degradedMs, fetchFn));
    else map.set(platform, simulated);
  }
  return map;
}

export class PlatformMonitor {
  private timer: NodeJS.Timeout | undefined;
  private runs = 0;
  private running: Promise<void> | null = null;
  lastRunAt: number | null = null;
  /** Enough checks to cover the longest threshold, with room for manual runs in between. */
  private readonly ruleHistory: number;

  constructor(
    private readonly ctx: AppContext,
    private readonly sources: Map<MonitoredPlatform, StatusSource>,
  ) {
    const longest = Math.max(ctx.config.monitorDegradedMs, ctx.config.monitorRecoveryMs);
    this.ruleHistory = Math.min(1_000, Math.max(HISTORY, Math.ceil(longest / ctx.config.monitorIntervalMs) * 3 + 5));
  }

  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.ctx.config.monitorIntervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** One pass over every platform and component. Overlapping runs are skipped. */
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    // Taken before the checks: the timer keeps pass starts evenly spaced, while slow sources would skew a later time.
    const now = this.ctx.now();
    const targets = [...this.sources].flatMap(([platform, source]) =>
      COMPONENTS.map((component) => ({ platform, component, source })),
    );
    const results = await Promise.all(
      targets.map(async (t) => {
        try {
          return { ...t, result: await t.source.check(t.platform, t.component) };
        } catch (err) {
          const detail = `Source error: ${err instanceof Error ? err.message : String(err)}`;
          this.ctx.log.warn({ platform: t.platform, component: t.component, source: t.source.type, err: detail }, 'monitor_source_failed');
          return { ...t, result: { status: 'unknown', detail, latencyMs: null } satisfies StatusResult };
        }
      }),
    );

    for (const r of results) this.apply(r.platform, r.component, r.source.type, r.result, now);
    this.lastRunAt = now;
    if (++this.runs % 50 === 0) prunePlatformChecks(this.ctx.db, now - RETENTION_MS);
  }

  private apply(platform: MonitoredPlatform, component: Component, source: string, r: StatusResult, now: number): void {
    const { ctx } = this;
    const category = COMPONENT_CATEGORY[component];
    const label = `${platform} ${component}`;

    const action: MonitorAction = transaction(ctx.db, () => {
      insertPlatformCheck(ctx.db, { platform, component, source, status: r.status, detail: r.detail, latencyMs: r.latencyMs, checkedAt: now });
      const active = findActiveIncident(ctx.db, { kind: 'platform', platform, category });
      let action = evaluateChecks(
        recentPlatformChecks(ctx.db, platform, component, this.ruleHistory),
        { open: !!active, monitorAttached: !!active?.sources.includes('monitor'), recovered: !!active?.recoveredAt },
        {
          degradedMs: ctx.config.monitorDegradedMs,
          recoveryMs: ctx.config.monitorRecoveryMs,
          maxGapMs: 2 * ctx.config.monitorIntervalMs + JITTER_MS,
        },
      );
      // Someone resolved the incident while this failure was already going on; reopening it on the next check
      // would undo their decision. A new failure after the platform recovers still opens one, and so does a
      // degraded platform, resolved as minor, going down completely.
      if (action === 'open') {
        const resolvedAt = lastPlatformResolvedAt(ctx.db, platform, category);
        if (
          resolvedAt !== null &&
          !wasOperationalSince(ctx.db, platform, component, resolvedAt) &&
          !(r.status === 'outage' && lastKnownStatusBefore(ctx.db, platform, component, resolvedAt) !== 'outage')
        ) {
          action = 'none';
        }
      }
      const event = (message: string) =>
        addIncidentEvent(ctx.db, { incidentId: active!.id, source: 'monitor', message, createdAt: now });

      if (active?.recoveredAt && (r.status === 'degraded' || r.status === 'outage')) {
        setIncidentRecovered(ctx.db, active.id, null);
        event(`${label} failing again after recovery: ${r.status}. Hold the all-clear.`);
      }

      switch (action) {
        case 'open': {
          const id = openPlatformIncident(ctx, {
            platform,
            category,
            source: 'monitor',
            title: `${label} ${r.status}`,
            message: `${label} ${r.status}: ${r.detail}`,
          });
          const earlier = clusterCandidates(ctx.db, platform, category, now - ctx.config.incidentWindowMinutes * 60_000).filter(
            (c) => c.incidentId === null,
          );
          if (earlier.length) {
            linkTicketsToIncident(
              ctx.db,
              earlier.map((c) => c.ticketId),
              id,
            );
            addIncidentSource(ctx.db, id, 'tickets');
            addIncidentEvent(ctx.db, {
              incidentId: id,
              source: 'tickets',
              message: `Linked ${earlier.length} earlier client reports`,
              createdAt: now,
            });
          }
          break;
        }
        case 'attach':
          addIncidentSource(ctx.db, active!.id, 'monitor');
          setIncidentRecovered(ctx.db, active!.id, null);
          event(`Monitor confirms ${label} ${r.status}: ${r.detail}`);
          break;
        case 'worsened':
          setIncidentRecovered(ctx.db, active!.id, null);
          event(`${label} worsened to outage: ${r.detail}`);
          break;
        case 'recovered':
          setIncidentRecovered(ctx.db, active!.id, now);
          event(
            `${label} operational for ${formatDuration(ctx.config.monitorRecoveryMs)}. Verify failed posts are republished, then resolve and send the all-clear.`,
          );
          break;
      }
      return action;
    });

    if (action !== 'none') ctx.log.warn({ platform, component, status: r.status, action }, 'monitor_action');
  }

  board(): BoardEntry[] {
    return [...this.sources].flatMap(([platform, source]) =>
      COMPONENTS.map((component) => {
        const checks = recentPlatformChecks(this.ctx.db, platform, component, HISTORY);
        const latest = checks[0] ?? null;
        let since: number | null = latest?.checkedAt ?? null;
        for (const c of checks) {
          if (c.status !== latest?.status) break;
          since = c.checkedAt;
        }
        return { platform, component, source: source.type, latest, since, history: checks.map((c) => c.status).reverse() };
      }),
    );
  }
}
