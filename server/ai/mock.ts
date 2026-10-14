import { plural, type Category, type Platform, type Priority, type RequestedAction } from '../domain.ts';
import type { ClassificationOutput, DraftOutput, IncidentBriefOutput } from './schemas.ts';
import { AiError, type ModelClient, type ModelRequest, type ModelResponse } from './types.ts';

const has = (text: string, re: RegExp) => re.test(text);

const PLATFORM_RULES: [Platform, RegExp][] = [
  ['Other', /\b(snapchat|pinterest|twitch|reddit)\b/i],
  ['Instagram', /\b(instagram|insta|ig|reels?)\b/i],
  ['TikTok', /\btiktok\b/i],
  ['LinkedIn', /\blinkedin\b/i],
  ['YouTube', /\b(youtube|yt)\b/i],
  ['Facebook', /\b(facebook|fb)\b/i],
  ['X', /\b(twitter|tweets?|on x|x account|x post)\b/i],
  ['Reporting Dashboard', /\b(dashboard|weekly report|monthly report|report)\b/i],
  ['Approval Portal', /\b(approval portal|portal)\b/i],
];

const CATEGORY_RULES: [Category, RegExp][] = [
  [
    'Account & Access',
    /\b(hacked|compromis\w*|password\w*|did(n'?t| not) request|unauthori[sz]ed|locked out|2fa|two.factor|log ?in|give .{0,30}access|add (him|her|them)|access to)\b/i,
  ],
  ['Brand Safety & PR', /\b(press|journalist|reporter|controvers\w*|backlash|crisis|statement|boycott|lawyer|without permission)\b/i],
  [
    'Billing & Contract',
    /\b(invoices?|billing|contract|renewal|pricing|price|cost|refund|cancel\w*|retainer|response time|start managing)\b/i,
  ],
  ['Community & Comments', /\b(comments?|trolls?|dms?|hostile|harass\w*|abusive)\b/i],
  ['Analytics & Reporting', /\b(report|numbers|analytics|reach|impressions|dashboard|metrics|engagement|views|stats|csv|export)\b/i],
  [
    'Publishing & Scheduling',
    /\b(post|posts|posted|publish\w*|publicaci\w*|scheduled|went live|go live|reschedul\w*|caption|story|stories|carousel|teaser|tweet|take it down|strike)\b/i,
  ],
  ['Campaign Strategy & Trends', /\b(trends?|trending|ideas?|campaign|launch|brainstorm|strategy|concepts?|calendar)\b/i],
];

function detectLanguage(text: string): string {
  if (has(text, /\b(hola|gracias|publicaci[oó]n|por favor|nuestro|cuenta)\b/i)) return 'es';
  if (has(text, /\b(bonjour|merci|publication|s'il vous pla[iî]t|notre)\b/i)) return 'fr';
  if (has(text, /\b(hallo|danke|bitte|beitrag|unser)\b/i)) return 'de';
  return 'en';
}

function requestedAction(text: string): RequestedAction {
  if (has(text, /\b(take (it|this|that|the post|them) down|take down|takedown|(delete|remove|pull) (my|the|this|that|our) (\w+ )?(post|tweet|video|reel|story|tiktok))\b/i))
    return 'takedown';
  if (has(text, /\b(statement|respond publicly|reply publicly|public response|post a response|respond to (the )?(journalist|press|reporter))\b/i))
    return 'public_response';
  if (has(text, /\b(hacked|compromis\w*|locked out|reset (the )?(password|2fa)|recover|give .* access|remove .* access|add (him|her|them)|add .* as (an )?admin|password reset)\b/i))
    return 'access';
  if (has(text, /\b(reschedul\w*|move (it|the post)|change|update|edit|swap|add .* filter|turn off comments|repost|republish|fix)\b/i))
    return 'change';
  if (has(text, /\?|\b(can you|could you|why|what|how|when)\b/i)) return 'info';
  return 'none';
}

function priority(text: string, action: RequestedAction): Priority {
  if (has(text, /\b(hacked|compromis\w*|unauthori[sz]ed|did(n'?t| not) request|nobody .{0,20}approved)\b/i)) return 'P1';
  if (has(text, /\b(address|scared|threat\w*|doxx\w*)\b/i) && has(text, /\b(comments?|posted)\b/i)) return 'P1';
  if (action === 'takedown' && has(text, /\b(now|asap|immediately|urgent)\b/i)) return 'P1';
  if (has(text, /\b(journalist|reporter|press)\b/i) && has(text, /\b(today|deadline|tonight)\b/i)) return 'P1';
  if (has(text, /\b(urgent|asap|immediately|today|this morning|never went live|didn'?t go live|failed|launch)\b/i)) return 'P2';
  if (has(text, /\b(thanks so much|thank you|fyi|no rush|whenever)\b/i)) return 'P4';
  return 'P3';
}

function sentiment(text: string): ClassificationOutput['sentiment'] {
  if (has(text, /!!|\b(unacceptable|furious|ridiculous|worst|disgrace)\b/i)) return 'angry';
  if (has(text, /\b(again|still|frustrat\w*|disappoint\w*|not happy|second time)\b/i)) return 'frustrated';
  if (has(text, /\b(thank|love|great job|amazing|fantastic)\b/i)) return 'positive';
  return 'neutral';
}

function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start + open.length, end).trim() : '';
}

function firstSentence(text: string): string {
  const body = text.replace(/^Subject:.*\n+/i, '').replace(/\s+/g, ' ').trim();
  const m = body.match(/^(.{20,200}?[.!?])(\s|$)/);
  return (m?.[1] ?? body.slice(0, 160)).trim();
}

export function mockClassify(ticketText: string): ClassificationOutput {
  const platform = PLATFORM_RULES.find(([, re]) => re.test(ticketText))?.[0] ?? 'None';
  const matched = CATEGORY_RULES.filter(([, re]) => re.test(ticketText)).map(([c]) => c);
  const category = matched[0] ?? 'Campaign Strategy & Trends';
  const action = requestedAction(ticketText);
  const language = detectLanguage(ticketText);
  let confidence = 0.9;
  if (matched.length === 0) confidence -= 0.35;
  if (matched.length >= 4) confidence -= 0.15;
  if (language !== 'en') confidence -= 0.3;
  return {
    summary: firstSentence(ticketText),
    rationale: `Mock classifier. Keyword match: ${matched.slice(0, 3).join(', ') || 'none'}.`,
    category,
    platform,
    requested_action: action,
    priority: priority(ticketText, action),
    sentiment: sentiment(ticketText),
    language,
    confidence: Math.max(0.2, Math.round(confidence * 100) / 100),
  };
}

export function mockDraft(prompt: string): DraftOutput {
  const token = prompt.match(/Client: (\[CLIENT_\d+\])/)?.[1] ?? 'there';
  const docs = [...prompt.matchAll(/<doc id="([^"]+)" title="([^"]+)">/g)].map((m) => ({ id: m[1]!, title: m[2]! }));
  const triage = prompt.match(/Triage: (.+?) \/ (.+?)\.\n/);
  const platform = triage?.[2] ?? '';
  const incident = between(prompt, '<incident>', '</incident>');

  if (docs.length === 0) {
    return {
      reply: `Hi ${token},\n\nThank you for your message. Your coordinator is looking into this and will follow up with you directly.\n\nMMC Client Services`,
      citations: [],
      grounded: false,
      confidence: 0.5,
      missing_info: ['No playbook article covers this request.'],
      internal_note: 'No matching playbook docs. Write this reply manually.',
    };
  }

  const primary = docs[0]!;
  const incidentLine = incident
    ? `We are aware of an issue currently affecting several accounts on ${platform}, and our Social Ops team is actively working on it. `
    : '';
  return {
    reply: `Hi ${token},\n\nThank you for letting us know. ${incidentLine}We have checked this against our "${primary.title}" guidance and the team is reviewing it now. We will confirm the next steps with you shortly.\n\nMMC Client Services`,
    citations: docs.slice(0, 2).map((d) => d.id),
    grounded: true,
    confidence: incident ? 0.86 : 0.8,
    missing_info: [],
    internal_note: `Mock draft based on ${primary.id}. Check specifics before sending.`,
  };
}

export function mockBrief(prompt: string): IncidentBriefOutput {
  const header = prompt.match(/Incident: (.+?) on (.+?)\./);
  const category = header?.[1] ?? 'Unknown';
  const platform = header?.[2] ?? 'Unknown';
  const reports = [...prompt.matchAll(/<report client="([^"]+)" tier="([^"]+)" at="([^"]+)">/g)];
  const signals = between(prompt, '<signals>\n', '\n</signals>')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));
  const runbook = prompt.match(/<doc id="(rb-[^"]+)"/)?.[1] ?? null;
  const platinum = reports.filter((r) => r[2] === 'platinum').length;
  const outage = signals.some((s) => /outage/i.test(s));

  return {
    title: `${platform} ${category.toLowerCase()} issue`,
    severity: outage || platinum > 0 ? 'SEV1' : 'SEV2',
    summary: `${plural(reports.length, 'client report')} and ${plural(signals.length, 'monitoring signal')} point to a ${category.toLowerCase()} problem on ${platform}.`,
    impact: `${reports.length} clients reported so far, ${platinum} platinum. Other clients on ${platform} are likely affected.`,
    suspected_cause: signals.length ? `Platform-side degradation reported by monitoring.` : 'Unknown',
    timeline: [
      ...signals.map((s) => ({ at: s.split(': ')[0] ?? '', event: s.split(': ').slice(1).join(': ') })),
      ...reports.map((r) => ({ at: r[3]!, event: `Report from ${r[1]} (${r[2]})` })),
    ].slice(0, 12),
    next_steps: [
      { step: `Confirm the failure pattern in the scheduler log for ${platform}.`, runbook_id: runbook },
      { step: 'Post a status note for coordinators.', runbook_id: runbook },
      { step: 'Contact platinum clients from the notify list.', runbook_id: null },
    ],
    unknowns: ['Root cause', 'Expected recovery time'],
    human_decisions: [`Whether to pause the ${platform} publishing queue for all clients`],
    client_comms_macro: `Hi {{client}},\n\n${platform} is having a problem on their side that is affecting several accounts we manage, including yours. The problem is with ${platform} itself, not something caused by your account or content, and you do not need to do anything. Our Social Ops team is on it, and any affected posts will be republished once the platform recovers. We will update you as soon as we know more.\n\nMMC Client Services`,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MockOptions {
  latencyMs?: number;
  failRate?: number;
}

/** Deterministic stand-in for the model. Reads the same prompts the real model gets. */
export class MockClient implements ModelClient {
  readonly name = 'mock';
  constructor(private readonly opts: MockOptions = {}) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const latency = (this.opts.latencyMs ?? 0) * (req.purpose === 'classify' ? 1 : 2.5);
    if (latency > 0) await sleep(latency * (0.7 + Math.random() * 0.6));
    if (this.opts.failRate && Math.random() < this.opts.failRate) {
      throw new AiError('transient', 'Mock transient failure');
    }

    const first = req.messages[0];
    const prompt = first && first.role === 'user' ? first.content : '';
    const output =
      req.purpose === 'classify'
        ? mockClassify(between(prompt, '<ticket>', '</ticket>'))
        : req.purpose === 'draft'
          ? mockDraft(prompt)
          : mockBrief(prompt);

    const inputChars = req.system.length + prompt.length;
    return {
      toolInput: output,
      toolUseId: `mock_${Date.now()}`,
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: Math.ceil(JSON.stringify(output).length / 4),
    };
  }
}
