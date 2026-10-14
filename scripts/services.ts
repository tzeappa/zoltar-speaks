/**
 * Makes sure the services the app needs are running. Today that is Ollama: for the models when AI_MODE is `ollama`,
 * and for the embedding model when playbook search is hybrid (KB_SEARCH).
 *
 *   npm run services              # start Ollama if it is down, pull missing models, load them into memory
 *   npm run services -- --install # also install Ollama if it is missing
 *   npm run services -- --check   # report only; exit 1 if anything is not ready
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ollamaStatus } from '../server/ai/ollama.ts';
import { loadConfig } from '../server/config.ts';
import { ollamaModels } from '../server/pipeline/embeddings.ts';
import { loadKb } from '../server/pipeline/retrieve.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values: args } = parseArgs({
  options: { install: { type: 'boolean', default: false }, check: { type: 'boolean', default: false } },
});

const ok = (msg: string) => console.log(`  ok    ${msg}`);
const todo = (msg: string) => console.log(`  ..    ${msg}`);
const fail = (msg: string): never => {
  console.error(`  FAIL  ${msg}`);
  process.exit(1);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

/** What Zoltar added to the machine, read by scripts/uninstall.sh. Only things that were not there before. */
function record(line: string): void {
  const file = '.zoltar-installed';
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  if (!lines.includes(line)) appendFileSync(file, `${line}\n`);
}

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`  FAIL  .env has an error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
})();
const { chat: chatModels, all: models } = ollamaModels(config, loadKb().length);
console.log(`AI mode: ${config.aiMode}`);

if (!models.length) {
  ok(config.aiMode === 'anthropic' ? 'Anthropic API; no local services needed' : `${config.aiMode}; no local services needed`);
  process.exit(0);
}

const url = new URL(config.ollamaUrl);
const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);

// Ollama creates ~/.ollama on first start. If it is not there yet, everything in it will be Zoltar's.
if (!args.check && local && !existsSync(join(homedir(), '.ollama'))) record('created ~/.ollama');

let status = await ollamaStatus(config.ollamaUrl, models);

if (args.check) {
  if (!status.reachable) fail(`Ollama not reachable at ${config.ollamaUrl}. Run \`make services\`.`);
  ok(`Ollama ${status.version} at ${config.ollamaUrl}`);
  if (status.missingModels.length) fail(`models not pulled: ${status.missingModels.join(', ')}. Run \`make services\`.`);
  ok(`models: ${models.join(', ')}`);
  process.exit(0);
}

if (!status.reachable) {
  if (!local) fail(`Ollama not reachable at ${config.ollamaUrl}. It is on another host, so start it there.`);

  if (!has('ollama')) {
    if (!args.install) fail('Ollama is not installed. Run `make install`.');
    installOllama();
  }

  todo(`starting Ollama on ${url.host}`);
  mkdirSync('data', { recursive: true });
  const logFd = openSync('data/ollama.log', 'a');
  // Detached so it keeps running after this script and the dev server exit. `make stop-ollama` stops it.
  const child = spawn('ollama', ['serve'], { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, OLLAMA_HOST: url.host } });
  // Stop Zoltar and `make stop-ollama` stop only this process, never an Ollama the user runs themselves.
  if (child.pid) writeFileSync('data/ollama.pid', String(child.pid));
  child.unref();

  const deadline = Date.now() + 30_000;
  while (!(status = await ollamaStatus(config.ollamaUrl, models)).reachable) {
    if (Date.now() > deadline) fail('Ollama did not start within 30 s. See data/ollama.log.');
    await sleep(500);
  }
}
ok(`Ollama ${status.version} at ${config.ollamaUrl}`);

for (const model of status.missingModels) await pull(model);
ok(`models: ${models.join(', ')}`);

// Loading a model takes seconds; doing it now keeps the first ticket from timing out. Embedding models are small
// and do not support /api/generate, so they load on first use.
// A model already in memory is skipped: Ollama queues the load request behind running requests, so with the app
// busy it would wait for a whole backlog of tickets.
const loaded = await fetch(`${config.ollamaUrl}/api/ps`)
  .then((r) => r.json() as Promise<{ models?: { name: string }[] }>)
  .then((b) => new Set((b.models ?? []).map((m) => m.name)))
  .catch(() => new Set<string>());
const inMemory = (m: string) => loaded.has(m) || (!m.includes(':') && loaded.has(`${m}:latest`));
let pending = false;
for (const model of chatModels.filter((m) => !inMemory(m))) {
  let res: Response;
  try {
    res = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: '30m' }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    pending = true;
    todo(`${model} is still loading (Ollama is busy); it finishes in the background`);
    continue;
  }
  if (!res.ok) fail(`could not load ${model}: HTTP ${res.status} ${await res.text()}`);
}
if (!pending) ok('models loaded into memory');

function installOllama(): void {
  todo('installing Ollama');
  const os = platform();
  const cmd =
    os === 'darwin' && has('brew')
      ? 'bash scripts/brew-install.sh ollama'
      : os === 'linux'
        ? 'curl -fsSL https://ollama.com/install.sh | sh'
        : fail('Install Ollama from https://ollama.com/download, then run `make services`.');
  if (spawnSync('sh', ['-c', cmd], { stdio: 'inherit' }).status !== 0) fail(`\`${cmd}\` failed`);
  if (os === 'linux') record('linux-ollama');
  if (!has('ollama')) fail('Ollama installed but not on PATH. Open a new terminal and run `make services`.');
  ok('Ollama installed');
}

async function pull(model: string): Promise<void> {
  todo(`pulling ${model} (first time only; several GB)`);
  const res = await fetch(`${config.ollamaUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) fail(`pull ${model}: HTTP ${res.status} ${await res.text()}`);
  let buf = '';
  let last = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body!) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
      if (msg.error) fail(`pull ${model}: ${msg.error}`);
      const progress = msg.total ? ` ${Math.floor(((msg.completed ?? 0) / msg.total) * 100)}%` : '';
      const text = `${msg.status ?? ''}${progress}`;
      if (text !== last && process.stdout.isTTY) process.stdout.write(`\r        ${text.padEnd(60)}`);
      last = text;
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\n');
  record(`model ${model}`);
  ok(`pulled ${model}`);
}
