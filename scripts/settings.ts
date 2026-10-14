// Prints the settings scripts/start.sh needs as shell assignments for `eval`. Values are single-quoted, so nothing
// in .env can run as a shell command. Exits non-zero (with the reason on stderr) when .env is invalid.
import { existsSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const c = loadConfig();
const q = (v: unknown) => `'${String(v).replaceAll("'", `'\\''`)}'`;
console.log(`MODE=${q(c.aiMode)} PORT=${q(c.port)} MODEL=${q(c.aiMode === 'ollama' ? c.modelSmart : '')}`);
