# Third-party notices

## Imported: InferenceMesh core (vendored into `src/core/`)

- Upstream: https://github.com/gdalabs/inferencemesh
- Pinned commit: `5e3004b6b4c01a6b72353515d82d2796e43d3972`
- Version at that commit: `0.1.0`
- Licence: MIT — `Copyright (c) 2026 GDA Labs`
- Decision record: [docs/10-vendor-decision-inferencemesh.md](./docs/10-vendor-decision-inferencemesh.md)

Imported files (mirroring the upstream `src/` layout):

```
src/core/types.ts
src/core/registry.ts
src/core/config.ts
src/core/router.ts
src/core/health.ts
src/core/ledger.ts
src/core/concurrency.ts
src/core/mesh.ts
src/core/gateway.ts        [modified — see below]
src/core/redact.ts
src/core/version.ts
src/core/index.ts
src/core/providers/base.ts
src/core/providers/openai-compat.ts
src/core/providers/gemini.ts
```

Modifications (MIT permits this; recorded for upstream tracking):

- `src/core/gateway.ts` — the upstream `/setup` page route and the `/v1/keys`
  route were removed, together with their imports of `setup-ui.ts` and
  `validation-probe.ts` (both excluded from the approved import set), and a
  type-only `Registry` import was retained. No routing logic changed.
- `src/core/mesh.ts` — a server-authoritative `FREE_ONLY` gate was added: an
  `enforceFreeOnly` mesh option (default off), request sanitisation that drops a
  pin to a non-free/unknown model and forces the free-only profile, a ranked
  chain filter that removes non-free candidates, and a final execution-boundary
  guard. The default adapter map also registers the new `anthropic` adapter, the
  `route` event carries the deterministic task analysis, the analyzer's
  `requiredCapabilities` are merged into the request's capabilities as a hard
  pre-scoring filter, and an `allowAvoidRiskProviders` option (default off)
  governs the construction-time removal of `risk: 'avoid'` providers. The
  candidate ranking step now delegates to the new
  explainable scorer (`src/core/scorer.ts`), preserving the existing scoring
  signals, weights and deterministic tie-break. Fallback execution gained an
  explicit per-request dedupe and an execution-boundary guard that repeats the
  FREE_ONLY/privacy/capability hard filters (and rejects unknown adapter kinds)
  immediately before any adapter call; no ranking, fallback strategy, retry
  classification or pin behavior changed.
- `src/core/gateway.ts` — in addition to the removals above, a `POST /v1/messages`
  route was added for Anthropic-compatible clients. The OpenAI-compatible route
  is unchanged.
- `src/core/types.ts` — `'anthropic'` added to `ProviderKind`; optional
  `risk`/`riskNote`/`riskVerifiedAt` fields added to `ProviderConfig`.
- `src/core/config.ts` (further) — validates provider risk metadata: `risk` in
  {ok,caution,avoid}, `riskVerifiedAt` YYYY-MM-DD, and `risk === 'avoid'`
  requires a non-empty `riskNote`. No routing behavior added.
- `src/core/config.ts` — valid provider kinds now include `'anthropic'`; registry
  validation was hardened: `apiKeyEnv`/`accountIdEnv` must be environment-variable
  names (a pasted secret is rejected with a hint), `baseUrl` must be a valid
  http(s) URL, and pricing must be finite and non-negative (missing/malformed
  pricing is rejected rather than treated as free).
- `src/core/index.ts` — exports the new `AnthropicAdapter`, the analyzer and the
  scorer.
- `src/core/registry.ts` — added a `withProfiles()` copy method (keeps loaded
  providers/credentials, overlays profiles/default) for the Tariffia mode layer,
  and a `withoutAvoidRisk()` copy that removes `risk: 'avoid'` providers. Routing
  and scoring helpers unchanged.
- `src/core/mesh.ts` (further) — `MeshOptions.freeFirst` (default off) and a
  stable `freeFirstDecision()` partition that orders free candidates before paid
  ones; `routeFor` drops a client pin to a paid model under FREE_FIRST so it
  cannot force paid-first behavior. Scoring, retry and adapter behavior unchanged.

## Seed data (candidate data, not imported code)

- **awesome-free-llm-apis** — https://github.com/mnfst/awesome-free-llm-apis —
  licence **CC0-1.0** (public domain). `seed/awesome-free-llm-apis.data.json`
  (`data.json`, retrieved 2026-10-04, SHA-256
  `84f4479125c52aa5569939dd5908fd4fb9fabdf2df99b78c82fe79b8e28ef693`, upstream
  `lastUpdated` 2026-08-21). Stored separately from the active registry as
  candidate data; it is never loaded by the router. See `seed/README.md`.

New Tariffia files (not derived from upstream; own MIT-licensed code):
`src/core/analyzer.ts`, `src/core/scorer.ts`,
`src/core/providers/anthropic.ts`, `src/core/providers/anthropic-wire.ts`,
`src/routing-mode.ts`, `src/mode-mesh.ts`, `src/catalog-reader.ts`,
`src/catalog-sync.ts`, `src/seed-import.ts`, `src/seed-candidates.ts`,
`src/candidate-review.ts`, `src/candidate-probe.ts`,
`src/free-status-evidence.ts`, `src/activation-gate.ts`,
`src/provider-builder.ts`, and `src/registry-merge.ts`.

All other imported files are byte-identical to the pinned upstream commit.

Adapted tests imported into `tests/` (upstream tests with relative imports
rewritten from `../src/...` to `../src/core/...`, and blocks that depend on
non-imported modules or upstream repo files removed):

```
tests/helpers.ts
tests/routing.test.ts
tests/mesh.test.ts
tests/ledger.test.ts
tests/concurrency.test.ts
tests/gemini.test.ts
tests/mesh-mask.test.ts
tests/redact.test.ts
tests/gateway.test.ts
tests/runtime-agnostic.test.ts
```

Held back (approved in `docs/10` but not imported): `embedded-registry.ts` +
`providers.default.json` (separate ship decision), and the upstream tests
`server-stream.test.ts` (requires the rejected Node server) and
`package.test.ts` (upstream package-shape coherence, not core).

The full MIT notice for the imported code:

```
MIT License

Copyright (c) 2026 GDA Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Considered: FreeLLMAPI (patterns only, not imported)

- Upstream: https://github.com/tashfeenahmed/freellmapi — MIT
- Status: reference for fallback/cooldown/error-classification patterns only.
  No code imported; if any is used, its notice and commit hash are added here.

## How updates are tracked

The upstream commit is recorded here and in the import commit message, and in
[docs/05-inferencemesh-core.md](./docs/05-inferencemesh-core.md) and
[docs/10-vendor-decision-inferencemesh.md](./docs/10-vendor-decision-inferencemesh.md).
