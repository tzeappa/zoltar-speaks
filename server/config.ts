import { MONITORED_PLATFORMS } from './domain.ts';

export type AiMode = 'anthropic' | 'ollama' | 'mock' | 'disabled';

const AI_MODES: AiMode[] = ['anthropic', 'ollama', 'mock', 'disabled'];

export const DEFAULT_OLLAMA_FAST = 'qwen3:8b';
export const DEFAULT_OLLAMA_SMART = 'qwen3:8b';

export interface Config {
  port: number;
  /** Address to listen on. Loopback by default: the app has no login, so it must not be reachable from the network by accident. */
  host: string;
  /** Extra host names the app may be reached by. localhost and IP addresses are always allowed. */
  allowedHosts: string[];
  dbPath: string;
  logLevel: string;
  production: boolean;
  anthropicApiKey: string | undefined;
  aiMode: AiMode;
  ollamaUrl: string;
  ollamaNumCtx: number;
  /** Playbook search: `keyword` (BM25), `hybrid` (BM25 plus embeddings), or `auto` (hybrid once the playbook is large). */
  kbSearch: 'auto' | 'keyword' | 'hybrid';
  kbHybridMinDocs: number;
  ollamaEmbedModel: string;
  /** Cosine similarity below which an embedding match is ignored, so unrelated text still retrieves nothing. */
  kbMinSimilarity: number;
  /** In hybrid search, a keyword match below this similarity is dropped as noise. */
  kbKeywordMinSimilarity: number;
  /** Models for the active mode: Anthropic IDs, Ollama tags, or mock names. */
  modelFast: string;
  modelSmart: string;
  aiTimeoutMs: number;
  ticketTokenBudget: number;
  mockLatencyMs: number;
  mockFailRate: number;
  confidenceThreshold: number;
  incidentWindowMinutes: number;
  incidentMinTickets: number;
  incidentMinClients: number;
  clientWatchMinTickets: number;
  workerConcurrency: number;
  workerPollMs: number;
  jobMaxAttempts: number;
  jobBackoffMs: number;
  monitorEnabled: boolean;
  monitorIntervalMs: number;
  monitorDegradedMs: number;
  monitorRecoveryMs: number;
  /** Per-platform source overrides; platforms not listed use the simulated source. */
  monitorSources: Record<string, MonitorSourceConfig>;
  seedOnStart: boolean;
}

export type MonitorSourceConfig =
  | { type: 'simulated' }
  | { type: 'statuspage'; url: string }
  | { type: 'http_probe'; url: string; degradedMs?: number };

function parseMonitorSources(raw: string | undefined): Record<string, MonitorSourceConfig> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MONITOR_SOURCES must be JSON, e.g. {"X":{"type":"statuspage","url":"https://..."}}');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MONITOR_SOURCES must be a JSON object');
  for (const [platform, src] of Object.entries(parsed as Record<string, MonitorSourceConfig>)) {
    // A misspelled key would otherwise leave that platform on the simulated source without a word.
    if (!(MONITORED_PLATFORMS as readonly string[]).includes(platform)) {
      throw new Error(`MONITOR_SOURCES.${platform}: unknown platform (one of ${MONITORED_PLATFORMS.join(', ')})`);
    }
    if (!['simulated', 'statuspage', 'http_probe'].includes(src?.type)) {
      throw new Error(`MONITOR_SOURCES.${platform}: unknown type`);
    }
    if (src.type !== 'simulated') {
      if (!src.url || !/^https?:$/.test(URL.parse(src.url)?.protocol ?? '')) {
        throw new Error(`MONITOR_SOURCES.${platform}: url must be an http(s) URL`);
      }
      if (src.type === 'http_probe' && src.degradedMs !== undefined && !(Number.isFinite(src.degradedMs) && src.degradedMs > 0)) {
        throw new Error(`MONITOR_SOURCES.${platform}: degradedMs must be a positive number`);
      }
    }
  }
  return parsed as Record<string, MonitorSourceConfig>;
}

/** Settings that no longer do anything, with what replaced them. Startup warns when one is still set. */
export const RETIRED_SETTINGS: Record<string, string> = {
  MONITOR_DEGRADED_CONSECUTIVE: 'MONITOR_DEGRADED_MS (how long, not how many checks)',
  MONITOR_RECOVERY_CONSECUTIVE: 'MONITOR_RECOVERY_MS (how long, not how many checks)',
};

function kbSearch(raw: string | undefined): Config['kbSearch'] {
  const v = raw?.trim() || 'auto';
  if (v !== 'auto' && v !== 'keyword' && v !== 'hybrid') throw new Error(`Invalid KB_SEARCH: ${v} (auto, keyword, or hybrid)`);
  return v;
}

/** `min` defaults to 1: a zero concurrency, timeout, or interval would silently stop the app from working. */
function num(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1, opts: { max?: number; int?: boolean } = {}): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${key}: ${raw}`);
  if (n < min) throw new Error(`${key} must be at least ${min}, got ${raw}`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`${key} must be at most ${opts.max}, got ${raw}`);
  if (opts.int && !Number.isInteger(n)) throw new Error(`${key} must be a whole number, got ${raw}`);
  return n;
}

const int = (env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1, max?: number) => num(env, key, fallback, min, { max, int: true });
const fraction = (env: NodeJS.ProcessEnv, key: string, fallback: number) => num(env, key, fallback, 0, { max: 1 });

/** Strict, so `MONITOR_ENABLED=0` does not silently mean "enabled". */
function flag(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${key} must be true or false, got ${env[key]}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.ANTHROPIC_API_KEY || undefined;
  // `live` was the name for Anthropic before local models were supported.
  const requested = (env.AI_MODE === 'live' ? 'anthropic' : env.AI_MODE) as AiMode | undefined;
  if (requested && !AI_MODES.includes(requested)) {
    throw new Error(`Invalid AI_MODE: ${requested} (use ${AI_MODES.join(', ')})`);
  }
  // Anthropic only when asked for: a key in the shell must not quietly send client requests to a third party.
  const aiMode: AiMode = requested || 'ollama';
  if (aiMode === 'anthropic' && !apiKey) {
    throw new Error('AI_MODE=anthropic requires ANTHROPIC_API_KEY');
  }
  const models: Record<AiMode, [string, string]> = {
    anthropic: [env.MODEL_FAST || 'claude-haiku-5-5', env.MODEL_SMART || 'claude-sonnet-5-5'],
    ollama: [env.OLLAMA_MODEL_FAST || DEFAULT_OLLAMA_FAST, env.OLLAMA_MODEL_SMART || DEFAULT_OLLAMA_SMART],
    // Mock calls are free; distinct names keep them out of cost figures and make them obvious in traces.
    mock: ['mock-fast', 'mock-smart'],
    disabled: ['mock-fast', 'mock-smart'],
  };
  const [modelFast, modelSmart] = models[aiMode];
  return {
    port: int(env, 'PORT', 8787, 1, 65_535),
    host: env.HOST?.trim() || '127.0.0.1',
    allowedHosts: (env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    dbPath: env.DB_PATH || 'data/zoltar.db',
    logLevel: env.LOG_LEVEL || 'info',
    production: env.NODE_ENV === 'production',
    anthropicApiKey: apiKey,
    aiMode,
    ollamaUrl: (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    ollamaNumCtx: int(env, 'OLLAMA_NUM_CTX', 16_384),
    kbSearch: kbSearch(env.KB_SEARCH),
    kbHybridMinDocs: int(env, 'KB_HYBRID_MIN_DOCS', 40),
    ollamaEmbedModel: env.OLLAMA_EMBED_MODEL?.trim() || 'nomic-embed-text',
    kbMinSimilarity: fraction(env, 'KB_MIN_SIMILARITY', 0.6),
    kbKeywordMinSimilarity: fraction(env, 'KB_KEYWORD_MIN_SIMILARITY', 0.5),
    modelFast,
    modelSmart,
    // Local models are slower, and the first call after start also loads the model into memory.
    aiTimeoutMs: num(env, 'AI_TIMEOUT_MS', aiMode === 'ollama' ? 180_000 : 30_000),
    ticketTokenBudget: num(env, 'TICKET_TOKEN_BUDGET', 20_000),
    mockLatencyMs: num(env, 'MOCK_LATENCY_MS', 400, 0),
    mockFailRate: fraction(env, 'MOCK_FAIL_RATE', 0),
    confidenceThreshold: fraction(env, 'CONFIDENCE_THRESHOLD', 0.7),
    incidentWindowMinutes: num(env, 'INCIDENT_WINDOW_MINUTES', 60),
    incidentMinTickets: int(env, 'INCIDENT_MIN_TICKETS', 5),
    incidentMinClients: int(env, 'INCIDENT_MIN_CLIENTS', 3),
    clientWatchMinTickets: int(env, 'CLIENT_WATCH_MIN_TICKETS', 3),
    workerConcurrency: int(env, 'WORKER_CONCURRENCY', 2),
    workerPollMs: num(env, 'WORKER_POLL_MS', 250),
    jobMaxAttempts: int(env, 'JOB_MAX_ATTEMPTS', 3),
    jobBackoffMs: num(env, 'JOB_BACKOFF_MS', 2_000),
    monitorEnabled: flag(env, 'MONITOR_ENABLED', true),
    monitorIntervalMs: num(env, 'MONITOR_INTERVAL_MS', 10_000),
    monitorDegradedMs: num(env, 'MONITOR_DEGRADED_MS', 20_000, 0),
    monitorRecoveryMs: num(env, 'MONITOR_RECOVERY_MS', 30_000, 0),
    monitorSources: parseMonitorSources(env.MONITOR_SOURCES),
    seedOnStart: flag(env, 'SEED_ON_START', true),
  };
}
