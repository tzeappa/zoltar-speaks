import type { FC } from 'hono/jsx';
import type { Metrics } from '../metrics.ts';
import { Card, ms, pct, live, reasonLabel, timeAgo, usd } from './ui.tsx';

const Stat: FC<{ label: string; value: string; hint?: string }> = (p) => (
  <div class="stat">
    <div class="stat-value">{p.value}</div>
    <div class="stat-label">{p.label}</div>
    {p.hint ? <div class="stat-hint">{p.hint}</div> : null}
  </div>
);

export interface OpsProps {
  m: Metrics;
  ai: { mode: string; enabled: boolean; modelFast: string; modelSmart: string; lastOkAt: number | null };
  monitorLastRunAt: number | null;
  now: number;
}

export const OpsPage: FC<OpsProps> = ({ m, ai, monitorLastRunAt, now }) => (
  <div {...live('ops', '/ops', 'ops tickets incidents platforms')}>
    <div class="page-head">
      <div>
        <h1>Operations</h1>
        <p class="sub">Last {m.windowHours} hours. Same data as GET /api/metrics.</p>
      </div>
    </div>

    <div class="stats">
      <Stat label="Requests triaged" value={String(m.tickets.triaged)} hint={`${m.tickets.total} received`} />
      <Stat label="Escalated to a human" value={pct(m.tickets.escalationRate)} hint={`${m.tickets.escalated} of ${m.tickets.triaged}`} />
      <Stat label="Drafts approved unchanged" value={pct(m.reviews[0]?.acceptanceRate ?? null)} hint={`${m.reviews[0]?.reviewed ?? 0} reviewed`} />
      <Stat label="Time to triage p50 / p95" value={`${ms(m.tickets.timeToTriageP50Ms)} / ${ms(m.tickets.timeToTriageP95Ms)}`} />
      <Stat label="AI cost" value={usd(m.aiCostUsd)} hint={m.aiCostPerTicketUsd !== null ? `${usd(m.aiCostPerTicketUsd)} per request` : undefined} />
      <Stat label="Queue" value={`${m.queue.queued + m.queue.running}`} hint={`${m.queue.failed} failed jobs`} />
    </div>

    <div class="grid-2">
      <div class="col">
        <Card title="AI">
          <dl class="kv">
            <dt>Mode</dt>
            <dd>{ai.mode}</dd>
            <dt>Status</dt>
            <dd>{ai.enabled ? 'enabled' : 'disabled (manual triage)'}</dd>
            <dt>Models</dt>
            <dd class="mono">
              {ai.modelFast} / {ai.modelSmart}
            </dd>
            <dt>Last successful call</dt>
            <dd>{timeAgo(ai.lastOkAt, now)}</dd>
            <dt>Last monitor run</dt>
            <dd>{timeAgo(monitorLastRunAt, now)}</dd>
          </dl>
          {ai.mode !== 'disabled' ? (
            <form method="post" action="/ops/ai">
              <input type="hidden" name="enabled" value={ai.enabled ? 'false' : 'true'} />
              <button class={`btn ${ai.enabled ? 'danger' : 'primary'}`} type="submit">
                {ai.enabled ? 'Turn AI off' : 'Turn AI on'}
              </button>
              <p class="muted small">With AI off, requests still reach the queue for manual triage and monitoring still opens incidents.</p>
            </form>
          ) : null}
        </Card>

        <Card title="Model calls by step">
          <table class="table compact">
            <thead>
              <tr>
                <th>Step</th>
                <th>Calls</th>
                <th>Errors</th>
                <th>Invalid</th>
                <th>p50</th>
                <th>p95</th>
                <th>Tokens in/out</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {m.ai.map((a) => (
                <tr>
                  <td>{a.purpose}</td>
                  <td>{a.calls}</td>
                  <td class={a.errors ? 'error' : ''}>{a.errors}</td>
                  <td class={a.invalidOutputs ? 'error' : ''}>{a.invalidOutputs}</td>
                  <td>{ms(a.p50Ms)}</td>
                  <td>{ms(a.p95Ms)}</td>
                  <td>
                    {a.inputTokens}/{a.outputTokens}
                  </td>
                  <td>{usd(a.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div class="col">
        <Card title="Why requests were escalated">
          {m.escalationReasons.length ? (
            <table class="table compact">
              <tbody>
                {m.escalationReasons.map((r) => (
                  <tr>
                    <td>{reasonLabel(r.reason)}</td>
                    <td class="right">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p class="muted">No escalations yet.</p>
          )}
        </Card>

        <Card title="Review outcomes by tier">
          <table class="table compact">
            <thead>
              <tr>
                <th>Tier</th>
                <th>Reviewed</th>
                <th>Approved</th>
                <th>Edited</th>
                <th>Rejected</th>
                <th>Acceptance</th>
                <th>Words edited</th>
              </tr>
            </thead>
            <tbody>
              {m.reviews.map((r) => (
                <tr>
                  <td>{r.tier}</td>
                  <td>{r.reviewed}</td>
                  <td>{r.approved}</td>
                  <td>{r.edited}</td>
                  <td>{r.rejected}</td>
                  <td>{pct(r.acceptanceRate)}</td>
                  <td>{r.avgEditDistance ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Incidents">
          <dl class="kv">
            <dt>Open</dt>
            <dd>{m.incidents.open}</dd>
            <dt>Acknowledged</dt>
            <dd>{m.incidents.acknowledged}</dd>
            <dt>Client watches</dt>
            <dd>{m.incidents.clientWatches}</dd>
          </dl>
        </Card>
      </div>
    </div>
  </div>
);
