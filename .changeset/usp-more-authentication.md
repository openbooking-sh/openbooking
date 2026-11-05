---
'@openbooking-sh/adapter-usp': minor
'@openbooking-sh/server': minor
---

More ways for a platform to authenticate to USP, all opt in through `createUsp({ platformAuth })` (and `usp: { platformAuth }` in the server). The default is unchanged: Ed25519 key proofs only.

- `proofAlgorithms: ['EdDSA', 'ES256']` also accepts P-256 proof keys for `platform_key_pop` (EdDSA stays the floor).
- `nonces: { secret }` makes a business require a server-issued nonce in every proof. A platform without one gets `proof_nonce_required` with the nonce (`DPoP-Nonce` header, or `data.nonce` over MCP) and retries.
- `httpSignatures: true` accepts RFC 9421 HTTP Message Signatures on REST (`ES256`): the platform signs with a key it publishes in its profile, the spec's covered components and `Content-Digest` are enforced, and a request that carries a DPoP proof or credential is never accepted on a signature instead. Advertised as `http_message_signature` in the profile's `authorization` policy. Not offered over MCP.

New error codes: `proof_nonce_required`, `signature_missing`, `signature_invalid`, `signature_expired`, `key_not_found`, `digest_mismatch`, `algorithm_unsupported`. The choices the spec leaves open are in `docs/SPEC-NOTES.md` section 6.
