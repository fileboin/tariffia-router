# 07 — What we take from FreeLLMAPI

**Source:** `tashfeenahmed/freellmapi` — MIT, TypeScript monorepo
(`shared/`, `server/`, `client/`, `cli/` + a desktop app). ~30k stars.

**Caveat first:** its README states it is **"for personal experimentation and
learning, not production"**, and it documents a per-provider ToS review and a
paid "live catalog" feed. So we borrow *engineering patterns* (with MIT
attribution where code is used), not its product posture, and we do not depend
on its catalog feed.

## Borrow (patterns)

| Area | Reference | What we adopt |
|---|---|---|
| Fallback loop | `server/src/lib/fallback-loop.ts` | A **single** attempt/fallback loop shared by every inbound wire format, instead of a copy per surface. Error classification, cooldown selection, one-key/one-model benching, Retry-After handling. |
| Error taxonomy | `server/src/lib/error-classify.ts` | Distinguish retryable vs client-fault vs auth vs daily-quota-exhausted vs model-not-found vs context-too-large vs timeout vs truncated stream. |
| Scoring | `server/src/services/router.ts` + `docs/en/architecture/01-routing-and-bandit-scoring.md` | Contextual-bandit scoring: weighted reliability/speed/intelligence with guardrail multipliers; decay-weighted history; exploration for unmeasured models. |
| Quota / cooldown | `server/src/services/ratelimit.ts` + `02-quota-and-cooldown-engine.md` | Per-key cooldown with backoff, model-level benching, quota accounting. |
| Streaming / degraded mode | `03-streaming-pipeline.md`, `04-degraded-mode-and-failover.md` | Late-failure handling, TTFB budget, hedging boundaries. |
| Wire adapters | `server/src/routes/{anthropic,responses,gemini,ollama}.ts`, `services/anthropic-map.ts` | Concrete patterns for translating Anthropic/Responses/Gemini/Ollama to and from a common shape. |
| Client config | `opencode.json` | The exact shape for wiring a local router into OpenCode/AndCode. |

## Not borrowed

- The premium catalog feed / hosted service.
- Its production disclaimer posture — we aim for a dependable local tool.
- Any provider access that depends on subscription-credential reuse; we stay
  BYO-key + legitimate free tiers.

## Verdict

FreeLLMAPI is our **second reference** after InferenceMesh: it contributes the
fallback/cooldown/error-classification and wire-adapter patterns that
InferenceMesh is missing. At this stage nothing is copied; import happens in the
MVP with attribution.
