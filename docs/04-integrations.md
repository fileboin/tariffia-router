# 04 — Integrations

The contract is deliberately protocol-level, so no per-client agent is needed:
**a base URL plus a key/config**.

## Endpoints exposed by Tariffia

| Endpoint | Purpose | Used by |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible chat | OpenCode, Codex, Cursor, Cline, Aider, most tools |
| `POST /v1/messages` | Anthropic-compatible messages | Claude Code, Anthropic SDKs |
| `GET /v1/models` | Model/alias discovery | most clients |
| `GET /health` | Liveness + active mode | ops, wrappers |
| `GET /status` | Providers, quota, health | CLI, PWA |

## Client configuration

### OpenCode / AndCode

OpenCode (and AndCode, which is OpenCode-based) accepts an OpenAI-compatible
provider in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "tariffia/auto",
  "provider": {
    "tariffia": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Tariffia Router (local)",
      "options": { "baseURL": "http://127.0.0.1:8910/v1" },
      "models": {
        "auto": { "name": "Tariffia Auto", "limit": { "context": 1048576, "output": 65536 } }
      }
    }
  }
}
```

### Claude Code

Anthropic-compatible endpoint via environment:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8910"
export ANTHROPIC_API_KEY="<tariffia token>"
```

### Codex

Point the OpenAI-compatible base URL at Tariffia (config/env depending on
version).

### OpenAI-compatible tools in general

```
baseURL = http://127.0.0.1:8910/v1
apiKey  = <tariffia token>
model   = tariffia/auto
```

### Gemini CLI and other non-OpenAI tools

Use an OpenAI-compatible shim config if the tool supports one; otherwise a small
documented recipe per tool (no routing logic lives in the recipe).

## Remote / VPS usage

The same server runs on a VPS. Expose it behind TLS and a token. Keep `FREE_ONLY`
and BYO keys; never share subscription credentials.

## Rule

No integration may embed provider keys or routing logic. Integrations only point
at Tariffia.
