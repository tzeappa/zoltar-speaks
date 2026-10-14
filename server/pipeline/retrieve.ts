import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import MiniSearch from 'minisearch';
import type { Db } from '../db/index.ts';
import type { Logger } from '../logger.ts';
import type { Config } from '../config.ts';
import { cosine, createEmbedder, searchMode, type Embedder } from './embeddings.ts';

export interface KbDoc {
  id: string;
  title: string;
  type: 'article' | 'runbook';
  tags: string;
  body: string;
}

export interface KbHit {
  doc: KbDoc;
  /** Ranking score: BM25 for keyword search, the fused rank score for hybrid search. Only the order is meaningful. */
  score: number;
  /** Cosine similarity to the query, when embeddings took part. */
  similarity?: number;
}

export interface SearchOptions {
  limit?: number;
  type?: KbDoc['type'];
  minScore?: number;
}

export interface SemanticOptions {
  embedder: Embedder;
  /** Caches document vectors across restarts. Without it they are computed once per process. */
  db?: Db;
  log?: Logger;
  /** An embedding-only match must reach this similarity to count. */
  minSimilarity?: number;
  /**
   * A keyword match must reach this similarity too. BM25 with fuzzy matching finds something in almost any text
   * ("weather in Lisbon" matched three articles); the embedding vetoes those, while real keyword matches score higher.
   */
  keywordMinSimilarity?: number;
}

/** Reciprocal rank fusion constant. 60 is the usual choice: it rewards agreement without letting one list dominate. */
const RRF_K = 60;
/** Candidates taken from each ranking before fusing. */
const CANDIDATES = 10;
/** After the embedding model fails, keyword search is used alone this long before trying again. */
const RETRY_AFTER_MS = 60_000;
/** Text sent per document; embedding models truncate long input anyway, and titles and tags carry the most signal. */
const DOC_CHARS = 4_000;

const DEFAULT_KB_DIR = join(import.meta.dirname, '..', 'kb');

export function parseDoc(raw: string, file: string): KbDoc {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`Missing front matter in ${file}`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  if (!meta.id || !meta.title || (meta.type !== 'article' && meta.type !== 'runbook')) {
    throw new Error(`Invalid front matter in ${file}`);
  }
  return { id: meta.id, title: meta.title, type: meta.type, tags: meta.tags ?? '', body: m[2]!.trim() };
}

export function loadKb(dir = DEFAULT_KB_DIR): KbDoc[] {
  const docs: KbDoc[] = [];
  for (const sub of ['articles', 'runbooks']) {
    for (const file of readdirSync(join(dir, sub)).filter((f) => f.endsWith('.md')).sort()) {
      const path = join(dir, sub, file);
      docs.push(parseDoc(readFileSync(path, 'utf8'), path));
    }
  }
  const ids = new Set<string>();
  for (const d of docs) {
    if (ids.has(d.id)) throw new Error(`Duplicate KB id ${d.id}`);
    ids.add(d.id);
  }
  return docs;
}

/** The index the app uses: hybrid when `KB_SEARCH` (or the playbook size, for `auto`) calls for it. */
export function createKbIndex(docs: KbDoc[], config: Config, db?: Db, log?: Logger): KbIndex {
  if (searchMode(config, docs.length) === 'keyword') return new KbIndex(docs);
  // The floors are calibrated for a real embedding model; the mock's word hashing scores far lower.
  const mock = config.aiMode === 'mock';
  return new KbIndex(docs, {
    embedder: createEmbedder(config),
    db,
    log,
    minSimilarity: mock ? 0 : config.kbMinSimilarity,
    keywordMinSimilarity: mock ? 0 : config.kbKeywordMinSimilarity,
  });
}

export class KbIndex {
  private readonly bm25: MiniSearch<KbDoc>;
  private readonly byId: Map<string, KbDoc>;

  private vectors: Promise<Map<string, Float32Array>> | null = null;
  private failedAt = 0;

  constructor(
    readonly docs: KbDoc[],
    private readonly semantic?: SemanticOptions,
  ) {
    this.byId = new Map(docs.map((d) => [d.id, d]));
    this.bm25 = new MiniSearch<KbDoc>({
      fields: ['title', 'tags', 'body'],
      storeFields: ['id'],
      searchOptions: { boost: { title: 2, tags: 2 }, fuzzy: 0.15, prefix: true, combineWith: 'OR' },
    });
    this.bm25.addAll(docs);
  }

  get(id: string): KbDoc | undefined {
    return this.byId.get(id);
  }

  get mode(): 'keyword' | 'hybrid' {
    return this.semantic ? 'hybrid' : 'keyword';
  }

  get embedModel(): string | undefined {
    return this.semantic?.embedder.model;
  }

  /** Embeds the playbook ahead of the first ticket. Never throws; failures fall back as in `search`. */
  async warm(): Promise<void> {
    if (!this.semantic) return;
    try {
      await this.docVectors(this.semantic);
    } catch (err) {
      this.unavailable(err);
    }
  }

  private unavailable(err: unknown): void {
    this.failedAt = Date.now();
    this.vectors = null;
    this.semantic?.log?.warn(
      { model: this.semantic.embedder.model, err: err instanceof Error ? err.message : String(err) },
      'kb_embeddings_unavailable_using_keyword_search',
    );
  }

  /** Keyword (BM25) search only. */
  query(text: string, opts: SearchOptions = {}): KbHit[] {
    const { limit = 3, type, minScore = 1 } = opts;
    return this.bm25
      .search(text, type ? { filter: (r) => this.byId.get(r.id)?.type === type } : {})
      .filter((r) => r.score >= minScore)
      .slice(0, limit)
      .map((r) => ({ doc: this.byId.get(r.id)!, score: Math.round(r.score * 100) / 100 }));
  }

  /**
   * Keyword search, plus embeddings when configured: both rankings are fused, so an article either one ranks highly
   * comes back, including a paraphrase that shares no words with it. If the embedding model is unavailable, this is
   * keyword search and logs why; retrieval never fails a ticket.
   */
  async search(text: string, opts: SearchOptions = {}): Promise<KbHit[]> {
    const { limit = 3 } = opts;
    const keyword = this.query(text, { ...opts, limit: CANDIDATES });
    if (!this.semantic || Date.now() - this.failedAt < RETRY_AFTER_MS) return keyword.slice(0, limit);

    let semantic: KbHit[];
    let similarity: Map<string, number>;
    try {
      similarity = await this.similarities(text, this.semantic);
      semantic = this.docs
        .filter((d) => !opts.type || d.type === opts.type)
        .map((doc) => ({ doc, score: similarity.get(doc.id)!, similarity: round3(similarity.get(doc.id)!) }))
        .filter((h) => h.score >= (this.semantic!.minSimilarity ?? 0))
        .sort((a, b) => b.score - a.score)
        .slice(0, CANDIDATES);
    } catch (err) {
      this.unavailable(err);
      return keyword.slice(0, limit);
    }

    const keywordFloor = this.semantic.keywordMinSimilarity ?? 0;
    const vetted = keyword
      .filter((h) => similarity.get(h.doc.id)! >= keywordFloor)
      .map((h) => ({ ...h, similarity: round3(similarity.get(h.doc.id)!) }));
    const fused = new Map<string, KbHit>();
    for (const list of [vetted, semantic]) {
      list.forEach((hit, rank) => {
        const prev = fused.get(hit.doc.id);
        fused.set(hit.doc.id, {
          doc: hit.doc,
          score: (prev?.score ?? 0) + 1 / (RRF_K + rank + 1),
          similarity: hit.similarity ?? prev?.similarity,
        });
      });
    }
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((h) => ({ ...h, score: Math.round(h.score * 10_000) / 100 }));
  }

  private async similarities(text: string, opts: SemanticOptions): Promise<Map<string, number>> {
    let vectors = await this.docVectors(opts);
    const [q] = await opts.embedder.embed([text], 'query');
    // A model re-pulled under the same name can change size; old cached vectors would score NaN and match nothing.
    if ([...vectors.values()].some((v) => v.length !== q!.length)) {
      opts.db?.prepare('DELETE FROM kb_embeddings WHERE model = ?').run(opts.embedder.model);
      this.vectors = null;
      vectors = await this.docVectors(opts);
      if ([...vectors.values()].some((v) => v.length !== q!.length)) throw new Error('Embedding sizes disagree');
    }
    return new Map(this.docs.map((d) => [d.id, cosine(q!, vectors.get(d.id)!)]));
  }

  /** Computed once and shared by concurrent searches; cached rows are reused while the document is unchanged. */
  private docVectors(opts: SemanticOptions): Promise<Map<string, Float32Array>> {
    this.vectors ??= (async () => {
      const { embedder, db } = opts;
      const out = new Map<string, Float32Array>();
      const hashOf = (d: KbDoc) => createHash('sha256').update(docText(d)).digest('hex').slice(0, 16);
      const select = db?.prepare('SELECT content_hash, vector FROM kb_embeddings WHERE doc_id = ? AND model = ?');
      const missing: KbDoc[] = [];
      for (const d of this.docs) {
        const row = select?.get(d.id, embedder.model) as { content_hash: string; vector: Uint8Array } | undefined;
        if (row && row.content_hash === hashOf(d)) {
          out.set(d.id, new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)));
        } else missing.push(d);
      }
      const upsert = db?.prepare(
        `INSERT INTO kb_embeddings (doc_id, model, content_hash, vector) VALUES (?, ?, ?, ?)
         ON CONFLICT (doc_id, model) DO UPDATE SET content_hash = excluded.content_hash, vector = excluded.vector`,
      );
      for (let i = 0; i < missing.length; i += 16) {
        const batch = missing.slice(i, i + 16);
        const vecs = await embedder.embed(batch.map(docText), 'document');
        batch.forEach((d, j) => {
          const v = Float32Array.from(vecs[j]!);
          out.set(d.id, v);
          upsert?.run(d.id, embedder.model, hashOf(d), new Uint8Array(v.buffer));
        });
      }
      if (missing.length) opts.log?.info({ model: embedder.model, embedded: missing.length, cached: this.docs.length - missing.length }, 'kb_embeddings_ready');
      return out;
    })();
    return this.vectors;
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const docText = (d: KbDoc) => `${d.title}\n${d.tags}\n${d.body}`.slice(0, DOC_CHARS);
