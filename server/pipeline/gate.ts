import type { Classification } from '../db/repo.ts';
import { higherPriority, type Priority, type RequestedAction, type Tier } from '../domain.ts';
import type { PiiKind } from './redact.ts';

export const TIER_FLOOR: Record<Tier, Priority> = {
  platinum: 'P2',
  gold: 'P3',
  standard: 'P4',
};

const IRREVERSIBLE_ACTIONS: RequestedAction[] = ['takedown', 'public_response', 'access'];
const SENSITIVE_CATEGORIES = ['Brand Safety & PR', 'Billing & Contract', 'Account & Access'];
const BLOCKING_PII: PiiKind[] = ['card', 'credential'];

const RISK_KEYWORDS: [string, RegExp][] = [
  [
    'security',
    /\b(hacked|compromised|unauthori[sz]ed|account takeover|did(n'?t| not) (request|approve)|never (requested|approved)|suspicious login)\b/i,
  ],
  ['press', /\b(press|journalist|reporter|media inquiry|newspaper|interview request)\b/i],
  // Keywords are the backstop for a misclassified ticket, so they include common Spanish, French, and German terms.
  [
    'legal',
    /\b(lawyers?|attorneys?|legal (action|team|department|notice)|lawsuit|sue|suing|cease and desist|defamation|libel|copyright infringement|infring(e|es|ed|ing|ement)|dmca|trademark|abogad[oa]s?|demanda|avocats?|poursuites?|anwalt|anw[äa]ltin|klage)\b/i,
  ],
  ['police', /\b(police|law enforcement|polic[ií]a|polizei)\b/i],
  ['cancellation', /\b(cancel (our|my|the) (contract|account|retainer)|terminate (our|the) (contract|agreement))\b/i],
  // A draft must never quote a price, even when the model files the request under strategy or publishing.
  [
    'money',
    /\b(price|prices|pricing|cost|costs|how much|invoices?|refunds?|billing|billed|overcharged|(double |been )?charged|payments?|fees?|rate card|subscription|(send|give|get) (us |me )?a quote|quote (us|me)|precios?|facturas?|reembolsos?|cobr[oóa]\w*|prix|factures?|rembours\w*|preise?|rechnung(en)?|erstattung|kosten)\b|[$€£]\s?\d/i,
  ],
];

export function findRiskKeywords(text: string): string[] {
  return RISK_KEYWORDS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export interface GateDraft {
  grounded: boolean;
  confidence: number;
  citations: string[];
}

export interface GateInput {
  classification: Classification | null;
  tier: Tier;
  draft: GateDraft | null;
  piiKinds: PiiKind[];
  injectionSuspected: boolean;
  riskKeywords: string[];
  /** Set when an AI step did not complete, e.g. "classify:transient" or "ai_disabled". */
  aiFailure: string | null;
  confidenceThreshold: number;
}

export interface GateDecision {
  route: 'suggest' | 'escalate';
  effectivePriority: Priority;
  reasons: string[];
}

/**
 * Routing is decided here, never by the model. Reasons use stable codes so the UI and metrics can group them.
 */
export function decide(input: GateInput): GateDecision {
  const { classification: c, tier, draft } = input;
  const floor = TIER_FLOOR[tier];
  const effectivePriority = c ? higherPriority(c.priority, floor) : higherPriority('P2', floor);
  const reasons: string[] = [];

  if (input.aiFailure) reasons.push(`ai_failed:${input.aiFailure}`);
  if (effectivePriority === 'P1') reasons.push('priority:P1');
  if (c && IRREVERSIBLE_ACTIONS.includes(c.requestedAction)) reasons.push(`action:${c.requestedAction}`);
  if (c && SENSITIVE_CATEGORIES.includes(c.category)) reasons.push(`category:${c.category}`);
  for (const kind of input.piiKinds) if (BLOCKING_PII.includes(kind)) reasons.push(`pii:${kind}`);
  if (input.injectionSuspected) reasons.push('prompt_injection_suspected');
  for (const kw of input.riskKeywords) reasons.push(`keyword:${kw}`);
  if (c && c.confidence < input.confidenceThreshold) reasons.push('low_confidence:classification');

  if (c && !input.aiFailure) {
    if (!draft) reasons.push('no_draft');
    else {
      if (!draft.grounded || draft.citations.length === 0) reasons.push('ungrounded_draft');
      if (draft.confidence < input.confidenceThreshold) reasons.push('low_confidence:draft');
    }
  }

  return { route: reasons.length ? 'escalate' : 'suggest', effectivePriority, reasons };
}
