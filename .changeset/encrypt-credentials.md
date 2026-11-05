---
'@openbooking-sh/hosted': minor
---

Encrypt owners' Google tokens and Stripe keys at rest. Set `tokenEncryptionKey` (`TOKEN_ENCRYPTION_KEY` in the Vercel entry; 32 bytes, base64 or hex) and `createHostedApp` encrypts those values (AES-256-GCM, each tied to its business and field) before they reach the business store, and decrypts them on the way out. `GET /api/maintenance/encrypt-secrets` (same `CRON_SECRET`) encrypts records written before the key was set; until then they still read fine. `requireTokenEncryption` (`TOKEN_ENCRYPTION_REQUIRED=1`) refuses to start without a key. A record holding encrypted values with no key, or the wrong key, fails with a clear error instead of passing ciphertext on as a token. New exports: `encryptedBusinessStore`, `parseEncryptionKey`, `SecretsError`.
