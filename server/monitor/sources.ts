import type { Db } from '../db/index.ts';
import { getSetting, setSetting } from '../db/repo.ts';
import type { Component, MonitoredPlatform, PlatformStatus } from '../domain.ts';

export interface StatusResult {
  status: PlatformStatus;
  detail: string;
  latencyMs: number | null;
}

/** A source may throw; the monitor records that as `unknown` rather than as a platform problem. */
export interface StatusSource {
  readonly type: string;
  check(platform: MonitoredPlatform, component: Component): Promise<StatusResult>;
}

type FetchFn = typeof fetch;

// ---------- simulated ----------

const simKey = (platform: string, component: string) => `sim_status:${platform}:${component}`;

export function getSimulatedStatus(db: Db, platform: string, component: string): { status: PlatformStatus; detail: string } {
  const raw = getSetting(db, simKey(platform, component));
  return raw ? (JSON.parse(raw) as { status: PlatformStatus; detail: string }) : { status: 'operational', detail: '' };
}

export function setSimulatedStatus(db: Db, platform: string, component: string, status: PlatformStatus, detail = ''): void {
  setSetting(db, simKey(platform, component), JSON.stringify({ status, detail }));
}

/** Status controlled from the Platforms page. Stands in for a real feed in demos and tests. */
export class SimulatedSource implements StatusSource {
  readonly type = 'simulated';
  constructor(private readonly db: Db) {}

  async check(platform: MonitoredPlatform, component: Component): Promise<StatusResult> {
    const s = getSimulatedStatus(this.db, platform, component);
    if (s.status === 'unknown') throw new Error(s.detail || 'Simulated source failure');
    const fallback: Record<PlatformStatus, string> = {
      operational: 'All checks passing',
      degraded: 'Elevated error rate',
      outage: 'Requests failing',
      unknown: '',
    };
    return { status: s.status, detail: s.detail || fallback[s.status], latencyMs: null };
  }
}

// ---------- Atlassian Statuspage ----------

export function mapStatuspageIndicator(indicator: unknown): PlatformStatus {
  switch (indicator) {
    case 'none':
      return 'operational';
    case 'minor':
      return 'degraded';
    case 'major':
    case 'critical':
      return 'outage';
    default:
      return 'unknown';
  }
}

/** Reads a Statuspage `/api/v2/status.json`. The page-level status applies to every component. */
export class StatuspageSource implements StatusSource {
  readonly type = 'statuspage';
  constructor(
    private readonly url: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  async check(): Promise<StatusResult> {
    const started = performance.now();
    const res = await this.fetchFn(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) throw new Error(`Status page returned HTTP ${res.status}`);
    const body = (await res.json()) as { status?: { indicator?: string; description?: string } };
    const status = mapStatuspageIndicator(body.status?.indicator);
    if (status === 'unknown') throw new Error('Status page response missing status.indicator');
    return { status, detail: body.status?.description ?? '', latencyMs };
  }
}

// ---------- synthetic HTTP probe ----------

export function classifyProbe(httpStatus: number, latencyMs: number, degradedMs: number): StatusResult {
  if (httpStatus >= 500) return { status: 'outage', detail: `HTTP ${httpStatus}`, latencyMs };
  if (httpStatus === 429) return { status: 'degraded', detail: 'Rate limited (HTTP 429)', latencyMs };
  if (httpStatus >= 400) throw new Error(`Probe misconfigured: HTTP ${httpStatus}`);
  if (latencyMs > degradedMs) return { status: 'degraded', detail: `Slow response: ${latencyMs} ms`, latencyMs };
  return { status: 'operational', detail: `HTTP ${httpStatus} in ${latencyMs} ms`, latencyMs };
}

/**
 * Timeouts and 5xx count against the platform. Connection errors (DNS, refused) are more often on our side, so they
 * surface as `unknown`.
 */
export class HttpProbeSource implements StatusSource {
  readonly type = 'http_probe';
  constructor(
    private readonly url: string,
    private readonly degradedMs = 2_000,
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 8_000,
  ) {}

  async check(): Promise<StatusResult> {
    const started = performance.now();
    try {
      const res = await this.fetchFn(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      const latencyMs = Math.round(performance.now() - started);
      // Only the status matters; an unread body keeps the connection open.
      await res.body?.cancel().catch(() => {});
      return classifyProbe(res.status, latencyMs, this.degradedMs);
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { status: 'outage', detail: `No response within ${this.timeoutMs} ms`, latencyMs: this.timeoutMs };
      }
      throw err;
    }
  }
}
