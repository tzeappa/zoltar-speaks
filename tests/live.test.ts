import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { insertTicketWithJob, setSetting } from '../server/db/repo.ts';
import { LiveFeed } from '../server/live.ts';
import { PlatformMonitor, sourcesFromConfig } from '../server/monitor/monitor.ts';
import { setSimulatedStatus } from '../server/monitor/sources.ts';
import { createServices } from '../server/services.ts';
import { makeCtx } from './helpers.ts';

const ingest = (ctx: ReturnType<typeof makeCtx>, n: number) =>
  insertTicketWithJob(
    ctx.db,
    { externalId: `live-${n}`, clientId: 'aurora-vance', channel: 'email', subject: 'Hi', body: 'Thanks!', receivedAt: ctx.clock.now },
    ctx.clock.now,
  );

describe('LiveFeed', () => {
  it('reports the topics whose tables changed, once', () => {
    const ctx = makeCtx({ config: { monitorEnabled: false } });
    const live = new LiveFeed(ctx.db);
    const seen: string[][] = [];
    const unsubscribe = live.subscribe((t) => seen.push(t));

    expect(live.tick()).toEqual([]);
    ingest(ctx, 1);
    expect(new Set(live.tick())).toEqual(new Set(['tickets', 'incidents', 'ops'])); // ticket plus its triage job
    expect(live.tick()).toEqual([]);

    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'outage');
    expect(new Set(live.tick())).toEqual(new Set(['ops', 'platforms']));
    expect(seen).toHaveLength(2);

    unsubscribe();
    expect(live.listenerCount).toBe(0);
    live.stop();
  });

  it('catches writes made outside the app, such as another process', () => {
    const ctx = makeCtx({ config: { monitorEnabled: false } });
    const live = new LiveFeed(ctx.db);
    live.subscribe(() => {});
    ctx.db.exec("INSERT INTO settings (key, value) VALUES ('x', 'y')");
    expect(live.tick()).toContain('ops');
    live.stop();
  });
});

describe('GET /events', () => {
  const setup = () => {
    const ctx = makeCtx({ config: { monitorEnabled: false } });
    const services = createServices(ctx, { onNewWork: () => {}, runMonitor: () => {} });
    const live = new LiveFeed(ctx.db, 60_000); // ticked by hand below
    return { ctx, live, app: createApp(ctx, services, new PlatformMonitor(ctx, sourcesFromConfig(ctx)), live) };
  };

  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) => {
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    return text;
  };

  it('streams changed topics and lets go when the page disconnects', async () => {
    const { ctx, live, app } = setup();
    const res = await app.request('/events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    expect(await readUntil(reader, 'event: ready')).toContain('retry: 3000');
    expect(live.listenerCount).toBe(1);

    setSetting(ctx.db, 'ai_enabled', 'false');
    live.tick();
    const text = await readUntil(reader, 'event: change');
    expect(text).toMatch(/event: change\ndata: .*\bops\b/);

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(live.listenerCount).toBe(0);
  });

  it('refuses more streams than the cap', async () => {
    const { live, app } = setup();
    for (let i = 0; i < 50; i++) live.subscribe(() => {});
    expect((await app.request('/events')).status).toBe(503);
    live.stop();
  });
});

describe('live pages', () => {
  it('refresh on pushed changes with a slow fallback, not fast polling', async () => {
    const ctx = makeCtx({ config: { monitorEnabled: false } });
    const services = createServices(ctx, { onNewWork: () => {}, runMonitor: () => {} });
    const app = createApp(ctx, services, new PlatformMonitor(ctx, sourcesFromConfig(ctx)));
    ingest(ctx, 1);
    for (const [path, topics] of [
      ['/queue', 'tickets incidents'],
      ['/tickets/1', 'tickets'],
      ['/incidents', 'incidents tickets'],
      ['/platforms', 'platforms'],
      ['/ops', 'ops tickets incidents platforms'],
    ] as const) {
      const html = await (await app.request(path)).text();
      expect(html, path).toContain(`data-live="${topics}"`);
      expect(html, path).toContain('hx-trigger="live, every 60s"');
      expect(html, path).not.toContain('hx-trigger="every ');
    }
  });
});
