import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Child } from 'hono/jsx';
import { aiEnabled, type AppContext } from '../context.ts';
import { lastSuccessfulAiCallAt, listIncidents, listTickets } from '../db/repo.ts';
import { computeMetrics } from '../metrics.ts';
import type { PlatformMonitor } from '../monitor/monitor.ts';
import { summaryText } from '../notify/send.ts';
import { incidentDetail, incidentList, ticketDetail } from '../read-models.ts';
import { HttpError, type Services } from '../services.ts';
import { IncidentPage, IncidentsPage } from '../views/incidents.tsx';
import { OpsPage } from '../views/ops.tsx';
import { PlatformsPage } from '../views/platforms.tsx';
import { QUEUE_FILTERS, QueuePage, type QueueFilter } from '../views/queue.tsx';
import { TicketPage } from '../views/ticket.tsx';
import { Layout, REVIEWERS, type LayoutProps } from '../views/ui.tsx';

const idParam = (raw: string) => {
  const id = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
  if (id <= 0) throw new HttpError(404, 'Not found');
  return id;
};

/** Path of `referer` if it is on this server, otherwise the queue. Never redirect off-site. */
export function sameOriginPath(referer: string | undefined, requestUrl: string): string {
  if (!referer) return '/queue';
  try {
    const ref = new URL(referer);
    // "//evil.example/x" is a path here but an off-site URL in a Location header.
    if (ref.origin !== new URL(requestUrl).origin || /^\/[/\\]/.test(ref.pathname)) return '/queue';
    return `${ref.pathname}${ref.search}`;
  } catch {
    return '/queue';
  }
}

async function form(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}

export function pageRoutes(ctx: AppContext, services: Services, monitor: PlatformMonitor): Hono {
  const app = new Hono();

  const reviewerOf = (c: Context) => {
    const r = getCookie(c, 'reviewer');
    return r && REVIEWERS.includes(r) ? r : REVIEWERS[0]!;
  };

  const page = (c: Context, title: string, active: LayoutProps['active'], body: Child) =>
    c.html(
      <Layout
        title={title}
        path={c.req.path}
        active={active}
        reviewer={reviewerOf(c)}
        aiState={{ mode: ctx.config.aiMode, enabled: aiEnabled(ctx) }}
        openIncidents={listIncidents(ctx.db).filter((i) => i.kind === 'platform' && i.status !== 'resolved').length}
        flash={c.req.query('flash') ?? null}
      >
        {body}
      </Layout>,
    );

  /** Runs an action and returns to `to`; a refusal (e.g. "still being triaged") is shown there instead of an error page. */
  const withFlash = (c: Context, to: string, action: () => void) => {
    try {
      action();
    } catch (err) {
      if (!(err instanceof HttpError) || err.status === 404) throw err;
      return c.redirect(`${to}?flash=${encodeURIComponent(err.message)}`, 303);
    }
    return c.redirect(to, 303);
  };

  app.get('/', (c) => c.redirect('/queue'));

  app.post('/reviewer', async (c) => {
    const { reviewer } = await form(c);
    if (reviewer && REVIEWERS.includes(reviewer)) setCookie(c, 'reviewer', reviewer, { path: '/', sameSite: 'Lax', httpOnly: true });
    return c.redirect(sameOriginPath(c.req.header('Referer'), c.req.url), 303);
  });

  app.get('/queue', (c) => {
    const raw = c.req.query('filter');
    const filter: QueueFilter = raw && raw in QUEUE_FILTERS ? (raw as QueueFilter) : 'needs_review';
    return page(c, `${QUEUE_FILTERS[filter]} queue`, 'queue', <QueuePage all={listTickets(ctx.db)} filter={filter} now={ctx.now()} />);
  });

  app.get('/tickets/:id', (c) => {
    const d = ticketDetail(ctx, idParam(c.req.param('id')));
    if (!d) throw new HttpError(404, 'Ticket not found');
    return page(c, d.ticket.subject, 'queue', <TicketPage d={d} reviewer={reviewerOf(c)} now={ctx.now()} />);
  });

  app.post('/tickets/:id/review', async (c) => {
    const id = idParam(c.req.param('id'));
    const f = await form(c);
    try {
      services.review(id, { action: f.action, body: f.body, note: f.note || undefined, reviewer: reviewerOf(c) });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status === 404) throw err;
      const d = ticketDetail(ctx, id)!;
      return page(c, d.ticket.subject, 'queue', <TicketPage d={d} reviewer={reviewerOf(c)} now={ctx.now()} error={err.message} />);
    }
    return c.redirect(`/tickets/${id}`, 303);
  });

  app.post('/tickets/:id/retriage', (c) => {
    const id = idParam(c.req.param('id'));
    return withFlash(c, `/tickets/${id}`, () => services.retriage(id));
  });

  app.post('/simulate/spike', (c) => {
    const ids = services.simulateSpike();
    return c.redirect(`/queue?filter=processing&flash=${encodeURIComponent(`${ids.length} Instagram publishing complaints received`)}`, 303);
  });

  app.get('/incidents', (c) => page(c, 'Incidents', 'incidents', <IncidentsPage incidents={incidentList(ctx)} now={ctx.now()} />));

  app.get('/incidents/:id', (c) => {
    const d = incidentDetail(ctx, idParam(c.req.param('id')));
    if (!d) throw new HttpError(404, 'Incident not found');
    return page(c, d.incident.title, 'incidents', <IncidentPage d={d} reviewer={reviewerOf(c)} now={ctx.now()} />);
  });

  for (const [path, status] of [
    ['ack', 'acknowledged'],
    ['resolve', 'resolved'],
  ] as const) {
    app.post(`/incidents/:id/${path}`, (c) => {
      const id = idParam(c.req.param('id'));
      services.setIncidentStatus(id, status, reviewerOf(c));
      return c.redirect(`/incidents/${id}`, 303);
    });
  }

  app.post('/incidents/:id/regenerate', (c) => {
    const id = idParam(c.req.param('id'));
    return withFlash(c, `/incidents/${id}`, () => services.regenerateBrief(id, reviewerOf(c)));
  });

  app.post('/incidents/:id/notify', async (c) => {
    const id = idParam(c.req.param('id'));
    const f = await form(c);
    return withFlash(c, `/incidents/${id}`, () => services.notifyClient(id, f.client_id ?? '', reviewerOf(c)));
  });

  for (const [path, action] of [
    ['notify-all', 'notifyAffected'],
    ['resolve-notify', 'resolveAndNotify'],
  ] as const) {
    app.post(`/incidents/:id/${path}`, async (c) => {
      const id = idParam(c.req.param('id'));
      const f = await form(c);
      let message: string;
      try {
        message = summaryText(await services[action](id, { subject: f.subject, body: f.body, expected_recipients: f.expected_recipients }, reviewerOf(c)));
      } catch (err) {
        if (!(err instanceof HttpError) || err.status === 404) throw err;
        message = `Not sent: ${err.message}`;
      }
      return c.redirect(`/incidents/${id}?flash=${encodeURIComponent(message)}`, 303);
    });
  }

  app.get('/platforms', (c) =>
    page(
      c,
      'Platforms',
      'platforms',
      <PlatformsPage board={monitor.board()} lastRunAt={monitor.lastRunAt} intervalMs={ctx.config.monitorIntervalMs}
        degradedMs={ctx.config.monitorDegradedMs}
        recoveryMs={ctx.config.monitorRecoveryMs}
        now={ctx.now()}
      />,
    ),
  );

  app.post('/platforms/simulate', async (c) => {
    services.simulateStatus(await form(c));
    return c.redirect('/platforms', 303);
  });

  app.post('/platforms/run', async (c) => {
    await monitor.runOnce();
    return c.redirect('/platforms', 303);
  });

  app.get('/ops', (c) =>
    page(
      c,
      'Ops',
      'ops',
      <OpsPage
        m={computeMetrics(ctx.db, ctx.now())}
        ai={{
          mode: ctx.config.aiMode,
          enabled: aiEnabled(ctx),
          modelFast: ctx.config.modelFast,
          modelSmart: ctx.config.modelSmart,
          lastOkAt: lastSuccessfulAiCallAt(ctx.db),
        }}
        monitorLastRunAt={monitor.lastRunAt}
        now={ctx.now()}
      />,
    ),
  );

  app.post('/ops/ai', async (c) => {
    const f = await form(c);
    services.setAiEnabled(f.enabled === 'true', reviewerOf(c));
    return c.redirect('/ops', 303);
  });

  return app;
}
