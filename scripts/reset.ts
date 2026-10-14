import { existsSync, rmSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const path = process.env.DB_PATH || 'data/zoltar.db';

// A running server keeps the deleted files open and goes on writing to them; that data is lost on the next start.
const port = (() => {
  try {
    return loadConfig().port;
  } catch {
    return 8787;
  }
})();
const running = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) })
  .then((r) => r.text())
  .then((t) => t.includes('"db"'))
  .catch(() => false);
if (running) {
  console.error(`Zoltar is running on port ${port}. Stop it first (make stop), then reset.`);
  process.exit(1);
}

for (const file of [path, `${path}-wal`, `${path}-shm`]) {
  if (existsSync(file)) rmSync(file);
}
console.log(`Removed ${path}. The next start reseeds the demo data.`);
