---
'@openbooking-sh/notifications': minor
'@openbooking-sh/hosted': minor
'@openbooking-sh/postgres': minor
---

Customers can unsubscribe from a business's emails. Customer emails carry an unsubscribe link and the RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers (`EmailMessage.headers`, passed on by `ResendMailer`). Hosted serves `/unsubscribe`: a GET shows a button, the POST records a hash of the address for that business, and nothing more is sent to it. New `SuppressionList` (`MemorySuppressionList`, `PostgresSuppressionList`, migration 5), `isSuppressed` and `unsubscribeUrl` options in `attachNotifications`, and a `suppressions` option on `createHostedApp` (`stores.suppressions` with Postgres).
