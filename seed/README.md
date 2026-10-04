# Seed data — free-provider candidates

This directory holds **candidate data**, not an active registry. Nothing here is
loaded by the router or by `registry/ollama.json`. It exists so providers can be
reviewed and, later, imported deliberately.

## `awesome-free-llm-apis.data.json`

- Source: https://github.com/mnfst/awesome-free-llm-apis
- File: `data.json` (the machine-readable form of the list's README)
- Licence: **CC0-1.0** (public domain dedication). No attribution is legally
  required; it is recorded here and in `THIRD_PARTY_NOTICES.md` anyway.
- Retrieved: 2026-10-04
- SHA-256: `84f4479125c52aa5569939dd5908fd4fb9fabdf2df99b78c82fe79b8e28ef693`
- Source `lastUpdated`: 2026-08-21 (the upstream file's own timestamp)

### What it is

A list of providers offering permanently-free LLM API tiers, with a base URL, a
short description, and per-model rows (id, name, context, max output, modality,
rate limit). All endpoints are OpenAI-SDK-compatible unless the entry says
otherwise.

### How Tariffia treats it

- **Read-only candidate data.** It is parsed and validated, never activated.
- It is **not** truth: every field is a claim to be re-verified against the
  provider's own documentation and a live probe before any provider is added to
  the active registry.
- Free status is **never** derived from a model name or from this list alone.
  A model becomes FREE_ONLY-eligible only through the active registry's explicit
  `price` of 0/0.

`seed/` is intentionally separate from `registry/`. Adding a provider means
authoring a reviewed entry in `registry/`, not pointing the router at this file.
