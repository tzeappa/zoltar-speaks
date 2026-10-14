import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { liveSchema, SCHEMA } from './schema.ts';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  // One transaction, so two processes opening the database together cannot interleave the drop and create.
  db.exec(`BEGIN IMMEDIATE; ${liveSchema()} COMMIT;`);
  return db;
}

/** Columns added after the first release. CREATE TABLE IF NOT EXISTS does not add them to existing databases. */
function migrate(db: Db): void {
  const addColumn = (table: string, column: string, ddl: string): boolean => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    return true;
  };
  addColumn('clients', 'contact_email', 'TEXT');
  if (addColumn('incidents', 'recovered_at', 'INTEGER')) {
    // Open incidents whose latest monitor event is the recovery note recovered before the column existed.
    db.exec(`
      UPDATE incidents SET recovered_at = (
        SELECT e.created_at FROM incident_events e
        WHERE e.incident_id = incidents.id AND e.source = 'monitor' ORDER BY e.id DESC LIMIT 1
      )
      WHERE status != 'resolved' AND (
        SELECT e.message FROM incident_events e
        WHERE e.incident_id = incidents.id AND e.source = 'monitor' ORDER BY e.id DESC LIMIT 1
      ) LIKE '% operational for % checks.%'`);
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
