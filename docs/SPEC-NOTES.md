# Spec notes: deviations, extensions and open questions

This document lists **every** place OpenBooking deviates from, extends, or interprets the specs it
implements. In code, the same spots are marked `// EXTENSION:` or `SPEC AMBIGUITY:`.

Specs as implemented (checked 2026-10-02):

| Spec                                                          | Version / source                                                                                  | Status in OpenBooking               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------- |
| UCP lodging booking `dev.ucp.lodging.booking`                 | UCP `main` @ `b0e81ade` (2026-09-30), **draft**, not in any release (latest release `2026-08-25`) | REST binding implemented (draft)    |
| UCP cancellation policy `dev.ucp.lodging.policy.cancellation` | same                                                                                              | implemented, with an extension      |
| UCP payment terms `dev.ucp.common.payment.terms`              | same                                                                                              | deposits only                       |
| MCP                                                           | protocol `2026-07-28` and the 2025 legacy versions, via `@modelcontextprotocol/server` 2.2        | implemented                         |
| A2A                                                           | v1.0 (protocol version `"1.0"`), `specification/a2a.proto`                                        | Agent Card only; endpoint is a stub |

---

## 1. UCP

### 1.1 Versioning and namespace

- **Version pin (spec ambiguity).** A UCP profile `version` must be a date (`^\d{4}-\d{2}-\d{2}$`), and UCP-authored capabilities declare the version of the release that contains them. Lodging is in no release yet. We declare `2026-09-30`, the date of the `main` commit we implemented against (`UCP_VERSION` in `adapter-ucp/src/constants.ts`), and link to the `/draft/` docs. This needs revisiting when lodging ships in a release.
- **Namespace.** UCP reserves `dev.ucp.*`. OpenBooking's additions use `sh.openbooking.*` (reverse-DNS of `openbooking.sh`, which we own). Extensions are versioned `2026-10-02`.
- **Schema URLs.** We cite `https://ucp.dev/draft/schemas/lodging/booking.json`, which appears verbatim in the spec. The URLs `…/schemas/lodging/policy_cancellation.json` and `…/schemas/common/payment_terms.json` are inferred from the same `source/schemas/` → `/schemas/` site layout. We omit `spec` URLs we could not confirm, since `spec` is optional for business profiles.

### 1.2 Discovery (`/.well-known/ucp`)

- **REST only.** Only the `rest` transport is advertised under `dev.ucp.lodging`. Our `/mcp` endpoint exposes agent-friendly tools (`search_availability`, …). It is **not** the UCP MCP binding (`create_booking_session`, …), so advertising it as UCP MCP would be wrong. A2A is a stub and is not advertised.
- **`payment_handlers` is `{}`.** It must be present even when empty. Deposits use a token extension instead (§1.8).
- **No signing keys.** No `keys` (JWK set) are published, and request/response signatures (`Signature`, `Signature-Input`, `Content-Digest`) are not implemented.
- **Extension capabilities.** We advertise `sh.openbooking.booking` (extends `dev.ucp.lodging.booking`) and `sh.openbooking.availability` (standalone). Their JSON Schemas are served by the deployment itself at `{endpoint}/schemas/<name>.json`, following the UCP extension pattern (`$defs["dev.ucp.lodging.booking"]` = `allOf` of the parent schema plus our fields).

### 1.3 Availability search: `sh.openbooking.availability` (EXTENSION)

UCP has no availability or search capability. The lodging roadmap lists discovery as future work, and issues #317, #479 and #303 propose one. We add:

```
GET {endpoint}/availability?date=YYYY-MM-DD&party_size=N[&time_from=HH:MM][&time_to=HH:MM][&offering_id=][&tags=a,b][&venue_id=][&limit=]
→ { ucp, property, offers: [ stay-shaped offer … ] }
```

Each offer reuses the `stay` shape (`id`, `stay_dates`, `accommodation_type`, `rate_plan`, `occupancy`, `totals`) and adds `time_slot`, `currency`, `policies` and `payment_terms`. Its `id` is the opaque slot id, which is passed back as `stays[0].id` on create.

### 1.4 Booking sessions

| Topic                                                                   | UCP                                                                                                     | OpenBooking                                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hold                                                                    | No hold object. `expires_at` covers "session state, quoted pricing, and any temporary inventory holds". | A session in `incomplete`/`ready_for_complete` **is** the hold. The inventory is reserved exclusively until `expires_at` (default 10 min). Cancel releases it early. |
| Create input                                                            | `stays[].id` **or** `accommodation_type.id` + `rate_plan.id`                                            | **Only `stays[].id`** (an offer id from `/availability`), and **exactly one stay**                                                                                   |
| `property`                                                              | required on create                                                                                      | Optional. If sent, `property.id` must match the slot's venue, otherwise `validation_error` (the hold is rolled back)                                                 |
| `guests[]`, `guest_assignments`, `travel_purpose`, `context`, `signals` | optional                                                                                                | Accepted and **ignored**                                                                                                                                             |
| `booker`                                                                | lead contact                                                                                            | Maps 1:1 to the core `Customer` (`first_name`, `last_name`, `email`, `phone_number`). We enforce UCP's lead rule: name plus email or phone before completion.        |
| PUT (full replacement)                                                  | replaces the session                                                                                    | Only `booker` changes are applied. A different `stays` → `operation_not_supported` (cancel and create a new session). Other fields are ignored rather than cleared.  |
| `accommodation_type`                                                    | room type                                                                                               | `{ id: resource kind ("table"), title: "Table for up to 4" }`. This is a semantic stretch for tables and staff.                                                      |
| `rate_plan`                                                             | rate plan                                                                                               | `{ id: offering id, title: offering name }` (e.g. "Dinner", "Chef's tasting menu")                                                                                   |
| `occupancy`                                                             | `adults`, `children`, `child_ages`, `total`                                                             | `total`, plus `adults`/`children` when known. Agents usually only know a party size.                                                                                 |
| `stay_dates`                                                            | `date_interval`; `end_date` semantics undefined (**PR #870**)                                           | **Spec ambiguity.** Both are the venue-local dates of slot start and end, so same-day slots have `start_date == end_date`.                                           |
| `stays[].time_slot`                                                     | —                                                                                                       | **EXTENSION** `{ start_at, end_at, timezone }`, because sub-day bookings need times.                                                                                 |
| `links`                                                                 | required                                                                                                | Always `[]`. We have no ToS or privacy links yet.                                                                                                                    |
| `continue_url`                                                          | SHOULD be present for non-terminal statuses                                                             | **Omitted.** There is no business web checkout to hand off to.                                                                                                       |
| `currency`                                                              | required                                                                                                | From `Venue.currency` (**core EXTENSION**: UCP `property` has no currency), with fallback to slot amounts                                                            |
| `totals`                                                                | exactly one `subtotal` and one `total`                                                                  | When the price is unknown up front (pay at venue), both are `0` with `display_text: "Pay at venue"` / `"Total due now"`. This is our interpretation.                 |
| `confirmation`                                                          | `{ id, label, … }` on `completed`                                                                       | `{ id: confirmation_code, label }`                                                                                                                                   |
| Response `ucp`                                                          | only `version` required                                                                                 | `{ version, capabilities: { <active name>: [{ version }] } }`. We don't know the exact expected shape of the active-capabilities list.                               |

### 1.5 Status mapping

| Core                   | UCP                                                                         |
| ---------------------- | --------------------------------------------------------------------------- |
| `held`, no customer    | `incomplete` (plus a `customer_details_required` message, `path: $.booker`) |
| `held`, with customer  | `ready_for_complete`                                                        |
| `confirmed`            | `completed`                                                                 |
| `cancelled`, `expired` | `canceled` (an expired hold adds an `info` message)                         |

`requires_escalation` and `complete_in_progress` are never produced, because confirmation is synchronous and there is no business UI handoff.

**Cancelling a `completed` session (spec ambiguity).** UCP doesn't say whether `cancel` applies after completion. We allow it and apply the cancellation policy. This is an extension.

### 1.6 Idempotency

- **Required on every write (stricter than UCP).** We require `Idempotency-Key` on **all** writes: create, update, complete and cancel. A missing key returns 400. The OpenAPI marks it required on create and update, the prose says "SHOULD support", and open PR #868 would make it optional on create and update. We chose the strict reading because agents retry.
- **Conflict.** Same key with a different body → 409 `idempotency_conflict`. Records are kept for 24h, the UCP minimum.
- **Deviation: only successes are stored.** UCP says to return the cached result for a matching retry. We cache **successful** results only. A failed call changes no state (providers must be atomic), so a retry with the same key re-executes. This lets an agent call `complete` without consent, ask the user, and retry with the same key plus `user_confirmed: true`.
- **Replays return the current state of the same session,** not a stale snapshot. A replayed create shows `canceled` if the hold has since expired. No second side effect happens.
- **Key scope.** Keys are global per deployment, not per session. Reusing a key for a different operation is a conflict.

### 1.7 Messages and errors

- **HTTP status.**
  - Protocol errors: `validation_error` → 400, `not_found` → 404, `idempotency_conflict` → 409, `provider_error` → 503.
  - Business outcomes → **200**. For operations on an existing session, the response is the session with the error in `messages[]` and the status unchanged. For create, it is `error_response` (`{ ucp: { version, status: "error" }, messages }`).
  - **Spec ambiguity:** the HTTP code for a business failure on _create_ isn't stated. We use 200.
- **Codes.** `slot_unavailable` → UCP `inventory_exhausted`, `party_size_unsupported` → `occupancy_exceeded_capacity`, `payment_failed` → `payment_failed`. Other codes pass through as OpenBooking codes (lowercase snake_case; UCP `error_code` is an open string).
- **Severity.** We only use `recoverable` (fixable in-protocol: validation, consent, customer details, payment) and `unrecoverable`. We avoid `requires_buyer_input` and `requires_buyer_review` because UCP ties `requires_*` to `status: requires_escalation`, which requires a `continue_url`.
- **`messages[].suggested_next_action` (EXTENSION).** A plain-language recovery instruction for agents. It is not added to the root of `error_response`, because that object has `additionalProperties: false`.
- **Non-refundable disclosure.** A non-refundable rate produces a `warning` with `presentation: "disclosure"` and `code: "dev.ucp.lodging.policy.cancellation"`, as the UCP docs describe.

### 1.8 Consent and payment (EXTENSIONS)

- **`user_confirmed: true` (request field, `sh.openbooking.booking`).**
  - It is **required** on `POST …/complete`. Without it the session stays `ready_for_complete` with a `user_confirmation_required` message.
  - It is required on `POST …/cancel` for a **completed** session. Releasing a hold doesn't need it.
  - UCP has no explicit-consent flag; this is the core "never auto-confirm" rule.
- **`payment_token` (request field, complete).**
  - It pays a deposit that is due at confirmation. It stands in for UCP `payment.instruments[]` and payment handlers until a real payment-handler integration exists.
  - We deliberately do **not** guess the instrument/credential shape.
  - The demo provider accepts tokens starting with `tok_`; `tok_fail…` is declined.

### 1.9 Cancellation policy

- **`policies[]` entry.**
  - Contains `type: "dev.ucp.lodging.policy.cancellation"`, `description: { plain }` and `refundability`. `applies_to` is not used, since there is one policy per session.
  - `refundability` is restricted to `refundable | partially_refundable | non_refundable`. UCP uses an open string with these as examples.
- **Structured schedule (EXTENSION).** We add `free_cancellation_until` (date-time or null), `late_cancellation_fee` and `no_show_fee` (Money or null) to the policy entry. UCP only has free-text deadlines; structured schedules are proposed in **PR #861** and issue #807. We'll align when they land.

### 1.10 Payment terms (deposits)

- **Shape.** One `payment.terms[]` entry `{ id: "deposit", title, description, schedules: [{ id, type, description, amount }] }`.
- **Schedule `type`.** `immediate` means due at confirmation; `at_property` means payable at the venue. UCP precisely defines only `immediate`.
- **Amount.** Integer minor units.
- **`selected_term_id` is never set,** because there is a single term.

---

## 2. MCP

- **Not the UCP MCP binding.** We expose seven agent-optimised tools instead of UCP's session CRUD: `get_business_info`, `search_availability`, `hold_slot`, `confirm_booking`, `get_booking`, `cancel_booking`, `reschedule_booking`. A UCP-conformant MCP binding could be added later as a separate adapter.
- **Flatter inputs than core.** `party_size` is an integer and `preferences` maps to core `tags`.
- **Input validation runs in the handler.**
  - Tool input schemas are advertised to clients as normal JSON Schema, but the SDK-side validator is a pass-through.
  - Validation happens in our handler, so failures come back as structured `{ code, message, suggested_next_action }` results with `isError: true` instead of plain SDK text.
  - Output schemas are declared and validated by the SDK on success. The SDK skips output validation when `isError` is set.
- **Transport.**
  - Stateless Streamable HTTP via `createMcpHandler`, which serves both the `2026-07-28` era (no sessions) and the 2025 legacy era.
  - The Host and Origin allow-list defaults to the `baseUrl` host plus localhost.
  - A stdio entry point is available for local clients.
- **Annotations.** `cancel_booking` is `destructiveHint: true`. Every mutating tool is `idempotentHint: true` because of the idempotency key.

## 3. A2A

- **Agent Card.** v1.0 card at `/.well-known/agent-card.json` with `supportedInterfaces[0] = { url: <base>/a2a, protocolBinding: "JSONRPC", protocolVersion: "1.0" }`. The v0.3 fields (`url`, `preferredTransport`, …) are not emitted. The legacy `/.well-known/agent.json` is not served.
- **Stub endpoint.** `POST /a2a` returns HTTP 501 with JSON-RPC error `-32601`. No task handling is implemented yet.
- **EXTENSION: MCP pointer.** `capabilities.extensions[]` includes `https://openbooking.sh/a2a/extensions/mcp-endpoint/v1` (`required: false`, `params.url` = the MCP endpoint). This is an informational pointer we defined.
- **No security schemes.** `securitySchemes` and `securityRequirements` are omitted because the demo has no auth.

## 4. Core model extensions with no UCP equivalent

- **Explicit consent.** `user_confirmed` on confirm, and on cancel of confirmed bookings.
- **Hold as a booking state.** A hold is a booking in status `held` with a mandatory `expires_at`. Lifecycle: `held → confirmed → cancelled`, or `held → expired | cancelled`.
- **Venue time zone and currency.** `Venue.timezone` (IANA) and `Venue.currency` are needed to interpret local slot times and amounts.
- **Structured errors.** `ErrorPayload` = `{ code, message, suggested_next_action, retryable, details? }`.

## 5. Open items to track upstream

- UCP PR #868: making Idempotency-Key optional on create and update.
- UCP PR #870: `stay_dates.end_date` semantics.
- UCP PR #861 and issue #807: structured cancellation schedules.
- UCP issue #858: accommodation type discriminator and tool naming.
- UCP issues #317, #479 and #303: appointment and availability capabilities. These could replace `sh.openbooking.availability` and `time_slot`.
- Lodging booking shipping in a tagged UCP release: re-pin `UCP_VERSION`.
