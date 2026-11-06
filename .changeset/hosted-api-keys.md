---
'@openbooking-sh/hosted': minor
'@openbooking-sh/postgres': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/booking-page': patch
---

API keys for hosted businesses, so a site with no backend can call its own booking API. Owners make keys in Studio → Settings → API keys (a name, and `read` or `book`); the secret is shown once and only a hash is stored. Send it as `x-openbooking-key` or `Authorization: Bearer obk_…` to `/b/{id}/book/api/*` or `/b/{id}/mcp`. Each key works for one business, is rate-limited on its own (300 a minute), shows when it was last used and can be revoked. Calls without a key stay public as before: a key identifies and limits a caller, it does not lock the API. New `apiKeys` option on `createHostedApp` (memory by default), `PostgresApiKeyStore` and `postgresStores(db).apiKeys` with migration 6 (`ob_api_keys`), and `api_keys` on Studio's `SettingsView`. The booking page's CORS preflight now allows the `x-openbooking-key` header.
