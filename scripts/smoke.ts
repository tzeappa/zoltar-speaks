/**
 * Starts the real server in mock mode on a throwaway database and checks it end to end over HTTP.
 *
 *   npm run smoke
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.SMOKE_PORT ?? '8799';
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'zoltar-smoke-'));

const server = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: '',
    AI_MODE: 'mock',
    PORT,
    DB_PATH: join(dir, 'smoke.db'),
    MOCK_LATENCY_MS: '20',
    MONITOR_INTERVAL_MS: '500',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok   ${what}`);
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // Not ready yet.
    }
    await sleep(250);
  }
  throw new Error(`FAIL: timed out waiting for ${what}`);
}

const json = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function run(): Promise<void> {
  const health = await waitFor('server start', async () => {
    const res = await fetch(`${BASE}/healthz`);
    return res.ok ? ((await res.json()) as { db: string; ai: { mode: string } }) : undefined;
  });
  check(health.db === 'ok' && health.ai.mode === 'mock', 'healthz reports db ok and mock AI');

  for (const path of ['/queue', '/incidents', '/platforms', '/ops', '/static/app.js', '/static/htmx.min.js', '/static/styles.css']) {
    const res = await fetch(`${BASE}${path}`);
    check(res.status === 200, `GET ${path} is 200`);
  }

  const page = await fetch(`${BASE}/queue`);
  check(page.headers.get('content-security-policy')?.includes("script-src 'self'"), 'pages send a CSP');

  const seeded = await waitFor('seed triage', async () => {
    const h = (await (await fetch(`${BASE}/healthz`)).json()) as { queue: { queued: number; running: number; done: number } };
    return h.queue.queued === 0 && h.queue.running === 0 && h.queue.done > 0 ? h.queue.done : undefined;
  });
  check(seeded >= 40, `seed requests triaged (${seeded})`);

  const created = await fetch(`${BASE}/api/tickets`, json({ client_id: 'kingsley-motors', subject: 'Smoke', body: 'Our Instagram post failed to publish.' }));
  check(created.status === 201, 'POST /api/tickets creates a ticket');
  const { id } = (await created.json()) as { id: number };
  const ticket = await waitFor('new ticket triage', async () => {
    const t = (await (await fetch(`${BASE}/api/tickets/${id}`)).json()) as { ticket: { route: string | null } };
    return t.ticket.route ? t.ticket : undefined;
  });
  check(['suggest', 'escalate'].includes(ticket.route!), `new ticket routed (${ticket.route})`);

  const forged = await fetch(`${BASE}/ops/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
    body: 'enabled=false',
  });
  check(forged.status === 403, 'cross-origin form post is rejected');

  check((await fetch(`${BASE}/api/platforms/simulate`, json({ platform: 'Instagram', component: 'publishing', status: 'outage' }))).ok, 'simulate outage');
  const incident = await waitFor('incident from monitor', async () => {
    const list = (await (await fetch(`${BASE}/api/incidents`)).json()) as { kind: string; platform: string }[];
    return list.find((i) => i.kind === 'platform' && i.platform === 'Instagram');
  });
  check(incident, 'monitor opens an Instagram incident');
}

let failed = false;
try {
  await run();
  console.log('smoke test passed');
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : err);
} finally {
  server.kill('SIGTERM');
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
