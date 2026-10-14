import { randomUUID } from 'node:crypto';

export interface Notice {
  to: string;
  subject: string;
  body: string;
  incidentId: number;
  clientId: string;
  kind: 'outage' | 'all_clear';
}

export interface Notifier {
  readonly channel: string;
  /** Resolves with a message id. Rejects if the message was not accepted. */
  send(n: Notice): Promise<{ providerId: string | null }>;
}

/** Simulated delivery: notices are recorded in the app and never leave it. Clients are fictional. */
export class OutboxNotifier implements Notifier {
  readonly channel = 'outbox';
  /** The most recent notices, for tests and debugging; the database keeps the full record. */
  readonly sent: Notice[] = [];
  async send(n: Notice) {
    this.sent.push(n);
    if (this.sent.length > 200) this.sent.shift();
    return { providerId: `outbox-${randomUUID()}` };
  }
}
