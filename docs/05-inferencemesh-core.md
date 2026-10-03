# 05 — InferenceMesh core plan

**Source:** `gdalabs/inferencemesh` — MIT, TypeScript, ~6.5k LOC, zero runtime
dependencies. It already implements most of the routing core we want, including
the explicit guarantee that it will not fall back to a paid model.

> Nothing is copied yet. This document is the plan; step 1 of the MVP performs
> the import with licence/attribution.

## What we take (concepts and, after import, files)

| File | Why |
|---|---|
| `src/types.ts` | Capabilities, privacy levels, price, quota, model/provider shapes |
| `src/registry.ts` | Candidate building, named profiles, `freeOnly` / price caps, `maxPrivacy` |
| `src/config.ts` | Registry validation (rejects unverified paid prices, unknown capabilities) |
| `src/router.ts` | Hard filters (privacy/capability/context) + soft scoring + fallback chain |
| `src/health.ts` | Circuit breaker / observed health |
| `src/ledger.ts` | Quota ledger (requests/min, requests/day, tokens/day) |
| `src/concurrency.ts` | In-flight limit per provider |
| `src/providers/base.ts` | Adapter contract and error classification |
| `src/providers/openai-compat.ts` | OpenAI-wire outbound adapter |
| `src/providers/gemini.ts` | Gemini outbound adapter |
| `src/gateway.ts` / `src/mesh.ts` | Attempt → fallback → bookkeeping loop |
| `src/server/node.ts` | Local HTTP server |
| `src/cli.ts` | Base CLI to extend |
| `test/*` | Routing/quota/health tests to keep and extend |

## How we import

1. **Vendor (fork) into `src/core/`**, preserving MIT headers and adding a
   `THIRD_PARTY_NOTICES.md` and the upstream commit hash in the import commit
   message. Vendoring (rather than depending on the npm package) keeps the
   zero-dependency property and lets us modify freely.
2. Record the upstream ref in `docs/05-inferencemesh-core.md` and in a
   `UPSTREAM` note so future syncs are possible.
3. Do not rename the concept names (`free`, `freeOnly`, `maxPrivacy`) — they map
   cleanly onto our modes.

## Gaps we must fill ourselves

1. **Anthropic support** — inbound `/v1/messages` and an Anthropic outbound
   adapter, plus SSE translation both ways. InferenceMesh has only
   `openai-compat`, `gemini`, `workers-ai`.
2. **Task analyzer** — deterministic rules first, optional cheap classifier,
   mapping a request to a profile (inspired by Daniel's `gatekeeper`, minus its
   paid runtime dependency).
3. **Modes layer** — FREE_ONLY / FREE_FIRST / BALANCED / CUSTOM over the
   existing profiles, plus `allowPaid` handling.
4. **ToS-risk flag** in the registry, with a default-refuse list.
5. **Our own registry data** (free tiers + Ollama + optional paid) with
   `priceVerifiedAt`.
6. **CLI naming and commands** (`tariffia …`), `/status`, `/health`, decision log.

## Why InferenceMesh over the alternatives

- MIT and tiny (auditable), zero runtime deps, runs on Node/Bun/Deno/Workers —
  which also covers Termux and VPS.
- Already free-first with a no-paid-fallback guarantee.
- It is immature (v0.1.0) and lacks Anthropic and a UI — exactly the gaps we
  bring value by filling.

Alternatives considered and rejected as a base: OmniRoute (too large, ToS/billing
risk), BitRouter (Rust, alpha, subscription sign-in), ccproxy (AGPL, TLS
interception), LiteLLM (licence ambiguity, size).
