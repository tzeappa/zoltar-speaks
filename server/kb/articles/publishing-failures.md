---
id: kb-publishing-failures
title: Why a scheduled post did not publish
type: article
tags: scheduled post failed missing not published late instagram tiktok facebook linkedin youtube x
---
Common causes, in order of frequency:

1. The platform rejected the post (format, caption length, unsupported music, expired media link).
2. The connected account token expired, usually after a password or 2FA change on the client side.
3. The platform API was degraded. Social Ops posts a status note when this affects several clients.
4. The post was not approved in the Approval Portal before the cutoff, so it stayed in draft.

What the coordinator does:

- Check the post status in the scheduler. "Rejected" shows the platform's reason; "Draft" means it was never approved.
- If the token expired, ask the client to reconnect the account through the Approval Portal. Never ask for a password.
- If the post can still go out, offer to republish it at the next agreed slot. Republishing needs the client's confirmation of the new time.
- If several clients report failures on the same platform, tell Social Ops.

What to tell the client: the post did not go live, the cause if known, and the proposed new time. Do not guess a cause.
