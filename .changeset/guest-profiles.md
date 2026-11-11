---
'@openbooking-sh/core': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/hosted': minor
'@openbooking-sh/postgres': minor
'@openbooking-sh/adapter-mcp': minor
'@openbooking-sh/booking-page': minor
'@openbooking-sh/client': minor
'create-openbooking': patch
---

Guest profiles, allergy notes and a pre-shift summary, all staff-only.

- **Allergy and dietary notes.** `hold_slot` (MCP), the booking page's confirm request and `service.hold` / `service.update` take an optional `dietary_notes` (300 characters). It is stored apart from the booking (a new `GuestStore`, `ob_dietary_notes` in Postgres), so no protocol response, email, webhook event, activity entry, analytics event or idempotency record can carry it. Studio shows it on the booking and in the pre-shift summary. It is deleted a day after the visit (`dietaryNoteRetentionDays`, hosted `dietaryNoteRetentionDays`; the daily purge does it), when the booking is cancelled or lapses, with the customer's erasure, and with the account. MCP agents are told it is optional and to use only what the guest said; `notes` no longer suggests allergies.
- **Guest profiles.** Staff set tags, notes and a VIP flag per guest in Studio (booking drawer, Customers). A guest is a per-business hash of their email (or phone), so nothing links guests across businesses and the profile table holds no contact detail. Visit count and last visit come from the business's own bookings. Profiles are in the customer export, removed on erasure and when no booking with that guest's details is left.
- **Pre-shift summary.** `GET /studio/api/preshift?date=` and a Pre-shift view: covers, party sizes, VIPs, first-time versus returning guests, allergy notes.
- **Postgres.** Migration 8 adds `ob_dietary_notes` and `ob_guest_profiles` (row level security on). `postgresStores(db).guests` is the store; pass it as `guests` to `createHostedApp` and `serviceOptions`.
