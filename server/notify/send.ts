import type { AppContext } from '../context.ts';
import {
  addIncidentEvent,
  affectedClients,
  claimOutbound,
  finishOutbound,
  listOutbound,
  markClientNotified,
  type Incident,
  type OutboundKind,
} from '../db/repo.ts';
import type { Client } from '../domain.ts';
import { personalize, type NoticeDraft } from './templates.ts';

export interface RecipientPlan {
  send: Client[];
  /** Would receive it but have no contact email; Ops contacts them another way. */
  noEmail: Client[];
}

const plan = (clients: Client[]): RecipientPlan => ({
  send: clients.filter((c) => c.contactEmail),
  noEmail: clients.filter((c) => !c.contactEmail),
});

const done = (ctx: AppContext, inc: Incident, kind: OutboundKind) =>
  new Set(
    listOutbound(ctx.db, inc.id)
      .filter((m) => m.kind === kind && m.status !== 'failed')
      .map((m) => m.clientId),
  );

/** Affected clients not told yet, whether by email or marked notified by hand. Failed sends are retried. */
export function outageRecipients(ctx: AppContext, inc: Incident): RecipientPlan {
  const sent = done(ctx, inc, 'outage');
  return plan(
    affectedClients(ctx.db, inc)
      .filter((a) => !a.notifiedAt && !sent.has(a.client.id))
      .map((a) => a.client),
  );
}

/** Everyone who heard about the outage, from us or by reporting it, and has not had the all-clear. */
export function allClearRecipients(ctx: AppContext, inc: Incident): RecipientPlan {
  const sent = done(ctx, inc, 'all_clear');
  return plan(
    affectedClients(ctx.db, inc)
      .filter((a) => (a.notifiedAt || a.reported) && !sent.has(a.client.id))
      .map((a) => a.client),
  );
}

export interface SendSummary {
  kind: OutboundKind;
  sent: string[];
  failed: { client: string; error: string }[];
  noEmail: string[];
}

const CONCURRENCY = 4;

export async function sendNotices(
  ctx: AppContext,
  inc: Incident,
  kind: OutboundKind,
  recipients: RecipientPlan,
  draft: NoticeDraft,
  by: string,
): Promise<SendSummary> {
  const summary: SendSummary = { kind, sent: [], failed: [], noEmail: recipients.noEmail.map((c) => c.name) };
  const queue = [...recipients.send];
  if (!queue.length && !summary.noEmail.length) return summary;

  const sendOne = async (client: Client) => {
    const subject = personalize(draft.subject, client);
    const body = personalize(draft.body, client);
    const id = claimOutbound(
      ctx.db,
      { incidentId: inc.id, clientId: client.id, kind, channel: ctx.notifier.channel, toAddress: client.contactEmail!, subject, body, sentBy: by },
      ctx.now(),
    );
    if (id === null) return; // already sent, or another request is sending it right now
    try {
      const res = await ctx.notifier.send({ to: client.contactEmail!, subject, body, incidentId: inc.id, clientId: client.id, kind });
      finishOutbound(ctx.db, id, res, ctx.now());
      if (kind === 'outage') markClientNotified(ctx.db, inc.id, client.id, by, ctx.now());
      summary.sent.push(client.name);
      ctx.log.info({ incident_id: inc.id, client_id: client.id, kind, channel: ctx.notifier.channel }, 'notice_sent');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      finishOutbound(ctx.db, id, { error }, ctx.now());
      summary.failed.push({ client: client.name, error });
      ctx.log.warn({ incident_id: inc.id, client_id: client.id, kind, channel: ctx.notifier.channel, err: error }, 'notice_failed');
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) await sendOne(c);
    }),
  );

  const label = kind === 'outage' ? 'Outage notice' : 'All-clear';
  const parts = [`${label} sent to ${summary.sent.length} client${summary.sent.length === 1 ? '' : 's'} by ${by} (${ctx.notifier.channel})`];
  if (summary.failed.length) parts.push(`${summary.failed.length} failed: ${summary.failed.map((f) => f.client).join(', ')}`);
  if (summary.noEmail.length) parts.push(`no email on file, contact directly: ${summary.noEmail.join(', ')}`);
  addIncidentEvent(ctx.db, { incidentId: inc.id, source: 'human', message: `${parts.join('. ')}.`, createdAt: ctx.now() });
  return summary;
}

export function summaryText(s: SendSummary): string {
  const label = s.kind === 'outage' ? 'Outage notice' : 'All-clear';
  const parts = [`${label} sent to ${s.sent.length} client${s.sent.length === 1 ? '' : 's'}`];
  if (s.failed.length) parts.push(`${s.failed.length} failed (retry them under Client notices)`);
  if (s.noEmail.length) parts.push(`${s.noEmail.length} without email: ${s.noEmail.join(', ')}`);
  return `${parts.join('. ')}.`;
}
