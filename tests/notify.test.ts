import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { openDb } from '../server/db/index.ts';
import {
  getClient,
  getIncident,
  incidentEvents,
  insertTicketWithJob,
  linkTicketsToIncident,
  listOutbound,
  setIncidentBrief,
  upsertClient,
} from '../server/db/repo.ts';
import type { MonitoredPlatform } from '../server/domain.ts';
import { PlatformMonitor, sourcesFromConfig } from '../server/monitor/monitor.ts';
import { SimulatedSource, setSimulatedStatus, type StatusSource } from '../server/monitor/sources.ts';
import { OutboxNotifier, type Notice, type Notifier } from '../server/notify/notifier.ts';
import { allClearDraft, outageDraft, personalize } from '../server/notify/templates.ts';
import { openPlatformIncident } from '../server/pipeline/incidents.ts';
import { CLIENTS } from '../server/seed/clients.ts';
import { seedIfEmpty } from '../server/seed/index.ts';
import { createServices } from '../server/services.ts';
import { makeCtx } from './helpers.ts';

const INSTAGRAM_CLIENTS = CLIENTS.filter((c) => c.platforms.includes('Instagram'));

function setup(notifier: Notifier = new OutboxNotifier()) {
  const ctx = makeCtx({ notifier, config: { monitorEnabled: false } });
  const services = createServices(ctx, { onNewWork: () => {}, runMonitor: () => {} });
  const incidentId = openPlatformIncident(ctx, {
    platform: 'Instagram',
    category: 'Publishing & Scheduling',
    source: 'monitor',
    title: 'Instagram publishing outage',
    message: 'Graph API 503',
  });
  return { ctx, services, incidentId };
}

const outage = (inc = { platform: 'Instagram', category: 'Publishing & Scheduling', briefStatus: 'none', brief: null } as const) =>
  outageDraft(inc);

/** Fails for chosen clients, to exercise failure recording and retries. */
class FlakyNotifier implements Notifier {
  readonly channel = 'outbox';
  readonly sent: Notice[] = [];
  constructor(private readonly failFor: Set<string>) {}
  async send(n: Notice) {
    if (this.failFor.has(n.clientId)) throw new Error('550 mailbox unavailable');
    this.sent.push(n);
    return { providerId: `m-${this.sent.length}` };
  }
}

describe('notice templates', () => {
  it('the fallback outage notice says the platform caused it', () => {
    const d = outage();
    expect(d.subject).toBe('Instagram issue affecting publishing and scheduled posts: not caused by your account');
    expect(d.body).toContain('The problem is with Instagram itself.');
    expect(d.body).toContain('It is not caused by your account');
  });

  it('uses the approved message from a ready brief', () => {
    const d = outageDraft({
      platform: 'Instagram',
      category: 'Publishing & Scheduling',
      briefStatus: 'ready',
      brief: { client_comms_macro: 'Hi {{client}}, Instagram is down on their side.' },
    });
    expect(d.body).toBe('Hi {{client}}, Instagram is down on their side.');
  });

  it('the all-clear says it is back to normal', () => {
    const d = allClearDraft({ platform: 'Instagram', category: 'Publishing & Scheduling' });
    expect(d.subject).toBe('Resolved: Instagram publishing and scheduled posts back to normal');
    expect(d.body).toContain('Everything is working normally again for publishing and scheduled posts.');
  });

  it('fills client and coordinator per recipient', () => {
    const c = CLIENTS.find((x) => x.id === 'juno-reyes')!;
    expect(personalize('Hi {{client}}, {{coordinator}} will call. {{other}}', c)).toBe('Hi Juno Reyes, Mei Chen will call. {{other}}');
  });
});

describe('outage notice', () => {
  it('emails every affected client once, personalized, and marks them notified', async () => {
    const notifier = new OutboxNotifier();
    const { ctx, services, incidentId } = setup(notifier);
    const summary = await services.notifyAffected(incidentId, outage(), 'Mei Chen');

    expect(summary.sent).toHaveLength(INSTAGRAM_CLIENTS.length);
    expect(summary.failed).toEqual([]);
    expect(notifier.sent.map((n) => n.to).sort()).toEqual(INSTAGRAM_CLIENTS.map((c) => c.contactEmail).sort());
    const juno = notifier.sent.find((n) => n.clientId === 'juno-reyes')!;
    expect(juno.body).toContain('Hi Juno Reyes,');
    expect(juno.body).toContain('Mei Chen will contact you');
    expect(juno.body).not.toContain('{{');

    expect(listOutbound(ctx.db, incidentId).every((m) => m.status === 'sent' && m.kind === 'outage')).toBe(true);
    expect(incidentEvents(ctx.db, incidentId).at(-1)?.message).toMatch(/^Outage notice sent to 9 clients by Mei Chen \(outbox\)/);
    await expect(services.notifyAffected(incidentId, outage(), 'Mei Chen')).rejects.toThrow(/already been notified/);
  });

  it('refuses to send when the recipients differ from the ones the sender was shown', async () => {
    const notifier = new OutboxNotifier();
    const { services, incidentId } = setup(notifier);
    const shown = INSTAGRAM_CLIENTS.slice(1).map((c) => c.id).join(',');
    await expect(services.notifyAffected(incidentId, { ...outage(), expected_recipients: shown }, 'Mei Chen')).rejects.toThrow(/recipients changed/);
    expect(notifier.sent).toHaveLength(0);
    const all = INSTAGRAM_CLIENTS.map((c) => c.id).join(',');
    expect((await services.notifyAffected(incidentId, { ...outage(), expected_recipients: all }, 'Mei Chen')).sent).toHaveLength(INSTAGRAM_CLIENTS.length);
  });

  it('skips clients already marked notified by hand', async () => {
    const notifier = new OutboxNotifier();
    const { services, incidentId } = setup(notifier);
    services.notifyClient(incidentId, 'aurora-vance', 'Dana Whitfield');
    await services.notifyAffected(incidentId, outage(), 'Mei Chen');
    expect(notifier.sent.some((n) => n.clientId === 'aurora-vance')).toBe(false);
    expect(notifier.sent).toHaveLength(INSTAGRAM_CLIENTS.length - 1);
  });

  it('never double-sends when two people click at once', async () => {
    const notifier = new OutboxNotifier();
    const { services, incidentId } = setup(notifier);
    await Promise.allSettled([
      services.notifyAffected(incidentId, outage(), 'Mei Chen'),
      services.notifyAffected(incidentId, outage(), 'Luis Ortega'),
    ]);
    const perClient = new Map<string, number>();
    for (const n of notifier.sent) perClient.set(n.clientId, (perClient.get(n.clientId) ?? 0) + 1);
    expect([...perClient.values()].every((v) => v === 1)).toBe(true);
    expect(perClient.size).toBe(INSTAGRAM_CLIENTS.length);
  });

  it('records failures, does not mark them notified, and retries only those', async () => {
    const notifier = new FlakyNotifier(new Set(['juno-reyes']));
    const { ctx, services, incidentId } = setup(notifier);
    const first = await services.notifyAffected(incidentId, outage(), 'Mei Chen');
    expect(first.failed).toEqual([{ client: 'Juno Reyes', error: '550 mailbox unavailable' }]);
    expect(listOutbound(ctx.db, incidentId).find((m) => m.clientId === 'juno-reyes')).toMatchObject({ status: 'failed', error: '550 mailbox unavailable' });

    notifier['failFor'].clear();
    const retry = await services.notifyAffected(incidentId, outage(), 'Mei Chen');
    expect(retry.sent).toEqual(['Juno Reyes']);
    expect(notifier.sent.filter((n) => n.clientId === 'juno-reyes')).toHaveLength(1);
    expect(listOutbound(ctx.db, incidentId).every((m) => m.status === 'sent')).toBe(true);
  });

  it('lists clients without an email instead of failing', async () => {
    const notifier = new OutboxNotifier();
    const { ctx, services, incidentId } = setup(notifier);
    upsertClient(ctx.db, { ...getClient(ctx.db, 'oakridge-coffee')!, contactEmail: null });
    const summary = await services.notifyAffected(incidentId, outage(), 'Mei Chen');
    expect(summary.noEmail).toEqual(['Oakridge Coffee Co.']);
    expect(notifier.sent.some((n) => n.clientId === 'oakridge-coffee')).toBe(false);
    expect(incidentEvents(ctx.db, incidentId).at(-1)?.message).toContain('no email on file, contact directly: Oakridge Coffee Co.');
  });

  it('rejects header injection, unknown placeholders, client watches, and resolved incidents', async () => {
    const notifier = new OutboxNotifier();
    const { ctx, services, incidentId } = setup(notifier);
    await expect(services.notifyAffected(incidentId, { subject: 'Hi\r\nBcc: all@evil.example', body: 'x' }, 'm')).rejects.toThrow(/one line/);
    await expect(services.notifyAffected(incidentId, { subject: 'Hi', body: 'Dear {{name}}' }, 'm')).rejects.toThrow(/Unknown placeholder/);
    await expect(services.notifyAffected(incidentId, { subject: ' ', body: 'x' }, 'm')).rejects.toThrow(/Subject is empty/);
    expect(notifier.sent).toHaveLength(0);

    ctx.db.prepare("UPDATE incidents SET kind = 'client_watch', client_id = 'juno-reyes' WHERE id = ?").run(incidentId);
    await expect(services.notifyAffected(incidentId, outage(), 'm')).rejects.toThrow(/platform incidents/);
    ctx.db.prepare("UPDATE incidents SET kind = 'platform', client_id = NULL, status = 'resolved' WHERE id = ?").run(incidentId);
    await expect(services.notifyAffected(incidentId, outage(), 'm')).rejects.toThrow(/all-clear instead/);
  });
});

describe('resolve and send all-clear', () => {
  const allClear = allClearDraft({ platform: 'Instagram', category: 'Publishing & Scheduling' });

  it('resolves and tells everyone who heard about the outage, once', async () => {
    const notifier = new OutboxNotifier();
    const { ctx, services, incidentId } = setup(notifier);
    services.notifyClient(incidentId, 'aurora-vance', 'Dana Whitfield');
    const { ticket } = insertTicketWithJob(
      ctx.db,
      { externalId: 'r-1', clientId: 'sable-stone', channel: 'email', subject: 'Post failed', body: 'Our post failed', receivedAt: ctx.clock.now },
      ctx.clock.now,
    );
    linkTicketsToIncident(ctx.db, [ticket.id], incidentId);

    const summary = await services.resolveAndNotify(incidentId, allClear, 'Mei Chen');
    expect(getIncident(ctx.db, incidentId)?.status).toBe('resolved');
    expect(summary.sent.sort()).toEqual(['Aurora Vance', 'Sable & Stone']);
    expect(notifier.sent.every((n) => n.kind === 'all_clear')).toBe(true);
    expect(notifier.sent[0]!.body).not.toContain('{{');

    const again = await services.resolveAndNotify(incidentId, allClear, 'Mei Chen');
    expect(again.sent).toEqual([]);
    expect(notifier.sent).toHaveLength(2);
    expect(incidentEvents(ctx.db, incidentId).filter((e) => e.message.startsWith('Resolved by'))).toHaveLength(1);
  });

  it('after a full outage notice, the all-clear goes to the same clients', async () => {
    const notifier = new OutboxNotifier();
    const { services, incidentId } = setup(notifier);
    await services.notifyAffected(incidentId, outage(), 'Mei Chen');
    const summary = await services.resolveAndNotify(incidentId, allClear, 'Mei Chen');
    expect(summary.sent).toHaveLength(INSTAGRAM_CLIENTS.length);
  });

  it('does not resolve when the message is invalid', async () => {
    const { ctx, services, incidentId } = setup();
    await expect(services.resolveAndNotify(incidentId, { subject: '', body: 'x' }, 'Mei Chen')).rejects.toThrow();
    expect(getIncident(ctx.db, incidentId)?.status).toBe('open');
  });
});

describe('recovery tracking', () => {
  it('marks the incident recovered, and clears it if the platform fails again', async () => {
    const ctx = makeCtx();
    const monitor = new PlatformMonitor(ctx, new Map<MonitoredPlatform, StatusSource>([['Instagram', new SimulatedSource(ctx.db)]]));
    const tick = async () => {
      ctx.clock.now += 10_000;
      await monitor.runOnce();
    };
    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'outage', 'Graph API 503');
    await tick();
    const id = ctx.db.prepare('SELECT id FROM incidents').get() as { id: number };
    expect(getIncident(ctx.db, id.id)?.recoveredAt).toBeNull();

    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'operational');
    for (let i = 0; i < 3; i++) await tick();
    expect(getIncident(ctx.db, id.id)?.recoveredAt).toBeNull(); // operational for 20 s
    await tick();
    expect(getIncident(ctx.db, id.id)?.recoveredAt).toBe(ctx.clock.now);

    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'degraded', 'slow');
    await tick();
    expect(getIncident(ctx.db, id.id)?.recoveredAt).toBeNull();
    expect(incidentEvents(ctx.db, id.id).at(-1)?.message).toContain('failing again after recovery');
  });
});

describe('incident page', () => {
  it('shows both notice forms, the recovery banner, and posts send from the page', async () => {
    const { ctx, services, incidentId } = setup();
    const app = createApp(ctx, services, new PlatformMonitor(ctx, sourcesFromConfig(ctx)));
    ctx.db.prepare('UPDATE incidents SET recovered_at = ? WHERE id = ?').run(ctx.clock.now, incidentId);

    const html = await (await app.request(`/incidents/${incidentId}`)).text();
    expect(html).toContain('Notify affected clients (9)');
    expect(html).toContain('Resolve and send all-clear (0)');
    expect(html).toContain('Instagram recovered');
    expect(html).toContain('<strong>Simulated delivery:</strong>');
    expect(html).toContain('not caused by your account');

    const res = await app.request(`/incidents/${incidentId}/notify-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' },
      body: new URLSearchParams({ ...outage() }).toString(),
    });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('Outage notice sent to 9 clients');
    const after = await (await app.request(`/incidents/${incidentId}`)).text();
    expect(after).toContain('Every affected client has been notified.');
    expect(after).toContain('Resolve and send all-clear (9)');
  });

  it('uses real client names, not pseudonym tokens, from the brief', async () => {
    const { ctx, services, incidentId } = setup();
    setIncidentBrief(ctx.db, incidentId, 'ready', {
      summary: 's',
      severity: 'SEV2',
      timeline: [],
      next_steps: [],
      unknowns: [],
      human_decisions: [],
      client_comms_macro: 'Hi {{client}}, like [CLIENT_1] and others, this is an Instagram issue.',
    });
    const app = createApp(ctx, services, new PlatformMonitor(ctx, sourcesFromConfig(ctx)));
    const html = await (await app.request(`/incidents/${incidentId}`)).text();
    expect(html).not.toContain('[CLIENT_1]');
  });

  it('rejects a cross-site send', async () => {
    const notifier = new OutboxNotifier();
    const { ctx, services, incidentId } = setup(notifier);
    const app = createApp(ctx, services, new PlatformMonitor(ctx, sourcesFromConfig(ctx)));
    const res = await app.request(`/incidents/${incidentId}/notify-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
      body: new URLSearchParams({ ...outage() }).toString(),
    });
    expect(res.status).toBe(403);
    expect(notifier.sent).toHaveLength(0);
  });
});

describe('database upgrade', () => {
  it('existing databases get the new columns and seeded contact emails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoltar-migrate-'));
    const path = join(dir, 'old.db');
    try {
      const old = openDb(path);
      old.exec('ALTER TABLE clients DROP COLUMN contact_email; ALTER TABLE incidents DROP COLUMN recovered_at');
      old.exec(`INSERT INTO clients (id, name, kind, tier, industry, coordinator) VALUES ('nova-kim', 'Nova Kim', 'influencer', 'platinum', 'music', 'Dana Whitfield')`);
      old.exec(`
        INSERT INTO incidents (id, kind, platform, category, title, created_at) VALUES
          (1, 'platform', 'Facebook', 'Publishing & Scheduling', 'recovered', 1), (2, 'platform', 'X', 'Publishing & Scheduling', 'still down', 1);
        INSERT INTO incident_events (incident_id, source, message, created_at) VALUES
          (1, 'monitor', 'Facebook publishing outage: 503', 10),
          (1, 'monitor', 'Facebook publishing operational for 3 checks. Verify failed posts are republished, then resolve.', 40),
          (2, 'monitor', 'X publishing outage: 503', 10)`);
      old.close();

      const db = openDb(path);
      expect(seedIfEmpty(db, Date.now())).toBe(false);
      expect(getClient(db, 'nova-kim')?.contactEmail).toBe('management@novakim.example');
      expect(getIncident(db, 1)?.recoveredAt).toBe(40);
      expect(getIncident(db, 2)?.recoveredAt).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
