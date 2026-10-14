import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { aiEnabled, type AppContext } from './context.ts';
import {
  addIncidentEvent,
  affectedClients,
  enqueueJob,
  getClient,
  getDraft,
  getIncident,
  getTicket,
  insertReview,
  insertTicketWithJob,
  markClientNotified,
  resetTicketForRetriage,
  setIncidentBrief,
  setIncidentStatus,
  setSetting,
  type Ticket,
} from './db/repo.ts';
import { COMPONENTS, MONITORED_PLATFORMS, type PlatformStatus } from './domain.ts';
import { setSimulatedStatus } from './monitor/sources.ts';
import { allClearRecipients, outageRecipients, sendNotices, type SendSummary } from './notify/send.ts';
import { insertSpike } from './seed/index.ts';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 415,
    message: string,
  ) {
    super(message);
  }
}

export interface Services {
  ingest(input: unknown): { ticket: Ticket; created: boolean };
  review(ticketId: number, input: unknown): void;
  retriage(ticketId: number): void;
  setIncidentStatus(id: number, status: 'acknowledged' | 'resolved', by: string): void;
  regenerateBrief(id: number, by: string): void;
  notifyClient(incidentId: number, clientId: string, by: string): void;
  /** Sends the outage notice to every affected client not yet notified. */
  notifyAffected(incidentId: number, input: unknown, by: string): Promise<SendSummary>;
  /** Resolves the incident (if still open) and sends the all-clear to everyone who heard about the outage. */
  resolveAndNotify(incidentId: number, input: unknown, by: string): Promise<SendSummary>;
  setAiEnabled(enabled: boolean, by: string): void;
  simulateStatus(input: unknown): void;
  simulateSpike(): number[];
}

export const IngestBody = z.object({
  external_id: z.string().min(1).max(200).optional(),
  client_id: z.string().min(1),
  channel: z.enum(['email', 'portal']).default('email'),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  received_at: z.number().int().positive().optional(),
});

export const ReviewBody = z.object({
  action: z.enum(['approve', 'reject']),
  body: z.string().max(10_000).optional(),
  note: z.string().max(1000).optional(),
  reviewer: z.string().min(1).max(100).default('coordinator'),
});

export const NoticeBody = z.object({
  subject: z
    .string()
    .trim()
    .min(1, 'Subject is empty')
    .max(200)
    .refine((s) => !/[\r\n]/.test(s), 'Subject must be one line'),
  body: z
    .string()
    .trim()
    .min(1, 'Message is empty')
    .max(5000)
    .refine((s) => !/\{\{(?!(client|coordinator)\}\})/.test(s), 'Unknown placeholder; only {{client}} and {{coordinator}} are filled in'),
  /** Client ids the sender was shown, comma separated. When given, the send is refused if the list has changed since. */
  expected_recipients: z.string().max(5000).optional(),
});

function checkRecipients(expected: string | undefined, actual: { id: string; name: string }[]): void {
  if (expected === undefined) return;
  const want = new Set(expected.split(',').filter(Boolean));
  if (want.size === actual.length && actual.every((c) => want.has(c.id))) return;
  const names = actual.map((c) => c.name).join(', ') || 'nobody';
  throw new HttpError(409, `The recipients changed since the form was opened (now: ${names}). Check and send again`);
}

const SimulateBody = z.object({
  platform: z.enum(MONITORED_PLATFORMS),
  component: z.enum(COMPONENTS),
  status: z.enum(['operational', 'degraded', 'outage', 'unknown']),
  detail: z.string().max(300).optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const res = schema.safeParse(input);
  if (!res.success) throw new HttpError(400, z.prettifyError(res.error));
  return res.data;
}

/** Word-level Levenshtein distance. Words match how reviewers think about edits and keep the cost low. */
export function wordEditDistance(a: string, b: string): number {
  const x = a.trim().split(/\s+/).filter(Boolean);
  const y = b.trim().split(/\s+/).filter(Boolean);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();

export function createServices(ctx: AppContext, hooks: { onNewWork: () => void; runMonitor: () => void }): Services {
  const { db } = ctx;

  const requireTicket = (id: number) => {
    const t = getTicket(db, id);
    if (!t) throw new HttpError(404, `Ticket ${id} not found`);
    return t;
  };
  const requireIncident = (id: number) => {
    const i = getIncident(db, id);
    if (!i) throw new HttpError(404, `Incident ${id} not found`);
    return i;
  };

  return {
    ingest(input) {
      const b = parse(IngestBody, input);
      if (!getClient(db, b.client_id)) throw new HttpError(400, `Unknown client_id ${b.client_id}`);
      const now = ctx.now();
      const res = insertTicketWithJob(
        db,
        {
          externalId: b.external_id ?? `api-${randomUUID()}`,
          clientId: b.client_id,
          channel: b.channel,
          subject: b.subject,
          body: b.body,
          receivedAt: b.received_at ?? now,
        },
        now,
      );
      ctx.log.info({ ticket_id: res.ticket.id, created: res.created }, 'ticket_ingested');
      if (res.created) hooks.onNewWork();
      return res;
    },

    review(ticketId, input) {
      const t = requireTicket(ticketId);
      if (t.reviewStatus !== 'pending') throw new HttpError(409, 'Ticket already reviewed');
      if (t.pipelineStatus === 'queued' || t.pipelineStatus === 'processing') {
        throw new HttpError(409, 'Ticket is still being triaged');
      }
      const b = parse(ReviewBody, input);
      const draft = getDraft(db, ticketId);
      const now = ctx.now();

      if (b.action === 'reject') {
        insertReview(db, { ticketId, action: 'rejected', finalBody: null, editDistance: null, reviewer: b.reviewer, note: b.note ?? null, createdAt: now });
      } else {
        const finalBody = normalize(b.body ?? draft?.body ?? '');
        if (!finalBody) throw new HttpError(400, 'Reply body is empty');
        const unchanged = !!draft && finalBody === normalize(draft.body);
        insertReview(db, {
          ticketId,
          action: unchanged ? 'approved' : 'edited',
          finalBody,
          editDistance: draft ? wordEditDistance(draft.body, finalBody) : null,
          reviewer: b.reviewer,
          note: b.note ?? null,
          createdAt: now,
        });
      }
      ctx.log.info({ ticket_id: ticketId, action: b.action, reviewer: b.reviewer }, 'ticket_reviewed');
    },

    retriage(ticketId) {
      const t = requireTicket(ticketId);
      if (t.pipelineStatus === 'queued' || t.pipelineStatus === 'processing') {
        throw new HttpError(409, 'Ticket is still being triaged');
      }
      // Re-triage resets the review; on an answered ticket that would put it back in the queue for a second reply.
      if (t.reviewStatus !== 'pending') throw new HttpError(409, `Already ${t.reviewStatus}; re-triage is only for unanswered requests`);
      resetTicketForRetriage(db, ticketId, ctx.now());
      hooks.onNewWork();
    },

    setIncidentStatus(id, status, by) {
      const inc = requireIncident(id);
      if (inc.status === 'resolved') throw new HttpError(409, 'Incident already resolved');
      if (status === 'acknowledged' && inc.status === 'acknowledged') return;
      const now = ctx.now();
      setIncidentStatus(db, id, status, now);
      addIncidentEvent(db, { incidentId: id, source: 'human', message: `${status === 'acknowledged' ? 'Acknowledged' : 'Resolved'} by ${by}`, createdAt: now });
      ctx.log.info({ incident_id: id, status, by }, 'incident_status');
    },

    regenerateBrief(id, by) {
      const inc = requireIncident(id);
      if (inc.kind !== 'platform') throw new HttpError(400, 'Only platform incidents have briefs');
      if (inc.briefStatus === 'pending') return;
      if (!aiEnabled(ctx)) throw new HttpError(409, 'AI is off, so no brief can be generated. Turn it on in Ops first.');
      const now = ctx.now();
      setIncidentBrief(db, id, 'pending', inc.brief);
      enqueueJob(db, 'incident_brief', id, now);
      addIncidentEvent(db, { incidentId: id, source: 'human', message: `Brief regeneration requested by ${by}`, createdAt: now });
      hooks.onNewWork();
    },

    notifyClient(incidentId, clientId, by) {
      const inc = requireIncident(incidentId);
      const client = getClient(db, clientId);
      if (!client) throw new HttpError(400, `Unknown client ${clientId}`);
      if (!affectedClients(db, inc).some((a) => a.client.id === clientId)) {
        throw new HttpError(400, `${client.name} is not affected by this incident`);
      }
      const now = ctx.now();
      if (markClientNotified(db, incidentId, clientId, by, now)) {
        addIncidentEvent(db, { incidentId, source: 'human', message: `${client.name} notified by ${by}`, createdAt: now });
      }
    },

    async notifyAffected(incidentId, input, by) {
      const inc = requireIncident(incidentId);
      if (inc.kind !== 'platform') throw new HttpError(400, 'Notices are only sent for platform incidents');
      if (inc.status === 'resolved') throw new HttpError(409, 'Incident is resolved; send the all-clear instead');
      const draft = parse(NoticeBody, input);
      const recipients = outageRecipients(ctx, inc);
      if (!recipients.send.length && !recipients.noEmail.length) throw new HttpError(409, 'Every affected client has already been notified');
      checkRecipients(draft.expected_recipients, recipients.send);
      return sendNotices(ctx, inc, 'outage', recipients, draft, by);
    },

    async resolveAndNotify(incidentId, input, by) {
      const inc = requireIncident(incidentId);
      if (inc.kind !== 'platform') throw new HttpError(400, 'Notices are only sent for platform incidents');
      const draft = parse(NoticeBody, input);
      const recipients = allClearRecipients(ctx, inc);
      checkRecipients(draft.expected_recipients, recipients.send);
      if (inc.status !== 'resolved') {
        const now = ctx.now();
        setIncidentStatus(db, incidentId, 'resolved', now);
        addIncidentEvent(db, { incidentId, source: 'human', message: `Resolved by ${by}`, createdAt: now });
        ctx.log.info({ incident_id: incidentId, status: 'resolved', by }, 'incident_status');
      }
      return sendNotices(ctx, getIncident(db, incidentId)!, 'all_clear', recipients, draft, by);
    },

    setAiEnabled(enabled, by) {
      setSetting(db, 'ai_enabled', enabled ? 'true' : 'false');
      ctx.log.warn({ enabled, by }, 'ai_kill_switch');
    },

    simulateStatus(input) {
      const b = parse(SimulateBody, input);
      setSimulatedStatus(db, b.platform, b.component, b.status as PlatformStatus, b.detail ?? '');
      ctx.log.info(b, 'simulated_status_set');
      hooks.runMonitor();
    },

    simulateSpike() {
      const ids = insertSpike(db, ctx.now());
      ctx.log.info({ ticket_ids: ids }, 'spike_simulated');
      hooks.onNewWork();
      return ids;
    },
  };
}
