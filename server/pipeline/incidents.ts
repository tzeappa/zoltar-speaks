import type { AppContext } from '../context.ts';
import { aiEnabled } from '../context.ts';
import { transaction } from '../db/index.ts';
import {
  addIncidentEvent,
  addIncidentSource,
  clusterCandidates,
  createIncident,
  enqueueJob,
  findActiveIncident,
  getIncident,
  incidentEvents,
  linkTicketsToIncident,
  setIncidentBrief,
  type Classification,
  type Incident,
  type IncidentSource,
  type Ticket,
} from '../db/repo.ts';
import { BRIEF_REFRESH_EVERY, plural, type Category, type Platform } from '../domain.ts';
import type { IncidentBriefOutput } from '../ai/schemas.ts';

export const CLUSTERABLE_CATEGORIES: Category[] = [
  'Publishing & Scheduling',
  'Analytics & Reporting',
  'Account & Access',
  'Community & Comments',
];

const NON_PLATFORM: Platform[] = ['Other', 'None'];

export interface ClusterThresholds {
  minTickets: number;
  minClients: number;
  watchMinTickets: number;
}

interface Clusterable {
  clientId: string;
  receivedAt: number;
}

export type ClusterVerdict<T> = { kind: 'platform' | 'client_watch'; members: T[] } | null;

/**
 * Many clients with the same problem is a platform incident. One client repeating themselves is a client watch.
 * Checks every window of `windowMs` that contains the current ticket, so arrival order does not matter.
 * `tickets` are unlinked tickets with the same platform and category, sorted by time, including the current one.
 */
export function evaluateCluster<T extends Clusterable>(
  tickets: T[],
  current: Clusterable,
  windowMs: number,
  t: ClusterThresholds,
  platformEligible: boolean,
): ClusterVerdict<T> {
  let watch: T[] | null = null;
  for (const start of tickets) {
    if (start.receivedAt < current.receivedAt - windowMs || start.receivedAt > current.receivedAt) continue;
    const members = tickets.filter((x) => x.receivedAt >= start.receivedAt && x.receivedAt <= start.receivedAt + windowMs);
    const clients = new Set(members.map((x) => x.clientId));
    if (platformEligible && members.length >= t.minTickets && clients.size >= t.minClients) return { kind: 'platform', members };
    const own = members.filter((x) => x.clientId === current.clientId);
    if (own.length >= t.watchMinTickets && own.length > (watch?.length ?? 0)) watch = own;
  }
  return watch ? { kind: 'client_watch', members: watch } : null;
}

export function openPlatformIncident(
  ctx: AppContext,
  i: { platform: Platform; category: Category; source: IncidentSource; title: string; message: string },
): number {
  const now = ctx.now();
  const withBrief = aiEnabled(ctx);
  const id = createIncident(ctx.db, {
    kind: 'platform',
    platform: i.platform,
    category: i.category,
    clientId: null,
    title: i.title,
    briefStatus: withBrief ? 'pending' : 'none',
    source: i.source,
    at: now,
  });
  addIncidentEvent(ctx.db, { incidentId: id, source: i.source, message: i.message, createdAt: now });
  if (withBrief) enqueueJob(ctx.db, 'incident_brief', id, now);
  ctx.log.warn({ incident_id: id, platform: i.platform, category: i.category, source: i.source }, 'incident_opened');
  return id;
}


function linkTicket(ctx: AppContext, incident: Incident, ticket: Ticket, now: number): void {
  linkTicketsToIncident(ctx.db, [ticket.id], incident.id);
  const firstReport = addIncidentSource(ctx.db, incident.id, 'tickets');
  addIncidentEvent(ctx.db, {
    incidentId: incident.id,
    source: 'tickets',
    message: firstReport ? `First client report linked (ticket #${ticket.id})` : `Ticket #${ticket.id} linked`,
    createdAt: now,
  });

  // A brief written before client reports arrived (monitor-first) goes stale as reports come in.
  const count = incident.ticketCount + 1;
  const due = firstReport || count % BRIEF_REFRESH_EVERY === 0;
  if (incident.kind === 'platform' && due && incident.briefStatus !== 'pending' && aiEnabled(ctx)) {
    setIncidentBrief(ctx.db, incident.id, 'pending', incident.brief);
    enqueueJob(ctx.db, 'incident_brief', incident.id, now);
    addIncidentEvent(ctx.db, {
      incidentId: incident.id,
      source: 'ai',
      message: `Brief refresh queued (${plural(count, 'client report')})`,
      createdAt: now,
    });
  }
}

/** Runs after a ticket is classified. Returns the incident the ticket ended up in, if any. */
export function onTicketClassified(ctx: AppContext, ticket: Ticket, cls: Classification): number | null {
  if (!CLUSTERABLE_CATEGORIES.includes(cls.category)) return null;
  const { config } = ctx;

  return transaction(ctx.db, () => {
    const now = ctx.now();
    const platformEligible = !NON_PLATFORM.includes(cls.platform);

    if (platformEligible) {
      const active = findActiveIncident(ctx.db, { kind: 'platform', platform: cls.platform, category: cls.category });
      if (active) {
        linkTicket(ctx, active, ticket, now);
        return active.id;
      }
    }

    const watch = findActiveIncident(ctx.db, {
      kind: 'client_watch',
      platform: cls.platform,
      category: cls.category,
      clientId: ticket.clientId,
    });

    const windowMs = config.incidentWindowMinutes * 60_000;
    const candidates = clusterCandidates(
      ctx.db,
      cls.platform,
      cls.category,
      ticket.receivedAt - windowMs,
      ticket.receivedAt + windowMs,
    ).filter((c) => c.incidentId === null || c.incidentId === watch?.id);
    const verdict = evaluateCluster(
      candidates,
      ticket,
      windowMs,
      {
        minTickets: config.incidentMinTickets,
        minClients: config.incidentMinClients,
        watchMinTickets: config.clientWatchMinTickets,
      },
      platformEligible,
    );

    if (verdict?.kind === 'platform') {
      const clientCount = new Set(verdict.members.map((c) => c.clientId)).size;
      const id = openPlatformIncident(ctx, {
        platform: cls.platform,
        category: cls.category,
        source: 'tickets',
        title: `${cls.platform}: ${cls.category} reports from ${clientCount} clients`,
        message: `Opened from ${verdict.members.length} reports across ${clientCount} clients within ${config.incidentWindowMinutes} min`,
      });
      linkTicketsToIncident(
        ctx.db,
        verdict.members.map((c) => c.ticketId),
        id,
      );
      return id;
    }

    if (watch) {
      linkTicket(ctx, watch, ticket, now);
      return watch.id;
    }

    if (verdict?.kind === 'client_watch') {
      const own = verdict.members;
      const id = createIncident(ctx.db, {
        kind: 'client_watch',
        platform: cls.platform,
        category: cls.category,
        clientId: ticket.clientId,
        title: `Client watch: ${own.length} ${cls.category} requests on ${cls.platform}`,
        briefStatus: 'none',
        source: 'tickets',
        at: now,
      });
      linkTicketsToIncident(
        ctx.db,
        own.map((c) => c.ticketId),
        id,
      );
      addIncidentEvent(ctx.db, {
        incidentId: id,
        source: 'tickets',
        message: `${own.length} requests from one client in ${config.incidentWindowMinutes} min`,
        createdAt: now,
      });
      ctx.log.info({ incident_id: id, client_id: ticket.clientId }, 'client_watch_opened');
      return id;
    }

    return null;
  });
}

/** Known-issue context for drafts of tickets linked to an open platform incident. */
export function incidentNoteFor(ctx: AppContext, incidentId: number | null, clientToken: string): string | null {
  if (incidentId === null) return null;
  const inc = getIncident(ctx.db, incidentId);
  if (!inc || inc.kind !== 'platform' || inc.status === 'resolved') return null;

  if (inc.briefStatus === 'ready' && inc.brief) {
    const brief = inc.brief as IncidentBriefOutput;
    return `Known issue: ${brief.summary}\nApproved client message:\n${brief.client_comms_macro.replaceAll('{{client}}', clientToken)}`;
  }
  const monitorEvent = [...incidentEvents(ctx.db, inc.id)].reverse().find((e) => e.source === 'monitor');
  const detail = monitorEvent ? ` Monitoring: ${monitorEvent.message}.` : '';
  return `Known issue: Social Ops is investigating ${inc.category.toLowerCase()} problems on ${inc.platform} affecting several clients.${detail} No cause or ETA confirmed yet.`;
}
