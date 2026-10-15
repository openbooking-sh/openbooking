# USP test vectors

Worked examples for the parts of the specification that can be implemented
wrongly without any reviewer noticing. Run them with:

```bash
python tools/usp_check.py vectors
```

CI runs the same command on every push.

## Why these exist

`platform_key_pop` is specified on both bindings and implemented on neither.
Prose review catches a contradictory MUST; it does not catch a canonicalization
rule that two implementers read the same way and encode differently. These
vectors publish the exact bytes, so a second implementation can disagree with
the first *before* both ship.

The same argument applies to concurrency and time. A spec can say "atomic" and
"use instants" and be read as agreement by two implementations that behave
differently under a lapsed hold or a daylight-saving transition. The `flow/`
vectors write those cases down.

## Three kinds of vector

| Directory | Asserts | Code field | Carried as |
|---|---|---|---|
| `pop/` | Protocol errors on the authentication path | `reject_code` | 4xx Problem Details / JSON-RPC `error` |
| `flow/` | Business outcomes on the booking path | `outcome_code` | HTTP 200 with the code in `messages[]` |
| `wire/` | On-the-wire shape rules a schema cannot express | none | A producer conformance failure, not an error code |

The two fields are checked against different mirrors and a vector may not set
both: a case is either a protocol error or a business outcome, never both. A
`reject_code` must appear in the §10.1.1 table and the OpenRPC
`USPProtocolError` enum. An `outcome_code` must appear in the §9.4.2
business-outcome table and must *not* appear in that enum, which is how the
checker proves the two error families stay disjoint.

## Format: `pop/`

One JSON object per file, under `pop/`.

| Field | Meaning |
|---|---|
| `id` | Stable identifier. **Must be cited in `specification.md`** — the checker fails otherwise, so prose and vectors cannot drift apart. |
| `section` | The specification section the vector pins down. |
| `requirement` | Short slug for the rule under test. |
| `binding` | `rest`, `mcp`, or both. |
| `expect` | `accept` or `reject`. |
| `reject_code` | For `reject` vectors. Must appear in the §10.1.1 error-code table **and** the OpenRPC `USPProtocolError` enum. |
| `notes` | What the vector is for, and what a naive implementation gets wrong. |
| `key` | Public JWK, its RFC 7638 thumbprint, and — for reproducibility — the raw private key. |
| `proof` | Compact JWS. Really signed; the checker verifies it. |
| `expected_claims` | The decoded payload, so a mismatch between prose and signature is caught. |
| `credential` | Validated against `schemas/profile.json#/$defs/BookingScopedCredential`. |
| `canonicalization` | `params` → `jcs` bytes → `usp_p` digest, all recomputed by the checker. |

## Format: `flow/`

One JSON object per file, under `flow/`. These are scenario vectors rather than
byte-level ones, so they read as given / when / then.

| Field | Meaning |
|---|---|
| `id` | Stable identifier. **Must be cited in `specification.md`**, same rule as `pop/`. |
| `section` | The specification section the vector pins down. |
| `requirement` | Short slug for the rule under test. |
| `kind` | `flow`. |
| `expect` | `accept` or `reject`. |
| `outcome_code` | For `reject` cases. Must be a §9.4.2 business-outcome code. |
| `given` | Starting state: the service, slot, capacity, and any hold. |
| `when` | Ordered steps with timestamps. Interleaved actors make the race explicit. |
| `then` | The required observable result, including capacity afterwards and whether a retry is worthwhile. |
| `wrong_answers` | Plausible implementations that violate the rule, and what each one costs. |
| `cases` / `variants` | Additional scenarios sharing the same setup. |

`wrong_answers` is the part that carries the weight. A vector that only records
the right answer tests a parser. Naming the specific wrong behaviours, and the
harm each causes, is what makes the vector useful to someone deciding how to
implement rather than checking that they already did.

| Vector | What it pins down |
|---|---|
| `101-hold-expiry-during-checkout` | A hold lapses mid-checkout while the slot stays free. Charging first strands a charged buyer with no booking; returning `slot_unavailable` throws away a slot that is still bookable. |
| `102-concurrent-holds-one-slot` | Two platforms race for the last capacity unit. Decidable only because capacity is consumed at hold creation, not at booking. |
| `103-dst-spanning-slot` | Two slots straddling a DST change where wall-clock arithmetic is wrong in opposite directions: 30 minutes for a 90-minute service, 2 hours for a 60-minute one. |
| `104-charge-without-booking` | The PSP charge succeeds and the booking write fails. There is no single transaction to roll back, so the vector records both permitted resolutions and the intermediate state that is forbidden. |
| `105-confirmation-mode-guard` | `confirm` from `pending` is legal only in manual mode. An auto-mode UCP-Native leftover that is still `pending` MUST be rejected with `invalid_transition` at HTTP 200; a booking-scoped credential MUST NOT authorize the call. |
| `106-ucp-native-fixed-deposit` | UCP-Native `deposit_required` with a fixed deposit: full checkout total, one selected term, one immediate schedule, balance `due_at` equal to slot start, order `accepted_term`, no `split_payments`. |
| `107-ucp-native-percentage-deposit` | Same shape with a percentage catalog deposit whose immediate amount is the business-computed integer 4000, not a platform-side 20 percent of total. |

## Format: `wire/`

One JSON object per file, under `wire/`. Each case is a concrete instance plus
what the checker must compute for it.

| Field | Meaning |
|---|---|
| `id` | Stable identifier. **Must be cited in `specification.md`**, same rule as `pop/`. |
| `section` | The specification section the vector pins down. |
| `requirement` | Short slug for the rule under test. |
| `kind` | `wire`. |
| `expect` | `accept` or `reject`. Must agree with the computed conformance. |
| `schema` | The `$def` the instance is validated against, as `file.json#/$defs/Name` under `schemas/`. |
| `instance` | The JSON a producer emitted. |
| `then.schema_valid` | Whether `instance` validates against `schema`. Recomputed. |
| `then.member_name_violations` | JSON Pointers of members that restyle a defined snake_case name (for example `serviceId`). Recomputed. |
| `then.conforming` | Schema-valid and no member-name violations. Recomputed. |
| `variants` / `wrong_answers` | As for `flow/`. Each variant carries its own `instance` and `then`. |

| Vector | What it pins down |
|---|---|
| `201-camelcase-member-names` | A service search hit that keeps every required member in snake_case but camelCases optional ones. It is schema-valid, because the schema allows extra members, and still non-conforming under the §1.1 member-name rule. |

## The keys are deliberately published

`key.private_key_d` is in the repository on purpose. These are test keys derived
from fixed seeds (`0x01…01` and `0x02…02`) so that anyone can regenerate the
vectors byte-for-byte and confirm the signatures independently. **They are not
secret and must never be used for anything.** `K1` is the legitimate platform;
`K2` exists solely to be rejected by `006-cross-key-replay`.

## What the checker verifies

- Every published JCS serialization and `usp_p` digest is recomputed. Non-integer
  JSON numbers are refused outright, which turns the specification's
  RECOMMENDATION about them into something a vector author cannot violate.
- Every signature is verified against the JWK in its own proof header, and every
  published thumbprint is recomputed from that JWK.
- `expected_claims` matches the signed payload.
- A `pop_key_mismatch` vector actually uses a key differing from the credential's
  `cnf.jkt` — otherwise it would pass while testing nothing.
- Every `reject_code` is reachable from both error-code mirrors.
- Every `id` is cited in `specification.md`.
- Every `wire/` case's schema validity, member-name violations, and conformance
  match what the vector asserts.

## Adding a vector

Add the file, cite its `id` in `specification.md`, and run the checker. If it is
a rejection case, prefer one that a *plausible* implementation would accept —
`006` is the model: it is a genuinely valid signature that must still be
rejected. A rejection vector that fails for an obvious reason tests the parser,
not the protocol.
