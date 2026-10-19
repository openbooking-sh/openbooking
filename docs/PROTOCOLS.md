# Protocols we follow

The protocols we build on are young, and USP and UCP are drafts. This page records, for each one, what we implement, where, which version or commit we are pinned to, and where its source lives. A weekly job (`scripts/watch-protocols.mjs`, run by `.github/workflows/watch-protocols.yml`) compares each upstream with these pins. Deviations and open questions live in [SPEC-NOTES.md](./SPEC-NOTES.md).

Checked 2026-10-17 against GitHub (`gh api`). "Reachable" means the URL returned HTTP 200, not that its content was re-read.

## Implemented

| Protocol                                                 | What for                                   | Where here                                              | Pinned                                                                                                                                        | Source                                                                                                                                 | Deviations                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| MCP (Model Context Protocol)                             | Main agent interface                       | `packages/adapter-mcp`                                  | Spec release `2026-07-28` (plus the 2025 legacy versions), through `@modelcontextprotocol/server` `^2.2.0` (no spec constant)                 | [spec](https://modelcontextprotocol.io/specification/2026-07-28), [repo](https://github.com/modelcontextprotocol/modelcontextprotocol) | SPEC-NOTES section 2                                                                                                           |
| WebMCP                                                   | Browser agents on the booking page         | `packages/booking-page` (`client.ts`, `registerWebMcp`) | No version exists (W3C Web Machine Learning CG draft). Watch baseline: commit `f14762e` (2026-10-16), not an implemented-against commit       | [draft](https://webmachinelearning.github.io/webmcp/), [repo](https://github.com/webmachinelearning/webmcp)                            | Code comment in `client.ts`: feature-detected, tolerant of both `document.modelContext` and the older `navigator.modelContext` |
| UCP (Universal Commerce Protocol, draft)                 | Commerce interface for agents (lodging)    | `packages/adapter-ucp` (`constants.ts`)                 | `main` at commit `b0e81ade` (2026-09-30), declared as `UCP_VERSION = '2026-09-30'`. Lodging is in no release (latest `v2026-08-25`)           | [docs](https://ucp.dev/draft/), [repo](https://github.com/Universal-Commerce-Protocol/ucp)                                             | SPEC-NOTES section 1 and 5                                                                                                     |
| USP (Universal Scheduling Protocol, draft, Wix + Stripe) | Platform bookings                          | `packages/adapter-usp` (`constants.ts`)                 | Spec version `2026-08-20`, commit `78363d7` (`78363d766e738efd44fb42d1d1bf93ce617187ec`, 2026-10-12), vendored by `scripts/sync-usp-spec.mjs` | [site](https://usp-protocol.dev), [repo](https://github.com/wix/universal-scheduling-protocol) (default branch `master`)               | SPEC-NOTES section 6                                                                                                           |
| A2A (Agent2Agent)                                        | Agent-to-agent discovery and `SendMessage` | `packages/adapter-a2a` (`A2A_PROTOCOL_VERSION = '1.0'`) | Protocol `1.0`, reviewed through release `v1.0.1` (`3303592`, 2026-05-28)                                                                     | [spec](https://a2a-protocol.org/latest/specification/), [repo](https://github.com/a2aproject/A2A)                                      | SPEC-NOTES section 3 (part shapes still unverified)                                                                            |

## Watched, not built

| Protocol                        | Why we watch                                                         | Pinned                                                                   | Source                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| ACP (Agentic Commerce Protocol) | Agent payments, see Linear OPE-14 (USP's ACP extension, Stripe SPTs) | Baseline commit `7fdd78d` (2026-07-18). The repo has no releases or tags | [site](https://www.agenticcommerce.dev), [repo](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol) |
| AP2 (Agent Payments Protocol)   | Consent and mandates, see Linear OPE-79                              | Release `v0.2.0` (2026-04-28); baseline commit `e1ea56d` (2026-04-29)    | [site](https://ap2-protocol.org), [repo](https://github.com/google-agentic-commerce/AP2)                                |

## What the weekly job decides

Pins live in `scripts/protocols.json`. A source counts as **changed** when:

- a release or tag newer than the pinned one exists, or
- a file under the watched paths differs between the pinned commit and the branch head (names and a compare link are listed), or
- the branch no longer contains the pinned commit (history rewritten).

Open and recently closed issues and PRs (matched by title keywords) are listed for context but never open an issue alone. When something changed, the workflow files one issue, "Protocol watch: <names> (<date>)", or updates the open one. A source that cannot be checked (rate limit, 404, a pin missing from the feed) makes the run fail visibly.

Pins do not move by themselves. The cycle is: read the diff, change the code or file a follow-up, then bump the pin in `scripts/protocols.json` and the row above, so the next report starts from what was reviewed. Run it locally with `node scripts/watch-protocols.mjs --dry-run` (set `GITHUB_TOKEN` to avoid the unauthenticated rate limit).

## State at the first run (2026-10-17)

- **USP**: no change since our pin.
- **UCP**: 22 commits and 26 watched files changed since `b0e81ade` (ask capability, signatures, cart, checkout, order, schemas). No file under the lodging schemas or docs changed, and there is no new release. New lodging proposals #953, #958, #959 and #960 (traveler identity, board and meal plan, promo codes, add-ons) are worth a read.
- **A2A**: v1.0.1 is out. Between v1.0.0 and v1.0.1 the proto changed only in comments about `tenant`, and the specification prose changed in the HTTP binding (media type) and TaskStatus values. Since v1.0.1, `a2a.proto` changed in one comment (`AgentInterface.url` for gRPC). Nothing affects our JSON-RPC `SendMessage`.
- **MCP**: no release after `2026-07-28`. The draft tree and SEPs moved (stateless MCP, tasks extension, server cards, skills extension). Those are SEPs in progress; this baseline shows them every week until the pin is bumped, by design.
- **WebMCP, ACP, AP2**: no changes since their baselines.

The monthly human review the issue asks for has not happened yet, so this page records the baseline only.
