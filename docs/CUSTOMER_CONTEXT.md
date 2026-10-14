# Customer context

All names, numbers, and clients are fictional assumptions.

## Customer

**MacMillan Marketing Company (MMC)** runs brand awareness and social media management for high-profile influencers and Forbes-list companies. MMC publishes on behalf of clients and monitors their socials, analytics, and trends.

## Users

| Team | Who | What they do today |
| --- | --- | --- |
| Client Services | ~10 account coordinators | Answer client requests from email and the client portal. ~150 requests/day. |
| Social Ops desk | ~4 people per shift, 24/7 | Watch publishing queues, analytics freshness, and client accounts. Own incidents. |

Neither team is technical. Coordinators live in an inbox; Ops lives in dashboards and runbooks.

## Typical requests

- "My 9am Instagram post never went live."
- "The weekly report shows half the reach we saw in the app."
- "Take that post down now."
- "The comments under yesterday's video are turning hostile."
- "A journalist emailed me about the campaign. What do we say?"
- "I can't log in to TikTok and I got a password reset I didn't request."
- "Can we get trend ideas for next week's launch?"
- Contract and invoice questions.

## Problems

1. **Slow triage.** A coordinator spends 10 to 15 minutes reading, categorizing, looking up the right playbook, and writing a first reply.
2. **Inconsistent priority.** High-stakes requests (account takeover, takedown, press) sometimes sit in the queue like routine ones. VIP clients expect a faster response than the queue order gives them.
3. **Late incident detection.** When a platform API degrades, scheduled posts fail for many clients at once. Ops usually learns about it from a trickle of client complaints spread across several coordinators, 30+ minutes after the first one.
4. **Confidentiality.** Client identities are newsworthy. MMC does not want client names sent to third-party services without need.

## What the solution does

- Classifies each request (category, platform, priority, requested action) and drafts a reply grounded in MMC's playbook, with citations.
- Routes risky requests to a human with explicit reasons. Tier and risk rules are code, not model judgment.
- Monitors the health of each social platform's publishing and analytics APIs. A degraded platform opens an incident before most clients notice, with a list of affected clients ordered by tier for proactive outreach.
- Groups similar requests across clients. When a cluster looks systemic, it opens (or joins) an incident for Ops with an AI-written brief, runbook steps, and a client-comms macro coordinators can reuse.
- Sends every affected client one notice saying the platform caused the problem, not their account, after Ops reviews the wording. When the platform has been healthy for 30 seconds, offers to resolve the incident and send an all-clear to everyone who heard about the outage. Delivery is simulated in this build.
- Replaces client names and PII with tokens before any model call. Can also run entirely on a local model, so no request text leaves MMC's machines.

## Value

| Metric | Today (assumed) | Target |
| --- | --- | --- |
| Time to first draft | 10 to 15 min | Under 1 min for suggested drafts |
| P1 requests misrouted | Occasional | Zero by rule (tier floor, action rules) |
| Time to detect a cross-client outage | 30+ min | One monitor check for an outage, 20 seconds for a degraded platform; otherwise the 5th report |
| Clients who hear about an outage from MMC first | Few | Every affected client, in one step |
| Clients told when it is fixed | Only those who ask | Everyone who heard about the outage |
| Coordinator effort on duplicate outage replies | One reply per client | One approved macro |

Draft acceptance rate and edit distance are tracked so MMC can verify the value instead of trusting it.

## Out of scope

- Auto-sending replies or notices. A coordinator approves every reply, and Ops sends every outage notice and all-clear.
- Real email delivery. Notices are recorded, not sent; connecting MMC's email provider is a later step.
- Posting, editing, or deleting anything on client socials.
- Replacing MMC's analytics and social listening tools. Platform health monitoring is in scope; trend and sentiment monitoring are not.
- Authentication, roles, multi-office setup.
