---
'@openbooking-sh/hosted': minor
---

Better analytics on owner pages (still cookieless, nothing personal): visits carry referrer, `utm_*`, `from` and landing page; named events for sign-up CTA clicks, outbound links, copies, FAQ opens, sections viewed, scroll depth and setup steps; heatmaps on. Sign-ups record their `source` (the website button, campaign or referring site), shown in `business_signed_up` and the Slack message. `TRACKER_JS` is exported for other sites.
