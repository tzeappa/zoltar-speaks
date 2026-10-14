import { z } from 'zod';
import type { AiCall } from '../db/repo.ts';
import { costUsd } from './pricing.ts';
import { AiError, type ModelClient, type ModelMessage, type Purpose } from './types.ts';

export class TokenBudget {
  used = 0;
  constructor(readonly limit: number) {}

  assertAvailable(): void {
    if (this.used >= this.limit) {
      throw new AiError('budget', `Token budget exhausted (${this.used}/${this.limit})`);
    }
  }

  add(tokens: number): void {
    this.used += tokens;
  }
}

export interface CallContext {
  client: ModelClient;
  record: (call: AiCall) => void;
  ticketId?: number;
  incidentId?: number;
  budget?: TokenBudget;
  timeoutMs: number;
  now?: () => number;
}

export interface StructuredRequest<S extends z.ZodType> {
  purpose: Purpose;
  model: string;
  promptVersion: string;
  system: string;
  user: string;
  schema: S;
  maxTokens: number;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  promptVersion: string;
  attempts: number;
}

const MAX_ATTEMPTS = 2;

/** Models sometimes send a nested array or object as a JSON-encoded string. Decode those top-level fields. */
export function decodeJsonStrings(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = v;
    if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) continue;
    try {
      out[k] = JSON.parse(v);
    } catch {
      // Not JSON; leave it for validation to report.
    }
  }
  return out;
}

/**
 * Forces a tool call whose input schema is derived from `schema`, validates the result, and on validation failure
 * sends the error back once. Every model round trip is recorded, including failed ones.
 */
export async function callStructured<S extends z.ZodType>(
  ctx: CallContext,
  req: StructuredRequest<S>,
): Promise<StructuredResult<z.infer<S>>> {
  const now = ctx.now ?? Date.now;
  const toolName = `submit_${req.purpose}`;
  const inputSchema = z.toJSONSchema(req.schema) as Record<string, unknown>;
  delete inputSchema.$schema;
  const messages: ModelMessage[] = [{ role: 'user', content: req.user }];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    ctx.budget?.assertAvailable();
    const started = now();
    const base = {
      ticketId: ctx.ticketId ?? null,
      incidentId: ctx.incidentId ?? null,
      purpose: req.purpose,
      model: req.model,
      promptVersion: req.promptVersion,
      attempt,
    };

    let res;
    try {
      res = await ctx.client.complete({
        purpose: req.purpose,
        model: req.model,
        system: req.system,
        messages,
        tool: { name: toolName, description: `Submit the ${req.purpose} result.`, inputSchema },
        maxTokens: req.maxTokens,
        timeoutMs: ctx.timeoutMs,
      });
    } catch (err) {
      const aiErr = err instanceof AiError ? err : new AiError('transient', String(err), err);
      ctx.record({
        ...base,
        status: 'error',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: now() - started,
        costUsd: 0,
        error: `${aiErr.kind}: ${aiErr.message}`.slice(0, 500),
        createdAt: started,
      });
      throw aiErr;
    }

    ctx.budget?.add(res.inputTokens + res.outputTokens);
    let parsed = req.schema.safeParse(res.toolInput);
    if (!parsed.success) {
      const decoded = req.schema.safeParse(decodeJsonStrings(res.toolInput));
      if (decoded.success) parsed = decoded;
    }
    const usage = {
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      latencyMs: now() - started,
      costUsd: costUsd(req.model, res.inputTokens, res.outputTokens),
      createdAt: started,
    };

    if (parsed.success) {
      ctx.record({ ...base, ...usage, status: 'ok', error: null });
      return { data: parsed.data, model: req.model, promptVersion: req.promptVersion, attempts: attempt };
    }

    const issues = z.prettifyError(parsed.error);
    ctx.record({ ...base, ...usage, status: 'invalid_output', error: issues.slice(0, 500) });
    if (res.toolUseId) {
      messages.push(
        { role: 'tool_call', toolUseId: res.toolUseId, input: res.toolInput, raw: res.raw },
        { role: 'tool_error', toolUseId: res.toolUseId, error: `Invalid input. Fix these issues and call the tool again:\n${issues}` },
      );
    } else {
      // Without this the second attempt would be the identical request.
      messages.push({ role: 'user', content: `Answer only by calling the ${toolName} tool.` });
    }
  }

  throw new AiError('invalid_output', `${req.purpose}: model output failed validation after ${MAX_ATTEMPTS} attempts`);
}
