import { describe, expect, it } from 'vitest';
import { evaluateCluster } from '../server/pipeline/incidents.ts';

const W = 60 * 60_000;
const t = { minTickets: 5, minClients: 3, watchMinTickets: 3 };
const at = (clientId: string, minute: number) => ({ clientId, receivedAt: minute * 60_000 });

describe('evaluateCluster', () => {
  it('opens a platform incident at 5 tickets from 3 clients within the window', () => {
    const tickets = [at('a', 0), at('b', 10), at('c', 20), at('a', 30), at('b', 40)];
    const v = evaluateCluster(tickets, tickets[4]!, W, t, true);
    expect(v?.kind).toBe('platform');
    expect(v?.members).toHaveLength(5);
  });

  it('needs enough distinct clients', () => {
    const tickets = [at('a', 0), at('b', 10), at('a', 20), at('b', 30), at('a', 40)];
    expect(evaluateCluster(tickets, tickets[4]!, W, t, true)?.kind).toBe('client_watch');
  });

  it('does not count tickets spread wider than the window, whatever the arrival order', () => {
    const tickets = [at('a', 0), at('b', 30), at('c', 60), at('d', 90), at('e', 120)];
    for (const current of tickets) expect(evaluateCluster(tickets, current, W, t, true)).toBeNull();
  });

  it('finds a cluster that starts after the current ticket', () => {
    const tickets = [at('a', 0), at('b', 20), at('c', 40), at('d', 50), at('e', 55)];
    expect(evaluateCluster(tickets, tickets[0]!, W, t, true)?.kind).toBe('platform');
  });

  it('never opens a platform incident for non-platform categories', () => {
    const tickets = [at('a', 0), at('b', 1), at('c', 2), at('d', 3), at('e', 4)];
    expect(evaluateCluster(tickets, tickets[0]!, W, t, false)).toBeNull();
  });

  it('opens a client watch with only that client’s tickets', () => {
    const tickets = [at('a', 0), at('b', 5), at('a', 10), at('a', 20)];
    const v = evaluateCluster(tickets, tickets[3]!, W, t, true);
    expect(v).toEqual({ kind: 'client_watch', members: [at('a', 0), at('a', 10), at('a', 20)] });
  });
});
