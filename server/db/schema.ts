// Timestamps are epoch milliseconds.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('influencer', 'brand')),
  tier TEXT NOT NULL CHECK (tier IN ('platinum', 'gold', 'standard')),
  industry TEXT NOT NULL,
  coordinator TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  platforms TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(id),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'portal')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  pipeline_status TEXT NOT NULL DEFAULT 'queued',
  redacted_text TEXT,
  pii_kinds TEXT NOT NULL DEFAULT '[]',
  route TEXT,
  route_reasons TEXT NOT NULL DEFAULT '[]',
  effective_priority TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  incident_id INTEGER REFERENCES incidents(id),
  triaged_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_received ON tickets(received_at);
CREATE INDEX IF NOT EXISTS idx_tickets_incident ON tickets(incident_id);

CREATE TABLE IF NOT EXISTS classifications (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id),
  category TEXT NOT NULL,
  platform TEXT NOT NULL,
  priority TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  summary TEXT NOT NULL,
  language TEXT NOT NULL,
  confidence REAL NOT NULL,
  rationale TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_class_cluster ON classifications(platform, category);

CREATE TABLE IF NOT EXISTS drafts (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id),
  body TEXT NOT NULL,
  citations TEXT NOT NULL,
  dropped_citations TEXT NOT NULL DEFAULT '[]',
  grounded INTEGER NOT NULL,
  confidence REAL NOT NULL,
  missing_info TEXT NOT NULL DEFAULT '[]',
  internal_note TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  action TEXT NOT NULL CHECK (action IN ('approved', 'edited', 'rejected')),
  final_body TEXT,
  edit_distance INTEGER,
  reviewer TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_ticket ON reviews(ticket_id);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('platform', 'client_watch')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  platform TEXT NOT NULL,
  category TEXT NOT NULL,
  client_id TEXT REFERENCES clients(id),
  title TEXT NOT NULL,
  brief TEXT,
  brief_status TEXT NOT NULL DEFAULT 'none' CHECK (brief_status IN ('none', 'pending', 'ready', 'failed')),
  sources TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS incident_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  source TEXT NOT NULL CHECK (source IN ('monitor', 'tickets', 'ai', 'human')),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_events ON incident_events(incident_id, created_at);

CREATE TABLE IF NOT EXISTS incident_notifications (
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  notified_by TEXT NOT NULL,
  notified_at INTEGER NOT NULL,
  PRIMARY KEY (incident_id, client_id)
);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL CHECK (kind IN ('outage', 'all_clear')),
  channel TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  error TEXT,
  provider_id TEXT,
  sent_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (incident_id, client_id, kind)
);

CREATE TABLE IF NOT EXISTS platform_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('publishing', 'analytics')),
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('operational', 'degraded', 'outage', 'unknown')),
  detail TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_checks ON platform_checks(platform, component, checked_at);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('triage', 'incident_brief')),
  ref_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER,
  incident_id INTEGER,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'invalid_output', 'error')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_calls_ticket ON ai_calls(ticket_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Playbook vectors for hybrid search, so the playbook is embedded once per model and content version.
CREATE TABLE IF NOT EXISTS kb_embeddings (
  doc_id TEXT NOT NULL,
  model TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (doc_id, model)
);

-- Bumped by triggers (see LIVE_TOPICS) so open pages refresh when their data changes, whoever wrote it.
CREATE TABLE IF NOT EXISTS live_versions (
  topic TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);
`;

/** Which page topics each table feeds. Pages subscribe to topics, not tables. */
export const LIVE_TOPICS: Record<string, string[]> = {
  tickets: ['tickets'],
  classifications: ['tickets'],
  drafts: ['tickets'],
  reviews: ['tickets', 'ops'],
  jobs: ['tickets', 'incidents', 'ops'],
  incidents: ['incidents'],
  incident_events: ['incidents'],
  incident_notifications: ['incidents'],
  outbound_messages: ['incidents'],
  platform_checks: ['platforms'],
  ai_calls: ['ops'],
  settings: ['ops', 'platforms'],
};

export function liveSchema(): string {
  const topics = [...new Set(Object.values(LIVE_TOPICS).flat())];
  const rows = topics.map((t) => `INSERT OR IGNORE INTO live_versions (topic) VALUES ('${t}');`);
  const triggers = Object.entries(LIVE_TOPICS).flatMap(([table, ts]) =>
    ['INSERT', 'UPDATE', 'DELETE'].map(
      (op) =>
        // Recreated on every start, so a change to LIVE_TOPICS reaches existing databases.
        `DROP TRIGGER IF EXISTS live_${table}_${op.toLowerCase()};\n` +
        `CREATE TRIGGER live_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN ` +
        `UPDATE live_versions SET version = version + 1 WHERE topic IN (${ts.map((t) => `'${t}'`).join(', ')}); END;`,
    ),
  );
  return [...rows, ...triggers].join('\n');
}
