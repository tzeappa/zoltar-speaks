import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createModelClient } from './ai/client.ts';
import { ollamaStatus } from './ai/ollama.ts';
import { createApp } from './app.ts';
import { loadConfig, RETIRED_SETTINGS } from './config.ts';
import type { AppContext } from './context.ts';
import { openDb } from './db/index.ts';
import { failInterruptedOutbound } from './db/repo.ts';
import { LiveFeed } from './live.ts';
import { createLogger } from './logger.ts';
import { PlatformMonitor, sourcesFromConfig } from './monitor/monitor.ts';
import { OutboxNotifier } from './notify/notifier.ts';
import { ollamaModels } from './pipeline/embeddings.ts';
import { createKbIndex, loadKb } from './pipeline/retrieve.ts';
import { Worker } from './pipeline/worker.ts';
import { seedIfEmpty } from './seed/index.ts';
import { createServices } from './services.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const log = createLogger(config.logLevel, !config.production && process.stdout.isTTY);
for (const [key, replacement] of Object.entries(RETIRED_SETTINGS)) {
  if (process.env[key]) log.warn(`${key} is no longer used and is ignored; use ${replacement}`);
}

const docs = loadKb();
const needed = ollamaModels(config, docs.length).all;
if (needed.length) {
  const status = await ollamaStatus(config.ollamaUrl, needed);
  if (!status.reachable) {
    log.error({ url: config.ollamaUrl, err: status.error }, 'Ollama is not running. Start it with `make services`; until then tickets go to manual triage.');
  } else if (status.missingModels.length) {
    log.error({ missing: status.missingModels }, `Ollama models missing. Run \`make services\` or \`ollama pull ${status.missingModels[0]}\`.`);
  } else {
    log.info({ url: config.ollamaUrl, version: status.version }, 'Ollama ready');
  }
}

const db = openDb(config.dbPath);
const kb = createKbIndex(docs, config, db, log);
const model = createModelClient(config);

const ctx: AppContext = { db, config, log, kb, model, notifier: new OutboxNotifier(), now: Date.now };

if (config.seedOnStart && seedIfEmpty(db, ctx.now())) log.info('seeded database with demo clients and requests');
const interrupted = failInterruptedOutbound(db, ctx.now());
if (interrupted) log.warn({ notices: interrupted }, 'notices interrupted by the last shutdown are marked failed so they can be retried');

const worker = new Worker(ctx);
const monitor = new PlatformMonitor(ctx, sourcesFromConfig(ctx));
const services = createServices(ctx, {
  onNewWork: () => worker.poke(),
  runMonitor: () => void monitor.runOnce(),
});
const live = new LiveFeed(db);
const app = createApp(ctx, services, monitor, live);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info(
    { port: info.port, host: config.host, ai_mode: config.aiMode, models: [config.modelFast, config.modelSmart], kb_docs: kb.docs.length },
    `listening on http://localhost:${info.port}`,
  );
});

void kb.warm();
worker.start();
if (config.monitorEnabled) monitor.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  live.stop();
  server.close();
  // A local model call can take minutes. Jobs cut off here are requeued on the next start, so do not wait for them.
  await Promise.race([Promise.allSettled([monitor.stop(), worker.stop()]), new Promise((r) => setTimeout(r, 3_000))]);
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Closing the Terminal window of the Mac starter sends SIGHUP.
process.on('SIGHUP', () => void shutdown('SIGHUP'));
