---
id: rb-publishing-backlog
title: "Runbook: publishing queue backlog in MMC's scheduler"
type: runbook
tags: scheduler queue backlog delayed posts late publishing stuck all platforms
---
Trigger: posts publishing late across several platforms at once, which points to MMC's scheduler rather than a platform.

1. Check the scheduler health page for queue depth and worker status.
2. If workers are down, page the on-call engineer.
3. Identify posts due in the next 2 hours and prioritize time-sensitive and platinum posts for manual publishing.
4. Post a status note for coordinators.
5. After recovery, confirm every delayed post went out once. Check for duplicates.
