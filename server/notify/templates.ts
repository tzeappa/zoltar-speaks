import type { IncidentBriefOutput } from '../ai/schemas.ts';
import type { Incident } from '../db/repo.ts';
import type { Category, Client } from '../domain.ts';

export interface NoticeDraft {
  subject: string;
  body: string;
}

const AREA: Partial<Record<Category, string>> = {
  'Publishing & Scheduling': 'publishing and scheduled posts',
  'Analytics & Reporting': 'analytics and reporting data',
  'Community & Comments': 'comments and community tools',
  'Account & Access': 'account access',
};
const area = (inc: Pick<Incident, 'category'>) => AREA[inc.category] ?? inc.category.toLowerCase();

/**
 * Outage notice. Uses the AI brief's approved client message when there is one, otherwise a fixed template.
 * Either way the text states that the platform caused the problem.
 */
type IncidentFields = Pick<Incident, 'platform' | 'category' | 'briefStatus'> & { brief: unknown };

/** Pass the display incident: its brief has real client names, not pseudonym tokens. */
export function outageDraft(inc: IncidentFields): NoticeDraft {
  const subject = `${inc.platform} issue affecting ${area(inc)}: not caused by your account`;
  const brief = inc.briefStatus === 'ready' ? (inc.brief as IncidentBriefOutput | null) : null;
  if (brief?.client_comms_macro) return { subject, body: brief.client_comms_macro };
  return {
    subject,
    body: `Hi {{client}},

${inc.platform} is having a problem on their side that affects ${area(inc)} for many accounts, including yours. The problem is with ${inc.platform} itself. It is not caused by your account, your content, or anything you did, and you do not need to do anything.

Our Social Ops team is watching ${inc.platform}'s status and holding affected posts. Anything that did not go out will be republished once ${inc.platform} recovers, and we will email you when everything is back to normal.

If something is time-critical, reply to this email and {{coordinator}} will contact you directly.

MMC Client Services`,
  };
}

export function allClearDraft(inc: Pick<Incident, 'platform' | 'category'>): NoticeDraft {
  return {
    subject: `Resolved: ${inc.platform} ${area(inc)} back to normal`,
    body: `Hi {{client}},

The ${inc.platform} issue we told you about is resolved. Everything is working normally again for ${area(inc)}. The cause was on ${inc.platform}'s side; nothing on your account needed to change.

Posts that were held or failed during the outage are going back into the schedule now. If any publish time had to move, {{coordinator}} will confirm the new time with you.

Thank you for your patience.

MMC Client Services`,
  };
}

/** Fills the per-client placeholders. Unknown placeholders are left as is so a reviewer can spot them. */
export function personalize(text: string, client: Client): string {
  return text.replaceAll('{{client}}', client.name).replaceAll('{{coordinator}}', client.coordinator);
}
