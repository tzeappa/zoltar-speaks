import type { Db } from './db/index.ts';

export type Listener = (topics: string[]) => void;

/**
 * Tells open pages which topics changed. Database triggers bump `live_versions`; this reads that small table on a
 * short timer while anyone is listening and reports the topics whose version moved. Reading the database (rather
 * than having every write path emit an event) also catches writes from other processes using the same database.
 */
export class LiveFeed {
  private readonly listeners = new Set<Listener>();
  private versions = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly intervalMs = 500,
  ) {}

  /** Returns an unsubscribe function. The timer runs only while there are listeners. */
  subscribe(fn: Listener): () => void {
    if (!this.listeners.size) {
      this.versions = this.read();
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      this.timer.unref();
    }
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) clearInterval(this.timer);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** One comparison; public so tests do not depend on the timer. */
  tick(): string[] {
    let next: Map<string, number>;
    try {
      next = this.read();
    } catch {
      return []; // database busy or closing; the next tick catches up
    }
    const changed = [...next].filter(([topic, v]) => this.versions.get(topic) !== v).map(([topic]) => topic);
    this.versions = next;
    if (changed.length) for (const fn of this.listeners) fn(changed);
    return changed;
  }

  stop(): void {
    clearInterval(this.timer);
    this.listeners.clear();
  }

  private read(): Map<string, number> {
    const rows = this.db.prepare('SELECT topic, version FROM live_versions').all() as { topic: string; version: number }[];
    return new Map(rows.map((r) => [r.topic, r.version]));
  }
}
