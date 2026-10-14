import type { Db } from './db/index.ts';
import { jobCounts } from './db/repo.ts';

type Row = Record<string, unknown>;

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export interface Metrics {
  windowHours: number;
  ai: {
    purpose: string;
    calls: number;
    errors: number;
    invalidOutputs: number;
    p50Ms: number | null;
    p95Ms: number | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[];
  aiCostUsd: number;
  aiCostPerTicketUsd: number | null;
  tickets: {
    total: number;
    triaged: number;
    suggested: number;
    escalated: number;
    escalationRate: number | null;
    failed: number;
    timeToTriageP50Ms: number | null;
    timeToTriageP95Ms: number | null;
  };
  escalationReasons: { reason: string; count: number }[];
  reviews: {
    tier: string;
    reviewed: number;
    approved: number;
    edited: number;
    rejected: number;
    acceptanceRate: number | null;
    avgEditDistance: number | null;
  }[];
  queue: ReturnType<typeof jobCounts>;
  incidents: { open: number; acknowledged: number; clientWatches: number };
}

const rate = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);

export function computeMetrics(db: Db, now: number, windowHours = 24): Metrics {
  const since = now - windowHours * 3_600_000;

  const calls = db.prepare('SELECT purpose, status, latency_ms, input_tokens, output_tokens, cost_usd FROM ai_calls WHERE created_at >= ?').all(since) as Row[];
  const byPurpose = new Map<string, Row[]>();
  for (const c of calls) byPurpose.set(c.purpose as string, [...(byPurpose.get(c.purpose as string) ?? []), c]);
  const ai = [...byPurpose].map(([purpose, rows]) => {
    const ok = rows.filter((r) => r.status === 'ok').map((r) => r.latency_ms as number).sort((a, b) => a - b);
    return {
      purpose,
      calls: rows.length,
      errors: rows.filter((r) => r.status === 'error').length,
      invalidOutputs: rows.filter((r) => r.status === 'invalid_output').length,
      p50Ms: percentile(ok, 50),
      p95Ms: percentile(ok, 95),
      inputTokens: rows.reduce((s, r) => s + (r.input_tokens as number), 0),
      outputTokens: rows.reduce((s, r) => s + (r.output_tokens as number), 0),
      costUsd: rows.reduce((s, r) => s + (r.cost_usd as number), 0),
    };
  });
  const aiCostUsd = ai.reduce((s, a) => s + a.costUsd, 0);

  const tickets = db.prepare('SELECT route, route_reasons, pipeline_status, created_at, triaged_at FROM tickets WHERE created_at >= ?').all(since) as Row[];
  const triaged = tickets.filter((t) => t.triaged_at !== null);
  const escalated = triaged.filter((t) => t.route === 'escalate');
  const ttt = triaged.map((t) => (t.triaged_at as number) - (t.created_at as number)).sort((a, b) => a - b);

  const reasonCounts = new Map<string, number>();
  for (const t of escalated) {
    for (const r of JSON.parse(t.route_reasons as string) as string[]) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }

  const reviewRows = db
    .prepare(
      `SELECT c.tier, r.action, r.edit_distance FROM reviews r
       JOIN tickets t ON t.id = r.ticket_id JOIN clients c ON c.id = t.client_id
       WHERE r.created_at >= ?`,
    )
    .all(since) as Row[];
  const reviews = ['all', 'platinum', 'gold', 'standard'].map((tier) => {
    const rows = tier === 'all' ? reviewRows : reviewRows.filter((r) => r.tier === tier);
    const edited = rows.filter((r) => r.action === 'edited');
    const distances = edited.map((r) => r.edit_distance).filter((d): d is number => typeof d === 'number');
    const approved = rows.filter((r) => r.action === 'approved').length;
    return {
      tier,
      reviewed: rows.length,
      approved,
      edited: edited.length,
      rejected: rows.filter((r) => r.action === 'rejected').length,
      acceptanceRate: rate(approved, rows.length),
      avgEditDistance: distances.length ? Math.round(distances.reduce((s, d) => s + d, 0) / distances.length) : null,
    };
  });

  const inc = db.prepare(`SELECT kind, status, COUNT(*) AS n FROM incidents WHERE status != 'resolved' GROUP BY kind, status`).all() as Row[];
  const count = (pred: (r: Row) => boolean) => inc.filter(pred).reduce((s, r) => s + (r.n as number), 0);

  return {
    windowHours,
    ai,
    aiCostUsd,
    aiCostPerTicketUsd: triaged.length ? aiCostUsd / triaged.length : null,
    tickets: {
      total: tickets.length,
      triaged: triaged.length,
      suggested: triaged.length - escalated.length,
      escalated: escalated.length,
      escalationRate: rate(escalated.length, triaged.length),
      failed: tickets.filter((t) => t.pipeline_status === 'failed').length,
      timeToTriageP50Ms: percentile(ttt, 50),
      timeToTriageP95Ms: percentile(ttt, 95),
    },
    escalationReasons: [...reasonCounts].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
    reviews,
    queue: jobCounts(db),
    incidents: {
      open: count((r) => r.kind === 'platform' && r.status === 'open'),
      acknowledged: count((r) => r.kind === 'platform' && r.status === 'acknowledged'),
      clientWatches: count((r) => r.kind === 'client_watch'),
    },
  };
}
