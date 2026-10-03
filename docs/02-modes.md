# 02 — Routing modes

Four modes. They are enforced in code, not as a prompt or a preference.

## `FREE_ONLY`

- Candidate pool is filtered to **local + legitimately free** models only
  (`isFree` + privacy filter applied before scoring).
- Paid models are rejected with a reason, not merely down-weighted.
- The fallback executor is **not allowed** to escalate to a paid model under any
  circumstance — if all free candidates fail, the request fails with a clear
  error. This is a guarantee, tested by a dedicated regression test.

## `FREE_FIRST`

- Free models are tried first, in ranked order.
- A paid model is used **only if** the user has explicitly enabled paid use
  (`allowPaid: true`) and a budget/consent rule is satisfied.
- Every paid escalation is logged with the reason and estimated cost.

## `BALANCED`

- No free/paid hard split. Candidates are scored by weighted
  quality + cost + latency (+ language, reliability).
- Default weights ship with the project; users may override them.

## `CUSTOM`

- A user rulebook (deterministic predicates) plus custom weights and price
  caps, in the spirit of a small YAML/JSON rule set.
- Deterministic rules take precedence over scoring; the scorer ranks whatever
  survives.

## Mapping to profiles

Modes are user-facing. Internally they map to named profiles plus a
`freeOnly` / `maxPricePerMTok` / `allowPaid` configuration:

| Mode | `freeOnly` | `allowPaid` | scoring |
|---|---|---|---|
| FREE_ONLY | true | false | free-quality weighted |
| FREE_FIRST | false | configurable | free first, paid as fallback |
| BALANCED | false | true | balanced weights |
| CUSTOM | by rule | by rule | user weights |

## Model aliases (target)

- `tariffia/auto` — the analyzer picks a profile
- `tariffia/free` — FREE_ONLY
- `tariffia/free-first` — FREE_FIRST
- `tariffia/balanced` — BALANCED
- `tariffia/<provider>/<model>` — explicit passthrough (still respects privacy
  and capability hard filters)
