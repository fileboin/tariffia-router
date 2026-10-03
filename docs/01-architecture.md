# 01 — Architecture

## Minimal architecture

```
USER / IDE / AGENT
      │   inbound: OpenAI /v1/chat/completions, Anthropic /v1/messages
      ▼
TARIFFIA WIRE LAYER        adapters in/out: openai-compat, anthropic, gemini, ollama; SSE both ways
      ▼
TASK ANALYZER              deterministic rules first; optional cheap model for one semantic question
      ▼
HARD FILTERS               capability, context window, privacy — correctness, not score
      ▼
MODEL SCORER               quality / cost / latency / language / reliability + health + quota
      ▼
PROFILE                    FREE_ONLY / FREE_FIRST / BALANCED / CUSTOM
      ▼
FALLBACK EXECUTOR          error classification, cooldown, benching; FREE_ONLY never escalates to paid
      ▼
REGISTRY                   providers.json: BYOK env, Ollama, free tiers, price+verifiedAt,
                           privacy tier, quota, ToS-risk flag
```

## Layers

| Layer | Responsibility | Notes |
|---|---|---|
| Wire layer | Parse inbound request, normalise to an internal chat shape, stream back in the caller's format | Adapter per protocol, not per vendor |
| Task analyzer | Classify the request (task type, size, tools/vision, language, privacy hint) and map it to a profile | Deterministic first; a model is asked only when code cannot decide |
| Hard filters | Remove candidates that cannot serve the request | Never overridden by score |
| Model scorer | Rank surviving candidates | Pure function, unit-testable, no network |
| Fallback executor | Attempt candidates in order, classify failures, cool down, bench sick models | Single implementation shared by all inbound formats |
| Registry | Source of truth for providers/models and their capabilities | Open JSON, BYOK |
| Observability | Per-decision log: chosen model, rejected alternatives, reason, cost, latency | Supports debugging and tuning |

## Key invariants

1. **Hard constraints are filters; preferences are weights.** A vision request
   without a vision model is not a worse choice — it is not a choice.
2. **A soft signal never empties the candidate chain.** If every health breaker
   is open, health is ignored rather than returning "no model".
3. **No paid model can be selected in `FREE_ONLY`.** Enforced before scoring,
   not after.
4. **Routing is pure.** It touches no network and consumes no quota, so it is
   cheap to test and reproducible.
5. **Secrets are write-only.** A stored key cannot be read back out through any
   endpoint or log.

## Request lifecycle (target)

1. Client calls `POST /v1/chat/completions` (or `/v1/messages`) with
   `model: "tariffia/auto"` (or a profile alias, or `provider/model` passthrough).
2. Wire layer normalises the request.
3. Task analyzer resolves `auto` → a concrete profile (or a request-supplied one).
4. Hard filters build the candidate pool.
5. Scorer ranks the pool; fallback executor attempts candidates in order.
6. First success streams back in the caller's wire format; failures are
   classified and recorded.
7. A decision record is logged (model, reason, rejections, cost, latency).
