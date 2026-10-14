import type { Db } from './index.ts';
import { transaction } from './index.ts';
import type {
  Category,
  Client,
  Component,
  MonitoredPlatform,
  PipelineStatus,
  PlatformStatus,
  Platform,
  Priority,
  RequestedAction,
  ReviewStatus,
  Route,
} from '../domain.ts';

type Row = Record<string, unknown>;

const json = <T>(v: unknown, fallback: T): T => (typeof v === 'string' ? (JSON.parse(v) as T) : fallback);

// ---------- clients ----------

function toClient(r: Row): Client {
  return {
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as Client['kind'],
    tier: r.tier as Client['tier'],
    industry: r.industry as string,
    coordinator: r.coordinator as string,
    aliases: json<string[]>(r.aliases, []),
    platforms: json<Platform[]>(r.platforms, []),
    contactEmail: (r.contact_email as string | null) ?? null,
  };
}

export function upsertClient(db: Db, c: Client): void {
  db.prepare(
    `INSERT INTO clients (id, name, kind, tier, industry, coordinator, aliases, platforms, contact_email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, tier=excluded.tier,
       industry=excluded.industry, coordinator=excluded.coordinator, aliases=excluded.aliases,
       platforms=excluded.platforms, contact_email=excluded.contact_email`,
  ).run(c.id, c.name, c.kind, c.tier, c.industry, c.coordinator, JSON.stringify(c.aliases), JSON.stringify(c.platforms), c.contactEmail);
}

/** Fills contact emails on clients seeded before the column existed. Never overwrites one already set. */
export function backfillContactEmail(db: Db, clientId: string, email: string): void {
  db.prepare('UPDATE clients SET contact_email = ? WHERE id = ? AND contact_email IS NULL').run(email, clientId);
}

export function listClients(db: Db): Client[] {
  return (db.prepare('SELECT * FROM clients ORDER BY name').all() as Row[]).map(toClient);
}

export function getClient(db: Db, id: string): Client | undefined {
  const r = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as Row | undefined;
  return r ? toClient(r) : undefined;
}

export function countClients(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n;
}

// ---------- tickets ----------

export interface Ticket {
  id: number;
  externalId: string;
  clientId: string;
  channel: 'email' | 'portal';
  subject: string;
  body: string;
  receivedAt: number;
  pipelineStatus: PipelineStatus;
  redactedText: string | null;
  piiKinds: string[];
  route: Route | null;
  routeReasons: string[];
  effectivePriority: Priority | null;
  reviewStatus: ReviewStatus;
  incidentId: number | null;
  triagedAt: number | null;
  createdAt: number;
}

function toTicket(r: Row): Ticket {
  return {
    id: r.id as number,
    externalId: r.external_id as string,
    clientId: r.client_id as string,
    channel: r.channel as Ticket['channel'],
    subject: r.subject as string,
    body: r.body as string,
    receivedAt: r.received_at as number,
    pipelineStatus: r.pipeline_status as PipelineStatus,
    redactedText: (r.redacted_text as string | null) ?? null,
    piiKinds: json<string[]>(r.pii_kinds, []),
    route: (r.route as Route | null) ?? null,
    routeReasons: json<string[]>(r.route_reasons, []),
    effectivePriority: (r.effective_priority as Priority | null) ?? null,
    reviewStatus: r.review_status as ReviewStatus,
    incidentId: (r.incident_id as number | null) ?? null,
    triagedAt: (r.triaged_at as number | null) ?? null,
    createdAt: r.created_at as number,
  };
}

export interface NewTicket {
  externalId: string;
  clientId: string;
  channel: 'email' | 'portal';
  subject: string;
  body: string;
  receivedAt: number;
}

/** Inserts the ticket and its triage job atomically. Returns the existing ticket on duplicate external_id. */
export function insertTicketWithJob(db: Db, t: NewTicket, now: number): { ticket: Ticket; created: boolean } {
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM tickets WHERE external_id = ?').get(t.externalId) as Row | undefined;
    if (existing) return { ticket: toTicket(existing), created: false };
    const res = db
      .prepare(
        `INSERT INTO tickets (external_id, client_id, channel, subject, body, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.externalId, t.clientId, t.channel, t.subject, t.body, t.receivedAt, now);
    const id = Number(res.lastInsertRowid);
    enqueueJob(db, 'triage', id, now);
    return { ticket: getTicket(db, id)!, created: true };
  });
}

export function getTicket(db: Db, id: number): Ticket | undefined {
  const r = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row | undefined;
  return r ? toTicket(r) : undefined;
}

export interface TicketListItem extends Ticket {
  clientName: string;
  clientTier: Client['tier'];
  category: Category | null;
  platform: Platform | null;
  summary: string | null;
  requestedAction: RequestedAction | null;
  incidentKind: IncidentKind | null;
}

const TICKET_LIST_SQL = `SELECT t.*, c.name AS client_name, c.tier AS client_tier,
         cl.category, cl.platform, cl.summary, cl.requested_action, i.kind AS incident_kind
  FROM tickets t
  JOIN clients c ON c.id = t.client_id
  LEFT JOIN classifications cl ON cl.ticket_id = t.id
  LEFT JOIN incidents i ON i.id = t.incident_id`;

export function listTickets(db: Db, limit = 200): TicketListItem[] {
  return toTicketListItems(db.prepare(`${TICKET_LIST_SQL} ORDER BY t.received_at DESC LIMIT ?`).all(limit) as Row[]);
}

function toTicketListItems(rows: Row[]): TicketListItem[] {
  return rows.map((r) => ({
    ...toTicket(r),
    clientName: r.client_name as string,
    clientTier: r.client_tier as Client['tier'],
    category: (r.category as Category | null) ?? null,
    platform: (r.platform as Platform | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    requestedAction: (r.requested_action as RequestedAction | null) ?? null,
    incidentKind: (r.incident_kind as IncidentKind | null) ?? null,
  }));
}

export function setPipelineStatus(db: Db, id: number, status: PipelineStatus): void {
  db.prepare('UPDATE tickets SET pipeline_status = ? WHERE id = ?').run(status, id);
}

export function saveRedaction(db: Db, id: number, redactedText: string, piiKinds: string[]): void {
  db.prepare('UPDATE tickets SET redacted_text = ?, pii_kinds = ? WHERE id = ?').run(
    redactedText,
    JSON.stringify(piiKinds),
    id,
  );
}

export function saveRoute(
  db: Db,
  id: number,
  r: { route: Route; reasons: string[]; effectivePriority: Priority | null; status: PipelineStatus; at: number },
): void {
  db.prepare(
    `UPDATE tickets SET route = ?, route_reasons = ?, effective_priority = ?, pipeline_status = ?, triaged_at = ?
     WHERE id = ?`,
  ).run(r.route, JSON.stringify(r.reasons), r.effectivePriority, r.status, r.at, id);
}

export function resetTicketForRetriage(db: Db, id: number, now: number): void {
  transaction(db, () => {
    db.prepare('DELETE FROM classifications WHERE ticket_id = ?').run(id);
    db.prepare('DELETE FROM drafts WHERE ticket_id = ?').run(id);
    db.prepare(
      `UPDATE tickets SET pipeline_status = 'queued', route = NULL, route_reasons = '[]', effective_priority = NULL,
       review_status = 'pending', triaged_at = NULL WHERE id = ?`,
    ).run(id);
    enqueueJob(db, 'triage', id, now);
  });
}

export function setReviewStatus(db: Db, id: number, status: ReviewStatus): void {
  db.prepare('UPDATE tickets SET review_status = ? WHERE id = ?').run(status, id);
}

export function unlinkTicketFromIncident(db: Db, ticketId: number): void {
  db.prepare('UPDATE tickets SET incident_id = NULL WHERE id = ?').run(ticketId);
}

export function linkTicketsToIncident(db: Db, ticketIds: number[], incidentId: number): void {
  const stmt = db.prepare('UPDATE tickets SET incident_id = ? WHERE id = ?');
  for (const id of ticketIds) stmt.run(incidentId, id);
}

// ---------- classifications ----------

export interface Classification {
  category: Category;
  platform: Platform;
  priority: Priority;
  sentiment: string;
  requestedAction: RequestedAction;
  summary: string;
  language: string;
  confidence: number;
  rationale: string;
}

export interface StoredClassification extends Classification {
  ticketId: number;
  model: string;
  promptVersion: string;
  createdAt: number;
}

export function saveClassification(
  db: Db,
  ticketId: number,
  c: Classification,
  meta: { model: string; promptVersion: string; at: number },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO classifications
     (ticket_id, category, platform, priority, sentiment, requested_action, summary, language, confidence, rationale,
      model, prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ticketId,
    c.category,
    c.platform,
    c.priority,
    c.sentiment,
    c.requestedAction,
    c.summary,
    c.language,
    c.confidence,
    c.rationale,
    meta.model,
    meta.promptVersion,
    meta.at,
  );
}

export function getClassification(db: Db, ticketId: number): StoredClassification | undefined {
  const r = db.prepare('SELECT * FROM classifications WHERE ticket_id = ?').get(ticketId) as Row | undefined;
  if (!r) return undefined;
  return {
    ticketId,
    category: r.category as Category,
    platform: r.platform as Platform,
    priority: r.priority as Priority,
    sentiment: r.sentiment as string,
    requestedAction: r.requested_action as RequestedAction,
    summary: r.summary as string,
    language: r.language as string,
    confidence: r.confidence as number,
    rationale: r.rationale as string,
    model: r.model as string,
    promptVersion: r.prompt_version as string,
    createdAt: r.created_at as number,
  };
}

// ---------- drafts ----------

export interface StoredDraft {
  ticketId: number;
  body: string;
  citations: string[];
  droppedCitations: string[];
  grounded: boolean;
  confidence: number;
  missingInfo: string[];
  internalNote: string;
  model: string;
  promptVersion: string;
  createdAt: number;
}

export function saveDraft(db: Db, d: StoredDraft): void {
  db.prepare(
    `INSERT OR REPLACE INTO drafts
     (ticket_id, body, citations, dropped_citations, grounded, confidence, missing_info, internal_note, model,
      prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.ticketId,
    d.body,
    JSON.stringify(d.citations),
    JSON.stringify(d.droppedCitations),
    d.grounded ? 1 : 0,
    d.confidence,
    JSON.stringify(d.missingInfo),
    d.internalNote,
    d.model,
    d.promptVersion,
    d.createdAt,
  );
}

export function getDraft(db: Db, ticketId: number): StoredDraft | undefined {
  const r = db.prepare('SELECT * FROM drafts WHERE ticket_id = ?').get(ticketId) as Row | undefined;
  if (!r) return undefined;
  return {
    ticketId,
    body: r.body as string,
    citations: json<string[]>(r.citations, []),
    droppedCitations: json<string[]>(r.dropped_citations, []),
    grounded: r.grounded === 1,
    confidence: r.confidence as number,
    missingInfo: json<string[]>(r.missing_info, []),
    internalNote: r.internal_note as string,
    model: r.model as string,
    promptVersion: r.prompt_version as string,
    createdAt: r.created_at as number,
  };
}

// ---------- reviews ----------

export interface Review {
  id: number;
  ticketId: number;
  action: 'approved' | 'edited' | 'rejected';
  finalBody: string | null;
  editDistance: number | null;
  reviewer: string;
  note: string | null;
  createdAt: number;
}

export function insertReview(db: Db, r: Omit<Review, 'id'>): void {
  transaction(db, () => {
    db.prepare(
      `INSERT INTO reviews (ticket_id, action, final_body, edit_distance, reviewer, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.ticketId, r.action, r.finalBody, r.editDistance, r.reviewer, r.note, r.createdAt);
    setReviewStatus(db, r.ticketId, r.action);
  });
}

export function listReviews(db: Db, ticketId: number): Review[] {
  return (db.prepare('SELECT * FROM reviews WHERE ticket_id = ? ORDER BY created_at').all(ticketId) as Row[]).map(
    (r) => ({
      id: r.id as number,
      ticketId: r.ticket_id as number,
      action: r.action as Review['action'],
      finalBody: (r.final_body as string | null) ?? null,
      editDistance: (r.edit_distance as number | null) ?? null,
      reviewer: r.reviewer as string,
      note: (r.note as string | null) ?? null,
      createdAt: r.created_at as number,
    }),
  );
}

// ---------- incidents ----------

export type IncidentKind = 'platform' | 'client_watch';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
export type IncidentSource = 'monitor' | 'tickets';

export interface Incident {
  id: number;
  kind: IncidentKind;
  status: IncidentStatus;
  platform: Platform;
  category: Category;
  clientId: string | null;
  title: string;
  brief: unknown;
  briefStatus: 'none' | 'pending' | 'ready' | 'failed';
  sources: IncidentSource[];
  createdAt: number;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
  /** Set when the monitor sees the platform healthy again; cleared if it fails again. */
  recoveredAt: number | null;
  ticketCount: number;
  clientCount: number;
}

const INCIDENT_SELECT = `
  SELECT i.*,
    (SELECT COUNT(*) FROM tickets t WHERE t.incident_id = i.id) AS ticket_count,
    (SELECT COUNT(DISTINCT t.client_id) FROM tickets t WHERE t.incident_id = i.id) AS client_count
  FROM incidents i`;

function toIncident(r: Row): Incident {
  return {
    id: r.id as number,
    kind: r.kind as IncidentKind,
    status: r.status as IncidentStatus,
    platform: r.platform as Platform,
    category: r.category as Category,
    clientId: (r.client_id as string | null) ?? null,
    title: r.title as string,
    brief: json<unknown>(r.brief, null),
    briefStatus: r.brief_status as Incident['briefStatus'],
    sources: json<IncidentSource[]>(r.sources, []),
    createdAt: r.created_at as number,
    acknowledgedAt: (r.acknowledged_at as number | null) ?? null,
    resolvedAt: (r.resolved_at as number | null) ?? null,
    recoveredAt: (r.recovered_at as number | null) ?? null,
    ticketCount: (r.ticket_count as number) ?? 0,
    clientCount: (r.client_count as number) ?? 0,
  };
}

export function createIncident(
  db: Db,
  i: {
    kind: IncidentKind;
    platform: Platform;
    category: Category;
    clientId: string | null;
    title: string;
    briefStatus: Incident['briefStatus'];
    source: IncidentSource;
    at: number;
  },
): number {
  const res = db
    .prepare(
      `INSERT INTO incidents (kind, platform, category, client_id, title, brief_status, sources, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(i.kind, i.platform, i.category, i.clientId, i.title, i.briefStatus, JSON.stringify([i.source]), i.at);
  return Number(res.lastInsertRowid);
}

export function addIncidentSource(db: Db, id: number, source: IncidentSource): boolean {
  const current = getIncident(db, id);
  if (!current || current.sources.includes(source)) return false;
  db.prepare('UPDATE incidents SET sources = ? WHERE id = ?').run(JSON.stringify([...current.sources, source]), id);
  return true;
}

export interface IncidentEvent {
  id: number;
  incidentId: number;
  source: 'monitor' | 'tickets' | 'ai' | 'human';
  message: string;
  createdAt: number;
}

export function addIncidentEvent(db: Db, e: Omit<IncidentEvent, 'id'>): void {
  db.prepare('INSERT INTO incident_events (incident_id, source, message, created_at) VALUES (?, ?, ?, ?)').run(
    e.incidentId,
    e.source,
    e.message,
    e.createdAt,
  );
}

export function incidentEvents(db: Db, incidentId: number): IncidentEvent[] {
  return (
    db.prepare('SELECT * FROM incident_events WHERE incident_id = ? ORDER BY created_at, id').all(incidentId) as Row[]
  ).map((r) => ({
    id: r.id as number,
    incidentId: r.incident_id as number,
    source: r.source as IncidentEvent['source'],
    message: r.message as string,
    createdAt: r.created_at as number,
  }));
}

export function getIncident(db: Db, id: number): Incident | undefined {
  const r = db.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).get(id) as Row | undefined;
  return r ? toIncident(r) : undefined;
}

export function listIncidents(db: Db): Incident[] {
  return (db.prepare(`${INCIDENT_SELECT} ORDER BY i.created_at DESC`).all() as Row[]).map(toIncident);
}

export function lastPlatformResolvedAt(db: Db, platform: Platform, category: Category): number | null {
  const r = db
    .prepare(`SELECT MAX(resolved_at) AS t FROM incidents WHERE kind = 'platform' AND platform = ? AND category = ?`)
    .get(platform, category) as { t: number | null };
  return r.t;
}

export function findActiveIncident(
  db: Db,
  q: { kind: IncidentKind; platform: Platform; category: Category; clientId?: string },
): Incident | undefined {
  const r = (
    q.kind === 'platform'
      ? db
          .prepare(`${INCIDENT_SELECT} WHERE i.kind = 'platform' AND i.status != 'resolved' AND i.platform = ? AND i.category = ?`)
          .get(q.platform, q.category)
      : db
          .prepare(
            `${INCIDENT_SELECT} WHERE i.kind = 'client_watch' AND i.status != 'resolved' AND i.platform = ? AND i.category = ? AND i.client_id = ?`,
          )
          .get(q.platform, q.category, q.clientId ?? null)
  ) as Row | undefined;
  return r ? toIncident(r) : undefined;
}

export function setIncidentBrief(db: Db, id: number, status: Incident['briefStatus'], brief: unknown, title?: string): void {
  db.prepare('UPDATE incidents SET brief_status = ?, brief = ?, title = COALESCE(?, title) WHERE id = ?').run(
    status,
    brief === null ? null : JSON.stringify(brief),
    title ?? null,
    id,
  );
}

export function setIncidentRecovered(db: Db, id: number, at: number | null): void {
  db.prepare('UPDATE incidents SET recovered_at = ? WHERE id = ?').run(at, id);
}

export function setIncidentStatus(db: Db, id: number, status: IncidentStatus, at: number): void {
  const col = status === 'acknowledged' ? 'acknowledged_at' : status === 'resolved' ? 'resolved_at' : null;
  if (col) db.prepare(`UPDATE incidents SET status = ?, ${col} = ? WHERE id = ?`).run(status, at, id);
  else db.prepare('UPDATE incidents SET status = ? WHERE id = ?').run(status, id);
}

export interface ClusterTicket {
  ticketId: number;
  clientId: string;
  clientTier: Client['tier'];
  receivedAt: number;
  incidentId: number | null;
  summary: string;
  priority: Priority;
}

/** Classified tickets with this platform and category received in [from, to]. */
export function clusterCandidates(
  db: Db,
  platform: Platform,
  category: Category,
  from: number,
  to = Number.MAX_SAFE_INTEGER,
): ClusterTicket[] {
  return (
    db
      .prepare(
        `SELECT t.id, t.client_id, c.tier, t.received_at, t.incident_id, cl.summary, cl.priority
         FROM tickets t
         JOIN classifications cl ON cl.ticket_id = t.id
         JOIN clients c ON c.id = t.client_id
         WHERE cl.platform = ? AND cl.category = ? AND t.received_at BETWEEN ? AND ?
         ORDER BY t.received_at`,
      )
      .all(platform, category, from, to) as Row[]
  ).map((r) => ({
    ticketId: r.id as number,
    clientId: r.client_id as string,
    clientTier: r.tier as Client['tier'],
    receivedAt: r.received_at as number,
    incidentId: (r.incident_id as number | null) ?? null,
    summary: r.summary as string,
    priority: r.priority as Priority,
  }));
}

export function incidentTickets(db: Db, incidentId: number): TicketListItem[] {
  return toTicketListItems(
    db.prepare(`${TICKET_LIST_SQL} WHERE t.incident_id = ? ORDER BY t.received_at DESC`).all(incidentId) as Row[],
  );
}

// ---------- jobs ----------

export type JobType = 'triage' | 'incident_brief';

export interface Job {
  id: number;
  type: JobType;
  refId: number;
  attempts: number;
}

export function enqueueJob(db: Db, type: JobType, refId: number, now: number): number {
  const res = db
    .prepare('INSERT INTO jobs (type, ref_id, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, refId, now, now, now);
  return Number(res.lastInsertRowid);
}

/** Atomically moves the oldest ready job to running and increments attempts. */
export function claimJob(db: Db, now: number): Job | undefined {
  return transaction(db, () => {
    const r = db
      .prepare(`SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY run_after, id LIMIT 1`)
      .get(now) as Row | undefined;
    if (!r) return undefined;
    db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(now, r.id as number);
    return { id: r.id as number, type: r.type as JobType, refId: r.ref_id as number, attempts: (r.attempts as number) + 1 };
  });
}

export function completeJob(db: Db, id: number, now: number): void {
  db.prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`).run(now, id);
}

export function retryJob(db: Db, id: number, error: string, runAfter: number, now: number): void {
  db.prepare(`UPDATE jobs SET status = 'queued', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?`).run(
    error,
    runAfter,
    now,
    id,
  );
}

export function failJob(db: Db, id: number, error: string, now: number): void {
  db.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(error, now, id);
}

/**
 * Jobs left in 'running' by a stopped process go back to the queue. A job that has used all its attempts fails
 * instead, so one that crashes the process every time cannot loop forever.
 */
export function requeueStaleJobs(db: Db, now: number, maxAttempts: number): { requeued: number; failed: Job[] } {
  return transaction(db, () => {
    const exhausted = (
      db.prepare(`SELECT * FROM jobs WHERE status = 'running' AND attempts >= ?`).all(maxAttempts) as Row[]
    ).map((r) => ({ id: r.id as number, type: r.type as JobType, refId: r.ref_id as number, attempts: r.attempts as number }));
    db.prepare(
      `UPDATE jobs SET status = 'failed', last_error = 'interrupted on every attempt', updated_at = ?
       WHERE status = 'running' AND attempts >= ?`,
    ).run(now, maxAttempts);
    const res = db.prepare(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'`).run(now);
    return { requeued: Number(res.changes), failed: exhausted };
  });
}

export function jobCounts(db: Db): Record<'queued' | 'running' | 'done' | 'failed', number> {
  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as Row[]) {
    counts[r.status as keyof typeof counts] = r.n as number;
  }
  return counts;
}

export function failedJobsSince(db: Db, since: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND updated_at >= ?`).get(since) as { n: number }).n;
}

export function nextJobDelay(db: Db, now: number): number | undefined {
  const r = db.prepare(`SELECT MIN(run_after) AS t FROM jobs WHERE status = 'queued'`).get() as { t: number | null };
  return r.t === null ? undefined : Math.max(0, r.t - now);
}

// ---------- ai_calls ----------

export interface AiCall {
  ticketId: number | null;
  incidentId: number | null;
  purpose: string;
  model: string;
  promptVersion: string;
  attempt: number;
  status: 'ok' | 'invalid_output' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  error: string | null;
  createdAt: number;
}

export function insertAiCall(db: Db, c: AiCall): void {
  db.prepare(
    `INSERT INTO ai_calls (ticket_id, incident_id, purpose, model, prompt_version, attempt, status, input_tokens,
       output_tokens, latency_ms, cost_usd, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.ticketId,
    c.incidentId,
    c.purpose,
    c.model,
    c.promptVersion,
    c.attempt,
    c.status,
    c.inputTokens,
    c.outputTokens,
    c.latencyMs,
    c.costUsd,
    c.error,
    c.createdAt,
  );
}

function toAiCall(r: Row): AiCall & { id: number } {
  return {
    id: r.id as number,
    ticketId: (r.ticket_id as number | null) ?? null,
    incidentId: (r.incident_id as number | null) ?? null,
    purpose: r.purpose as string,
    model: r.model as string,
    promptVersion: r.prompt_version as string,
    attempt: r.attempt as number,
    status: r.status as AiCall['status'],
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    latencyMs: r.latency_ms as number,
    costUsd: r.cost_usd as number,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

export function aiCallsFor(db: Db, q: { ticketId?: number; incidentId?: number }): (AiCall & { id: number })[] {
  const rows = q.ticketId
    ? db.prepare('SELECT * FROM ai_calls WHERE ticket_id = ? ORDER BY id').all(q.ticketId)
    : db.prepare('SELECT * FROM ai_calls WHERE incident_id = ? ORDER BY id').all(q.incidentId ?? -1);
  return (rows as Row[]).map(toAiCall);
}

export function lastSuccessfulAiCallAt(db: Db): number | null {
  const r = db.prepare(`SELECT MAX(created_at) AS t FROM ai_calls WHERE status = 'ok'`).get() as { t: number | null };
  return r.t;
}

export interface AffectedClient {
  client: Client;
  reported: boolean;
  notifiedAt: number | null;
  notifiedBy: string | null;
}

const TIER_ORDER: Record<Client['tier'], number> = { platinum: 0, gold: 1, standard: 2 };

/** Clients that use the incident's platform, platinum first. Drives proactive outreach. */
export function affectedClients(db: Db, incident: Incident): AffectedClient[] {
  const reportedIds = new Set(
    (db.prepare('SELECT DISTINCT client_id FROM tickets WHERE incident_id = ?').all(incident.id) as Row[]).map(
      (r) => r.client_id as string,
    ),
  );
  const notified = new Map(
    (db.prepare('SELECT * FROM incident_notifications WHERE incident_id = ?').all(incident.id) as Row[]).map((r) => [
      r.client_id as string,
      { at: r.notified_at as number, by: r.notified_by as string },
    ]),
  );
  return listClients(db)
    .filter((c) =>
      incident.kind === 'client_watch' ? c.id === incident.clientId : c.platforms.includes(incident.platform) || reportedIds.has(c.id),
    )
    .map((client) => ({
      client,
      reported: reportedIds.has(client.id),
      notifiedAt: notified.get(client.id)?.at ?? null,
      notifiedBy: notified.get(client.id)?.by ?? null,
    }))
    .sort((a, b) => TIER_ORDER[a.client.tier] - TIER_ORDER[b.client.tier] || a.client.name.localeCompare(b.client.name));
}

export function markClientNotified(db: Db, incidentId: number, clientId: string, by: string, at: number): boolean {
  const res = db
    .prepare(
      `INSERT INTO incident_notifications (incident_id, client_id, notified_by, notified_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(incidentId, clientId, by, at);
  return Number(res.changes) > 0;
}

// ---------- outbound messages ----------

export type OutboundKind = 'outage' | 'all_clear';

export interface OutboundMessage {
  id: number;
  incidentId: number;
  clientId: string;
  kind: OutboundKind;
  channel: string;
  toAddress: string;
  subject: string;
  body: string;
  status: 'sending' | 'sent' | 'failed';
  error: string | null;
  providerId: string | null;
  sentBy: string;
  createdAt: number;
  updatedAt: number;
}

function toOutbound(r: Row): OutboundMessage {
  return {
    id: r.id as number,
    incidentId: r.incident_id as number,
    clientId: r.client_id as string,
    kind: r.kind as OutboundKind,
    channel: r.channel as string,
    toAddress: r.to_address as string,
    subject: r.subject as string,
    body: r.body as string,
    status: r.status as OutboundMessage['status'],
    error: (r.error as string | null) ?? null,
    providerId: (r.provider_id as string | null) ?? null,
    sentBy: r.sent_by as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

/**
 * Reserves the one message of this kind for this client and incident. Returns its id, or null if it was
 * already sent or is being sent. A failed message can be claimed again, which is how retries work.
 */
export function claimOutbound(
  db: Db,
  m: Pick<OutboundMessage, 'incidentId' | 'clientId' | 'kind' | 'channel' | 'toAddress' | 'subject' | 'body' | 'sentBy'>,
  now: number,
): number | null {
  const row = db
    .prepare(
      `INSERT INTO outbound_messages (incident_id, client_id, kind, channel, to_address, subject, body, status, sent_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)
       ON CONFLICT (incident_id, client_id, kind) DO UPDATE SET
         channel = excluded.channel, to_address = excluded.to_address, subject = excluded.subject, body = excluded.body,
         status = 'sending', error = NULL, sent_by = excluded.sent_by, updated_at = excluded.updated_at
       WHERE outbound_messages.status = 'failed'
       RETURNING id`,
    )
    .get(m.incidentId, m.clientId, m.kind, m.channel, m.toAddress, m.subject, m.body, m.sentBy, now, now) as { id: number } | undefined;
  return row?.id ?? null;
}

/** A notice left in 'sending' by a stopped process may not have gone out; marking it failed makes it retryable. */
export function failInterruptedOutbound(db: Db, now: number): number {
  const res = db
    .prepare(`UPDATE outbound_messages SET status = 'failed', error = 'Interrupted before delivery was confirmed', updated_at = ? WHERE status = 'sending'`)
    .run(now);
  return Number(res.changes);
}

export function finishOutbound(db: Db, id: number, result: { providerId: string | null } | { error: string }, now: number): void {
  if ('error' in result) {
    db.prepare(`UPDATE outbound_messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(result.error, now, id);
  } else {
    db.prepare(`UPDATE outbound_messages SET status = 'sent', provider_id = ?, updated_at = ? WHERE id = ?`).run(result.providerId, now, id);
  }
}

export function listOutbound(db: Db, incidentId: number): OutboundMessage[] {
  return (db.prepare('SELECT * FROM outbound_messages WHERE incident_id = ? ORDER BY id').all(incidentId) as Row[]).map(toOutbound);
}

// ---------- platform checks ----------

export interface PlatformCheck {
  platform: MonitoredPlatform;
  component: Component;
  source: string;
  status: PlatformStatus;
  detail: string;
  latencyMs: number | null;
  checkedAt: number;
}

function toCheck(r: Row): PlatformCheck {
  return {
    platform: r.platform as MonitoredPlatform,
    component: r.component as Component,
    source: r.source as string,
    status: r.status as PlatformStatus,
    detail: r.detail as string,
    latencyMs: (r.latency_ms as number | null) ?? null,
    checkedAt: r.checked_at as number,
  };
}

export function insertPlatformCheck(db: Db, c: PlatformCheck): void {
  db.prepare(
    `INSERT INTO platform_checks (platform, component, source, status, detail, latency_ms, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.platform, c.component, c.source, c.status, c.detail, c.latencyMs, c.checkedAt);
}

/** Most recent checks first. */
export function recentPlatformChecks(db: Db, platform: string, component: string, limit: number): PlatformCheck[] {
  return (
    db
      // Insertion order, not checked_at: a clock that steps back must not make an older check look newest.
      .prepare('SELECT * FROM platform_checks WHERE platform = ? AND component = ? ORDER BY id DESC LIMIT ?')
      .all(platform, component, limit) as Row[]
  ).map(toCheck);
}

/** Whether the component had an operational check after `since`. */
export function wasOperationalSince(db: Db, platform: string, component: string, since: number): boolean {
  return !!db
    .prepare(`SELECT 1 FROM platform_checks WHERE platform = ? AND component = ? AND status = 'operational' AND checked_at > ? LIMIT 1`)
    .get(platform, component, since);
}

/** The last non-unknown status at or before `at`, if any. */
export function lastKnownStatusBefore(db: Db, platform: string, component: string, at: number): string | null {
  const row = db
    .prepare(
      `SELECT status FROM platform_checks WHERE platform = ? AND component = ? AND status != 'unknown' AND checked_at <= ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(platform, component, at) as { status: string } | undefined;
  return row?.status ?? null;
}

export function prunePlatformChecks(db: Db, olderThan: number): void {
  db.prepare('DELETE FROM platform_checks WHERE checked_at < ?').run(olderThan);
}

// ---------- settings ----------

export function getSetting(db: Db, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}
