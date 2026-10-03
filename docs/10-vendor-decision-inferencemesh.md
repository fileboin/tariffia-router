# 10 — Vendor decision: InferenceMesh base (LOCKED)

Status: **LOCKED / accepted**. Documentation only — no upstream source has been
imported into this repository yet.

## Upstream

- Repository: https://github.com/gdalabs/inferencemesh
- Pinned commit: `5e3004b6b4c01a6b72353515d82d2796e43d3972`
  (default branch `main`, 2026-09-17, tree `9f240b4bae82a6ec1fe7f612d818e3b10da7cba3`)
- Version at that commit: `0.1.0`
- Alternative release point (not chosen): tag `v0.1.0-rc.1` =
  `a4e724d31870699dda1db3647c1b0ff9674cc790` (2026-09-05). `main` is preferred
  because it adds `src/redact.ts`, `test/redact.test.ts`,
  `test/mesh-mask.test.ts`, and a streaming-test flake fix.
- Licence: **MIT**, `Copyright (c) 2026 GDA Labs`.

## Decision

**Vendor** the selected core files into `src/core/` (pinned to the commit above),
rather than depending on the upstream package or tracking its `main` branch.

## Why vendor instead of dependency

1. **We must modify the routing core.** Tariffia needs a server-authoritative
   `FREE_ONLY` gate and an Anthropic adapter, neither of which can be done cleanly
   as a black-box dependency.
2. **Preserve the zero-runtime-dependency property.** Upstream ships with no
   `dependencies`; an external dependency would pull its own release cadence and
   transitive surface.
3. **Small and MIT.** ~6.5k LOC, permissive licence — cheap to freeze and audit.
4. **Upstream's own guarantees stay testable under our suite** (runtime-agnostic,
   no `node:` imports reachable from the engine entry point).
5. **Low bus factor.** Upstream is a single-maintainer `v0.1.0` with one rc tag;
   vendoring means we own the code after import.

Upstream tracking after import: keep upstream file headers, record the pinned
commit here and in the import commit message, and diff upstream releases against
our snapshot to cherry-pick.

## Exact modules planned for import (into `src/core/`)

Runtime-agnostic engine:

- `src/types.ts`
- `src/registry.ts`
- `src/config.ts`
- `src/router.ts`
- `src/health.ts`
- `src/ledger.ts`
- `src/concurrency.ts`
- `src/mesh.ts`
- `src/gateway.ts`
- `src/redact.ts`
- `src/version.ts`
- `src/providers/base.ts`
- `src/providers/openai-compat.ts`
- `src/providers/gemini.ts`
- `src/index.ts` (trimmed to what we keep)
- `src/embedded-registry.ts` + `providers.default.json` (reference data only;
  separate decision whether to ship)

Tests to import/adapt: `test/helpers.ts`, `routing.test.ts`, `gateway.test.ts`,
`mesh.test.ts`, `ledger.test.ts`, `concurrency.test.ts`, `gemini.test.ts`,
`server-stream.test.ts`, `runtime-agnostic.test.ts`, `mesh-mask.test.ts`,
`redact.test.ts`, `package.test.ts`.

## Modules explicitly rejected (do NOT import)

- `src/cli.ts` (upstream-named; we build `tariffia`)
- `src/server/node.ts` (Node-specific server + file key store; we serve
  `gateway.handleRequest` from our own server)
- `src/setup.ts`, `src/setup-ui.ts`
- `src/language-probe.ts`, `src/probe-report.ts`, `src/validation-probe.ts`
- `src/catalogs.ts`, `src/sync.ts`
- `scripts/discover-providers.mjs`, `install.sh`, `Dockerfile`, `sea-config.json`
- `.github/workflows/*`, upstream README translations, upstream `docs/`
- Upstream tests for the rejected modules (`cli.test.ts`, `setup*.test.ts`,
  `sync.test.ts`, `language-probe.test.ts`, `models-doc.test.ts`,
  `readme-translations.test.ts`, `key-store.test.ts`, `probe-report.test.ts`,
  `validation-probe.test.ts`)

## Required Tariffia FREE_ONLY server-authoritative gate

Upstream's `free` profile is a hard filter for normal routing and fallback, but
an explicit `pin` (any client `model` string that is not `mesh/<profile>`)
bypasses `freeOnly`, and the client-supplied `body.mesh.*` routing extension is
passed through unvalidated. Therefore Tariffia MUST add, before `Router.route()`:

- ignore or strip client-supplied `pin` and `body.mesh.*` routing overrides; and
- when the active mode is `FREE_ONLY`, reject any candidate that is not free.

The mode is decided by the server, never by the client. A regression test must
assert that a client-pinned paid model is rejected in `FREE_ONLY`, and that no
fallback path can reach a paid candidate.

## Required Anthropic adapter

Upstream has no Anthropic support. Tariffia must add:

- inbound `POST /v1/messages` with Anthropic SSE translation; and
- an outbound `AnthropicAdapter` implementing the `Adapter` contract
  (`chat` + `stream`), using `src/providers/gemini.ts` as the template for a
  non-OpenAI wire format.

## Attribution and NOTICE

Keep upstream attribution. When source is imported, `THIRD_PARTY_NOTICES.md`
must include the full MIT text with `Copyright (c) 2026 GDA Labs`, the upstream
URL, the pinned commit, the imported file list, and a note of Tariffia's
modifications. A reserved entry is present in `THIRD_PARTY_NOTICES.md` now; no
source has been copied.
