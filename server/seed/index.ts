import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { backfillContactEmail, countClients, insertTicketWithJob, upsertClient } from '../db/repo.ts';
import { CLIENTS } from './clients.ts';
import { SEED_TICKETS, SPIKE_TICKETS } from './tickets.ts';

export function seedIfEmpty(db: Db, now: number): boolean {
  if (countClients(db) > 0) {
    for (const c of CLIENTS) if (c.contactEmail) backfillContactEmail(db, c.id, c.contactEmail);
    return false;
  }
  for (const c of CLIENTS) upsertClient(db, c);
  // Oldest first so job order matches arrival order.
  for (const t of [...SEED_TICKETS].sort((a, b) => b.minutesAgo - a.minutesAgo)) {
    insertTicketWithJob(
      db,
      {
        externalId: t.id,
        clientId: t.clientId,
        channel: t.channel,
        subject: t.subject,
        body: t.body,
        receivedAt: now - t.minutesAgo * 60_000,
      },
      now,
    );
  }
  return true;
}

export function insertSpike(db: Db, now: number): number[] {
  const batch = randomUUID().slice(0, 8);
  return SPIKE_TICKETS.map(
    (t, i) =>
      insertTicketWithJob(
        db,
        {
          externalId: `spike-${batch}-${i + 1}`,
          clientId: t.clientId,
          channel: t.channel,
          subject: t.subject,
          body: t.body,
          receivedAt: now - (SPIKE_TICKETS.length - i) * 60_000,
        },
        now,
      ).ticket.id,
  );
}
