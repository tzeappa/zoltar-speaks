import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { ollamaStatus } from './ai/ollama.ts';
import { aiEnabled, type AppContext } from './context.ts';
import { failedJobsSince, jobCounts, lastSuccessfulAiCallAt } from './db/repo.ts';
import { LiveFeed } from './live.ts';
import { ollamaModels } from './pipeline/embeddings.ts';
import type { PlatformMonitor } from './monitor/monitor.ts';
import { apiRoutes } from './routes/api.ts';
import { pageRoutes } from './routes/pages.tsx';
import { HttpError, type Services } from './services.ts';

const ROOT = join(import.meta.dirname, '..');

const STATIC: Record<string, { path: string; type: string }> = {
  'styles.css': { path: join(ROOT, 'server', 'public', 'styles.css'), type: 'text/css; charset=utf-8' },
  'app.js': { path: join(ROOT, 'server', 'public', 'app.js'), type: 'text/javascript; charset=utf-8' },
  'htmx.min.js': { path: join(ROOT, 'node_modules', 'htmx.org', 'dist', 'htmx.min.js'), type: 'text/javascript; charset=utf-8' },
};

/** Each open tab holds one; the cap keeps a runaway client from exhausting the process. */
const MAX_LIVE_STREAMS = 50;
const KEEP_ALIVE_MS = 25_000;

export function createApp(ctx: AppContext, services: Services, monitor: PlatformMonitor, live = new LiveFeed(ctx.db)): Hono {
  const app = new Hono();

  app.use(requestId());
  // DNS rebinding: a page on evil.example can re-point its name at 127.0.0.1 and then read and post here as a
  // same-origin page, past both the loopback binding and the CSRF check. Rebinding needs a host name, so IP addresses
  // and localhost are safe; any other name must be listed in ALLOWED_HOSTS.
  app.use(async (c, next) => {
    if (!hostAllowed(c.req.header('host') ?? new URL(c.req.url).host, ctx.config.allowedHosts)) return c.text('Unknown host. Add it to ALLOWED_HOSTS.', 421);
    await next();
  });
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: 'same-origin',
    }),
  );
  // No auth yet, so a page on another origin must not be able to post forms here (approve, turn AI off).
  app.use(csrf());
  app.use(bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }));
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    if (c.req.path.startsWith('/static/')) return;
    const polling = c.req.method === 'GET' && (c.req.header('HX-Request') === 'true' || c.req.path === '/events');
    ctx.log[polling ? 'debug' : 'info'](
      {
        request_id: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: Math.round(performance.now() - started),
      },
      'http',
    );
  });

  app.get('/healthz', async (c) => {
    try {
      ctx.db.prepare('SELECT 1').get();
    } catch (err) {
      return c.json({ status: 'down', db: String(err) }, 503);
    }
    const now = ctx.now();
    const queue = jobCounts(ctx.db);
    const monitorStale =
      ctx.config.monitorEnabled && (monitor.lastRunAt === null || now - monitor.lastRunAt > ctx.config.monitorIntervalMs * 3);
    const recentFailures = failedJobsSince(ctx.db, now - 60_000);
    const needed = ollamaModels(ctx.config, ctx.kb.docs.length).all;
    const ollama = needed.length ? await ollamaStatus(ctx.config.ollamaUrl, needed) : undefined;
    const ollamaDown = ollama !== undefined && (!ollama.reachable || ollama.missingModels.length > 0);
    return c.json({
      status: monitorStale || recentFailures > 0 || ollamaDown ? 'degraded' : 'ok',
      db: 'ok',
      ai: {
        mode: ctx.config.aiMode,
        enabled: aiEnabled(ctx),
        models: [ctx.config.modelFast, ctx.config.modelSmart],
        lastSuccessAt: lastSuccessfulAiCallAt(ctx.db),
        ...(ollama && { ollama: { url: ctx.config.ollamaUrl, ...ollama } }),
      },
      kb: { docs: ctx.kb.docs.length, search: ctx.kb.mode, ...(ctx.kb.mode === 'hybrid' && { embedModel: ctx.kb.embedModel }) },
      queue: { ...queue, failedLastMinute: recentFailures },
      monitor: { enabled: ctx.config.monitorEnabled, lastRunAt: monitor.lastRunAt, stale: monitorStale },
    });
  });

  // Pages listen here and refresh the parts whose topics changed (see LIVE_TOPICS and data-live in the views).
  app.get('/events', (c) => {
    if (live.listenerCount >= MAX_LIVE_STREAMS) return c.text('Too many live connections', 503);
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: string) => stream.writeSSE({ event, data }).catch(() => {});
      const unsubscribe = live.subscribe((topics) => void send('change', topics.join(' ')));
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'ready', data: '', retry: 3_000 });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(KEEP_ALIVE_MS);
        // A comment line: keeps proxies and the browser from treating a quiet connection as dead.
        await stream.write(': keep-alive\n\n').catch(() => {});
      }
      unsubscribe();
    });
  });

  // Read on each request in development so CSS and JS edits show up without a restart.
  const cache = new Map<string, string>();
  app.get('/static/:file', (c) => {
    const file = c.req.param('file');
    const entry = Object.hasOwn(STATIC, file) ? STATIC[file] : undefined;
    if (!entry) return c.notFound();
    let body = cache.get(entry.path);
    if (body === undefined) {
      body = readFileSync(entry.path, 'utf8');
      if (ctx.config.production) cache.set(entry.path, body);
    }
    return c.body(body, 200, { 'Content-Type': entry.type, 'Cache-Control': ctx.config.production ? 'public, max-age=3600' : 'no-cache' });
  });

  app.route('/api', apiRoutes(ctx, services, monitor));
  app.route('/', pageRoutes(ctx, services, monitor));

  app.onError((err, c) => {
    const status = err instanceof HttpError || err instanceof HTTPException ? err.status : 500;
    if (status === 500) ctx.log.error({ request_id: c.get('requestId'), err: err.stack ?? String(err) }, 'unhandled_error');
    const message = status === 500 ? 'Internal error' : err.message || (status === 403 ? 'Forbidden' : 'Request refused');
    if (c.req.path.startsWith('/api/')) return c.json({ error: message, request_id: c.get('requestId') }, status);
    return c.html(`<!doctype html><title>Error</title><p>${status}: ${escapeHtml(message)}</p><p><a href="/queue">Back to queue</a></p>`, status);
  });

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.html('<p>Not found. <a href="/queue">Queue</a></p>', 404)));

  return app;
}

export function hostAllowed(header: string | undefined, allowed: string[]): boolean {
  if (!header) return false;
  const host = header
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[(.*)\]$/, '$1');
  return isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost') || allowed.includes(host);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
