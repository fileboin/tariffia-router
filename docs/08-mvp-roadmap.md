# 08 — MVP roadmap

Ordered. Each step ends with a working, testable state. Nothing beyond step 0 is
implemented yet.

## Step 0 — Scaffold (this repository) ✅

- Empty repo, structure, README, architecture/decision docs, first commit.
- No router code, no third-party source.

## Step 1 — Import the routing core

- Vendor InferenceMesh core into `src/core/` (MIT headers + upstream ref +
  `THIRD_PARTY_NOTICES.md`).
- Keep its routing purity tests; get the build and tests green.
- **Exit:** `router.route()` works against an in-memory registry.

## Step 2 — Registry + local provider

- Define our `providers.json` schema (capability, context, price +
  `priceVerifiedAt`, privacy tier, quota, ToS-risk flag, `apiKeyEnv`).
- Ship `registry/providers.example.json` and an Ollama entry.
- **Exit:** router ranks an Ollama model and a free-tier model from config.

## Step 3 — Modes

- Implement FREE_ONLY / FREE_FIRST / BALANCED / CUSTOM over profiles.
- Add a regression test proving FREE_ONLY never selects or falls back to a paid
  model.
- **Exit:** mode change alters candidate pool exactly as documented.

## Step 4 — Wire layer + local server

- Inbound: `/v1/chat/completions` (streaming) and `/v1/messages` (streaming).
- Outbound: OpenAI-compat, Anthropic, Gemini, Ollama adapters.
- `GET /v1/models`, `/health`, `/status`.
- **Exit:** `curl` a chat request and receive a streamed completion.

## Step 5 — Fallback executor

- Single attempt/fallback loop; error classification; cooldown; model benching.
- **Exit:** killing the first provider transparently fails over.

## Step 6 — CLI

- `tariffia serve | status | doctor | providers | route`.
- **Exit:** `tariffia route "…"` explains the chosen model and rejected
  alternatives with reasons.

## Step 7 — Client integrations

- `opencode.json` provider block; Claude Code `ANTHROPIC_BASE_URL` recipe; Codex
  and generic OpenAI-compatible recipes.
- **Exit:** OpenCode/AndCode and Claude Code both work through Tariffia.

## Step 8 — Task analyzer (deterministic first)

- Deterministic classifier: size, tools/image presence, language, requested
  alias → profile.
- Optional cheap-model step for the one semantic question, behind a flag.
- **Exit:** `tariffia/auto` picks sensible profiles across task types.

## Deferred (post-MVP)

- Task analyzer with a paid/external classifier.
- PWA dashboard (health, quota, decision log).
- Android thin wrapper; desktop thin wrapper.
- Catalog sync / freshness tooling.
- Community/custom rulebook sharing.

## Definition of done for MVP

A user can start Tariffia on a laptop or in Termux, point OpenCode and Claude
Code at it, run in `FREE_ONLY` with Ollama and free tiers, and see (via CLI)
exactly why each request went where it did.
