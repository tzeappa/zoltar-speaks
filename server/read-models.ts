import type { IncidentBriefOutput } from './ai/schemas.ts';
import type { AppContext } from './context.ts';
import {
  affectedClients,
  aiCallsFor,
  getClassification,
  getClient,
  getDraft,
  getIncident,
  getTicket,
  incidentEvents,
  incidentTickets,
  listClients,
  listIncidents,
  listOutbound,
  listReviews,
  type Incident,
} from './db/repo.ts';
import { allClearRecipients, outageRecipients } from './notify/send.ts';
import { allClearDraft, outageDraft } from './notify/templates.ts';
import { clientTokens, rehydrate } from './pipeline/redact.ts';

function tokenMap(ctx: AppContext): Record<string, string> {
  const clients = listClients(ctx.db);
  const tokens = clientTokens(clients);
  return Object.fromEntries(clients.map((c) => [tokens.get(c.id)!, c.name]));
}

function rehydrateDeep<T>(value: T, map: Record<string, string>): T {
  if (typeof value === 'string') return rehydrate(value, map) as T;
  if (Array.isArray(value)) return value.map((v) => rehydrateDeep(v, map)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rehydrateDeep(v, map)])) as T;
  }
  return value;
}

export type DisplayIncident = Omit<Incident, 'brief'> & { brief: IncidentBriefOutput | null };

function displayIncident(inc: Incident, map: Record<string, string>): DisplayIncident {
  return { ...inc, title: rehydrate(inc.title, map), brief: inc.brief ? rehydrateDeep(inc.brief as IncidentBriefOutput, map) : null };
}

export function ticketDetail(ctx: AppContext, id: number) {
  const ticket = getTicket(ctx.db, id);
  if (!ticket) return null;
  const client = getClient(ctx.db, ticket.clientId)!;
  const draft = getDraft(ctx.db, id) ?? null;
  const map = tokenMap(ctx);
  const rawIncident = ticket.incidentId ? getIncident(ctx.db, ticket.incidentId) : undefined;
  const incident = rawIncident ? displayIncident(rawIncident, map) : null;
  return {
    ticket,
    client,
    classification: getClassification(ctx.db, id) ?? null,
    draft,
    citedDocs: (draft?.citations ?? []).map((cid) => ctx.kb.get(cid)).filter((d) => d !== undefined),
    reviews: listReviews(ctx.db, id),
    aiCalls: aiCallsFor(ctx.db, { ticketId: id }),
    incident,
    incidentMacro: incident?.brief?.client_comms_macro.replaceAll('{{client}}', client.name) ?? null,
  };
}
export type TicketDetail = NonNullable<ReturnType<typeof ticketDetail>>;

export function incidentDetail(ctx: AppContext, id: number) {
  const raw = getIncident(ctx.db, id);
  if (!raw) return null;
  const map = tokenMap(ctx);
  const incident = displayIncident(raw, map);
  return {
    incident,
    client: raw.clientId ? (getClient(ctx.db, raw.clientId) ?? null) : null,
    events: incidentEvents(ctx.db, id).map((e) => ({ ...e, message: rehydrate(e.message, map) })),
    affected: affectedClients(ctx.db, raw),
    notices: {
      outage: { ...outageDraft(incident), recipients: outageRecipients(ctx, raw) },
      allClear: { ...allClearDraft(raw), recipients: allClearRecipients(ctx, raw) },
      messages: listOutbound(ctx.db, id),
    },
    tickets: incidentTickets(ctx.db, id),
    aiCalls: aiCallsFor(ctx.db, { incidentId: id }),
    runbooks: ((raw.brief as IncidentBriefOutput | null)?.next_steps ?? [])
      .map((s) => s.runbook_id)
      .filter((r): r is string => !!r)
      .filter((r, i, all) => all.indexOf(r) === i)
      .map((r) => ctx.kb.get(r))
      .filter((d) => d !== undefined),
  };
}
export type IncidentDetail = NonNullable<ReturnType<typeof incidentDetail>>;

export function incidentList(ctx: AppContext): DisplayIncident[] {
  const map = tokenMap(ctx);
  return listIncidents(ctx.db).map((i) => displayIncident(i, map));
}
