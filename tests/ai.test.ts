import { describe, expect, it } from 'vitest';
import { toApiMessages } from '../server/ai/anthropic.ts';
import { IncidentBriefOutput } from '../server/ai/schemas.ts';
import { decodeJsonStrings } from '../server/ai/structured.ts';

describe('toApiMessages', () => {
  it('answers every replayed tool_use in the repair turn', () => {
    const raw = [
      { type: 'tool_use', id: 'tu_1', name: 'submit_incident_brief', input: { title: 'x' } },
      { type: 'tool_use', id: 'tu_2', name: 'submit_incident_brief', input: { next_steps: [] } },
    ];
    const msgs = toApiMessages(
      [
        { role: 'user', content: 'reports' },
        { role: 'tool_call', toolUseId: 'tu_1', input: { title: 'x' }, raw },
        { role: 'tool_error', toolUseId: 'tu_1', error: 'missing fields' },
      ],
      'submit_incident_brief',
    );
    const results = msgs[2]!.content as { type: string; tool_use_id: string }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['tu_1', 'tu_2']);
    expect(results.every((r) => r.type === 'tool_result')).toBe(true);
  });
});

describe('decodeJsonStrings', () => {
  const brief = {
    title: 'Instagram publishing degraded',
    severity: 'SEV2',
    summary: 'Publishing is failing.',
    impact: 'Platinum clients on Instagram.',
    suspected_cause: 'Unknown',
    timeline: '[{"at": "10:02", "event": "Monitor reported degraded"}]',
    next_steps: '[{"step": "Check the scheduler log", "runbook_id": null}]',
    unknowns: [],
    human_decisions: [],
    client_comms_macro: 'Hi {{client}}, we are looking into it.',
  };

  it('recovers arrays sent as JSON strings', () => {
    expect(IncidentBriefOutput.safeParse(brief).success).toBe(false);
    const parsed = IncidentBriefOutput.safeParse(decodeJsonStrings(brief));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.timeline[0]?.event).toBe('Monitor reported degraded');
  });

  it('leaves ordinary strings and invalid JSON alone', () => {
    expect(decodeJsonStrings({ a: 'plain', b: '[not json', c: 3 })).toEqual({ a: 'plain', b: '[not json', c: 3 });
  });
});
