# 09 — Decided vs not-yet-decided

## Decided

| # | Decision | Rationale |
|---|---|---|
| D1 | Core is headless and provider-independent | One core, many clients |
| D2 | Core language: TypeScript on Node 20+, zero/minimal runtime deps | Chosen core (InferenceMesh) is TS + dep-free; runs on Node/Bun/Deno/Workers, Termux, VPS |
| D3 | Integration contract is a base URL + key (OpenAI + Anthropic compatible) | No per-client agent |
| D4 | CLI first; PWA proposed as first optional UI; Android/desktop are thin wrappers over the local server, never a second core | Avoids premature native work |
| D5 | Base the routing core on `gdalabs/inferencemesh` (MIT), vendored, with attribution | Tiny, auditable, free-first, no-paid-fallback guarantee |
| D6 | Borrow fallback/cooldown/error patterns from FreeLLMAPI (MIT) | Fills the gaps InferenceMesh has |
| D7 | Borrow the "deterministic-first, typed verdict" idea from `gatekeeper`; do **not** depend on its paid TypeSafe runtime | Design reference only |
| D8 | `FREE_ONLY` is enforced in code and covered by a dedicated test | It is a guarantee, not a preference |
| D9 | Reject subscription-credential reuse, TLS interception, rate-limit evasion; BYO keys + legitimate free tiers only | Legal/ToS safety |
| D10 | Repository is **private** for now | Pre-implementation; flip to public when ready |
| D11 | License: **MIT (proposed)** | Compatible with the MIT core and the project's intent |

## Open (needs a decision before or during the MVP)

| # | Question | Options / notes |
|---|---|---|
| O1 | Final repository visibility | private now; public later? |
| O2 | Confirm MIT license | or Apache-2.0 (if patent grant matters) |
| O3 | Confirm TypeScript/Node as final stack | vs. a compiled single binary later (Node SEA like InferenceMesh) |
| O4 | Vendor vs. depend on InferenceMesh | currently plan A = vendor with upstream tracking |
| O5 | Default port and token policy | example uses `8910` + a bearer token |
| O6 | Config format | `providers.json` (JSON) now; YAML rulebook for CUSTOM later? |
| O7 | Free-tier catalog source | hand-curated vs. sync from a public catalog; must stay honest with `priceVerifiedAt` |
| O8 | Include paid providers at all in MVP | could ship local+free only first |
| O9 | PWA in MVP or deferred | currently deferred (post-MVP) |
| O10 | Native Android wrapper | only if Termux + PWA is not enough |
| O11 | Desktop wrapper framework | Tauri vs. Electron — deferred |
| O12 | Task analyzer: deterministic only vs. optional cheap classifier | MVP: deterministic; classifier behind a flag |
| O13 | Telemetry | default off; local-only decision log |
| O14 | Naming/branding, domain, npm package scope | `tariffia-router`; scope TBD |
