import { CLASSIFY_SYSTEM, PROMPT_VERSIONS, classifyUser } from '../ai/prompts.ts';
import { ClassificationOutput } from '../ai/schemas.ts';
import { callStructured, type CallContext } from '../ai/structured.ts';
import type { Classification } from '../db/repo.ts';
import type { Client } from '../domain.ts';

export interface ClassifyInput {
  clientToken: string;
  client: Pick<Client, 'kind' | 'industry'>;
  channel: string;
  text: string;
}

export async function classifyTicket(
  call: CallContext,
  model: string,
  input: ClassifyInput,
): Promise<{ classification: Classification; model: string; promptVersion: string }> {
  const res = await callStructured(call, {
    purpose: 'classify',
    model,
    promptVersion: PROMPT_VERSIONS.classify,
    system: CLASSIFY_SYSTEM,
    user: classifyUser(input),
    schema: ClassificationOutput,
    maxTokens: 800,
  });
  const o = res.data;
  return {
    classification: {
      category: o.category,
      platform: o.platform,
      priority: o.priority,
      sentiment: o.sentiment,
      requestedAction: o.requested_action,
      summary: o.summary,
      language: o.language,
      confidence: o.confidence,
      rationale: o.rationale,
    },
    model: res.model,
    promptVersion: res.promptVersion,
  };
}
