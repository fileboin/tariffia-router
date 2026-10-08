# 02 — Routing modes

Four modes. They are enforced in code, not as a prompt or a preference.

## `FREE_ONLY`

- Candidate pool is filtered to **explicitly 0/0-priced** models only
  (`isFree` + privacy filter applied before scoring).
- Paid models are rejected with a reason, not merely down-weighted.
- The fallback executor is **not allowed** to escalate to a paid model under any
  circumstance — if all free candidates fail, the request fails with a clear
  error. This is a guarantee, tested by a dedicated regression test.

## `FREE_FIRST`

- Free models are tried first, in ranked order.
- Paid fallback is permitted only when a valid server-owned
  `TARIFFIA_MAX_PRICE_PER_MTOK` is configured. Both input and output rates must
  be at or below it. With no valid cap, paid candidates are rejected.
- The cap is a per-model USD/MTok rate ceiling, not a per-request USD budget.

## `BALANCED`

- No free/paid hard split. Candidates are scored by weighted
  quality + cost + latency (+ language, reliability).
- The same server-owned price cap filters candidates before scoring; without a
  valid cap, only explicitly 0/0-priced models remain eligible.
- Default weights ship with the project; users may override them.

## `CUSTOM`

- A user rulebook (deterministic predicates) plus custom weights and price
  caps, in the spirit of a small YAML/JSON rule set.
- Deterministic rules take precedence over scoring; the scorer ranks whatever
  survives.

## Mapping to profiles

Modes are server-selected. They map to named profiles plus FREE_ONLY enforcement
and FREE_FIRST ordering. The server-owned rate cap applies independently of
client-selected profiles and model pins:

| Mode | Paid eligibility | scoring |
|---|---|---|---|
| FREE_ONLY | never; hard filter | free-quality weighted |
| FREE_FIRST | within cap, after free candidates | `best` weights |
| BALANCED | within cap | balanced weights |
| CUSTOM | reserved; fails closed | not implemented |

The cap applies separately to input and output rates. It limits configured
provider rates only; actual request cost depends on token usage and provider
billing. An absent or invalid cap disables paid candidates.

## Model aliases (target)

- `tariffia/auto` — the analyzer picks a profile
- `tariffia/free` — FREE_ONLY
- `tariffia/free-first` — FREE_FIRST
- `tariffia/balanced` — BALANCED
- `tariffia/<provider>/<model>` — explicit passthrough (still respects privacy
  and capability hard filters)
