export const TIERS = ['platinum', 'gold', 'standard'] as const;
export type Tier = (typeof TIERS)[number];

export const CATEGORIES = [
  'Publishing & Scheduling',
  'Analytics & Reporting',
  'Community & Comments',
  'Brand Safety & PR',
  'Campaign Strategy & Trends',
  'Account & Access',
  'Billing & Contract',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const PLATFORMS = [
  'Instagram',
  'TikTok',
  'X',
  'LinkedIn',
  'YouTube',
  'Facebook',
  'Reporting Dashboard',
  'Approval Portal',
  'Other',
  'None',
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SENTIMENTS = ['positive', 'neutral', 'frustrated', 'angry'] as const;

export const REQUESTED_ACTIONS = [
  'none',
  'info',
  'change',
  'takedown',
  'public_response',
  'access',
] as const;
export type RequestedAction = (typeof REQUESTED_ACTIONS)[number];

export type Route = 'suggest' | 'escalate';
export type PipelineStatus = 'queued' | 'processing' | 'done' | 'failed';
export type ReviewStatus = 'pending' | 'approved' | 'edited' | 'rejected';

export interface Client {
  id: string;
  name: string;
  kind: 'influencer' | 'brand';
  tier: Tier;
  industry: string;
  coordinator: string;
  aliases: string[];
  platforms: Platform[];
  /** Where incident notices go. Clients without one are skipped and listed for manual contact. */
  contactEmail: string | null;
}

/** A platform incident's brief is rewritten on its first client report and every this many after. */
export const BRIEF_REFRESH_EVERY = 5;

export const MONITORED_PLATFORMS = ['Instagram', 'TikTok', 'X', 'LinkedIn', 'YouTube', 'Facebook'] as const;
export type MonitoredPlatform = (typeof MONITORED_PLATFORMS)[number];

export const COMPONENTS = ['publishing', 'analytics'] as const;
export type Component = (typeof COMPONENTS)[number];

export type PlatformStatus = 'operational' | 'degraded' | 'outage' | 'unknown';

export const COMPONENT_CATEGORY: Record<Component, Category> = {
  publishing: 'Publishing & Scheduling',
  analytics: 'Analytics & Reporting',
};

export function priorityRank(p: Priority): number {
  return PRIORITIES.indexOf(p);
}

export function higherPriority(a: Priority, b: Priority): Priority {
  return priorityRank(a) <= priorityRank(b) ? a : b;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
