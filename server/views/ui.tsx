import type { Child, FC } from 'hono/jsx';
import { raw } from 'hono/html';
import type { PlatformStatus, Priority, Tier } from '../domain.ts';

/**
 * Keeps a container current. app.js listens to /events and fires `live` on every container whose `data-live` lists a
 * topic that changed; htmx then re-fetches it. The 60 s fallback keeps relative times fresh and covers a dropped
 * connection. app.js holds a refresh while the user is typing or tabbing inside, and runs it when they leave.
 * hx-disinherit keeps these swap settings out of boosted links inside the container. It lists them by name: `*` would
 * also cut off the page's hx-boost, turning every link and form inside into a full page load.
 */
export const live = (id: string, url: string, topics: string) => ({
  id,
  'hx-get': url,
  'hx-trigger': 'live, every 60s',
  'hx-select': `#${id}`,
  'hx-swap': 'outerHTML',
  'hx-disinherit': 'hx-select hx-swap hx-sync',
  // A change that lands while a refresh is in flight gets its own request afterwards instead of being dropped.
  'hx-sync': 'this:queue last',
  'data-live': topics,
});

/** Static files are cached for an hour in production; a new value per start makes browsers fetch the new ones. */
const ASSET_VERSION = Date.now().toString(36);

export const REVIEWERS = ['Dana Whitfield', 'Luis Ortega', 'Mei Chen', 'Ops shift lead'];

export function timeAgo(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

export function usd(n: number): string {
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function ms(n: number | null): string {
  if (n === null) return '-';
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
}

export function pct(n: number | null): string {
  return n === null ? '-' : `${Math.round(n * 100)}%`;
}

const ACTION_LABELS: Record<string, string> = {
  takedown: 'Takedown requested',
  public_response: 'Public response requested',
  access: 'Account access change',
};

const FAILURE_LABELS: Record<string, string> = {
  ai_disabled: 'AI disabled: manual triage',
  retries_exhausted: 'AI unavailable after retries: manual triage',
  error: 'Processing error: manual triage',
};

/** Human text for gate reason codes. Codes stay stable for metrics; labels are for coordinators. */
export function reasonLabel(code: string): string {
  const [kind, ...rest] = code.split(':');
  const value = rest.join(':');
  switch (kind) {
    case 'priority':
      return `${value} priority`;
    case 'action':
      return ACTION_LABELS[value] ?? `Action: ${value}`;
    case 'category':
      return `Sensitive category: ${value}`;
    case 'pii':
      return value === 'card' ? 'Card number in message' : 'Credential in message';
    case 'prompt_injection_suspected':
      return 'Possible prompt injection';
    case 'keyword':
      if (value === 'security') return 'Possible account compromise';
      return value === 'money' ? 'Pricing or billing question' : `Mentions ${value}`;
    case 'low_confidence':
      return `Low ${value} confidence`;
    case 'ungrounded_draft':
      return 'Draft not grounded in playbook';
    case 'no_draft':
      return 'No draft';
    case 'ai_failed': {
      if (FAILURE_LABELS[value]) return FAILURE_LABELS[value];
      const [step, why] = value.split(':');
      return `AI ${step} failed (${why}): manual triage`;
    }
    default:
      return code;
  }
}

export const PriorityBadge: FC<{ p: Priority | null }> = ({ p }) =>
  p ? <span class={`badge prio prio-${p.toLowerCase()}`}>{p}</span> : <span class="badge muted">--</span>;

export const TierBadge: FC<{ tier: Tier }> = ({ tier }) => <span class={`badge tier tier-${tier}`}>{tier}</span>;

export const StatusPill: FC<{ status: PlatformStatus }> = ({ status }) => (
  <span class={`pill status-${status}`}>{status}</span>
);

export const Chip: FC<{ children: Child; tone?: string }> = ({ children, tone }) => (
  <span class={`chip ${tone ?? ''}`}>{children}</span>
);

export const Card: FC<{ title?: Child; children: Child; class?: string; actions?: Child; id?: string }> = (p) => (
  <section class={`card ${p.class ?? ''}`} id={p.id}>
    {p.title || p.actions ? (
      <header class="card-head">
        <h2>{p.title}</h2>
        {p.actions ? <div class="card-actions">{p.actions}</div> : null}
      </header>
    ) : null}
    {p.children}
  </section>
);

export interface LayoutProps {
  title: string;
  /** Path of this page, so the top bar can refresh its counts in place. */
  path: string;
  active: 'queue' | 'incidents' | 'platforms' | 'ops';
  reviewer: string;
  aiState: { mode: string; enabled: boolean };
  openIncidents: number;
  flash?: string | null;
  children: Child;
}

export const Layout: FC<LayoutProps> = (p) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* No history cache: it would keep client messages in localStorage and show stale pages on Back. */}
        <meta name="htmx-config" content='{"allowEval":false,"includeIndicatorStyles":false,"historyCacheSize":0}' />
        <title>{`${p.title} | Zoltar`}</title>
        <link rel="stylesheet" href={`/static/styles.css?v=${ASSET_VERSION}`} />
        <script src="/static/htmx.min.js" defer></script>
        <script src={`/static/app.js?v=${ASSET_VERSION}`} defer></script>
      </head>
      <body hx-boost="true">
        <header class="topbar" {...live('topbar', p.path, 'incidents ops')}>
          <a class="brand" href="/queue">
            Zoltar <span>for MacMillan Marketing</span>
          </a>
          <nav>
            <a href="/queue" class={p.active === 'queue' ? 'active' : ''}>Queue</a>
            <a href="/incidents" class={p.active === 'incidents' ? 'active' : ''}>
              Incidents {p.openIncidents ? <span class="count alert">{p.openIncidents}</span> : null}
            </a>
            <a href="/platforms" class={p.active === 'platforms' ? 'active' : ''}>Platforms</a>
            <a href="/ops" class={p.active === 'ops' ? 'active' : ''}>Ops</a>
          </nav>
          <div class="topbar-right">
            <span class={`ai-state ${p.aiState.enabled ? 'on' : 'off'}`}>
              AI: {p.aiState.enabled ? p.aiState.mode : 'off'}
            </span>
            <form method="post" action="/reviewer" class="reviewer">
              <label>
                Working as{' '}
                <select name="reviewer" data-autosubmit>
                  {REVIEWERS.map((r) => (
                    <option value={r} selected={r === p.reviewer}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <noscript>
                <button type="submit">Set</button>
              </noscript>
            </form>
          </div>
        </header>
        {p.flash ? <div class="flash">{p.flash}</div> : null}
        <main>{p.children}</main>
      </body>
    </html>
  </>
);
