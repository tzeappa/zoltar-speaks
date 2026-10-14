import { MockClient } from '../server/ai/mock.ts';
import type { ModelClient, ModelRequest, ModelResponse, Purpose } from '../server/ai/types.ts';
import { loadConfig, type Config } from '../server/config.ts';
import type { AppContext } from '../server/context.ts';
import { openDb } from '../server/db/index.ts';
import { upsertClient } from '../server/db/repo.ts';
import { silentLogger } from '../server/logger.ts';
import { OutboxNotifier, type Notifier } from '../server/notify/notifier.ts';
import { KbIndex, loadKb } from '../server/pipeline/retrieve.ts';
import { CLIENTS } from '../server/seed/clients.ts';

const kb = new KbIndex(loadKb());

export interface TestCtx extends AppContext {
  clock: { now: number };
}

export function makeCtx(opts: { config?: Partial<Config>; model?: ModelClient; notifier?: Notifier; seedClients?: boolean } = {}): TestCtx {
  const clock = { now: Date.UTC(2026, 9, 14, 9, 0, 0) };
  const config: Config = {
    ...loadConfig({ AI_MODE: 'mock' }),
    modelFast: 'mock-fast',
    modelSmart: 'mock-smart',
    jobBackoffMs: 0,
    ...opts.config,
  };
  const db = openDb(':memory:');
  if (opts.seedClients !== false) for (const c of CLIENTS) upsertClient(db, c);
  return {
    db,
    config,
    log: silentLogger,
    kb,
    model: opts.model ?? new MockClient(),
    notifier: opts.notifier ?? new OutboxNotifier(),
    now: () => clock.now,
    clock,
  };
}

export type Script = (req: ModelRequest, call: number) => ModelResponse | Promise<ModelResponse> | undefined;

/** Wraps the mock; a script can override any call by purpose. Records every request. */
export class ScriptedClient implements ModelClient {
  readonly name = 'scripted';
  readonly requests: ModelRequest[] = [];
  private readonly counts = new Map<Purpose, number>();
  private readonly mock = new MockClient();
  constructor(private readonly scripts: Partial<Record<Purpose, Script>> = {}) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const n = (this.counts.get(req.purpose) ?? 0) + 1;
    this.counts.set(req.purpose, n);
    const scripted = await this.scripts[req.purpose]?.(req, n);
    return scripted ?? this.mock.complete(req);
  }
}
