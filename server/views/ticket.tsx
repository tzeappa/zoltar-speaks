import type { FC } from 'hono/jsx';
import type { TicketDetail } from '../read-models.ts';
import { Card, Chip, PriorityBadge, TierBadge, clock, ms, live, reasonLabel, timeAgo, usd } from './ui.tsx';

const ReviewPanel: FC<{ d: TicketDetail; reviewer: string; error?: string | null }> = ({ d, reviewer, error }) => {
  const { ticket, draft, reviews } = d;
  const last = reviews.at(-1);
  const busy = ticket.pipelineStatus === 'queued' || ticket.pipelineStatus === 'processing';

  if (busy) {
    return (
      <Card title="Reply" id="review-panel">
        <p class="muted">Triage in progress. The draft appears here when ready.</p>
      </Card>
    );
  }

  if (last) {
    const label = { approved: 'Approved as drafted', edited: 'Edited and approved', rejected: 'Rejected' }[last.action];
    return (
      <Card title="Reply" id="review-panel" class={`reviewed ${last.action}`}>
        <p class="review-status">
          <strong>{label}</strong> by {last.reviewer}, {clock(last.createdAt)}
          {last.editDistance !== null && last.action === 'edited' ? <span class="muted"> ({last.editDistance} words changed)</span> : null}
        </p>
        {last.finalBody ? <pre class="reply">{last.finalBody}</pre> : null}
        {last.note ? <p class="muted">Note: {last.note}</p> : null}
        <a class="btn ghost" href="/queue" data-key="next">
          Back to queue
        </a>
      </Card>
    );
  }

  return (
    <Card title={draft ? 'Draft reply' : 'Reply (no draft)'} id="review-panel">
      {error ? <p class="error">{error}</p> : null}
      {!draft ? <p class="muted">No AI draft for this request. Write the reply manually.</p> : null}
      {d.incidentMacro ? (
        <div class="macro-hint">
          Linked to an incident with an approved client message.{' '}
          <button type="button" class="btn small" data-insert-macro={d.incidentMacro}>
            Use incident message
          </button>
        </div>
      ) : null}
      <form
        method="post"
        action={`/tickets/${ticket.id}/review`}
        hx-post={`/tickets/${ticket.id}/review`}
        hx-target="#review-panel"
        hx-select="#review-panel"
        hx-swap="outerHTML"
      >
        <textarea name="body" rows={12} maxlength={10_000} aria-label="Reply to the client" data-draft>
          {draft?.body ?? ''}
        </textarea>
        {draft && (draft.missingInfo.length || draft.internalNote) ? (
          <div class="draft-notes">
            {draft.internalNote ? <p>{draft.internalNote}</p> : null}
            {draft.missingInfo.length ? (
              <ul>
                {draft.missingInfo.map((m) => (
                  <li>{m}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <input type="text" name="note" maxlength={1_000} aria-label="Internal note" placeholder="Internal note (optional)" />
        <div class="actions">
          <button class="btn primary" type="submit" name="action" value="approve" data-key="approve">
            Approve and send <kbd>a</kbd>
          </button>
          <button class="btn danger" type="submit" name="action" value="reject" data-key="reject">
            Reject <kbd>r</kbd>
          </button>
          <span class="muted small">
            <kbd>e</kbd> edit
          </span>
        </div>
      </form>
    </Card>
  );
};

export const TicketPage: FC<{ d: TicketDetail; reviewer: string; now: number; error?: string | null }> = ({ d, reviewer, now, error }) => {
  const { ticket, client, classification: c, draft } = d;
  const busy = ticket.pipelineStatus === 'queued' || ticket.pipelineStatus === 'processing';
  const totalCost = d.aiCalls.reduce((s, x) => s + x.costUsd, 0);
  const totalLatency = d.aiCalls.reduce((s, x) => s + x.latencyMs, 0);

  return (
    <div {...(busy ? live('ticket-main', `/tickets/${ticket.id}`, 'tickets') : { id: 'ticket-main' })}>
      <div class="page-head">
        <div>
          <a href="/queue" class="back" data-back hx-boost="false">
            ← Back to queue
          </a>
          <h1>
            <PriorityBadge p={ticket.effectivePriority} /> {ticket.subject}
          </h1>
          <p class="sub">
            <strong>{client.name}</strong> <TierBadge tier={client.tier} /> {client.kind}, {client.industry}. Coordinator {client.coordinator}.
            Via {ticket.channel}, {timeAgo(ticket.receivedAt, now)}.
          </p>
        </div>
        {ticket.reviewStatus === 'pending' && (
          <form method="post" action={`/tickets/${ticket.id}/retriage`}>
            <button class="btn ghost" type="submit">
              Re-run triage
            </button>
          </form>
        )}
      </div>

      {d.incident ? (
        <div class={`banner incident-${d.incident.kind}`}>
          <strong>{d.incident.kind === 'platform' ? 'Platform incident' : 'Client watch'}:</strong>{' '}
          <a href={`/incidents/${d.incident.id}`}>{d.incident.title}</a> ({d.incident.status})
        </div>
      ) : null}

      <div class="grid-2">
        <div class="col">
          <Card title="Message">
            <pre class="message">{ticket.body}</pre>
            {ticket.redactedText ? (
              <details data-hold-refresh>
                <summary>What the AI saw</summary>
                <pre class="message redacted">{ticket.redactedText}</pre>
                {ticket.piiKinds.length ? <p class="muted small">Redacted: {ticket.piiKinds.join(', ')}</p> : null}
              </details>
            ) : null}
          </Card>

          <Card title="Routing">
            {ticket.route ? (
              <>
                <p>
                  {ticket.route === 'escalate' ? (
                    <span class="route escalate">Needs human judgment</span>
                  ) : (
                    <span class="route suggest">Draft can be approved as is</span>
                  )}
                </p>
                {ticket.routeReasons.length ? (
                  <ul class="reasons">
                    {ticket.routeReasons.map((r) => (
                      <li>{reasonLabel(r)}</li>
                    ))}
                  </ul>
                ) : null}
                {c && ticket.effectivePriority && ticket.effectivePriority !== c.priority ? (
                  <p class="muted small">
                    Priority raised from {c.priority} to {ticket.effectivePriority} by the {client.tier} tier floor.
                  </p>
                ) : null}
              </>
            ) : (
              <p class="muted">{busy ? 'Triage in progress.' : 'Not routed.'}</p>
            )}
          </Card>

          <Card title="Classification">
            {c ? (
              <dl class="kv">
                <dt>Category</dt>
                <dd>{c.category}</dd>
                <dt>Platform</dt>
                <dd>{c.platform}</dd>
                <dt>Requested action</dt>
                <dd>{c.requestedAction}</dd>
                <dt>Model priority</dt>
                <dd>{c.priority}</dd>
                <dt>Sentiment</dt>
                <dd>{c.sentiment}</dd>
                <dt>Language</dt>
                <dd>{c.language}</dd>
                <dt>Confidence</dt>
                <dd>{Math.round(c.confidence * 100)}%</dd>
                <dt>Summary</dt>
                <dd>{c.summary}</dd>
                <dt>Rationale</dt>
                <dd class="muted">{c.rationale}</dd>
              </dl>
            ) : (
              <p class="muted">{busy ? 'Classifying...' : 'No classification.'}</p>
            )}
          </Card>
        </div>

        <div class="col">
          <ReviewPanel d={d} reviewer={reviewer} error={error} />

          <Card title="Playbook sources">
            {d.citedDocs.length ? (
              d.citedDocs.map((doc) => (
                <details class="source">
                  <summary>
                    {doc.title} <span class="muted small">{doc.id}</span>
                  </summary>
                  <pre class="doc">{doc.body}</pre>
                </details>
              ))
            ) : (
              <p class="muted">{draft ? 'Draft cites no playbook articles.' : 'No draft.'}</p>
            )}
            {draft?.droppedCitations.length ? (
              <p class="error small">Removed citations not in the retrieved set: {draft.droppedCitations.join(', ')}</p>
            ) : null}
            {draft ? (
              <p class="muted small">
                Grounded: {draft.grounded ? 'yes' : 'no'}. Draft confidence {Math.round(draft.confidence * 100)}%.
              </p>
            ) : null}
          </Card>

          <Card title="Model calls">
            {d.aiCalls.length ? (
              <>
                <table class="table compact">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Model</th>
                      <th>Status</th>
                      <th>Tokens in/out</th>
                      <th>Latency</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.aiCalls.map((x) => (
                      <tr>
                        <td>
                          {x.purpose}
                          {x.attempt > 1 ? <span class="muted"> (retry)</span> : null}
                        </td>
                        <td class="mono">{x.model}</td>
                        <td class={x.status === 'ok' ? '' : 'error'} title={x.error ?? ''}>
                          {x.status}
                        </td>
                        <td>
                          {x.inputTokens}/{x.outputTokens}
                        </td>
                        <td>{ms(x.latencyMs)}</td>
                        <td>{usd(x.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p class="muted small">
                  Total {ms(totalLatency)} model time, {usd(totalCost)}. Prompt versions:{' '}
                  {[c?.promptVersion, draft?.promptVersion].filter(Boolean).join(', ')}
                </p>
              </>
            ) : (
              <p class="muted">No model calls.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};
