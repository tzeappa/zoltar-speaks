---
id: rb-platform-publishing-outage
title: "Runbook: platform publishing failures across clients"
type: runbook
tags: outage api degraded publishing failed multiple clients instagram tiktok facebook meta platform status scheduled posts
---
Trigger: scheduled posts failing on one platform for 3 or more clients.

1. Check the scheduler's failure log for the platform. Note the error codes and the first failure time.
2. Check the platform's developer status page and MMC's #platform-status channel.
3. If failures continue, pause the publishing queue for that platform to stop repeated failed attempts. Pausing affects all clients, so the shift lead decides.
4. Post a status note for coordinators with the affected platform, start time, and what clients should expect.
5. Notify platinum clients' coordinators first so they can contact clients directly.
6. When the platform recovers, republish failed posts in order of original schedule, skipping time-sensitive posts until the client confirms.
7. Resolve the incident after the backlog is clear and failed posts are accounted for.
