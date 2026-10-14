import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { costUsd, hasPrice } from '../server/ai/pricing.ts';
import { TokenBudget, callStructured, type CallContext } from '../server/ai/structured.ts';
import { AiError, type ModelClient, type ModelRequest, type ModelResponse } from '../server/ai/types.ts';
import { DEFAULT_OLLAMA_SMART, loadConfig } from '../server/config.ts';
import type { AiCall } from '../server/db/repo.ts';
import { enqueueJob, failJob, insertAiCall, insertTicketWithJob, saveRoute } from '../server/db/repo.ts';
import { createApp } from '../server/app.ts';
import { PlatformMonitor, sourcesFromConfig } from '../server/monitor/monitor.ts';
import { createServices } from '../server/services.ts';
import { higherPriority, plural, priorityRank } from '../server/domain.ts';
import { computeMetrics, percentile } from '../server/metrics.ts';
import { ms, pct, reasonLabel, timeAgo, usd } from '../server/views/ui.tsx';
import { makeCtx } from './helpers.ts';

describe('loadConfig', () => {
  it('defaults to Ollama even with a key, and uses Anthropic only when asked', () => {
    expect(loadConfig({}).aiMode).toBe('ollama');
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }).aiMode).toBe('ollama');
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', AI_MODE: 'anthropic' }).aiMode).toBe('anthropic');
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', AI_MODE: 'live' }).aiMode).toBe('anthropic');
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', AI_MODE: 'mock' }).aiMode).toBe('mock');
  });

  it('picks models for the active mode', () => {
    const anthropic = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', AI_MODE: 'anthropic' });
    expect([anthropic.modelFast, anthropic.modelSmart]).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    const ollama = loadConfig({ OLLAMA_MODEL_FAST: 'small:1b', MODEL_FAST: 'claude-x' });
    expect([ollama.modelFast, ollama.modelSmart]).toEqual(['small:1b', DEFAULT_OLLAMA_SMART]);
    expect(loadConfig({ AI_MODE: 'mock' }).modelFast).toBe('mock-fast');
  });

  it('gives local models a longer timeout unless one is set', () => {
    expect(loadConfig({}).aiTimeoutMs).toBe(180_000);
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', AI_MODE: 'anthropic' }).aiTimeoutMs).toBe(30_000);
    expect(loadConfig({ AI_TIMEOUT_MS: '5000' }).aiTimeoutMs).toBe(5000);
    expect(loadConfig({ OLLAMA_URL: 'http://gpu-box:11434/' }).ollamaUrl).toBe('http://gpu-box:11434');
  });

  it('fails fast on invalid settings instead of running misconfigured', () => {
    expect(() => loadConfig({ AI_MODE: 'turbo' })).toThrow(/AI_MODE/);
    expect(() => loadConfig({ AI_MODE: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ AI_MODE: 'live' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => loadConfig({ MONITOR_SOURCES: '{bad' })).toThrow(/MONITOR_SOURCES/);
    expect(() => loadConfig({ MONITOR_SOURCES: '{"X":{"type":"ftp"}}' })).toThrow(/unknown type/);
    expect(() => loadConfig({ MONITOR_SOURCES: '{"X":{"type":"statuspage"}}' })).toThrow(/url must be/);
    expect(() => loadConfig({ MONITOR_SOURCES: '{"X":{"type":"statuspage","url":"not a url"}}' })).toThrow(/url must be/);
    expect(() => loadConfig({ MONITOR_SOURCES: '{"instagram":{"type":"simulated"}}' })).toThrow(/unknown platform/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/at most 65535/);
    expect(() => loadConfig({ PORT: '1.5' })).toThrow(/whole number/);
    expect(() => loadConfig({ WORKER_CONCURRENCY: '1.5' })).toThrow(/whole number/);
    expect(() => loadConfig({ CONFIDENCE_THRESHOLD: '7' })).toThrow(/at most 1/);
    expect(() => loadConfig({ MONITOR_ENABLED: 'maybe' })).toThrow(/true or false/);
  });

  it('reads 0 and 1 as booleans', () => {
    expect(loadConfig({ MONITOR_ENABLED: '0', SEED_ON_START: '1' })).toMatchObject({ monitorEnabled: false, seedOnStart: true });
  });

  it('parses numbers and flags', () => {
    const c = loadConfig({ PORT: '9000', CONFIDENCE_THRESHOLD: '0.8', MONITOR_ENABLED: 'false', SEED_ON_START: 'false' });
    expect(c).toMatchObject({ port: 9000, confidenceThreshold: 0.8, monitorEnabled: false, seedOnStart: false });
  });
});

describe('pricing', () => {
  it('charges per million tokens and nothing for unknown or mock models', () => {
    expect(costUsd('claude-haiku-5-5', 1_000_000, 0)).toBe(1);
    expect(costUsd('claude-sonnet-5-5', 1000, 1000)).toBeCloseTo(0.018);
    expect(costUsd('mock-fast', 1_000_000, 1_000_000)).toBe(0);
    expect(hasPrice('claude-sonnet-5-5')).toBe(true);
    expect(hasPrice('mock-smart')).toBe(false);
  });
});

describe('TokenBudget', () => {
  it('throws a budget error once the limit is reached', () => {
    const b = new TokenBudget(100);
    b.add(99);
    expect(() => b.assertAvailable()).not.toThrow();
    b.add(1);
    expect(() => b.assertAvailable()).toThrow(AiError);
  });
});

describe('callStructured', () => {
  const schema = z.object({ answer: z.string() });
  const req = { purpose: 'classify' as const, model: 'claude-haiku-5-5', promptVersion: 'v', system: 's', user: 'u', schema, maxTokens: 100 };

  function ctxWith(responses: (ModelResponse | Error)[]) {
    const calls: AiCall[] = [];
    const requests: ModelRequest[] = [];
    const client: ModelClient = {
      name: 'test',
      async complete(r) {
        requests.push(structuredClone(r));
        const next = responses.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
    };
    const ctx: CallContext = { client, record: (c) => calls.push(c), timeoutMs: 1000, now: () => 0 };
    return { ctx, calls, requests };
  }

  const ok = (input: unknown, id: string | null = 'tu'): ModelResponse => ({ toolInput: input, toolUseId: id, inputTokens: 100, outputTokens: 50 });

  it('records cost and returns validated data', async () => {
    const { ctx, calls } = ctxWith([ok({ answer: 'yes' })]);
    const res = await callStructured(ctx, req);
    expect(res).toMatchObject({ data: { answer: 'yes' }, attempts: 1 });
    expect(calls[0]).toMatchObject({ status: 'ok', inputTokens: 100, outputTokens: 50 });
    expect(calls[0]!.costUsd).toBeCloseTo(0.00035);
  });

  it('retries once when the model answers without a tool call, then gives up', async () => {
    const { ctx, calls, requests } = ctxWith([ok(undefined, null), ok(undefined, null)]);
    await expect(callStructured(ctx, req)).rejects.toMatchObject({ kind: 'invalid_output' });
    expect(calls.map((c) => c.status)).toEqual(['invalid_output', 'invalid_output']);
    expect(requests[1]!.messages).toHaveLength(2);
    expect(requests[1]!.messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('calling the') });
  });

  it('accepts JSON-encoded fields without spending a repair turn', async () => {
    const nested = z.object({ items: z.array(z.string()) });
    const { ctx, calls } = ctxWith([ok({ items: '["a","b"]' })]);
    const res = await callStructured(ctx, { ...req, schema: nested });
    expect(res.data.items).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1);
  });

  it('records a transport error with zero tokens and rethrows it', async () => {
    const { ctx, calls } = ctxWith([new AiError('transient', 'HTTP 529: overloaded')]);
    await expect(callStructured(ctx, req)).rejects.toMatchObject({ kind: 'transient' });
    expect(calls[0]).toMatchObject({ status: 'error', inputTokens: 0, costUsd: 0 });
    expect(calls[0]!.error).toContain('529');
  });

  it('wraps unknown errors as transient so the worker retries them', async () => {
    const { ctx } = ctxWith([new TypeError('fetch failed')]);
    await expect(callStructured(ctx, req)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('stops before calling the model when the budget is spent', async () => {
    const { ctx, requests } = ctxWith([ok({ answer: 'yes' })]);
    const budget = new TokenBudget(10);
    budget.add(10);
    await expect(callStructured({ ...ctx, budget }, req)).rejects.toMatchObject({ kind: 'budget' });
    expect(requests).toHaveLength(0);
  });
});

describe('metrics', () => {
  it('percentile uses nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it('computes cost, escalation rate, and reasons inside the window only', () => {
    const ctx = makeCtx();
    const now = ctx.clock.now;
    const call = (createdAt: number, status: AiCall['status'], cost: number): AiCall => ({
      ticketId: null,
      incidentId: null,
      purpose: 'classify',
      model: 'claude-haiku-5-5',
      promptVersion: 'v',
      attempt: 1,
      status,
      inputTokens: 10,
      outputTokens: 10,
      latencyMs: 100,
      costUsd: cost,
      error: null,
      createdAt,
    });
    insertAiCall(ctx.db, call(now - 1000, 'ok', 0.01));
    insertAiCall(ctx.db, call(now - 1000, 'error', 0));
    insertAiCall(ctx.db, call(now - 48 * 3_600_000, 'ok', 5));

    const t1 = insertTicketWithJob(ctx.db, { externalId: 'm1', clientId: 'kingsley-motors', channel: 'email', subject: 's', body: 'b', receivedAt: now }, now).ticket.id;
    const t2 = insertTicketWithJob(ctx.db, { externalId: 'm2', clientId: 'nova-kim', channel: 'email', subject: 's', body: 'b', receivedAt: now }, now).ticket.id;
    saveRoute(ctx.db, t1, { route: 'escalate', reasons: ['priority:P1'], effectivePriority: 'P1', status: 'done', at: now + 2000 });
    saveRoute(ctx.db, t2, { route: 'suggest', reasons: [], effectivePriority: 'P3', status: 'done', at: now + 4000 });

    const m = computeMetrics(ctx.db, now + 5000);
    expect(m.aiCostUsd).toBeCloseTo(0.01);
    expect(m.ai[0]).toMatchObject({ purpose: 'classify', calls: 2, errors: 1 });
    expect(m.tickets).toMatchObject({ triaged: 2, escalated: 1, escalationRate: 0.5 });
    expect(m.escalationReasons).toEqual([{ reason: 'priority:P1', count: 1 }]);
    expect(m.aiCostPerTicketUsd).toBeCloseTo(0.005);
  });
});

describe('healthz', () => {
  it('is degraded by a recent job failure, and recovers after a minute', async () => {
    const ctx = makeCtx({ config: { monitorEnabled: false } });
    const services = createServices(ctx, { onNewWork: () => {}, runMonitor: () => {} });
    const app = createApp(ctx, services, new PlatformMonitor(ctx, sourcesFromConfig(ctx)));
    const job = enqueueJob(ctx.db, 'triage', 1, ctx.clock.now);
    failJob(ctx.db, job, 'HTTP 400', ctx.clock.now);

    const health = async () => (await (await app.request('/healthz')).json()) as { status: string; queue: { failed: number; failedLastMinute: number } };
    expect(await health()).toMatchObject({ status: 'degraded', queue: { failed: 1, failedLastMinute: 1 } });
    ctx.clock.now += 60_001;
    expect(await health()).toMatchObject({ status: 'ok', queue: { failed: 1, failedLastMinute: 0 } });
  });

  it('is degraded when the configured Ollama is not reachable', async () => {
    // Port 9 (discard) refuses connections, so the check fails fast.
    const ctx = makeCtx({ config: { monitorEnabled: false, aiMode: 'ollama', ollamaUrl: 'http://127.0.0.1:9' } });
    const services = createServices(ctx, { onNewWork: () => {}, runMonitor: () => {} });
    const app = createApp(ctx, services, new PlatformMonitor(ctx, sourcesFromConfig(ctx)));
    const body = (await (await app.request('/healthz')).json()) as { status: string; ai: { ollama: { reachable: boolean } } };
    expect(body.status).toBe('degraded');
    expect(body.ai.ollama.reachable).toBe(false);
  });
});

describe('domain helpers', () => {
  it('orders priorities with P1 highest', () => {
    expect(priorityRank('P1')).toBeLessThan(priorityRank('P4'));
    expect(higherPriority('P3', 'P2')).toBe('P2');
    expect(higherPriority('P1', 'P4')).toBe('P1');
  });

  it('pluralizes counts', () => {
    expect(plural(1, 'report')).toBe('1 report');
    expect(plural(0, 'report')).toBe('0 reports');
    expect(plural(6, 'monitor signal')).toBe('6 monitor signals');
  });
});

describe('view formatting', () => {
  const now = Date.UTC(2026, 9, 14, 12);
  it('formats relative times', () => {
    expect(timeAgo(null, now)).toBe('never');
    expect(timeAgo(now - 30_000, now)).toBe('30s ago');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 72 * 3_600_000, now)).toBe('3d ago');
    expect(timeAgo(now + 10_000, now)).toBe('0s ago');
  });

  it('formats money, durations, and rates', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(1.5)).toBe('$1.50');
    expect(ms(null)).toBe('-');
    expect(ms(420)).toBe('420 ms');
    expect(ms(11_100)).toBe('11.1 s');
    expect(pct(null)).toBe('-');
    expect(pct(0.456)).toBe('46%');
  });

  it('labels every gate reason code for coordinators', () => {
    expect(reasonLabel('priority:P1')).toBe('P1 priority');
    expect(reasonLabel('action:takedown')).toBe('Takedown requested');
    expect(reasonLabel('category:Billing & Contract')).toBe('Sensitive category: Billing & Contract');
    expect(reasonLabel('pii:card')).toBe('Card number in message');
    expect(reasonLabel('pii:credential')).toBe('Credential in message');
    expect(reasonLabel('prompt_injection_suspected')).toBe('Possible prompt injection');
    expect(reasonLabel('keyword:security')).toBe('Possible account compromise');
    expect(reasonLabel('keyword:press')).toBe('Mentions press');
    expect(reasonLabel('low_confidence:draft')).toBe('Low draft confidence');
    expect(reasonLabel('ungrounded_draft')).toBe('Draft not grounded in playbook');
    expect(reasonLabel('ai_failed:retries_exhausted')).toBe('AI unavailable after retries: manual triage');
    expect(reasonLabel('ai_failed:classify:invalid_output')).toBe('AI classify failed (invalid_output): manual triage');
    expect(reasonLabel('something_new')).toBe('something_new');
  });
});
