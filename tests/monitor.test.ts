import { describe, expect, it } from 'vitest';
import { findActiveIncident, incidentEvents, insertTicketWithJob, listIncidents, setIncidentStatus } from '../server/db/repo.ts';
import type { MonitoredPlatform, PlatformStatus } from '../server/domain.ts';
import { PlatformMonitor } from '../server/monitor/monitor.ts';
import { evaluateChecks, formatDuration, type Check, type IncidentState } from '../server/monitor/rules.ts';
import {
  HttpProbeSource,
  SimulatedSource,
  StatuspageSource,
  classifyProbe,
  mapStatuspageIndicator,
  setSimulatedStatus,
  type StatusSource,
} from '../server/monitor/sources.ts';
import { Worker } from '../server/pipeline/worker.ts';
import { makeCtx } from './helpers.ts';

const cfg = { degradedMs: 20_000, recoveryMs: 30_000, maxGapMs: 21_000 };
const none: IncidentState = { open: false, monitorAttached: false, recovered: false };
const mine: IncidentState = { open: true, monitorAttached: true, recovered: false };
const fromTickets: IncidentState = { open: true, monitorAttached: false, recovered: false };
/** Newest first, as stored, `everyMs` apart (the monitor runs every 10 s by default). */
const seq = (...s: PlatformStatus[]): Check[] => spaced(10_000, ...s);
const spaced = (everyMs: number, ...s: PlatformStatus[]): Check[] =>
  s.map((status, i) => ({ status, checkedAt: 1_000_000 - i * everyMs }));

describe('evaluateChecks', () => {
  it('opens on a single outage', () => {
    expect(evaluateChecks(seq('outage'), none, cfg)).toBe('open');
  });

  it('opens on degraded only after it has lasted 20 seconds', () => {
    expect(evaluateChecks(seq('degraded'), none, cfg)).toBe('none');
    expect(evaluateChecks(seq('degraded', 'degraded', 'operational'), none, cfg)).toBe('none');
    expect(evaluateChecks(seq('degraded', 'degraded', 'degraded'), none, cfg)).toBe('open');
    expect(evaluateChecks(seq('degraded', 'outage', 'degraded'), none, cfg)).toBe('open');
  });

  it('is not sped up by extra checks in between', () => {
    // Six "Run checks now" clicks two seconds apart: 10 s of degraded, however many checks.
    expect(evaluateChecks(spaced(2_000, 'degraded', 'degraded', 'degraded', 'degraded', 'degraded', 'degraded'), none, cfg)).toBe('none');
    const recovering = [...spaced(2_000, 'operational', 'operational', 'operational', 'operational'), { status: 'outage' as const, checkedAt: 0 }];
    expect(evaluateChecks(recovering, mine, cfg)).toBe('none');
  });

  it('tolerates timer jitter at the threshold', () => {
    expect(evaluateChecks(spaced(9_990, 'degraded', 'degraded', 'degraded'), none, cfg)).toBe('open');
  });

  it('attaches to an incident opened from tickets', () => {
    expect(evaluateChecks(seq('outage'), fromTickets, cfg)).toBe('attach');
  });

  it('does nothing while the problem continues', () => {
    expect(evaluateChecks(seq('outage', 'outage'), mine, cfg)).toBe('none');
    expect(evaluateChecks(seq('degraded', 'degraded', 'degraded'), mine, cfg)).toBe('none');
  });

  it('records worsening from degraded to outage', () => {
    expect(evaluateChecks(seq('outage', 'degraded', 'degraded'), mine, cfg)).toBe('worsened');
  });

  it('notes recovery once, after 30 seconds operational', () => {
    expect(evaluateChecks(seq('operational', 'operational', 'operational', 'outage'), mine, cfg)).toBe('none');
    expect(evaluateChecks(seq('operational', 'operational', 'operational', 'operational', 'outage'), mine, cfg)).toBe('recovered');
    expect(
      evaluateChecks(seq('operational', 'operational', 'operational', 'operational', 'operational', 'outage'), { ...mine, recovered: true }, cfg),
    ).toBe('none');
  });

  it('never acts on unknown, and skips a short run of it', () => {
    expect(evaluateChecks(seq('unknown', 'outage'), none, cfg)).toBe('none');
    expect(evaluateChecks(seq('degraded', 'unknown', 'degraded'), none, cfg)).toBe('open');
    expect(evaluateChecks(seq('degraded', 'unknown', 'unknown'), none, cfg)).toBe('none');
  });

  it('does not count a gap with no readings as the problem lasting', () => {
    // Degraded, then nothing known for a minute (source failing, server stopped), then degraded again.
    expect(evaluateChecks(seq('degraded', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'degraded'), none, cfg)).toBe('none');
    const restart = [{ status: 'degraded' as const, checkedAt: 4_000_000 }, { status: 'degraded' as const, checkedAt: 400_000 }];
    expect(evaluateChecks(restart, none, cfg)).toBe('none');
    const recoveredAcrossStop = [{ status: 'operational' as const, checkedAt: 4_000_000 }, { status: 'operational' as const, checkedAt: 400_000 }];
    expect(evaluateChecks(recoveredAcrossStop, mine, cfg)).toBe('none');
  });

  it('does not report recovery for an incident the monitor never saw', () => {
    expect(evaluateChecks(seq('operational', 'operational', 'operational', 'operational', 'outage'), fromTickets, cfg)).toBe('none');
  });

  it('opens at once and recovers at once with zero durations', () => {
    const instant = { degradedMs: 0, recoveryMs: 0, maxGapMs: 21_000 };
    expect(evaluateChecks(seq('degraded'), none, instant)).toBe('open');
    expect(evaluateChecks(seq('operational', 'degraded'), mine, instant)).toBe('recovered');
  });
});

describe('formatDuration', () => {
  it('reads naturally', () => {
    expect([1_000, 20_000, 60_000, 90_000, 120_000].map(formatDuration)).toEqual([
      '1 second',
      '20 seconds',
      '1 minute',
      '1 minute 30 seconds',
      '2 minutes',
    ]);
  });
});

describe('sources', () => {
  it('maps Statuspage indicators', () => {
    expect(['none', 'minor', 'major', 'critical', 'weird'].map(mapStatuspageIndicator)).toEqual([
      'operational',
      'degraded',
      'outage',
      'outage',
      'unknown',
    ]);
  });

  it('reads a Statuspage feed', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ status: { indicator: 'major', description: 'Partial outage' } }))) as typeof fetch;
    const res = await new StatuspageSource('https://status.example', fetchFn).check();
    expect(res).toMatchObject({ status: 'outage', detail: 'Partial outage' });
  });

  it('throws on a broken Statuspage response so the monitor records unknown', async () => {
    const fetchFn = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    await expect(new StatuspageSource('https://status.example', fetchFn).check()).rejects.toThrow('HTTP 502');
  });

  it('classifies probe responses', () => {
    expect(classifyProbe(200, 100, 2000).status).toBe('operational');
    expect(classifyProbe(200, 3000, 2000).status).toBe('degraded');
    expect(classifyProbe(429, 100, 2000).status).toBe('degraded');
    expect(classifyProbe(503, 100, 2000).status).toBe('outage');
    expect(() => classifyProbe(404, 100, 2000)).toThrow('misconfigured');
  });

  it('treats a probe timeout as an outage but a connection error as a source failure', async () => {
    const timeout = (async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as typeof fetch;
    expect((await new HttpProbeSource('https://x', 2000, timeout).check()).status).toBe('outage');

    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(new HttpProbeSource('https://x', 2000, refused).check()).rejects.toThrow('fetch failed');
  });
});

describe('PlatformMonitor', () => {
  const setup = () => {
    const ctx = makeCtx();
    const sources = new Map<MonitoredPlatform, StatusSource>([['Instagram', new SimulatedSource(ctx.db)]]);
    const monitor = new PlatformMonitor(ctx, sources);
    const tick = async () => {
      ctx.clock.now += 10_000;
      await monitor.runOnce();
    };
    return { ctx, monitor, tick };
  };

  it('opens one incident on outage, links earlier reports, and notes recovery', async () => {
    const { ctx, tick } = setup();
    const worker = new Worker(ctx);
    // Two earlier Instagram publishing reports, below the ticket cluster threshold.
    for (const [i, clientId] of ['aurora-vance', 'nova-kim'].entries()) {
      insertTicketWithJob(
        ctx.db,
        { externalId: `t${i}`, clientId, channel: 'email', subject: 'Post failed', body: 'My Instagram post failed to publish this morning.', receivedAt: ctx.clock.now - 60_000 },
        ctx.clock.now,
      );
    }
    await worker.drain();
    expect(listIncidents(ctx.db)).toHaveLength(0);

    await tick();
    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'outage', 'Graph API 503');
    await tick();
    await tick();

    const incidents = listIncidents(ctx.db);
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(inc).toMatchObject({ kind: 'platform', platform: 'Instagram', category: 'Publishing & Scheduling', ticketCount: 2 });
    expect(new Set(inc.sources)).toEqual(new Set(['monitor', 'tickets']));

    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'operational');
    for (let i = 0; i < 5; i++) await tick();
    const messages = incidentEvents(ctx.db, inc.id).map((e) => e.message);
    expect(messages.filter((m) => m.includes('operational for 30 seconds'))).toHaveLength(1);
    // Recovery is a note; Ops resolves.
    expect(findActiveIncident(ctx.db, { kind: 'platform', platform: 'Instagram', category: 'Publishing & Scheduling' })?.status).toBe('open');
  });

  it('records a failing source as unknown and opens nothing', async () => {
    const { ctx, monitor, tick } = setup();
    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'unknown', 'Status page timed out');
    await tick();
    await tick();
    expect(listIncidents(ctx.db)).toHaveLength(0);
    const cell = monitor.board().find((b) => b.component === 'publishing')!;
    expect(cell.latest).toMatchObject({ status: 'unknown' });
    expect(cell.latest?.detail).toContain('Status page timed out');
  });

  it('does not reopen an incident resolved during the same outage, but opens one for a new outage', async () => {
    const { ctx, tick } = setup();
    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'outage', 'Graph API 503');
    await tick();
    const [first] = listIncidents(ctx.db);
    setIncidentStatus(ctx.db, first!.id, 'resolved', ctx.clock.now);
    await tick();
    await tick();
    expect(listIncidents(ctx.db)).toHaveLength(1);

    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'operational');
    await tick();
    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'outage', 'Graph API 503');
    await tick();
    expect(listIncidents(ctx.db)).toHaveLength(2);
  });

  it('opens again when a degradation Ops resolved turns into an outage', async () => {
    const { ctx, tick } = setup();
    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'degraded', 'slow');
    for (let i = 0; i < 3; i++) await tick();
    const [first] = listIncidents(ctx.db);
    setIncidentStatus(ctx.db, first!.id, 'resolved', ctx.clock.now);
    await tick();
    expect(listIncidents(ctx.db)).toHaveLength(1);

    setSimulatedStatus(ctx.db, 'Instagram', 'publishing', 'outage', 'Graph API 503');
    await tick();
    expect(listIncidents(ctx.db)).toHaveLength(2);
    expect(listIncidents(ctx.db)[0]).toMatchObject({ status: 'open', title: expect.stringContaining('outage') });
  });

  it('maps analytics problems to the analytics category', async () => {
    const { ctx, tick } = setup();
    setSimulatedStatus(ctx.db, 'Instagram', 'analytics', 'degraded');
    await tick();
    await tick();
    expect(listIncidents(ctx.db)).toHaveLength(0); // degraded for 10 s
    await tick();
    expect(listIncidents(ctx.db)[0]).toMatchObject({ category: 'Analytics & Reporting' });
  });
});
