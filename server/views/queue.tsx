import type { FC } from 'hono/jsx';
import type { TicketListItem } from '../db/repo.ts';
import { priorityRank } from '../domain.ts';
import { Chip, PriorityBadge, TierBadge, live, reasonLabel, timeAgo } from './ui.tsx';

export const QUEUE_FILTERS = {
  needs_review: 'Needs human',
  suggested: 'Draft ready',
  processing: 'Processing',
  done: 'Done',
} as const;
export type QueueFilter = keyof typeof QUEUE_FILTERS;

export function filterTickets(all: TicketListItem[], filter: QueueFilter): TicketListItem[] {
  const pending = (t: TicketListItem) => t.reviewStatus === 'pending' && t.pipelineStatus !== 'queued' && t.pipelineStatus !== 'processing';
  const pick: Record<QueueFilter, (t: TicketListItem) => boolean> = {
    needs_review: (t) => pending(t) && t.route === 'escalate',
    suggested: (t) => pending(t) && t.route === 'suggest',
    processing: (t) => t.pipelineStatus === 'queued' || t.pipelineStatus === 'processing',
    done: (t) => t.reviewStatus !== 'pending',
  };
  const rows = all.filter(pick[filter]);
  if (filter === 'done') return rows;
  // Highest effective priority first, then oldest first within a priority.
  return rows.sort(
    (a, b) =>
      priorityRank(a.effectivePriority ?? 'P4') - priorityRank(b.effectivePriority ?? 'P4') || a.receivedAt - b.receivedAt,
  );
}

const REVIEW_LABEL = { approved: 'Approved', edited: 'Edited and sent', rejected: 'Rejected', pending: '' } as const;

const Row: FC<{ t: TicketListItem; now: number }> = ({ t, now }) => (
  <a class="row" href={`/tickets/${t.id}`} data-row={String(t.id)}>
    <div class="row-prio">
      <PriorityBadge p={t.effectivePriority} />
    </div>
    <div class="row-main">
      <div class="row-title">
        <strong>{t.clientName}</strong>
        <TierBadge tier={t.clientTier} />
        <span class="row-subject">{t.subject}</span>
      </div>
      <div class="row-meta">
        {t.category ? <Chip>{t.category}</Chip> : null}
        {t.platform && t.platform !== 'None' ? <Chip>{t.platform}</Chip> : null}
        {t.incidentId ? (
          <Chip tone={t.incidentKind === 'client_watch' ? 'reason' : 'incident'}>
            {t.incidentKind === 'client_watch' ? 'Client watch' : 'Platform incident'} #{t.incidentId}
          </Chip>
        ) : null}
        {t.reviewStatus !== 'pending' ? <Chip tone="done">{REVIEW_LABEL[t.reviewStatus]}</Chip> : null}
        {t.routeReasons.slice(0, 3).map((r) => (
          <Chip tone="reason">{reasonLabel(r)}</Chip>
        ))}
        {t.routeReasons.length > 3 ? <span class="more">+{t.routeReasons.length - 3}</span> : null}
        {t.pipelineStatus === 'processing' ? <Chip tone="processing">Triaging</Chip> : null}
        {t.pipelineStatus === 'queued' ? <Chip tone="processing">Queued</Chip> : null}
      </div>
      {t.summary ? <div class="row-summary">{t.summary}</div> : null}
    </div>
    <div class="row-age">{timeAgo(t.receivedAt, now)}</div>
  </a>
);

export const QueuePage: FC<{ all: TicketListItem[]; filter: QueueFilter; now: number }> = ({ all, filter, now }) => {
  const rows = filterTickets(all, filter);
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Client requests</h1>
          <p class="sub">Every reply is reviewed by a coordinator. Keys: j/k move, Enter open.</p>
        </div>
        <form method="post" action="/simulate/spike">
          <button class="btn secondary" type="submit">
            Simulate ticket spike
          </button>
        </form>
      </div>
      <div {...live('queue', `/queue?filter=${filter}`, 'tickets incidents')}>
        <nav class="tabs">
          {(Object.keys(QUEUE_FILTERS) as QueueFilter[]).map((f) => (
            <a href={`/queue?filter=${f}`} class={f === filter ? 'active' : ''}>
              {QUEUE_FILTERS[f]} <span class="count">{filterTickets(all, f).length}</span>
            </a>
          ))}
        </nav>
        <div class="list" data-list>
          {rows.length ? rows.map((t) => <Row t={t} now={now} />) : <p class="empty">Nothing here.</p>}
        </div>
      </div>
    </>
  );
};
