import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { listClients, listTickets } from '../db/repo.ts';
import { computeMetrics } from '../metrics.ts';
import type { PlatformMonitor } from '../monitor/monitor.ts';
import { incidentDetail, incidentList, ticketDetail } from '../read-models.ts';
import { HttpError, type Services } from '../services.ts';

const idParam = (raw: string) => {
  const id = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
  if (id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
};

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  // Requiring the JSON content type forces a CORS preflight for cross-origin callers, which this API never approves.
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
  return body as Record<string, unknown>;
}

const actor = (by: unknown) => (typeof by === 'string' && by.trim() ? by.trim().slice(0, 100) : 'api');

export function apiRoutes(ctx: AppContext, services: Services, monitor: PlatformMonitor): Hono {
  const api = new Hono();

  api.get('/clients', (c) => c.json(listClients(ctx.db)));

  api.post('/tickets', async (c) => {
    const { ticket, created } = services.ingest(await jsonBody(c.req.raw));
    return c.json({ id: ticket.id, external_id: ticket.externalId, created }, created ? 201 : 200);
  });
  api.get('/tickets', (c) => c.json(listTickets(ctx.db)));
  api.get('/tickets/:id', (c) => {
    const d = ticketDetail(ctx, idParam(c.req.param('id')));
    if (!d) throw new HttpError(404, 'Ticket not found');
    return c.json(d);
  });
  api.post('/tickets/:id/review', async (c) => {
    services.review(idParam(c.req.param('id')), await jsonBody(c.req.raw));
    return c.json({ ok: true });
  });
  api.post('/tickets/:id/retriage', (c) => {
    services.retriage(idParam(c.req.param('id')));
    return c.json({ ok: true }, 202);
  });

  api.get('/incidents', (c) => c.json(incidentList(ctx)));
  api.get('/incidents/:id', (c) => {
    const d = incidentDetail(ctx, idParam(c.req.param('id')));
    if (!d) throw new HttpError(404, 'Incident not found');
    return c.json(d);
  });
  api.post('/incidents/:id/ack', (c) => {
    services.setIncidentStatus(idParam(c.req.param('id')), 'acknowledged', 'api');
    return c.json({ ok: true });
  });
  api.post('/incidents/:id/resolve', (c) => {
    services.setIncidentStatus(idParam(c.req.param('id')), 'resolved', 'api');
    return c.json({ ok: true });
  });
  api.post('/incidents/:id/regenerate-brief', (c) => {
    services.regenerateBrief(idParam(c.req.param('id')), 'api');
    return c.json({ ok: true }, 202);
  });
  api.post('/incidents/:id/notify', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (typeof body.client_id !== 'string' || !body.client_id) throw new HttpError(400, 'client_id required');
    services.notifyClient(idParam(c.req.param('id')), body.client_id.slice(0, 100), actor(body.by));
    return c.json({ ok: true });
  });
  api.post('/incidents/:id/notify-all', async (c) => {
    const body = await jsonBody(c.req.raw);
    return c.json(await services.notifyAffected(idParam(c.req.param('id')), body, actor(body.by)));
  });
  api.post('/incidents/:id/resolve-notify', async (c) => {
    const body = await jsonBody(c.req.raw);
    return c.json(await services.resolveAndNotify(idParam(c.req.param('id')), body, actor(body.by)));
  });

  api.get('/platforms', (c) => c.json({ lastRunAt: monitor.lastRunAt, board: monitor.board() }));
  api.post('/platforms/simulate', async (c) => {
    services.simulateStatus(await jsonBody(c.req.raw));
    return c.json({ ok: true });
  });
  api.post('/monitor/run', async (c) => {
    await monitor.runOnce();
    return c.json({ ok: true, lastRunAt: monitor.lastRunAt });
  });

  api.post('/simulate/spike', (c) => c.json({ ticket_ids: services.simulateSpike() }, 201));

  api.post('/settings/ai', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean');
    services.setAiEnabled(body.enabled, 'api');
    return c.json({ ok: true });
  });

  api.get('/metrics', (c) => c.json(computeMetrics(ctx.db, ctx.now())));

  api.get('/kb/:id', (c) => {
    const doc = ctx.kb.get(c.req.param('id'));
    if (!doc) throw new HttpError(404, 'Document not found');
    return c.json(doc);
  });

  return api;
}
