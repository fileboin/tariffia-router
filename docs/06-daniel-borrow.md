# 06 — What we take from the AgriciDaniel ecosystem

These repositories are Claude Code skill/plugin suites. Most are domain tools
(SEO, ads, blog, Obsidian) that are **irrelevant** to a router. A few contain
reusable *patterns*. We borrow ideas and small patterns, not their products.

## Borrow (patterns)

### `gatekeeper` — task/decision routing (MIT)

The single most relevant project. Pattern:

```
event -> deterministic rules (code) -> one batched semantic judgment
      -> decision table (first match wins) -> typed Verdict
```

- `gatekeeper/gatekeeper/rules.py` — deterministic predicates:
  `matches | equals | in | shorter_than | longer_than | exists`, with
  `all | any | not`.
- Verdict types: `allow | route | suggest | confirm | escalate | block`.
- Confidence bands + group rollup + a per-decision audit log (rules fired,
  answer, band, cost, latency).

**Use:** the shape of our Task Analyzer — decide what code can decide, ask a
model only the one semantic question left, then act on a typed verdict with
confidence and fallback bands.

**Caveat:** gatekeeper's semantic step calls the **paid** TypeSafe "Jev" API
(`gatekeeper/gatekeeper/jev.py`, `https://api.typesafe.ai/v1/systemone`,
`USD_PER_MTOK_INPUT = 0.042`). We do **not** use it as a runtime; it is a design
reference only.

### `plan-gate` — cheap-model tiering (MIT)

A cheap model explores read-only and produces a plan; writes happen only after
approval. Method is agent-agnostic. **Use:** validates our tiering idea — cheap
model for analysis, stronger model only when needed.

### `claude-ads` — adapters + governance manifests (MIT)

- `claude_ads_core/adapters/` — a clean adapter-per-format pattern.
- `control-plane/manifests/` — `capability-manifest.json`, `scoring-profiles.json`,
  `control-registry.json`, licensing/privacy/security review templates,
  dependency inventory.

**Use:** the registry/governance idea — providers carry capability manifests and
a ToS/risk disposition, and there is an evidence trail for decisions.

### Multi-host packaging

- `claude-obsidian` ships `.cursor/`, `.windsurf/`, `AGENTS.md`, `GEMINI.md`.
- `claude-ads` ships `CODEX.md`, `GEMINI.md`, a Python core with a CLI entry.
- `codex-seo` ships `.codex-plugin/plugin.json` + hooks.

**Use:** the pattern for distributing one thing to many hosts. Our distribution
is simpler (a base URL + config), but if we ever ship host-native glue, this is
the shape.

### MCP / secrets pattern

- `banana-claude/.mcp.json` and plugin `userConfig` with a `sensitive` key.
**Use:** how to declare an MCP server and hold a secret without committing it.

## Reject

- All domain skills and sub-agents (SEO/ads/blog/Obsidian/image) — out of scope.
- `codex-seo` — **proprietary licence** despite an "MIT" string in its plugin
  manifest. Do not use.
- Any author-specific distribution channel; the code itself is decoupled
  (no content files reference the author's domains).

## Verdict

From Daniel we take **one idea (gatekeeper's decide-with-code-first, typed
verdict)** and **two small patterns (adapter + capability/risk manifests, and
multi-host packaging)**. No code is copied at this stage.
