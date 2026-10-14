import type { PlatformStatus } from '../domain.ts';

export type MonitorAction = 'open' | 'attach' | 'worsened' | 'recovered' | 'none';

export interface Check {
  status: PlatformStatus;
  checkedAt: number;
}

export interface RuleConfig {
  /** How long a platform must stay degraded (or worse) before an incident opens. Outage opens at once. */
  degradedMs: number;
  /** How long it must stay operational before recovery is noted. */
  recoveryMs: number;
  /**
   * Known checks further apart than this break a streak. Without it an hour with no readings (server stopped, laptop
   * asleep, the source failing) would count as an hour degraded, and one bad check after it would open an incident.
   */
  maxGapMs: number;
}

export interface IncidentState {
  open: boolean;
  monitorAttached: boolean;
  /** Recovery already noted (`recovered_at` set). */
  recovered: boolean;
}

/** Checks run on a timer, so a streak meant to last 20 s can measure 19.99 s; this keeps jitter from adding an interval. */
export const JITTER_MS = 1_000;

const isBad = (s: PlatformStatus) => s === 'degraded' || s === 'outage';

/**
 * Decides what the latest check means for incidents. `checks` is newest first. Thresholds are durations, not check
 * counts, so extra checks ("Run checks now", a simulated change) cannot make anything happen sooner. `unknown` checks
 * (source failures) never trigger anything; a run of them longer than `maxGapMs` breaks a streak.
 */
export function evaluateChecks(checks: Check[], incident: IncidentState, cfg: RuleConfig): MonitorAction {
  if (checks.length === 0 || checks[0]!.status === 'unknown') return 'none';
  const known = checks.filter((c) => c.status !== 'unknown');
  const latest = known[0]!;
  const lasted = (holds: (s: PlatformStatus) => boolean) => {
    let start = latest.checkedAt;
    for (const c of known) {
      if (!holds(c.status) || start - c.checkedAt > cfg.maxGapMs) break;
      start = c.checkedAt;
    }
    return latest.checkedAt - start + JITTER_MS;
  };

  if (isBad(latest.status)) {
    const triggered = latest.status === 'outage' || lasted(isBad) >= cfg.degradedMs;
    if (!triggered) return 'none';
    if (!incident.open) return 'open';
    if (!incident.monitorAttached) return 'attach';
    if (latest.status === 'outage' && known[1]?.status === 'degraded') return 'worsened';
    return 'none';
  }

  if (incident.open && incident.monitorAttached && !incident.recovered && lasted((s) => s === 'operational') >= cfg.recoveryMs) {
    return 'recovered';
  }
  return 'none';
}

/** "20 seconds", "2 minutes", "1 minute 30 seconds". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (!min) return part(sec, 'second');
  return sec ? `${part(min, 'minute')} ${part(sec, 'second')}` : part(min, 'minute');
}
