import { describe, expect, it } from 'vitest';
import type { Classification } from '../server/db/repo.ts';
import { decide, findRiskKeywords, type GateInput } from '../server/pipeline/gate.ts';

const cls = (over: Partial<Classification> = {}): Classification => ({
  category: 'Publishing & Scheduling',
  platform: 'Instagram',
  priority: 'P3',
  sentiment: 'neutral',
  requestedAction: 'info',
  summary: 'Post did not publish',
  language: 'en',
  confidence: 0.9,
  rationale: '',
  ...over,
});

const input = (over: Partial<GateInput> = {}): GateInput => ({
  classification: cls(),
  tier: 'standard',
  draft: { grounded: true, confidence: 0.85, citations: ['kb-publishing-failures'] },
  piiKinds: [],
  injectionSuspected: false,
  riskKeywords: [],
  aiFailure: null,
  confidenceThreshold: 0.7,
  ...over,
});

describe('decide', () => {
  it('suggests a routine, grounded, confident request', () => {
    expect(decide(input())).toEqual({ route: 'suggest', effectivePriority: 'P3', reasons: [] });
  });

  it.each([
    ['platinum', 'P4', 'P2'],
    ['platinum', 'P1', 'P1'],
    ['gold', 'P4', 'P3'],
    ['gold', 'P2', 'P2'],
    ['standard', 'P4', 'P4'],
  ] as const)('applies the %s tier floor to %s -> %s', (tier, modelPriority, expected) => {
    expect(decide(input({ tier, classification: cls({ priority: modelPriority }) })).effectivePriority).toBe(expected);
  });

  it('a tier floor raises priority but does not by itself escalate', () => {
    const d = decide(input({ tier: 'platinum', classification: cls({ priority: 'P4' }) }));
    expect(d.route).toBe('suggest');
    expect(d.effectivePriority).toBe('P2');
  });

  it.each(['takedown', 'public_response', 'access'] as const)('escalates the irreversible action %s', (action) => {
    const d = decide(input({ classification: cls({ requestedAction: action }) }));
    expect(d.route).toBe('escalate');
    expect(d.reasons).toContain(`action:${action}`);
  });

  it.each(['Brand Safety & PR', 'Billing & Contract', 'Account & Access'] as const)('escalates the sensitive category %s', (category) => {
    expect(decide(input({ classification: cls({ category }) })).reasons).toContain(`category:${category}`);
  });

  it('escalates P1 regardless of everything else', () => {
    expect(decide(input({ classification: cls({ priority: 'P1' }) })).reasons).toEqual(['priority:P1']);
  });

  it('escalates cards and credentials but not emails or phones', () => {
    expect(decide(input({ piiKinds: ['email', 'phone'] })).route).toBe('suggest');
    expect(decide(input({ piiKinds: ['card'] })).reasons).toContain('pii:card');
    expect(decide(input({ piiKinds: ['credential'] })).reasons).toContain('pii:credential');
  });

  it('escalates suspected prompt injection and risk keywords', () => {
    expect(decide(input({ injectionSuspected: true })).reasons).toContain('prompt_injection_suspected');
    expect(decide(input({ riskKeywords: ['legal'] })).reasons).toContain('keyword:legal');
  });

  it('escalates low confidence on either step', () => {
    expect(decide(input({ classification: cls({ confidence: 0.5 }) })).reasons).toContain('low_confidence:classification');
    expect(decide(input({ draft: { grounded: true, confidence: 0.5, citations: ['x'] } })).reasons).toContain('low_confidence:draft');
  });

  it('escalates ungrounded drafts and drafts without citations', () => {
    expect(decide(input({ draft: { grounded: false, confidence: 0.9, citations: ['x'] } })).reasons).toContain('ungrounded_draft');
    expect(decide(input({ draft: { grounded: true, confidence: 0.9, citations: [] } })).reasons).toContain('ungrounded_draft');
  });

  it('routes to manual triage when AI failed before classification', () => {
    const d = decide(input({ classification: null, draft: null, aiFailure: 'classify:transient', tier: 'gold' }));
    expect(d.route).toBe('escalate');
    expect(d.reasons).toEqual(['ai_failed:classify:transient']);
    expect(d.effectivePriority).toBe('P2');
  });

  it('does not add no_draft on top of an AI failure during drafting', () => {
    const d = decide(input({ draft: null, aiFailure: 'draft:invalid_output' }));
    expect(d.reasons).toEqual(['ai_failed:draft:invalid_output']);
  });

  it('reports a missing draft when there was no failure', () => {
    expect(decide(input({ draft: null })).reasons).toEqual(['no_draft']);
  });
});

describe('findRiskKeywords', () => {
  it.each([
    ['Our account was hacked last night', 'security'],
    ['We got password reset emails we did not request', 'security'],
    ['A journalist from the Times called', 'press'],
    ['Our lawyer will be in touch', 'legal'],
    ['We have contacted the police', 'police'],
    ['We want to cancel our contract', 'cancellation'],
    ['Can we get 2 extra posts per week in December? What would that cost?', 'money'],
    ['Question about the October invoice', 'money'],
    ['We were charged twice, please fix the payment', 'money'],
    ['Can you send a quote for next quarter?', 'money'],
    ['Necesito un reembolso de la factura', 'money'],
    ['Our legal team says this is copyright infringement', 'legal'],
    ['We received a DMCA notice', 'legal'],
  ])('flags "%s" as %s', (text, kw) => {
    expect(findRiskKeywords(text)).toContain(kw);
  });

  it('ignores routine requests', () => {
    expect(findRiskKeywords('Please move Friday’s carousel to Saturday at 10am')).toEqual([]);
  });

  it('does not treat a discount code in a client post as a money question', () => {
    expect(findRiskKeywords('The TikTok caption has the wrong discount code, it should be HOLIDAY20')).not.toContain('money');
  });

  it.each(['Boost the paid social campaign', 'Can you quote post this on X?', 'Our TikTok got a copyright strike on the music'])(
    'does not flag routine wording "%s"',
    (text) => {
      expect(findRiskKeywords(text)).toEqual([]);
    },
  );

  it('does not treat "press release" scheduling as a cancellation', () => {
    expect(findRiskKeywords('Can you cancel the 3pm post and schedule it tomorrow?')).not.toContain('cancellation');
  });
});
