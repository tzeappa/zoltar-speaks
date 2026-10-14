/**
 * Runs the app in the background, like a service. Uses the same pid file and log as the Mac starter, so
 * "Stop Zoltar", `make stop`, and the uninstaller all find it.
 *
 *   node --import tsx scripts/daemon.ts start   # start detached, wait until it answers, return
 *   node --import tsx scripts/daemon.ts stop    # stop the app running from this folder, however it was started
 *   node --import tsx scripts/daemon.ts running # exit 0 if the app answers, so `make start` can skip setup
 *   node --import tsx scripts/daemon.ts status  # print the app's health report, for `make status`
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../server/config.ts';

const ROOT = process.cwd();
const LOG = 'data/zoltar.log';
const PIDFILE = 'data/zoltar.pid';
/** Rotated at start, so a long-running install does not fill the disk. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;

const ok = (msg: string) => console.log(`  ok    ${msg}`);
const todo = (msg: string) => console.log(`  ..    ${msg}`);
const fail = (msg: string): never => {
  console.error(`  FAIL  ${msg}`);
  process.exit(1);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (existsSync('.env')) process.loadEnvFile('.env');

const command = process.argv[2];
if (command === 'start') await start();
else if (command === 'running') process.exit((await answers(healthUrl(loadConfig()))) ? 0 : 1);
else if (command === 'status') await status();
else if (command === 'stop') await stop();
else fail('usage: daemon.ts start|stop|running|status');

/** For `make status`: the app's own health report, read from wherever .env says it listens. */
async function status(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(`.env has an error: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const res = await fetch(healthUrl(config!), { signal: AbortSignal.timeout(3_000) });
    ok(`app at http://localhost:${config!.port}: ${await res.text()}`);
  } catch {
    todo(`app not running on port ${config!.port}`);
  }
}

async function start(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(`.env has an error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const health = healthUrl(config!);
  const url = `http://localhost:${config!.port}`;

  if (await answers(health)) {
    ok(`already running at ${url}${appPids().length ? ` (pid ${appPids().join(', ')})` : ''}`);
    return;
  }
  if (spawnSync('lsof', ['-nP', `-iTCP:${config!.port}`, '-sTCP:LISTEN'], { stdio: 'ignore' }).status === 0) {
    fail(`another program is using port ${config!.port}. Stop it, or set a different PORT in .env.`);
  }

  mkdirSync('data', { recursive: true });
  if (existsSync(LOG) && statSync(LOG).size > MAX_LOG_BYTES) renameSync(LOG, `${LOG}.1`);
  const logFd = openSync(LOG, 'a');
  // detached starts a new session, so closing this terminal (SIGHUP) does not stop the app.
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (!child.pid) fail('could not start the app');
  writeFileSync(PIDFILE, String(child.pid));
  child.unref();

  todo('starting the app');
  const deadline = Date.now() + 60_000;
  while (!(await answers(health))) {
    if (!alive(child.pid!)) {
      rmSync(PIDFILE, { force: true });
      console.error(tail(LOG, 20));
      fail(`the app stopped while starting. Full log: ${LOG}`);
    }
    if (Date.now() > deadline) {
      try {
        process.kill(child.pid!, 'SIGTERM');
      } catch {
        // already gone
      }
      rmSync(PIDFILE, { force: true });
      fail(`the app did not answer within 60 s. See ${LOG}.`);
    }
    await sleep(500);
  }
  ok(`running in the background at ${url} (pid ${child.pid})`);
  console.log(`        logs: make logs (${LOG})    stop: make stop`);
}

/** One implementation for "Stop Zoltar", the installers, and `make stop`; it also stops a Mac starter window cleanly. */
async function stop(): Promise<void> {
  process.exit(spawnSync('bash', ['scripts/stop.sh', '--app-only'], { stdio: 'inherit' }).status ?? 1);
}

/** App processes started from this folder: by this script, the Mac starter, `make dev`, or `npm start`. */
function appPids(): number[] {
  const found = spawnSync('pgrep', ['-f', 'tsx.*server/main.ts'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
  const pids = found.filter((pid) => pid !== process.pid && cwdOf(pid) === ROOT);
  if (existsSync(PIDFILE)) {
    const pid = Number(readFileSync(PIDFILE, 'utf8'));
    // After a crash the pid may belong to another program by now.
    const cmd = pid ? spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout : '';
    if (cmd.includes('server/main.ts') && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

function cwdOf(pid: number): string | undefined {
  // Linux images often have no lsof.
  if (existsSync(`/proc/${pid}/cwd`)) {
    try {
      return realpathSync(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  }
  const out = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout;
  return out.split('\n').find((l) => l.startsWith('n'))?.slice(1);
}

function healthUrl(config: ReturnType<typeof loadConfig>): string {
  const host = ['0.0.0.0', '::', ''].includes(config.host) ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}/healthz`;
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return (await res.text()).includes('"db"');
  } catch {
    return false;
  }
}

function tail(file: string, lines: number): string {
  return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
}
