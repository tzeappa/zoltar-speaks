import { describe, expect, it } from 'vitest';
import { AiError } from '../server/ai/types.ts';
import {
  aiCallsFor,
  getClassification,
  getDraft,
  getIncident,
  getTicket,
  incidentEvents,
  insertTicketWithJob,
  listIncidents,
  setSetting,
} from '../server/db/repo.ts';
import { openPlatformIncident } from '../server/pipeline/incidents.ts';
import { Worker } from '../server/pipeline/worker.ts';
import { HttpError, createServices, wordEditDistance } from '../server/services.ts';
import { SPIKE_TICKETS } from '../server/seed/tickets.ts';
import { ScriptedClient, makeCtx, type TestCtx } from './helpers.ts';

let seq = 0;
function ingest(ctx: TestCtx, clientId: string, subject: string, body: string, minutesAgo = 0) {
  return insertTicketWithJob(
    ctx.db,
    { externalId: `t-${++seq}`, clientId, channel: 'email', subject, body, receivedAt: ctx.clock.now - minutesAgo * 60_000 },
    ctx.clock.now,
  ).ticket.id;
}

const ROUTINE = ['kingsley-motors', 'Weekly report question', 'The weekly report reach looks lower than the Instagram app. Which number is right?'] as const;

describe('triage pipeline', () => {
  it('classifies, drafts with valid citations, suggests, and traces every call', async () => {
    const model = new ScriptedClient();
    const ctx = makeCtx({ model });
    const id = ingest(ctx, ...ROUTINE);
    await new Worker(ctx).drain();

    const t = getTicket(ctx.db, id)!;
    expect(t).toMatchObject({ pipelineStatus: 'done', route: 'suggest', routeReasons: [] });
    expect(getClassification(ctx.db, id)!.category).toBe('Analytics & Reporting');
    // Platinum floor.
    expect(t.effectivePriority).toBe('P2');

    const draft = getDraft(ctx.db, id)!;
    expect(draft.citations.length).toBeGreaterThan(0);
    expect(draft.citations.every((c) => ctx.kb.get(c))).toBe(true);
    expect(draft.body).toContain('Kingsley Motors');

    const calls = aiCallsFor(ctx.db, { ticketId: id });
    expect(calls.map((c) => c.purpose)).toEqual(['classify', 'draft']);
    expect(calls.map((c) => c.model)).toEqual(['mock-fast', 'mock-smart']);
    expect(calls.every((c) => c.status === 'ok' && c.inputTokens > 0)).toBe(true);
  });

  it('never sends client names or raw PII to the model', async () => {
    const model = new ScriptedClient();
    const ctx = makeCtx({ model });
    ingest(ctx, 'halcyon-bank', 'New manager', 'Halcyon Bank here. Add Tom, tom@halcyon.example, +1 415 555 0134. Password: Halcyon2026!');
    await new Worker(ctx).drain();

    const prompts = model.requests.map((r) => JSON.stringify(r.messages)).join('\n');
    for (const leaked of ['Halcyon', 'tom@halcyon.example', '555 0134', 'Halcyon2026!']) expect(prompts).not.toContain(leaked);
    expect(prompts).toContain('[CLIENT_');
  });

  it('escalates sensitive requests even when the draft is fine', async () => {
    const ctx = makeCtx();
    const id = ingest(ctx, 'lumen-skincare', 'Wrong code', "Please take it down ASAP, yesterday's TikTok has the wrong discount code.");
    await new Worker(ctx).drain();
    const t = getTicket(ctx.db, id)!;
    expect(t.route).toBe('escalate');
    expect(t.routeReasons).toEqual(expect.arrayContaining(['action:takedown', 'priority:P1']));
    expect(getDraft(ctx.db, id)).toBeDefined();
  });

  it('repairs one invalid output and records both attempts', async () => {
    const model = new ScriptedClient({
      classify: (_req, n) => (n === 1 ? { toolInput: { category: 'Nonsense' }, toolUseId: 'tu_1', inputTokens: 10, outputTokens: 5 } : undefined),
    });
    const ctx = makeCtx({ model });
    const id = ingest(ctx, ...ROUTINE);
    await new Worker(ctx).drain();

    expect(getTicket(ctx.db, id)!.route).toBe('suggest');
    const classify = aiCallsFor(ctx.db, { ticketId: id }).filter((c) => c.purpose === 'classify');
    expect(classify.map((c) => c.status)).toEqual(['invalid_output', 'ok']);
    expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'tool_call', 'tool_error']);
  });

  it('escalates to manual triage after two invalid outputs, without retrying the job', async () => {
    const model = new ScriptedClient({ classify: () => ({ toolInput: {}, toolUseId: 'tu', inputTokens: 1, outputTokens: 1 }) });
    const ctx = makeCtx({ model });
    const id = ingest(ctx, ...ROUTINE);
    await new Worker(ctx).drain();

    const t = getTicket(ctx.db, id)!;
    expect(t).toMatchObject({ route: 'escalate', pipelineStatus: 'failed', routeReasons: ['ai_failed:classify:invalid_output'] });
    expect(aiCallsFor(ctx.db, { ticketId: id })).toHaveLength(2);
  });

  it('retries transient errors and keeps completed steps', async () => {
    const model = new ScriptedClient({
      draft: (_req, n) => {
        if (n === 1) throw new AiError('transient', '529 overloaded');
        return undefined;
      },
    });
    const ctx = makeCtx({ model });
    const id = ingest(ctx, ...ROUTINE);
    await new Worker(ctx).drain();

    expect(getTicket(ctx.db, id)!.route).toBe('suggest');
    const purposes = aiCallsFor(ctx.db, { ticketId: id }).map((c) => `${c.purpose}:${c.status}`);
    // Classification is not repeated on the retry.
    expect(purposes).toEqual(['classify:ok', 'draft:error', 'draft:ok']);
  });

  it('routes to manual triage when retries are exhausted', async () => {
    const model = new ScriptedClient({
      classify: () => {
        throw new AiError('transient', 'timeout');
      },
    });
    const ctx = makeCtx({ model, config: { jobMaxAttempts: 3 } });
    const id = ingest(ctx, 'juno-reyes', 'Help', 'My Instagram post failed.');
    await new Worker(ctx).drain();

    const t = getTicket(ctx.db, id)!;
    expect(t).toMatchObject({ route: 'escalate', pipelineStatus: 'failed', routeReasons: ['ai_failed:retries_exhausted'] });
    // Gold floor with no classification falls back to P2.
    expect(t.effectivePriority).toBe('P2');
    expect(model.requests).toHaveLength(3);
  });

  it('drops hallucinated citations and escalates the draft as ungrounded', async () => {
    const model = new ScriptedClient({
      draft: () => ({
        toolInput: { reply: 'Hi', citations: ['kb-made-up'], grounded: true, confidence: 0.95, missing_info: [], internal_note: '' },
        toolUseId: 'tu',
        inputTokens: 1,
        outputTokens: 1,
      }),
    });
    const ctx = makeCtx({ model });
    const id = ingest(ctx, ...ROUTINE);
    await new Worker(ctx).drain();

    expect(getDraft(ctx.db, id)).toMatchObject({ citations: [], droppedCitations: ['kb-made-up'], grounded: false });
    expect(getTicket(ctx.db, id)!.routeReasons).toContain('ungrounded_draft');
  });

  it('skips the model entirely when AI is switched off', async () => {
    const model = new ScriptedClient();
    const ctx = makeCtx({ model });
    setSetting(ctx.db, 'ai_enabled', 'false');
    const id = ingest(ctx, ...ROUTINE);
    await new Worker(ctx).drain();

    expect(model.requests).toHaveLength(0);
    expect(getTicket(ctx.db, id)).toMatchObject({ route: 'escalate', routeReasons: ['ai_failed:ai_disabled'] });
  });

  it('fails a job interrupted on its last attempt instead of requeuing it forever', () => {
    const ctx = makeCtx({ config: { jobMaxAttempts: 2 } });
    const id = ingest(ctx, ...ROUTINE);
    ctx.db.prepare(`UPDATE jobs SET status = 'running', attempts = 2 WHERE ref_id = ?`).run(id);
    const worker = new Worker(ctx);
    worker.start();
    void worker.stop();
    expect(ctx.db.prepare('SELECT status FROM jobs WHERE ref_id = ?').get(id)).toEqual({ status: 'failed' });
    expect(getTicket(ctx.db, id)).toMatchObject({ route: 'escalate', routeReasons: ['ai_failed:interrupted'] });
  });

  it('escalates when the per-ticket token budget runs out', async () => {
    const ctx = makeCtx({ config: { ticketTokenBudget: 50 } });
    const id = ingest(ctx, ...ROUTINE);
    await new Worker(ctx).drain();
    expect(getTicket(ctx.db, id)!.routeReasons).toEqual(['ai_failed:draft:budget']);
  });
});

describe('incidents from tickets', () => {
  it('opens a platform incident at 5 reports from 3+ clients and briefs it', async () => {
    const ctx = makeCtx();
    const worker = new Worker(ctx);
    SPIKE_TICKETS.forEach((t, i) => ingest(ctx, t.clientId, t.subject, t.body, SPIKE_TICKETS.length - i));
    await worker.drain();

    const [inc] = listIncidents(ctx.db);
    expect(inc).toMatchObject({ kind: 'platform', platform: 'Instagram', category: 'Publishing & Scheduling', ticketCount: 6, clientCount: 5 });
    expect(getIncident(ctx.db, inc!.id)!.briefStatus).toBe('ready');

    // The 6th ticket arrived after the incident opened, so its draft knows about the incident.
    const sixth = listTicketsIn(ctx, inc!.id).at(-1)!;
    expect(getDraft(ctx.db, sixth)!.body).toContain('aware of an issue');

    const brief = getIncident(ctx.db, inc!.id)!.brief as { client_comms_macro: string; summary: string };
    expect(brief.client_comms_macro).toContain('{{client}}');
    // Stored pseudonymized; never contains real names.
    expect(JSON.stringify(brief)).not.toMatch(/Kingsley|Aurora|Nova Kim/);
  });

  it('does not open a platform incident for one client, but opens a client watch', async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 4; i++) ingest(ctx, 'juno-reyes', 'Comments', 'Hostile comments under my Instagram reel again.', 30 - i);
    await new Worker(ctx).drain();
    const incidents = listIncidents(ctx.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ kind: 'client_watch', clientId: 'juno-reyes', ticketCount: 4, briefStatus: 'none' });
  });

  it('ignores reports outside the window', async () => {
    const ctx = makeCtx();
    const clients = ['aurora-vance', 'nova-kim', 'sable-stone', 'marco-bellini', 'kingsley-motors'];
    clients.forEach((c, i) => ingest(ctx, c, 'Post failed', 'My Instagram post failed to publish.', i * 30));
    await new Worker(ctx).drain();
    expect(listIncidents(ctx.db).filter((i) => i.kind === 'platform')).toHaveLength(0);
  });

  it('refreshes a monitor-first brief when client reports arrive', async () => {
    const ctx = makeCtx();
    const worker = new Worker(ctx);
    const id = openPlatformIncident(ctx, {
      platform: 'Instagram',
      category: 'Publishing & Scheduling',
      source: 'monitor',
      title: 'Instagram publishing outage',
      message: 'Instagram publishing outage: 503',
    });
    await worker.drain();
    ingest(ctx, 'aurora-vance', 'Post failed', 'My Instagram post failed to publish.');
    await worker.drain();

    const messages = incidentEvents(ctx.db, id).map((e) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining([expect.stringContaining('First client report linked'), expect.stringContaining('Brief refresh queued')]),
    );
    expect(aiCallsFor(ctx.db, { incidentId: id }).filter((c) => c.purpose === 'incident_brief')).toHaveLength(2);
    expect(getIncident(ctx.db, id)!.briefStatus).toBe('ready');
  });
});

function listTicketsIn(ctx: TestCtx, incidentId: number): number[] {
  return (ctx.db.prepare('SELECT id FROM tickets WHERE incident_id = ? ORDER BY id').all(incidentId) as { id: number }[]).map((r) => r.id);
}

describe('services', () => {
  const setup = () => {
    const ctx = makeCtx();
    const worker = new Worker(ctx);
    const services = createServices(ctx, { onNewWork: () => {}, runMonitor: () => {} });
    return { ctx, worker, services };
  };

  it('ingest is idempotent on external_id', () => {
    const { services } = setup();
    const body = { external_id: 'abc', client_id: 'nova-kim', subject: 's', body: 'b' };
    const a = services.ingest(body);
    const b = services.ingest(body);
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, ticket: { id: a.ticket.id } });
  });

  it('rejects unknown clients and bad input', () => {
    const { services } = setup();
    expect(() => services.ingest({ client_id: 'nobody', subject: 's', body: 'b' })).toThrow(HttpError);
    expect(() => services.ingest({ client_id: 'nova-kim' })).toThrow(HttpError);
  });

  it('records approve vs edit with word edit distance, and blocks double review', async () => {
    const { ctx, worker, services } = setup();
    const a = services.ingest({ client_id: 'kingsley-motors', subject: ROUTINE[1], body: ROUTINE[2] }).ticket.id;
    const b = services.ingest({ client_id: 'kingsley-motors', subject: ROUTINE[1], body: ROUTINE[2] + ' Thanks.' }).ticket.id;
    await worker.drain();

    services.review(a, { action: 'approve', body: getDraft(ctx.db, a)!.body, reviewer: 'Dana' });
    services.review(b, { action: 'approve', body: getDraft(ctx.db, b)!.body + ' Talk soon.', reviewer: 'Dana' });

    const rows = ctx.db.prepare('SELECT ticket_id, action, edit_distance FROM reviews ORDER BY ticket_id').all();
    expect(rows).toEqual([
      { ticket_id: a, action: 'approved', edit_distance: 0 },
      { ticket_id: b, action: 'edited', edit_distance: 2 },
    ]);
    expect(() => services.review(a, { action: 'reject' })).toThrow(/already reviewed/);
  });

  it('refuses review while triage is running', () => {
    const { services } = setup();
    const id = services.ingest({ client_id: 'nova-kim', subject: 's', body: 'b' }).ticket.id;
    expect(() => services.review(id, { action: 'approve', body: 'x' })).toThrow(/still being triaged/);
  });

  it('only resolves once and logs who did it', () => {
    const { ctx, services } = setup();
    const id = openPlatformIncident(ctx, { platform: 'X', category: 'Publishing & Scheduling', source: 'monitor', title: 't', message: 'm' });
    services.setIncidentStatus(id, 'acknowledged', 'Mei Chen');
    services.setIncidentStatus(id, 'resolved', 'Mei Chen');
    expect(() => services.setIncidentStatus(id, 'resolved', 'Mei Chen')).toThrow(/already resolved/);
    expect(incidentEvents(ctx.db, id).map((e) => e.message)).toEqual(
      expect.arrayContaining(['Acknowledged by Mei Chen', 'Resolved by Mei Chen']),
    );
  });

  it('refuses retriage while a triage job is pending', () => {
    const { services } = setup();
    const id = services.ingest({ client_id: 'nova-kim', subject: 's', body: 'b' }).ticket.id;
    expect(() => services.retriage(id)).toThrow(/still being triaged/);
  });

  it('refuses retriage of an answered ticket, so it cannot be answered twice', async () => {
    const { worker, services } = setup();
    const id = services.ingest({ client_id: 'nova-kim', subject: 'Reschedule', body: 'Move Thursday post to Friday please.' }).ticket.id;
    await worker.drain();
    services.review(id, { action: 'reject', reviewer: 'Mei Chen' });
    expect(() => services.retriage(id)).toThrow(/Already rejected/);
  });

  it('moves a re-triaged ticket out of an incident it no longer matches', async () => {
    let platform = 'Instagram';
    const model = new ScriptedClient({
      classify: async (req) => {
        const res = await new ScriptedClient().complete(req);
        return { ...res, toolInput: { ...(res.toolInput as object), platform, category: 'Publishing & Scheduling' } };
      },
    });
    const ctx = makeCtx({ model });
    const worker = new Worker(ctx);
    const services = createServices(ctx, { onNewWork: () => {}, runMonitor: () => {} });
    const inc = openPlatformIncident(ctx, { platform: 'Instagram', category: 'Publishing & Scheduling', source: 'monitor', title: 't', message: 'm' });
    const id = ingest(ctx, 'aurora-vance', 'Post failed', 'My post failed to publish.');
    await worker.drain();
    expect(getTicket(ctx.db, id)!.incidentId).toBe(inc);

    platform = 'TikTok';
    services.retriage(id);
    await worker.drain();
    expect(getTicket(ctx.db, id)!.incidentId).toBeNull();
  });

  it('does not generate briefs while AI is off', async () => {
    const { ctx, worker, services } = setup();
    const id = openPlatformIncident(ctx, { platform: 'X', category: 'Publishing & Scheduling', source: 'monitor', title: 't', message: 'm' });
    setSetting(ctx.db, 'ai_enabled', 'false');
    await worker.drain();
    expect(getIncident(ctx.db, id)!.briefStatus).toBe('none');
    expect(aiCallsFor(ctx.db, { incidentId: id })).toHaveLength(0);
    expect(() => services.regenerateBrief(id, 'Mei Chen')).toThrow(/AI is off/);
  });

  it('marks a client notified once', () => {
    const { ctx, services } = setup();
    const id = openPlatformIncident(ctx, { platform: 'X', category: 'Publishing & Scheduling', source: 'monitor', title: 't', message: 'm' });
    services.notifyClient(id, 'halcyon-bank', 'Luis Ortega');
    services.notifyClient(id, 'halcyon-bank', 'Luis Ortega');
    expect(incidentEvents(ctx.db, id).filter((e) => e.message.includes('notified'))).toHaveLength(1);
  });
});

describe('wordEditDistance', () => {
  it('counts word insertions, deletions and substitutions', () => {
    expect(wordEditDistance('a b c', 'a b c')).toBe(0);
    expect(wordEditDistance('a b c', 'a x c')).toBe(1);
    expect(wordEditDistance('a b c', 'a b c d e')).toBe(2);
    expect(wordEditDistance('', 'a b')).toBe(2);
  });
});
