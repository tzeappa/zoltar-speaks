/**
 * Playbook retrieval: keyword (BM25) against hybrid (BM25 plus embeddings) on paraphrased requests that avoid the
 * articles' own wording, which is where keyword search misses. Also checks that unrelated text retrieves nothing.
 *
 *   npm run eval:retrieval                        # hybrid with OLLAMA_EMBED_MODEL (ollama pull nomic-embed-text first)
 *   npm run eval:retrieval -- --mock              # offline, with the word-hashing embedder
 *   npm run eval:retrieval -- --min-similarity 0.55 --keyword-min-similarity 0.45
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../server/config.ts';
import { HashEmbedder, OllamaEmbedder, type Embedder } from '../server/pipeline/embeddings.ts';
import { KbIndex, loadKb, type KbDoc } from '../server/pipeline/retrieve.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const { values: args } = parseArgs({
  options: { mock: { type: 'boolean', default: false }, 'min-similarity': { type: 'string' }, 'keyword-min-similarity': { type: 'string' } },
});

/** Request, document type, and the documents that count as a correct answer. */
export const PARAPHRASES: [string, KbDoc['type'], string[]][] = [
  ['Our reel was supposed to go live at 9 but it never appeared on the feed', 'article', ['kb-publishing-failures']],
  ["I can't get into the brand's profile anymore, the code on my phone isn't arriving", 'article', ['kb-account-access']],
  ["Somebody is posting crypto giveaways from our page and we didn't write them", 'article', ['kb-account-compromise']],
  ["The follower growth in your PDF doesn't match what the app tells me", 'article', ['kb-analytics-latency', 'kb-reports']],
  ['Why were we charged extra this quarter?', 'article', ['kb-billing']],
  ['People keep leaving nasty replies under our posts, can you clean them up', 'article', ['kb-comment-moderation', 'kb-hostile-comments']],
  ['A newspaper writer emailed asking for our side of the story', 'article', ['kb-crisis-comms']],
  ['Hundreds of furious people flooded our latest video after the ad aired', 'article', ['kb-hostile-comments', 'kb-crisis-comms']],
  ['Do you also look after our Pinterest boards?', 'article', ['kb-managed-platforms']],
  ["Can we push Thursday's post to next week and use a different photo", 'article', ['kb-rescheduling']],
  ["When do I need to sign off on next month's content so it goes out on time?", 'article', ['kb-scheduling-approval']],
  ["It's Saturday night, how soon will someone answer me?", 'article', ['kb-sla']],
  ['Please get rid of that post immediately, it shows the wrong price', 'article', ['kb-takedown']],
  ["Any fresh ideas for our summer launch? What's popular right now?", 'article', ['kb-trend-research']],
  ['Can I get the numbers emailed to me every Monday instead?', 'article', ['kb-reports']],
  ['Many clients say their Meta posts are failing since this morning', 'runbook', ['rb-platform-publishing-outage']],
  ["Dashboards for several customers show yesterday's numbers as zero", 'runbook', ['rb-analytics-stale']],
  ['Everything we schedule is going out hours late on every network', 'runbook', ['rb-publishing-backlog']],
  ["A client's account was taken over and is posting spam", 'runbook', ['rb-account-compromise']],
  ['A client is trending for the wrong reasons after an offensive ad', 'runbook', ['rb-brand-safety-flareup']],
];

/** Should retrieve nothing: a draft built on an unrelated article is worse than one with no article. */
export const UNRELATED = ['zzzz qqqq', "What's the weather in Lisbon tomorrow?", 'Recommend a good pasta recipe for dinner', 'Who won the football game last night?'];

const config = loadConfig();
// Same floors as the app: the configured ones for a real model, none for the mock (see createKbIndex).
const minSimilarity = args['min-similarity'] ? Number(args['min-similarity']) : args.mock ? 0 : config.kbMinSimilarity;
const keywordMinSimilarity = args['keyword-min-similarity'] ? Number(args['keyword-min-similarity']) : args.mock ? 0 : config.kbKeywordMinSimilarity;
// No short query timeout here: a slow answer is fine, a silent fallback to keyword search would fake the numbers.
const embedder: Embedder = args.mock ? new HashEmbedder() : new OllamaEmbedder(config.ollamaUrl, config.ollamaEmbedModel, 300_000, fetch, 300_000);
const docs = loadKb();
const keyword = new KbIndex(docs);
const hybrid = new KbIndex(docs, { embedder, minSimilarity, keywordMinSimilarity });
const raw = new KbIndex(docs, { embedder, minSimilarity: -1 });

async function score(index: KbIndex) {
  let hit1 = 0;
  let hit3 = 0;
  let rr = 0;
  const misses: string[] = [];
  for (const [q, type, expected] of PARAPHRASES) {
    const ids = (await index.search(q, { type, limit: 3 })).map((h) => h.doc.id);
    const rank = ids.findIndex((id) => expected.includes(id));
    if (rank === 0) hit1++;
    if (rank >= 0) {
      hit3++;
      rr += 1 / (rank + 1);
    } else misses.push(`${q}  ->  ${ids.join(', ') || '(nothing)'}`);
  }
  let falseHits = 0;
  for (const q of UNRELATED) if ((await index.search(q, { limit: 3 })).length) falseHits++;
  const n = PARAPHRASES.length;
  return { hit1: hit1 / n, hit3: hit3 / n, mrr: rr / n, falseHits, misses };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
// Search falls back to keyword results when embeddings fail, so check them directly first.
try {
  await embedder.embed(['preflight'], 'query');
} catch (err) {
  console.error(`Embeddings failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
const k = await score(keyword);
const h = await score(hybrid);

// Similarity of the best match for each unrelated query, to choose KB_MIN_SIMILARITY.
const best: number[] = [];
for (const q of UNRELATED) best.push((await raw.search(q, { limit: 1 }))[0]?.similarity ?? 0);
const relevant: number[] = [];
for (const [q, type, expected] of PARAPHRASES) {
  const hit = (await raw.search(q, { type, limit: 10 })).find((x) => expected.includes(x.doc.id));
  relevant.push(hit?.similarity ?? 0);
}

console.log(`Playbook retrieval, ${PARAPHRASES.length} paraphrased requests, ${docs.length} documents, ${embedder.model}, min similarity ${minSimilarity} (keyword matches ${keywordMinSimilarity})\n`);
console.log('| Metric | Keyword | Hybrid |');
console.log('| --- | --- | --- |');
console.log(`| Right document first | ${pct(k.hit1)} | ${pct(h.hit1)} |`);
console.log(`| Right document in top 3 | ${pct(k.hit3)} | ${pct(h.hit3)} |`);
console.log(`| Mean reciprocal rank | ${k.mrr.toFixed(2)} | ${h.mrr.toFixed(2)} |`);
console.log(`| Unrelated requests that retrieved something | ${k.falseHits} of ${UNRELATED.length} | ${h.falseHits} of ${UNRELATED.length} |`);
console.log(
  `\nSimilarity of the right document: min ${Math.min(...relevant).toFixed(3)}, median ${relevant.sort()[Math.floor(relevant.length / 2)]!.toFixed(3)}. Best match for unrelated text: max ${Math.max(...best).toFixed(3)}.`,
);
for (const [label, r] of [['Keyword', k], ['Hybrid', h]] as const) {
  if (r.misses.length) console.log(`\n${label} misses:\n  ${r.misses.join('\n  ')}`);
}
