import { z } from 'zod';
import { CATEGORIES, PLATFORMS, PRIORITIES, REQUESTED_ACTIONS, SENTIMENTS } from '../domain.ts';

// Routing fields come first: smaller models fill fields in schema order and can drop later ones after a long rationale.
export const ClassificationOutput = z.object({
  category: z.enum(CATEGORIES),
  platform: z
    .enum(PLATFORMS)
    .describe('Platform the request is about. "Other" for platforms MMC does not manage, "None" if not platform-specific.'),
  requested_action: z.enum(REQUESTED_ACTIONS),
  priority: z.enum(PRIORITIES),
  sentiment: z.enum(SENTIMENTS),
  language: z.string().min(2).max(10).describe('ISO 639-1 code of the client message.'),
  confidence: z.number().min(0).max(1).describe('Probability that category, priority and action are all correct.'),
  summary: z.string().min(1).max(400).describe('One sentence: what the client needs.'),
  rationale: z.string().min(1).max(1200).describe('At most two sentences on why this category, priority and action.'),
});
export type ClassificationOutput = z.infer<typeof ClassificationOutput>;

export const DraftOutput = z.object({
  reply: z.string().min(1).max(3000).describe('Reply to the client, ready for a coordinator to review.'),
  citations: z.array(z.string()).max(6).describe('IDs of the <doc> elements the reply relies on.'),
  grounded: z.boolean().describe('True only if every factual statement in the reply comes from the cited docs.'),
  confidence: z.number().min(0).max(1).describe('Probability the reply can be sent with no edits.'),
  missing_info: z.array(z.string()).max(5).describe('Questions the coordinator should resolve before sending.'),
  internal_note: z.string().max(500).describe('One or two sentences for the coordinator: risks, what to verify.'),
});
export type DraftOutput = z.infer<typeof DraftOutput>;

export const IncidentBriefOutput = z.object({
  title: z.string().min(1).max(120),
  severity: z.enum(['SEV1', 'SEV2', 'SEV3']),
  summary: z.string().min(1).max(800),
  impact: z.string().min(1).max(500).describe('Who is affected and how, by client tier.'),
  suspected_cause: z.string().max(500).describe('Hypothesis supported by the reports, or "Unknown".'),
  timeline: z
    .array(z.object({ at: z.string(), event: z.string() }))
    .max(12)
    .describe('Key moments from the reports, oldest first. Use the provided times.'),
  next_steps: z
    .array(z.object({ step: z.string(), runbook_id: z.string().nullable() }))
    .min(1)
    .max(8),
  unknowns: z.array(z.string()).max(6),
  human_decisions: z.array(z.string()).max(5).describe('Decisions Social Ops must make; the model must not make them.'),
  client_comms_macro: z
    .string()
    .min(1)
    .max(1200)
    .describe('Email to affected clients. States the platform caused it, not their account. Use {{client}} for the client name. No ETA unless known.'),
});
export type IncidentBriefOutput = z.infer<typeof IncidentBriefOutput>;
