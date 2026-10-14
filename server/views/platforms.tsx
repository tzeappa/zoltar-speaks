import type { FC } from 'hono/jsx';
import { MONITORED_PLATFORMS, type Component } from '../domain.ts';
import type { BoardEntry } from '../monitor/monitor.ts';
import { formatDuration } from '../monitor/rules.ts';
import { StatusPill, live, timeAgo } from './ui.tsx';

const STATUSES = ['operational', 'degraded', 'outage', 'unknown'] as const;

const Cell: FC<{ e: BoardEntry | undefined; now: number }> = ({ e, now }) => {
  if (!e) return <td>-</td>;
  const status = e.latest?.status ?? 'unknown';
  return (
    <td class="status-cell">
      <div class="status-line">
        <StatusPill status={status} />
        <span class="muted small">since {timeAgo(e.since, now)}</span>
      </div>
      <div class="small">{e.latest?.detail ?? 'No checks yet'}</div>
      <div class="spark" title="Last 20 checks, oldest first">
        {e.history.map((s) => (
          <i class={`s-${s}`} />
        ))}
      </div>
      {e.source === 'simulated' ? (
        <form method="post" action="/platforms/simulate" class="sim">
          <input type="hidden" name="platform" value={e.platform} />
          <input type="hidden" name="component" value={e.component} />
          <label class="muted small">
            Simulate{' '}
            <select name="status">
              {STATUSES.map((s) => (
                <option value={s} selected={s === status}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {/* An explicit button: a status change can open a real incident, so it must not fire while arrowing through. */}
          <button class="btn small" type="submit">
            Set
          </button>
        </form>
      ) : (
        <div class="muted small">Source: {e.source}</div>
      )}
    </td>
  );
};

export const PlatformsPage: FC<{
  board: BoardEntry[];
  lastRunAt: number | null;
  intervalMs: number;
  degradedMs: number;
  recoveryMs: number;
  now: number;
}> = ({ board, lastRunAt, intervalMs, degradedMs, recoveryMs, now }) => {
  const get = (platform: string, component: Component) => board.find((b) => b.platform === platform && b.component === component);
  return (
    <div {...live('platforms', '/platforms', 'platforms')}>
      <div class="page-head">
        <div>
          <h1>Platform health</h1>
          <p class="sub">
            Checked every {Math.round(intervalMs / 1000)}s, last run {timeAgo(lastRunAt, now)}. Outage opens an incident on the first check;
            degraded opens one after {formatDuration(degradedMs)} of degraded checks. Recovery is noted after {formatDuration(recoveryMs)} of
            operational checks; running checks more often does not shorten either. A failing status source shows as unknown and never opens an incident.
          </p>
        </div>
        <form method="post" action="/platforms/run">
          <button class="btn secondary" type="submit">
            Run checks now
          </button>
        </form>
      </div>
      <table class="table platforms">
        <thead>
          <tr>
            <th>Platform</th>
            <th>Publishing API</th>
            <th>Analytics API</th>
          </tr>
        </thead>
        <tbody>
          {MONITORED_PLATFORMS.map((p) => (
            <tr>
              <th>{p}</th>
              <Cell e={get(p, 'publishing')} now={now} />
              <Cell e={get(p, 'analytics')} now={now} />
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted small">
        Simulated sources stand in for real feeds. Configure Statuspage or HTTP probe sources per platform with MONITOR_SOURCES.
      </p>
    </div>
  );
};
