# 00 — Overview

## What Tariffia Router is

A single, small, provider-independent **model router core**. It accepts requests
in standard wire formats, decides which model should serve each request, and
forwards the request with streaming and automatic fallback.

It is not tied to one vendor, one client, or one deployment shape.

## Goals

1. **One core, many entry points** — CLI, local HTTP server, optional PWA,
   optional Android/desktop wrappers.
2. **Local / free first** — usable with Ollama and legitimate free tiers, with
   no paid key required.
3. **Drop-in for existing AI tools** — expose OpenAI-compatible and
   Anthropic-compatible endpoints so clients need only a URL + key.
4. **Honest routing** — the mode is enforced in code, not by preference.
5. **Small surface** — no unnecessary frameworks; the core stays readable and
   auditable.

## Non-goals (for now)

- No per-client agent or plugin that re-implements the router.
- No billing system, multi-tenancy, or account management.
- No subscription-credential reuse, TLS interception, or rate-limit evasion.
- No large agent framework (LangChain/LangGraph/etc.) inside the core.
- No hosted SaaS in the MVP.

## Scope of this stage

This repository is **pre-implementation**. Only the scaffold and the design
documents exist. No router code and no third-party source have been added yet.
The next stage (MVP step 1) is to import and adapt the routing core — see
[05-inferencemesh-core.md](./05-inferencemesh-core.md) and
[08-mvp-roadmap.md](./08-mvp-roadmap.md).
