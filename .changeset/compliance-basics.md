---
'@openbooking-sh/booking-page': patch
'@openbooking-sh/studio': patch
'@openbooking-sh/hosted': patch
'@openbooking-sh/postgres': patch
---

Privacy basics from the compliance audit:

- No more Google Fonts: the booking page, Studio, sign-up and setup no longer load anything from
  Google, so a visit does not hand the visitor's IP address to a third party. The font stack falls
  back to the system font (Geist still applies if installed).
- The PostHog snippet on owner pages counts page views only: autocapture and heatmaps are off and
  all text is masked, because Studio shows customer names and notes. The password reset page no
  longer carries the snippet, since its link holds the reset token.
- Migration 3 turns on row level security for every `ob_` table. With no policies, a role that does
  not own the tables (a REST or Data API layer's anon role) sees nothing. The role OpenBooking
  connects as must be the one that created the tables, as it is by default.
