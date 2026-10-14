import type { FC } from 'hono/jsx';
import type { DisplayIncident, IncidentDetail } from '../read-models.ts';
import { Card, Chip, PriorityBadge, TierBadge, clock, ms, live, timeAgo, usd } from './ui.tsx';

const SourceChips: FC<{ sources: string[] }> = ({ sources }) => (
  <>
    {sources.map((s) => (
      <Chip tone={`source-${s}`}>{s === 'monitor' ? 'Platform monitor' : 'Client reports'}</Chip>
    ))}
  </>
);

const StatusBadge: FC<{ status: string }> = ({ status }) => <span class={`badge inc-${status}`}>{status}</span>;

export const IncidentsPage: FC<{ incidents: DisplayIncident[]; now: number }> = ({ incidents, now }) => {
  const active = incidents.filter((i) => i.status !== 'resolved');
  const resolved = incidents.filter((i) => i.status === 'resolved');
  const Item: FC<{ i: DisplayIncident }> = ({ i }) => (
    <a class="row incident-row" href={`/incidents/${i.id}`} data-row={String(i.id)}>
      <div class="row-prio">
        <StatusBadge status={i.status} />
      </div>
      <div class="row-main">
        <div class="row-title">
          <strong>{i.title}</strong>
          {i.brief ? <span class={`badge sev sev-${i.brief.severity.toLowerCase()}`}>{i.brief.severity}</span> : null}
        </div>
        <div class="row-meta">
          <Chip>{i.kind === 'platform' ? 'Platform incident' : 'Client watch'}</Chip>
          <Chip>{i.platform}</Chip>
          <Chip>{i.category}</Chip>
          <SourceChips sources={i.sources} />
          <span class="muted small">
            {i.ticketCount} tickets from {i.clientCount} clients
          </span>
        </div>
      </div>
      <div class="row-age">{timeAgo(i.createdAt, now)}</div>
    </a>
  );

  return (
    <div {...live('incidents', '/incidents', 'incidents tickets')}>
      <div class="page-head">
        <div>
          <h1>Incidents</h1>
          <p class="sub">Opened by the platform monitor or by clusters of client reports. Only Ops resolves them.</p>
        </div>
      </div>
      <div class="list" data-list>
        {active.length ? active.map((i) => <Item i={i} />) : <p class="empty">No active incidents.</p>}
      </div>
      {resolved.length ? (
        <>
          <h3 class="section">Resolved</h3>
          <div class="list">{resolved.map((i) => <Item i={i} />)}</div>
        </>
      ) : null}
    </div>
  );
};

const Brief: FC<{ d: IncidentDetail }> = ({ d }) => {
  const { incident: inc } = d;
  if (inc.kind === 'client_watch') {
    return (
      <Card title="Client watch">
        <p>
          One client sent several {inc.category.toLowerCase()} requests in a short window. This is not a platform problem, so no AI
          brief is generated. Check in with the client directly and review the linked requests together.
        </p>
      </Card>
    );
  }
  if (inc.briefStatus === 'pending' && !inc.brief) {
    return (
      <Card title="AI brief">
        <p class="muted">Generating brief...</p>
      </Card>
    );
  }
  if (!inc.brief) {
    return (
      <Card title="AI brief">
        <p class="muted">
          {inc.briefStatus === 'failed' ? 'Brief generation failed. Follow the runbook directly.' : 'AI is off, so no brief was generated. Follow the runbook directly.'}
        </p>
      </Card>
    );
  }
  const b = inc.brief;
  return (
    <Card
      title={
        <>
          AI brief <span class={`badge sev sev-${b.severity.toLowerCase()}`}>{b.severity}</span>
        </>
      }
      actions={
        <form method="post" action={`/incidents/${inc.id}/regenerate`}>
          <button class="btn small ghost" type="submit" disabled={inc.briefStatus === 'pending'}>
            {inc.briefStatus === 'pending' ? 'Regenerating...' : 'Regenerate'}
          </button>
        </form>
      }
    >
      {inc.briefStatus === 'failed' ? <p class="error small">Last regeneration failed; showing the previous brief.</p> : null}
      <p class="lead">{b.summary}</p>
      <dl class="kv">
        <dt>Impact</dt>
        <dd>{b.impact}</dd>
        <dt>Suspected cause</dt>
        <dd>{b.suspected_cause}</dd>
      </dl>
      <h3>Next steps</h3>
      <ol class="steps">
        {b.next_steps.map((s) => (
          <li>
            {s.step} {s.runbook_id ? <span class="muted small">({s.runbook_id})</span> : null}
          </li>
        ))}
      </ol>
      {b.human_decisions.length ? (
        <>
          <h3>Decisions for Ops</h3>
          <ul>
            {b.human_decisions.map((x) => (
              <li>{x}</li>
            ))}
          </ul>
        </>
      ) : null}
      {b.unknowns.length ? (
        <>
          <h3>Unknown</h3>
          <ul class="muted">
            {b.unknowns.map((x) => (
              <li>{x}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>Client message</h3>
      <pre class="reply">{b.client_comms_macro}</pre>
      <button type="button" class="btn small" data-copy={b.client_comms_macro}>
        Copy
      </button>
    </Card>
  );
};

type Notices = IncidentDetail['notices'];

const Recipients: FC<{ r: Notices['outage']['recipients'] }> = ({ r }) => (
  <div class="recipients">
    <p class="small">
      <strong>To:</strong> {r.send.length ? r.send.map((c) => c.name).join(', ') : 'nobody with an email on file'}
    </p>
    {r.noEmail.length ? (
      <p class="small warn">No email on file, contact directly: {r.noEmail.map((c) => c.name).join(', ')}</p>
    ) : null}
  </div>
);

const NoticeForm: FC<{ action: string; draft: Notices['outage']; submit: string; confirm: string }> = ({ action, draft, submit, confirm }) => (
  <form method="post" action={action} class="notice-form" data-confirm={confirm}>
    <input type="hidden" name="expected_recipients" value={draft.recipients.send.map((c) => c.id).join(',')} />
    <Recipients r={draft.recipients} />
    <label>
      Subject
      <input type="text" name="subject" value={draft.subject} maxlength={200} required />
    </label>
    <label>
      Message
      <textarea name="body" rows={12} maxlength={5000} required>
        {draft.body}
      </textarea>
    </label>
    <p class="muted small">{'{{client}}'} and {'{{coordinator}}'} are filled in for each client. Each client gets their own email.</p>
    <button class="btn primary" type="submit">
      {submit}
    </button>
  </form>
);

const ChannelNote: FC = () => (
  <p class="channel-note">
    <strong>Simulated delivery:</strong> notices are recorded below, not emailed. The clients are fictional.
  </p>
);

const NoticesCard: FC<{ d: IncidentDetail; now: number }> = ({ d, now }) => {
  const { incident: inc, notices: n } = d;
  const resolved = inc.status === 'resolved';
  const outageCount = n.outage.recipients.send.length;
  const clearCount = n.allClear.recipients.send.length;
  const clearPending = clearCount + n.allClear.recipients.noEmail.length > 0;
  const plural = (k: number) => `${k} client${k === 1 ? '' : 's'}`;

  return (
    <Card title="Client notices" id="notices">
      <ChannelNote />

      {!resolved ? (
        outageCount || n.outage.recipients.noEmail.length ? (
          <details class="compose" data-hold-refresh>
            <summary class="btn primary">Notify affected clients ({outageCount})</summary>
            <NoticeForm
              action={`/incidents/${inc.id}/notify-all`}
              draft={n.outage}
              submit={`Send outage notice to ${plural(outageCount)}`}
              confirm={`Send the outage notice to ${plural(outageCount)}?`}
            />
          </details>
        ) : (
          <p class="muted small">Every affected client has been notified.</p>
        )
      ) : null}

      {!resolved || clearPending ? (
        <details class={`compose ${inc.recoveredAt && !resolved ? 'recovered' : ''}`} id="all-clear" data-hold-refresh>
          <summary class={`btn ${inc.recoveredAt && !resolved ? 'ok' : 'secondary'}`}>
            {resolved ? `Send all-clear (${clearCount})` : `Resolve and send all-clear (${clearCount})`}
          </summary>
          {!resolved && !inc.recoveredAt ? (
            <p class="warn small">The monitor has not confirmed {inc.platform} is healthy yet. Check before telling clients it is fixed.</p>
          ) : null}
          <NoticeForm
            action={`/incidents/${inc.id}/resolve-notify`}
            draft={n.allClear}
            submit={resolved ? `Send all-clear to ${plural(clearCount)}` : `Resolve and send all-clear to ${plural(clearCount)}`}
            confirm={
              resolved
                ? `Send the all-clear to ${plural(clearCount)}?`
                : `Resolve this incident and send the all-clear to ${plural(clearCount)}?`
            }
          />
        </details>
      ) : null}

      {n.messages.length ? (
        <table class="table compact notices-sent">
          <tbody>
            {n.messages.map((m) => (
              <tr>
                <td>
                  <strong>{d.affected.find((a) => a.client.id === m.clientId)?.client.name ?? m.clientId}</strong>
                  <div class="muted small">{m.toAddress}</div>
                </td>
                <td>{m.kind === 'outage' ? 'Outage' : 'All-clear'}</td>
                <td class={m.status === 'failed' ? 'error' : ''} title={m.error ?? undefined}>
                  {m.status === 'failed' ? `failed: ${m.error}` : m.status}
                </td>
                <td class="right muted small">
                  {m.channel}, {timeAgo(m.updatedAt, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {n.messages.some((m) => m.status === 'failed') ? (
        <p class="muted small">Failed notices are retried the next time you send that notice.</p>
      ) : null}
    </Card>
  );
};

export const IncidentPage: FC<{ d: IncidentDetail; reviewer: string; now: number }> = ({ d, reviewer, now }) => {
  const { incident: inc } = d;
  const polling = inc.briefStatus === 'pending' || inc.status !== 'resolved';
  const unnotified = d.affected.filter((a) => !a.notifiedAt && !a.reported).length;

  return (
    <div {...(polling ? live('incident-main', `/incidents/${inc.id}`, 'incidents tickets') : { id: 'incident-main' })}>
      <div class="page-head">
        <div>
          <a href="/incidents" class="back" data-back hx-boost="false">
            ← Back to incidents
          </a>
          <h1>
            <StatusBadge status={inc.status} /> {inc.title}
          </h1>
          <p class="sub">
            {inc.platform}, {inc.category}. Opened {timeAgo(inc.createdAt, now)}. <SourceChips sources={inc.sources} />
          </p>
        </div>
        <div class="actions">
          {inc.status === 'open' ? (
            <form method="post" action={`/incidents/${inc.id}/ack`}>
              <button class="btn secondary" type="submit">
                Acknowledge
              </button>
            </form>
          ) : null}
          {inc.status !== 'resolved' ? (
            <form method="post" action={`/incidents/${inc.id}/resolve`}>
              <button class="btn primary" type="submit">
                Resolve
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {inc.kind === 'platform' && inc.recoveredAt && inc.status !== 'resolved' ? (
        <div class="banner recovered">
          <strong>{inc.platform} recovered {timeAgo(inc.recoveredAt, now)}.</strong> The monitor reports it healthy again. Check that
          held posts went out, then{' '}
          <a href="#all-clear" data-open>
            resolve and send the all-clear
          </a>
          .
        </div>
      ) : null}

      <div class="grid-2">
        <div class="col">
          <Brief d={d} />
          {d.runbooks.map((r) => (
            <Card title={r.title}>
              <pre class="doc">{r.body}</pre>
            </Card>
          ))}
        </div>
        <div class="col">
          {inc.kind === 'platform' ? <NoticesCard d={d} now={now} /> : null}
          <Card title={`Affected clients (${d.affected.length})`} actions={unnotified ? <span class="badge alert">{unnotified} to contact</span> : null}>
            <p class="muted small">Clients on {inc.platform}, platinum first. Contact them before they write in.</p>
            <table class="table compact">
              <tbody>
                {d.affected.map((a) => (
                  <tr id={`notify-${a.client.id}`}>
                    <td>
                      <strong>{a.client.name}</strong> <TierBadge tier={a.client.tier} />
                      <div class="muted small">
                        {a.client.coordinator}
                        {a.client.contactEmail ? `, ${a.client.contactEmail}` : ', no email on file'}
                      </div>
                    </td>
                    <td>{a.reported ? <Chip tone="reason">Reported</Chip> : null}</td>
                    <td class="right">
                      {a.notifiedAt ? (
                        <span class="muted small">
                          Notified by {a.notifiedBy}, {clock(a.notifiedAt)}
                        </span>
                      ) : (
                        <form
                          method="post"
                          action={`/incidents/${inc.id}/notify`}
                          hx-post={`/incidents/${inc.id}/notify`}
                          hx-target={`#notify-${a.client.id}`}
                          hx-select={`#notify-${a.client.id}`}
                          hx-swap="outerHTML"
                        >
                          <input type="hidden" name="client_id" value={a.client.id} />
                          <button class="btn small" type="submit">
                            Mark notified
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Timeline">
            <ol class="timeline">
              {d.events.map((e) => (
                <li class={`ev ev-${e.source}`}>
                  <span class="ev-time">{clock(e.createdAt)}</span>
                  <span class="ev-source">{e.source}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ol>
          </Card>

          <Card title={`Linked requests (${d.tickets.length})`}>
            {d.tickets.length ? (
              <div class="list">
                {d.tickets.map((t) => (
                  <a class="row slim" href={`/tickets/${t.id}`}>
                    <div class="row-prio">
                      <PriorityBadge p={t.effectivePriority} />
                    </div>
                    <div class="row-main">
                      <div class="row-title">
                        <strong>{t.clientName}</strong> <TierBadge tier={t.clientTier} /> <span class="row-subject">{t.subject}</span>
                      </div>
                    </div>
                    <div class="row-age">{timeAgo(t.receivedAt, now)}</div>
                  </a>
                ))}
              </div>
            ) : (
              <p class="muted">No client reports yet.</p>
            )}
          </Card>

          {d.aiCalls.length ? (
            <Card title="Model calls">
              <table class="table compact">
                <tbody>
                  {d.aiCalls.map((x) => (
                    <tr>
                      <td>{x.purpose}</td>
                      <td class="mono">{x.model}</td>
                      <td class={x.status === 'ok' ? '' : 'error'}>{x.status}</td>
                      <td>{ms(x.latencyMs)}</td>
                      <td>{usd(x.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
};
