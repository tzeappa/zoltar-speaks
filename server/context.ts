import type { CallContext, TokenBudget } from './ai/structured.ts';
import type { ModelClient } from './ai/types.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { getSetting, insertAiCall } from './db/repo.ts';
import type { Logger } from './logger.ts';
import type { Notifier } from './notify/notifier.ts';
import type { KbIndex } from './pipeline/retrieve.ts';

export interface AppContext {
  db: Db;
  config: Config;
  log: Logger;
  kb: KbIndex;
  model: ModelClient;
  notifier: Notifier;
  now: () => number;
}

/** AI can be off by config or by the runtime kill switch on the Ops page. */
export function aiEnabled(ctx: AppContext): boolean {
  return ctx.config.aiMode !== 'disabled' && getSetting(ctx.db, 'ai_enabled') !== 'false';
}

export function callContext(
  ctx: AppContext,
  scope: { ticketId?: number; incidentId?: number; budget?: TokenBudget },
): CallContext {
  return {
    client: ctx.model,
    timeoutMs: ctx.config.aiTimeoutMs,
    now: ctx.now,
    ...scope,
    record: (call) => {
      insertAiCall(ctx.db, call);
      ctx.log[call.status === 'ok' ? 'debug' : 'warn'](
        {
          ticket_id: call.ticketId,
          incident_id: call.incidentId,
          purpose: call.purpose,
          model: call.model,
          attempt: call.attempt,
          status: call.status,
          latency_ms: call.latencyMs,
          input_tokens: call.inputTokens,
          output_tokens: call.outputTokens,
          cost_usd: call.costUsd,
          err: call.error ?? undefined,
        },
        'ai_call',
      );
    },
  };
}
