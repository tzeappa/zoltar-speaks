/**
 * Runs the 40 labeled seed requests through the real pipeline (classify, retrieve, draft, gate) in an in-memory DB
 * and compares against human labels.
 *
 *   npm run eval                          # Ollama, or Anthropic with AI_MODE=anthropic
 *   npm run eval -- --mock                # offline, deterministic
 *   AI_MODE=anthropic npm run eval -- --fast claude-sonnet-5-5   # compare a different classification model
 *   npm run eval -- --json out.json
 */
import { existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createModelClient } from '../server/ai/client.ts';
import { ollamaStatus } from '../server/ai/ollama.ts';
import { AiError } from '../server/ai/types.ts';
import { loadConfig } from '../server/config.ts';
import type { AppContext } from '../server/context.ts';
import { openDb } from '../server/db/index.ts';
import { aiCallsFor, getClassification, getTicket, insertTicketWithJob, upsertClient } from '../server/db/repo.ts';
import { priorityRank } from '../server/domain.ts';
import { silentLogger } from '../server/logger.ts';
import { percentile } from '../server/metrics.ts';
import { OutboxNotifier } from '../server/notify/notifier.ts';
import { decide, findRiskKeywords } from '../server/pipeline/gate.ts';
import { detectPromptInjection, redactPii } from '../server/pipeline/redact.ts';
import { createKbIndex, loadKb } from '../server/pipeline/retrieve.ts';
import { triageTicket } from '../server/pipeline/triage.ts';
import { CLIENTS } from '../server/seed/clients.ts';
import { SEED_TICKETS } from '../server/seed/tickets.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values: args } = parseArgs({
  options: {
    fast: { type: 'string' },
    smart: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    json: { type: 'string' },
    mock: { type: 'boolean', default: false },
  },
});

const base = loadConfig({ ...process.env, ...(args.mock ? { AI_MODE: 'mock' } : {}) });
if (base.aiMode === 'disabled') throw new Error('AI_MODE=disabled; nothing to evaluate');
const config = {
  ...base,
  modelFast: args.fast ?? base.modelFast,
  modelSmart: args.smart ?? base.modelSmart,
  mockLatencyMs: 0,
  seedOnStart: false,
};
if (config.aiMode === 'ollama') {
  const status = await ollamaStatus(config.ollamaUrl, [config.modelFast, config.modelSmart]);
  if (!status.reachable || status.missingModels.length) {
    console.error(status.reachable ? `Missing Ollama models: ${status.missingModels.join(', ')}` : `Ollama not reachable at ${config.ollamaUrl}`);
    console.error('Run `make services` first, or `npm run eval -- --mock` for an offline run.');
    process.exit(2);
  }
}

const db = openDb(':memory:');
for (const c of CLIENTS) upsertClient(db, c);
const now = Date.now();
const ctx: AppContext = {
  db,
  config,
  log: silentLogger,
  kb: createKbIndex(loadKb(), config, db, silentLogger),
  model: createModelClient(config),
  notifier: new OutboxNotifier(),
  now: Date.now,
};

const ids = new Map<string, number>();
for (const t of SEED_TICKETS) {
  const { ticket } = insertTicketWithJob(
    db,
    { externalId: t.id, clientId: t.clientId, channel: t.channel, subject: t.subject, body: t.body, receivedAt: now - t.minutesAgo * 60_000 },
    now,
  );
  ids.set(t.id, ticket.id);
}

async function runOne(ticketId: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await triageTicket(ctx, ticketId);
    } catch (err) {
      if (!(err instanceof AiError && err.kind === 'transient') || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

console.log(`Evaluating ${SEED_TICKETS.length} requests with ${config.modelFast} / ${config.modelSmart}...`);
const started = Date.now();
const queue = [...SEED_TICKETS];
await Promise.all(
  Array.from({ length: Number(args.concurrency) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        await runOne(ids.get(t.id)!);
        process.stdout.write('.');
      } catch (err) {
        process.stdout.write('x');
        console.error(`\n${t.id}: ${String(err)}`);
      }
    }
  }),
);
console.log(` ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

// ---------- score ----------

interface Row {
  id: string;
  category: [string, string | undefined];
  platform: [string, string | undefined];
  action: [string, string | undefined];
  priority: [string, string | undefined];
  expectedEscalate: boolean;
  escalated: boolean;
  reasons: string[];
}

const rows: Row[] = SEED_TICKETS.map((s) => {
  const id = ids.get(s.id)!;
  const t = getTicket(db, id)!;
  const c = getClassification(db, id);
  const client = CLIENTS.find((x) => x.id === s.clientId)!;
  const raw = `${s.subject}\n${s.body}`;
  // What the gate would decide with a perfect classifier and a perfect draft.
  const expected = decide({
    classification: {
      category: s.label.category,
      platform: s.label.platform,
      requestedAction: s.label.action,
      priority: s.label.priority,
      sentiment: 'neutral',
      summary: '',
      language: 'en',
      confidence: 1,
      rationale: '',
    },
    tier: client.tier,
    draft: { grounded: true, confidence: 1, citations: ['x'] },
    piiKinds: redactPii(raw).piiKinds,
    injectionSuspected: detectPromptInjection(raw),
    riskKeywords: findRiskKeywords(raw),
    aiFailure: null,
    confidenceThreshold: config.confidenceThreshold,
  });
  return {
    id: s.id,
    category: [s.label.category, c?.category],
    platform: [s.label.platform, c?.platform],
    action: [s.label.action, c?.requestedAction],
    priority: [s.label.priority, c?.priority],
    expectedEscalate: expected.route === 'escalate',
    escalated: t.route === 'escalate',
    reasons: t.routeReasons,
  };
});

const n = rows.length;
const acc = (f: (r: Row) => boolean) => rows.filter(f).length / n;
const exact = (k: 'category' | 'platform' | 'action' | 'priority') => acc((r) => r[k][0] === r[k][1]);
const withinOne = acc((r) => !!r.priority[1] && Math.abs(priorityRank(r.priority[0] as never) - priorityRank(r.priority[1] as never)) <= 1);

const mustEscalate = rows.filter((r) => r.expectedEscalate);
const safeToSuggest = rows.filter((r) => !r.expectedEscalate);
const recall = mustEscalate.filter((r) => r.escalated).length / (mustEscalate.length || 1);
const overEscalation = safeToSuggest.filter((r) => r.escalated).length / (safeToSuggest.length || 1);

const calls = SEED_TICKETS.flatMap((s) => aiCallsFor(db, { ticketId: ids.get(s.id)! }));
const latency = (purpose: string) =>
  calls
    .filter((c) => c.purpose === purpose && c.status === 'ok')
    .map((c) => c.latencyMs)
    .sort((a, b) => a - b);
const perTicket = SEED_TICKETS.map((s) => aiCallsFor(db, { ticketId: ids.get(s.id)! }).reduce((sum, c) => sum + c.latencyMs, 0)).sort(
  (a, b) => a - b,
);
const cost = calls.reduce((s, c) => s + c.costUsd, 0);
const invalid = calls.filter((c) => c.status === 'invalid_output').length;
const errors = calls.filter((c) => c.status === 'error').length;

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const ms = (x: number | null) => (x === null ? '-' : `${(x / 1000).toFixed(2)}s`);

const summary = {
  models: { fast: config.modelFast, smart: config.modelSmart },
  n,
  categoryAccuracy: exact('category'),
  platformAccuracy: exact('platform'),
  actionAccuracy: exact('action'),
  priorityExact: exact('priority'),
  priorityWithinOne: withinOne,
  escalationRecall: recall,
  mustEscalate: mustEscalate.length,
  missedEscalations: mustEscalate.filter((r) => !r.escalated).map((r) => r.id),
  overEscalationRate: overEscalation,
  invalidOutputs: invalid,
  errors,
  classifyP50Ms: percentile(latency('classify'), 50),
  classifyP95Ms: percentile(latency('classify'), 95),
  draftP50Ms: percentile(latency('draft'), 50),
  draftP95Ms: percentile(latency('draft'), 95),
  ticketP50Ms: percentile(perTicket, 50),
  ticketP95Ms: percentile(perTicket, 95),
  costUsd: cost,
  costPerTicketUsd: cost / n,
};

console.log(`| Metric | Value |
| --- | --- |
| Models | ${config.modelFast} / ${config.modelSmart} |
| Category accuracy | ${pct(summary.categoryAccuracy)} |
| Platform accuracy | ${pct(summary.platformAccuracy)} |
| Requested action accuracy | ${pct(summary.actionAccuracy)} |
| Priority exact / within one | ${pct(summary.priorityExact)} / ${pct(summary.priorityWithinOne)} |
| Escalation recall | ${pct(recall)} (${mustEscalate.length - summary.missedEscalations.length} of ${mustEscalate.length}) |
| Over-escalation | ${pct(overEscalation)} (${safeToSuggest.filter((r) => r.escalated).length} of ${safeToSuggest.length}) |
| Invalid outputs / errors | ${invalid} / ${errors} |
| Classify p50 / p95 | ${ms(summary.classifyP50Ms)} / ${ms(summary.classifyP95Ms)} |
| Draft p50 / p95 | ${ms(summary.draftP50Ms)} / ${ms(summary.draftP95Ms)} |
| Model time per request p50 / p95 | ${ms(summary.ticketP50Ms)} / ${ms(summary.ticketP95Ms)} |
| Cost per request | $${summary.costPerTicketUsd.toFixed(4)} |`);

const misses = rows.filter((r) => r.category[0] !== r.category[1] || (r.expectedEscalate && !r.escalated));
if (misses.length) {
  console.log('\nDisagreements (label -> model):');
  for (const r of misses) {
    const flags = [
      r.category[0] !== r.category[1] ? `category ${r.category[0]} -> ${r.category[1]}` : '',
      r.expectedEscalate && !r.escalated ? 'MISSED ESCALATION' : '',
    ].filter(Boolean);
    console.log(`  ${r.id}: ${flags.join('; ')}`);
  }
}

const failures = new Map<string, number>();
for (const c of calls.filter((x) => x.status !== 'ok')) {
  const key = `${c.purpose} ${c.status}: ${(c.error ?? '').split('\n')[0]!.slice(0, 160)}`;
  failures.set(key, (failures.get(key) ?? 0) + 1);
}
if (failures.size) {
  console.log('\nFailed calls:');
  for (const [k, v] of [...failures].sort((a, b) => b[1] - a[1])) console.log(`  ${v}x ${k}`);
}

if (args.json) {
  writeFileSync(args.json, JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nWrote ${args.json}`);
}
process.exit(summary.missedEscalations.length ? 1 : 0);
