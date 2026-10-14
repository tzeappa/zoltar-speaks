import { DRAFT_SYSTEM, PROMPT_VERSIONS, draftUser } from '../ai/prompts.ts';
import { DraftOutput } from '../ai/schemas.ts';
import { callStructured, type CallContext } from '../ai/structured.ts';
import type { Client } from '../domain.ts';
import type { KbDoc } from './retrieve.ts';

export function validateCitations(cited: string[], retrievedIds: string[]): { valid: string[]; dropped: string[] } {
  const allowed = new Set(retrievedIds);
  const valid: string[] = [];
  const dropped: string[] = [];
  for (const id of new Set(cited)) (allowed.has(id) ? valid : dropped).push(id);
  return { valid, dropped };
}

export interface DraftInput {
  clientToken: string;
  client: Pick<Client, 'kind' | 'industry'>;
  text: string;
  summary: string;
  category: string;
  platform: string;
  docs: KbDoc[];
  incidentNote: string | null;
}

export interface DraftResult {
  body: string;
  citations: string[];
  droppedCitations: string[];
  grounded: boolean;
  confidence: number;
  missingInfo: string[];
  internalNote: string;
  model: string;
  promptVersion: string;
}

/** Body is returned pseudonymized; the caller rehydrates it. */
export async function draftReply(call: CallContext, model: string, input: DraftInput): Promise<DraftResult> {
  const res = await callStructured(call, {
    purpose: 'draft',
    model,
    promptVersion: PROMPT_VERSIONS.draft,
    system: DRAFT_SYSTEM,
    user: draftUser(input),
    schema: DraftOutput,
    // Leaves room for models that think before calling the tool.
    maxTokens: 4000,
  });
  const o = res.data;
  const { valid, dropped } = validateCitations(
    o.citations,
    input.docs.map((d) => d.id),
  );
  return {
    body: o.reply,
    citations: valid,
    droppedCitations: dropped,
    // A fabricated citation means the model's own grounding claim cannot be trusted.
    grounded: o.grounded && valid.length > 0 && dropped.length === 0,
    confidence: o.confidence,
    missingInfo: o.missing_info,
    internalNote: o.internal_note,
    model: res.model,
    promptVersion: res.promptVersion,
  };
}
