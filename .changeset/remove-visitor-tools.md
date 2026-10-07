---
'@openbooking-sh/hosted': minor
---

Removes the marketing-site visitor tools: the `/api/visit` Slack beacon and the `TRACKER_JS` click/scroll tracker (no longer exported). They were for watching openbooking.sh, not part of hosting. Owner pages keep the plain cookieless PostHog snippet, sign-up source and setup-step events.
