---
id: rb-analytics-stale
title: "Runbook: analytics data missing or wrong across clients"
type: runbook
tags: analytics dashboard stale missing data wrong numbers report pipeline sync multiple clients
---
Trigger: several clients report missing days, zeros, or numbers far from in-app values.

1. Check the dashboard's "last sync" time per platform.
2. Compare one affected client's numbers with the platform's native analytics for the same day.
3. If a sync failed, page the data on-call engineer and hold scheduled report delivery for affected clients.
4. Post a status note for coordinators: which reports are affected and that corrected versions will follow.
5. After the backfill, regenerate affected reports and notify coordinators to resend.
