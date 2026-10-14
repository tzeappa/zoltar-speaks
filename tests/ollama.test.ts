import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createModelClient } from '../server/ai/client.ts';
import { OllamaClient, ollamaStatus, toChatMessages } from '../server/ai/ollama.ts';
import { callStructured, type CallContext } from '../server/ai/structured.ts';
import { AiError, type ModelRequest } from '../server/ai/types.ts';
import { loadConfig } from '../server/config.ts';
import type { AiCall } from '../server/db/repo.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeFetch(handler: (url: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    return handler(url, body);
  }) as typeof fetch;
  return { fn, calls };
}

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  purpose: 'classify',
  model: 'qwen3:8b',
  system: 'You classify.',
  messages: [{ role: 'user', content: 'My post failed.' }],
  tool: { name: 'submit_classify', description: 'Submit the classify result.', inputSchema: { type: 'object' } },
  maxTokens: 500,
  timeoutMs: 5_000,
  ...over,
});

describe('OllamaClient', () => {
  it('sends the tool schema as the output format, with thinking off and a large context', async () => {
    const f = fakeFetch(() => json({ message: { content: '{"category":"x"}' }, prompt_eval_count: 120, eval_count: 30 }));
    const res = await new OllamaClient({ url: 'http://ollama:11434', numCtx: 16384, fetchFn: f.fn }).complete(req());

    expect(f.calls[0]!.url).toBe('http://ollama:11434/api/chat');
    expect(f.calls[0]!.body).toMatchObject({
      model: 'qwen3:8b',
      format: { type: 'object' },
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 500, num_ctx: 16384 },
    });
    expect(res).toMatchObject({ toolInput: { category: 'x' }, inputTokens: 120, outputTokens: 30 });
    expect(res.toolUseId).toMatch(/^ollama-/);
  });

  it('returns non-JSON text as-is so validation can report it', async () => {
    const f = fakeFetch(() => json({ message: { content: 'Sure! Here is the result' } }));
    const res = await new OllamaClient({ url: 'http://o', numCtx: 1, fetchFn: f.fn }).complete(req());
    expect(res.toolInput).toBe('Sure! Here is the result');
  });

  it('explains a missing model and does not retry it', async () => {
    const f = fakeFetch(() => json({ error: 'model "qwen3:8b" not found' }, 404));
    const err = await new OllamaClient({ url: 'http://o', numCtx: 1, fetchFn: f.fn }).complete(req()).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ kind: 'permanent' });
    expect(err.message).toMatch(/ollama pull qwen3:8b/);
  });

  it('treats a stopped server and 5xx as transient', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await new OllamaClient({ url: 'http://o', numCtx: 1, fetchFn: down }).complete(req()).catch((e) => e);
    expect(err).toMatchObject({ kind: 'transient' });
    expect(err.message).toMatch(/make services/);

    const busy = fakeFetch(() => new Response('overloaded', { status: 503 }));
    expect(await new OllamaClient({ url: 'http://o', numCtx: 1, fetchFn: busy.fn }).complete(req()).catch((e) => e)).toMatchObject({
      kind: 'transient',
    });
  });

  it('replays a repair turn as plain chat', () => {
    const msgs = toChatMessages('Sys.', 'Submit.', [
      { role: 'user', content: 'ticket' },
      { role: 'tool_call', toolUseId: 'ollama-1', input: { a: 1 } },
      { role: 'tool_error', toolUseId: 'ollama-1', error: 'Invalid input: a must be a string' },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[0]!.content).toMatch(/single JSON object/);
    expect(msgs[2]!.content).toBe('{"a":1}');
  });

  it('gets a repair turn through callStructured when the first answer is off-schema', async () => {
    let n = 0;
    const f = fakeFetch(() => json({ message: { content: n++ === 0 ? '{"label":5}' : '{"label":"ok"}' } }));
    const calls: AiCall[] = [];
    const ctx: CallContext = { client: new OllamaClient({ url: 'http://o', numCtx: 1, fetchFn: f.fn }), record: (c) => calls.push(c), timeoutMs: 1000 };
    const out = await callStructured(ctx, {
      purpose: 'classify',
      model: 'qwen3:8b',
      promptVersion: 't',
      system: 's',
      user: 'u',
      schema: z.object({ label: z.string() }),
      maxTokens: 100,
    });
    expect(out.data).toEqual({ label: 'ok' });
    expect(calls.map((c) => [c.status, c.costUsd])).toEqual([
      ['invalid_output', 0],
      ['ok', 0],
    ]);
    const second = f.calls[1]!.body.messages as { role: string; content: string }[];
    expect(second.at(-1)!.content).toMatch(/label/);
  });
});

describe('ollamaStatus', () => {
  it('reports missing models, matching untagged names to :latest', async () => {
    const f = fakeFetch((url) =>
      url.endsWith('/api/version') ? json({ version: '0.40.3' }) : json({ models: [{ name: 'qwen3:8b' }, { name: 'llama3:latest' }] }),
    );
    expect(await ollamaStatus('http://o', ['qwen3:8b', 'llama3', 'gemma:2b'], f.fn)).toEqual({
      reachable: true,
      version: '0.40.3',
      missingModels: ['gemma:2b'],
    });
  });

  it('never throws when Ollama is down', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await ollamaStatus('http://o', ['qwen3:8b', 'qwen3:8b'], down)).toMatchObject({ reachable: false, missingModels: ['qwen3:8b'] });
  });
});

describe('createModelClient', () => {
  it('picks the client for the mode', () => {
    expect(createModelClient(loadConfig({})).name).toBe('ollama');
    expect(createModelClient(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' })).name).toBe('ollama');
    expect(createModelClient(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', AI_MODE: 'anthropic' })).name).toBe('anthropic');
    expect(createModelClient(loadConfig({ AI_MODE: 'mock' })).name).toBe('mock');
  });

  it('never answers with canned output when AI is disabled', async () => {
    const client = createModelClient(loadConfig({ AI_MODE: 'disabled' }));
    await expect(client.complete({} as never)).rejects.toMatchObject({ kind: 'disabled' });
  });
});

describe('loadConfig', () => {
  it('rejects settings that would silently stop the app', () => {
    expect(() => loadConfig({ WORKER_CONCURRENCY: '0' })).toThrow(/WORKER_CONCURRENCY must be at least 1/);
    expect(() => loadConfig({ AI_TIMEOUT_MS: '-5' })).toThrow(/AI_TIMEOUT_MS/);
    expect(loadConfig({ WORKER_CONCURRENCY: ' ', MOCK_LATENCY_MS: '0' })).toMatchObject({ workerConcurrency: 2, mockLatencyMs: 0 });
  });
});
