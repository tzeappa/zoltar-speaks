import { BRIEF_SYSTEM, PROMPT_VERSIONS, briefUser } from '../ai/prompts.ts';
import { IncidentBriefOutput } from '../ai/schemas.ts';
import { callStructured } from '../ai/structured.ts';
import { aiEnabled, callContext, type AppContext } from '../context.ts';
import {
  addIncidentEvent,
  affectedClients,
  enqueueJob,
  getIncident,
  incidentEvents,
  incidentTickets,
  listClients,
  setIncidentBrief,
} from '../db/repo.ts';
import { BRIEF_REFRESH_EVERY, plural } from '../domain.ts';
import { clientTokens, pseudonymize } from './redact.ts';

const MAX_REPORTS = 12;
const MAX_REPORT_CHARS = 800;

/**
 * Generates and stores the brief. The stored brief stays pseudonymized because its summary and macro are reused in
 * later draft prompts; views rehydrate it for display.
 */
export async function generateIncidentBrief(ctx: AppContext, incidentId: number): Promise<void> {
  const inc = getIncident(ctx.db, incidentId);
  if (!inc) throw new Error(`Incident ${incidentId} not found`);
  // Jobs queued before the kill switch was flipped must not call the model.
  if (!aiEnabled(ctx)) {
    setIncidentBrief(ctx.db, incidentId, inc.brief ? 'ready' : 'none', inc.brief);
    return;
  }

  const clients = listClients(ctx.db);
  const tokens = clientTokens(clients);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  const linked = incidentTickets(ctx.db, incidentId);
  // The brief's client message goes out verbatim to every affected client, so text that tried to steer the model
  // stays out of it. Those tickets are still linked and counted; they are escalated for a person on their own.
  const tickets = linked
    .filter((t) => !t.routeReasons.includes('prompt_injection_suspected'))
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .slice(0, MAX_REPORTS);
  const reports = tickets.map((t) => ({
    token: tokens.get(t.clientId) ?? '[CLIENT_?]',
    tier: byId.get(t.clientId)?.tier ?? 'standard',
    at: iso(t.receivedAt),
    summary: pseudonymize(t.summary ?? '', clients).text,
    text: (t.redactedText ?? pseudonymize(`${t.subject}\n${t.body}`, clients).text).slice(0, MAX_REPORT_CHARS),
  }));

  const signals = incidentEvents(ctx.db, incidentId)
    .filter((e) => e.source === 'monitor')
    .map((e) => ({ at: iso(e.createdAt), message: e.message }));

  const affectedByTier: Record<string, number> = {};
  for (const a of affectedClients(ctx.db, inc)) affectedByTier[a.client.tier] = (affectedByTier[a.client.tier] ?? 0) + 1;

  const query = `${inc.platform} ${inc.category} ${reports.map((r) => r.summary).join(' ')} ${signals.map((s) => s.message).join(' ')}`;
  const runbooks = (await ctx.kb.search(query, { type: 'runbook', limit: 2 })).map((h) => h.doc);

  setIncidentBrief(ctx.db, incidentId, 'pending', inc.brief);
  const res = await callStructured(callContext(ctx, { incidentId }), {
    purpose: 'incident_brief',
    model: ctx.config.modelSmart,
    promptVersion: PROMPT_VERSIONS.incident_brief,
    system: BRIEF_SYSTEM,
    user: briefUser({ platform: inc.platform, category: inc.category, signals, affectedByTier, reports, runbooks }),
    schema: IncidentBriefOutput,
    maxTokens: 6000,
  });

  const validRunbooks = new Set(runbooks.map((r) => r.id));
  const brief = {
    ...res.data,
    next_steps: res.data.next_steps.map((s) => ({
      ...s,
      runbook_id: s.runbook_id && validRunbooks.has(s.runbook_id) ? s.runbook_id : null,
    })),
  };
  setIncidentBrief(ctx.db, incidentId, 'ready', brief, brief.title);
  addIncidentEvent(ctx.db, {
    incidentId,
    source: 'ai',
    message: `Brief generated (${brief.severity}) from ${plural(reports.length, 'report')} and ${plural(signals.length, 'monitor signal')}`,
    createdAt: ctx.now(),
  });

  // Reports linked while the model was writing do not queue a refresh of their own (one is already pending).
  const before = linked.length;
  const after = incidentTickets(ctx.db, incidentId).length;
  const missed = (before === 0 && after > 0) || Math.floor(after / BRIEF_REFRESH_EVERY) > Math.floor(before / BRIEF_REFRESH_EVERY);
  if (missed && getIncident(ctx.db, incidentId)?.status !== 'resolved') {
    setIncidentBrief(ctx.db, incidentId, 'pending', brief, brief.title);
    enqueueJob(ctx.db, 'incident_brief', incidentId, ctx.now());
    addIncidentEvent(ctx.db, {
      incidentId,
      source: 'ai',
      message: `Brief refresh queued (${plural(after - before, 'client report')} arrived while it was written)`,
      createdAt: ctx.now(),
    });
  }
}
