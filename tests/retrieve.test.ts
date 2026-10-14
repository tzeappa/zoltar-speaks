import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db/index.ts';
import type { Logger } from '../server/logger.ts';
import { validateCitations } from '../server/pipeline/draft.ts';
import { OllamaEmbedder, ollamaModels, searchMode, type Embedder } from '../server/pipeline/embeddings.ts';
import { KbIndex, loadKb, type KbDoc } from '../server/pipeline/retrieve.ts';

const kb = new KbIndex(loadKb());

describe('KbIndex', () => {
  it('loads articles and runbooks', () => {
    expect(kb.docs.filter((d) => d.type === 'article').length).toBeGreaterThanOrEqual(10);
    expect(kb.docs.filter((d) => d.type === 'runbook').length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['My scheduled Instagram post never went live', ['kb-publishing-failures']],
    ['The weekly report reach number is lower than the app', ['kb-reports', 'kb-analytics-latency']],
    ['Someone hacked our account and changed the password', ['kb-account-compromise']],
    ['Please take down the post with the wrong discount code', ['kb-takedown']],
  ])('finds the right article for "%s"', (query, expected) => {
    const top = kb.query(query, { type: 'article', limit: 3 }).map((h) => h.doc.id);
    expect(top.some((id) => expected.includes(id))).toBe(true);
  });

  it('filters by type', () => {
    const hits = kb.query('publishing failures across many clients', { type: 'runbook', limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.doc.type === 'runbook')).toBe(true);
  });

  it('returns nothing for unrelated text', () => {
    expect(kb.query('zzzz qqqq', { type: 'article', limit: 3 })).toEqual([]);
  });
});

describe('validateCitations', () => {
  it('keeps retrieved ids, drops the rest, and dedupes', () => {
    expect(validateCitations(['a', 'b', 'a', 'x'], ['a', 'b', 'c'])).toEqual({ valid: ['a', 'b'], dropped: ['x'] });
  });
});

/** Counts words per concept, so "reel" and "post" land together the way a real embedding model would place them. */
class ConceptEmbedder implements Embedder {
  readonly model = 'concepts';
  calls: string[][] = [];
  fail = false;
  private readonly concepts = [
    ['post', 'posts', 'publish', 'published', 'reel', 'feed', 'live', 'scheduled'],
    ['invoice', 'billing', 'charged', 'price', 'payment', 'money'],
    ['weather', 'rain', 'sunny', 'forecast'],
  ];
  async embed(texts: string[]): Promise<number[][]> {
    if (this.fail) throw new Error('model not loaded');
    this.calls.push(texts);
    return texts.map((t) => {
      const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
      return [...this.concepts.map((c) => words.filter((w) => c.includes(w)).length), 0.01];
    });
  }
}

const doc = (id: string, title: string, tags: string, body: string): KbDoc => ({ id, title, type: 'article', tags, body });
const DOCS = [
  doc('kb-publishing', 'Why a scheduled post did not publish', 'scheduled post failed', 'Check the publishing log.'),
  doc('kb-billing', 'Invoices and payment', 'invoice billing price', 'Billing questions go to the account lead.'),
  doc('kb-weather', 'Weather days', 'rain forecast', 'Outdoor shoots move when rain is forecast.'),
];

describe('hybrid search', () => {
  it('finds a paraphrase that shares no words with the article', async () => {
    const q = 'our reel never showed up on the feed';
    expect(new KbIndex(DOCS).query(q)).toEqual([]);
    const hits = await new KbIndex(DOCS, { embedder: new ConceptEmbedder(), minSimilarity: 0.6 }).search(q);
    expect(hits.map((h) => h.doc.id)).toEqual(['kb-publishing']);
    expect(hits[0]!.similarity).toBeGreaterThan(0.9);
  });

  it('drops keyword matches the embedding says are unrelated', async () => {
    // "forecast" matches the weather article by keyword; the question is about money.
    const q = 'what is the billing forecast for the invoice and payment';
    expect(new KbIndex(DOCS).query(q).map((h) => h.doc.id)).toContain('kb-weather');
    const hits = await new KbIndex(DOCS, { embedder: new ConceptEmbedder(), minSimilarity: 0.6, keywordMinSimilarity: 0.6 }).search(q);
    expect(hits.map((h) => h.doc.id)).not.toContain('kb-weather');
    expect(hits[0]!.doc.id).toBe('kb-billing');
  });

  it('falls back to keyword search when the embedding model fails, and retries later', async () => {
    const embedder = new ConceptEmbedder();
    embedder.fail = true;
    const warnings: unknown[] = [];
    const log = { warn: (o: unknown) => warnings.push(o), info: () => {} } as unknown as Logger;
    const kb = new KbIndex(DOCS, { embedder, log });
    expect((await kb.search('scheduled post failed')).map((h) => h.doc.id)).toEqual(['kb-publishing']);
    expect(warnings).toHaveLength(1);

    embedder.fail = false;
    await kb.search('scheduled post failed');
    expect(embedder.calls).toHaveLength(0); // still backing off
    vi.useFakeTimers({ now: Date.now() + 61_000 });
    try {
      await kb.search('our reel');
      expect(embedder.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches document vectors in the database and re-embeds only changed documents', async () => {
    const db = openDb(':memory:');
    const first = new ConceptEmbedder();
    await new KbIndex(DOCS, { embedder: first, db }).search('post');
    expect(first.calls.map((c) => c.length)).toEqual([3, 1]); // three documents, then the query

    const second = new ConceptEmbedder();
    const edited = [DOCS[0]!, { ...DOCS[1]!, body: 'Billing questions go to finance.' }, DOCS[2]!];
    const hits = await new KbIndex(edited, { embedder: second, db }).search('post');
    expect(second.calls.map((c) => c.length)).toEqual([1, 1]); // only the edited one, then the query
    expect(hits[0]!.doc.id).toBe('kb-publishing');
  });

  it('embeds the playbook once even when searches start together', async () => {
    const embedder = new ConceptEmbedder();
    const kb = new KbIndex(DOCS, { embedder });
    await Promise.all([kb.search('post'), kb.search('invoice'), kb.search('rain')]);
    expect(embedder.calls.filter((c) => c.length === 3)).toHaveLength(1);
  });
});

describe('search mode', () => {
  const base = { kbSearch: 'auto' as const, kbHybridMinDocs: 40, aiMode: 'ollama' as const };
  it('turns hybrid on once the playbook is large, only where Ollama is the model', () => {
    expect(searchMode(base, 39)).toBe('keyword');
    expect(searchMode(base, 40)).toBe('hybrid');
    expect(searchMode({ ...base, aiMode: 'anthropic' }, 100)).toBe('keyword');
    expect(searchMode({ ...base, aiMode: 'disabled', kbSearch: 'hybrid' }, 100)).toBe('keyword');
    expect(searchMode({ ...base, kbSearch: 'hybrid' }, 3)).toBe('hybrid');
    expect(searchMode({ ...base, kbSearch: 'keyword' }, 100)).toBe('keyword');
  });

  it('adds the embedding model to what setup pulls and health checks', () => {
    const config = loadConfig({ AI_MODE: 'ollama', KB_SEARCH: 'hybrid' });
    expect(ollamaModels(config, 20)).toEqual({ chat: ['qwen3:8b'], all: ['qwen3:8b', 'nomic-embed-text'] });
    expect(ollamaModels(loadConfig({ AI_MODE: 'ollama' }), 20).all).toEqual(['qwen3:8b']);
    expect(ollamaModels(loadConfig({ AI_MODE: 'mock', KB_SEARCH: 'hybrid' }), 20).all).toEqual([]);
    expect(() => loadConfig({ KB_SEARCH: 'semantic' })).toThrow('Invalid KB_SEARCH');
  });
});

describe('OllamaEmbedder', () => {
  it('sends nomic task prefixes and explains a missing model', async () => {
    const bodies: { model: string; input: string[] }[] = [];
    const ok = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ embeddings: [[1, 0]] }));
    }) as unknown as typeof fetch;
    await new OllamaEmbedder('http://x', 'nomic-embed-text', 1000, ok).embed(['hi'], 'query');
    await new OllamaEmbedder('http://x', 'mxbai-embed-large', 1000, ok).embed(['hi'], 'document');
    expect(bodies.map((b) => b.input[0])).toEqual(['search_query: hi', 'hi']);

    const missing = (async () => new Response('model not found', { status: 404 })) as unknown as typeof fetch;
    await expect(new OllamaEmbedder('http://x', 'nomic-embed-text', 1000, missing).embed(['hi'], 'query')).rejects.toThrow(
      'ollama pull nomic-embed-text',
    );
  });
});
