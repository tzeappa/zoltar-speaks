import { TokenBudget } from '../ai/structured.ts';
import { AiError } from '../ai/types.ts';
import { aiEnabled, callContext, type AppContext } from '../context.ts';
import {
  getClassification,
  getClient,
  getDraft,
  getIncident,
  getTicket,
  listClients,
  saveClassification,
  saveDraft,
  saveRedaction,
  saveRoute,
  setPipelineStatus,
  unlinkTicketFromIncident,
  type Classification,
} from '../db/repo.ts';
import { classifyTicket } from './classify.ts';
import { draftReply } from './draft.ts';
import { decide, findRiskKeywords } from './gate.ts';
import { incidentNoteFor, onTicketClassified } from './incidents.ts';
import { clientTokens, detectPromptInjection, neutralizePromptTags, pseudonymize, rehydrate, type PiiKind } from './redact.ts';

/**
 * Computes the route from whatever is stored for the ticket. Used after a normal run, after a partial failure, and by
 * the worker when retries are exhausted, so every path goes through the same gate.
 */
export function finalizeRoute(ctx: AppContext, ticketId: number, aiFailure: string | null): void {
  const ticket = getTicket(ctx.db, ticketId);
  if (!ticket) return;
  const client = getClient(ctx.db, ticket.clientId);
  const raw = `${ticket.subject}\n${ticket.body}`;
  const classification = getClassification(ctx.db, ticketId) ?? null;
  const draft = getDraft(ctx.db, ticketId) ?? null;

  const decision = decide({
    classification,
    tier: client?.tier ?? 'standard',
    draft,
    piiKinds: ticket.piiKinds as PiiKind[],
    injectionSuspected: detectPromptInjection(raw),
    riskKeywords: findRiskKeywords(raw),
    aiFailure,
    confidenceThreshold: ctx.config.confidenceThreshold,
  });

  saveRoute(ctx.db, ticketId, {
    route: decision.route,
    reasons: decision.reasons,
    effectivePriority: decision.effectivePriority,
    status: aiFailure && !classification ? 'failed' : 'done',
    at: ctx.now(),
  });
  ctx.log.info(
    { ticket_id: ticketId, route: decision.route, priority: decision.effectivePriority, reasons: decision.reasons },
    'ticket_routed',
  );
}

function failureCode(step: string, err: unknown): string {
  return `${step}:${err instanceof AiError ? err.kind : 'error'}`;
}

/**
 * Transient AI errors are rethrown so the worker retries the job. Completed steps are not repeated on retry.
 */
export async function triageTicket(ctx: AppContext, ticketId: number): Promise<void> {
  const ticket = getTicket(ctx.db, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  const client = getClient(ctx.db, ticket.clientId);
  if (!client) throw new Error(`Client ${ticket.clientId} not found`);
  const clients = listClients(ctx.db);
  const token = clientTokens(clients).get(client.id)!;

  setPipelineStatus(ctx.db, ticketId, 'processing');
  const p = pseudonymize(neutralizePromptTags(`Subject: ${ticket.subject}\n\n${ticket.body}`), clients);
  saveRedaction(ctx.db, ticketId, p.text, p.piiKinds);

  if (!aiEnabled(ctx)) return finalizeRoute(ctx, ticketId, 'ai_disabled');

  const call = callContext(ctx, { ticketId, budget: new TokenBudget(ctx.config.ticketTokenBudget) });
  const promptClient = { kind: client.kind, industry: client.industry };

  let classification: Classification | undefined = getClassification(ctx.db, ticketId);
  if (!classification) {
    try {
      const res = await classifyTicket(call, ctx.config.modelFast, {
        clientToken: token,
        client: promptClient,
        channel: ticket.channel,
        text: p.text,
      });
      classification = {
        ...res.classification,
        summary: rehydrate(res.classification.summary, p.map),
        rationale: rehydrate(res.classification.rationale, p.map),
      };
      saveClassification(ctx.db, ticketId, classification, {
        model: res.model,
        promptVersion: res.promptVersion,
        at: ctx.now(),
      });
    } catch (err) {
      if (err instanceof AiError && err.kind === 'transient') throw err;
      ctx.log.warn({ ticket_id: ticketId, err: String(err) }, 'classify_failed');
      return finalizeRoute(ctx, ticketId, failureCode('classify', err));
    }
  }

  let current = getTicket(ctx.db, ticketId)!;
  // After a re-triage the ticket may now belong to a different platform or category than its incident.
  const linked = current.incidentId ? getIncident(ctx.db, current.incidentId) : undefined;
  if (linked && (linked.platform !== classification.platform || linked.category !== classification.category)) {
    unlinkTicketFromIncident(ctx.db, ticketId);
    current = getTicket(ctx.db, ticketId)!;
  }
  const incidentId = current.incidentId ?? onTicketClassified(ctx, current, classification);

  if (!getDraft(ctx.db, ticketId)) {
    // Stored summaries are rehydrated for display; pseudonymize again before they go back to the model.
    const summary = pseudonymize(classification.summary, clients).text;
    const docs = (
      await ctx.kb.search(`${summary} ${classification.category} ${classification.platform} ${p.text}`, { type: 'article', limit: 3 })
    ).map((h) => h.doc);
    try {
      const d = await draftReply(call, ctx.config.modelSmart, {
        clientToken: token,
        client: promptClient,
        text: p.text,
        summary,
        category: classification.category,
        platform: classification.platform,
        docs,
        incidentNote: incidentNoteFor(ctx, incidentId, token),
      });
      saveDraft(ctx.db, {
        ticketId,
        body: rehydrate(d.body, p.map),
        citations: d.citations,
        droppedCitations: d.droppedCitations,
        grounded: d.grounded,
        confidence: d.confidence,
        missingInfo: d.missingInfo.map((m) => rehydrate(m, p.map)),
        internalNote: rehydrate(d.internalNote, p.map),
        model: d.model,
        promptVersion: d.promptVersion,
        createdAt: ctx.now(),
      });
    } catch (err) {
      if (err instanceof AiError && err.kind === 'transient') throw err;
      ctx.log.warn({ ticket_id: ticketId, err: String(err) }, 'draft_failed');
      return finalizeRoute(ctx, ticketId, failureCode('draft', err));
    }
  }

  finalizeRoute(ctx, ticketId, null);
}
