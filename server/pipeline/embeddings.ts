import type { Config } from '../config.ts';

export interface Embedder {
  readonly model: string;
  /** One vector per text. `kind` matters for models trained with query and document prefixes. */
  embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
}

/** Embeddings from an Ollama model at OLLAMA_URL (this machine by default). Text is pseudonymized ticket content. */
export class OllamaEmbedder implements Embedder {
  constructor(
    private readonly url: string,
    readonly model: string,
    private readonly timeoutMs = 120_000,
    private readonly fetchFn: typeof fetch = fetch,
    /** A query embedding runs inside every triage; when Ollama is busy, keyword search beats waiting. */
    private readonly queryTimeoutMs = 10_000,
  ) {}

  async embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]> {
    // nomic-embed-text is trained with these task prefixes and ranks noticeably worse without them.
    const prefix = this.model.startsWith('nomic-embed') ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
    const res = await this.fetchFn(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts.map((t) => prefix + t), truncate: true }),
      signal: AbortSignal.timeout(kind === 'query' ? Math.min(this.queryTimeoutMs, this.timeoutMs) : this.timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      if (res.status === 404) throw new Error(`Embedding model ${this.model} is not pulled. Run \`ollama pull ${this.model}\`.`);
      throw new Error(`Ollama embed HTTP ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as { embeddings?: number[][] };
    if (!body.embeddings || body.embeddings.length !== texts.length) throw new Error('Ollama returned no embeddings');
    return body.embeddings;
  }
}

const HASH_DIMS = 256;

/**
 * Feature hashing over words: deterministic and offline, for tests and the mock mode. It measures word overlap,
 * not meaning, so it exercises the hybrid code path without pretending to be a real embedding model.
 */
export class HashEmbedder implements Embedder {
  readonly model = `hash-${HASH_DIMS}`;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Array<number>(HASH_DIMS).fill(0);
      for (const word of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
        v[(h >>> 0) % HASH_DIMS]! += 1;
      }
      return v;
    });
  }
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export type SearchMode = 'keyword' | 'hybrid';

/**
 * Keyword (BM25) search is enough for a small playbook with distinctive vocabulary. `auto` adds embeddings once the
 * playbook reaches `KB_HYBRID_MIN_DOCS`, where paraphrased requests start missing the right article.
 */
export function searchMode(config: Pick<Config, 'kbSearch' | 'kbHybridMinDocs' | 'aiMode'>, docCount: number): SearchMode {
  if (config.kbSearch === 'keyword' || config.aiMode === 'disabled') return 'keyword';
  if (config.kbSearch === 'hybrid') return 'hybrid';
  // A hosted-model setup may have no Ollama at all, so auto never makes it depend on one.
  if (config.aiMode === 'anthropic') return 'keyword';
  return docCount >= config.kbHybridMinDocs ? 'hybrid' : 'keyword';
}

export function createEmbedder(config: Pick<Config, 'aiMode' | 'ollamaUrl' | 'ollamaEmbedModel'>): Embedder {
  return config.aiMode === 'mock' ? new HashEmbedder() : new OllamaEmbedder(config.ollamaUrl, config.ollamaEmbedModel);
}

/** The Ollama model hybrid search needs, if any. */
export function embedModelNeeded(config: Config, docCount: number): string | null {
  return searchMode(config, docCount) === 'hybrid' && config.aiMode !== 'mock' ? config.ollamaEmbedModel : null;
}

/** Every Ollama model this configuration uses, for setup and health checks: chat models, then the embedding model. */
export function ollamaModels(config: Config, docCount: number): { chat: string[]; all: string[] } {
  const chat = config.aiMode === 'ollama' ? [...new Set([config.modelFast, config.modelSmart])] : [];
  const embed = embedModelNeeded(config, docCount);
  return { chat, all: embed ? [...chat, embed] : chat };
}
