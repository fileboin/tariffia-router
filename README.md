# Tariffia Router

**Universal, provider-independent AI model router. Local / free first.**

One small core that speaks the standard AI APIs (OpenAI-compatible and
Anthropic-compatible) and routes each request to the best available model by
task, capability, context, privacy, availability, speed and price — with
automatic fallback. It can run on a laptop or a VPS and be plugged into any
compatible client without a per-client agent.

```
Claude Code · OpenCode · Codex · AndCode · Gemini CLI · other tools
                              │
                              ▼
                        TARIFFIA ROUTER
                              │
              LOCAL / FREE / OPTIONAL PAID
```

> **Status: pre-implementation.** This repository currently contains only the
> scaffold and the architecture / decision documents. No router code has been
> written yet, and no third-party source has been copied. See
> [`docs/`](./docs) and [`docs/08-mvp-roadmap.md`](./docs/08-mvp-roadmap.md).

## Principles

- **One core → many ways to use it.** CLI, local HTTP API server, optional PWA,
  optional Android/desktop wrappers — all thin layers over the same core.
- **Local / free first.** Fully usable with Ollama and legitimate free tiers,
  no paid key required.
- **Provider-independent.** Adding or removing a provider never changes the
  clients.
- **Honest free-only.** `FREE_ONLY` mode must *technically* be unable to call a
  paid model, not just prefer not to.
- **No ToS / billing bypass.** No subscription-credential reuse, no TLS
  interception, no rate-limit evasion. BYO keys and legitimate free tiers only.

## Routing modes

| Mode | Behaviour |
|---|---|
| `FREE_ONLY` | Hard filter: local + legitimately free only. A paid model can never be selected or used as fallback. |
| `FREE_FIRST` | Free models first; paid only if the user explicitly allows it and a budget/consent rule is met. |
| `BALANCED` | Weighted quality + speed + cost. |
| `CUSTOM` | User-defined rulebook and weights. |

## Planned usage

```bash
# target interface (not implemented yet)
tariffia serve        # start the local OpenAI/Anthropic-compatible endpoint
tariffia status       # health, quota, active mode
tariffia providers    # list registered providers/models
tariffia route "…"    # explain which model would be chosen and why
```

Clients then need only a URL and a key/config:

- **OpenAI-compatible:** `baseURL = http://127.0.0.1:PORT/v1`
- **Anthropic-compatible:** `ANTHROPIC_BASE_URL = http://127.0.0.1:PORT`

## Documents

| Doc | Contents |
|---|---|
| [00-overview.md](./docs/00-overview.md) | What this is, scope, non-goals |
| [01-architecture.md](./docs/01-architecture.md) | Minimal architecture and data flow |
| [02-modes.md](./docs/02-modes.md) | FREE_ONLY / FREE_FIRST / BALANCED / CUSTOM semantics |
| [03-client-decision.md](./docs/03-client-decision.md) | CLI / server / PWA / Android / desktop decision |
| [04-integrations.md](./docs/04-integrations.md) | Claude Code, AndCode, OpenCode, Codex, Gemini CLI |
| [05-inferencemesh-core.md](./docs/05-inferencemesh-core.md) | How the InferenceMesh core will be used |
| [06-daniel-borrow.md](./docs/06-daniel-borrow.md) | What is taken from the AgriciDaniel ecosystem |
| [07-freellmapi-borrow.md](./docs/07-freellmapi-borrow.md) | What is taken from FreeLLMAPI |
| [08-mvp-roadmap.md](./docs/08-mvp-roadmap.md) | MVP steps in order |
| [09-open-decisions.md](./docs/09-open-decisions.md) | Decided vs not-yet-decided |

## Repository layout

```
tariffia-router/
├── README.md
├── LICENSE                 # MIT (proposed)
├── package.json            # minimal, zero runtime deps
├── docs/                   # architecture + decisions (this stage)
├── src/
│   ├── core/               # routing core (to be vendored/adapted)
│   ├── adapters/           # wire-format adapters (OpenAI, Anthropic, Gemini, Ollama)
│   ├── server/             # local HTTP server
│   └── cli/                # command line interface
├── registry/               # provider/model catalog
├── tests/
└── scripts/
```

## Install on a VPS (one command)

Requirements: Linux with systemd, root (sudo), and **Node.js >= 20 already installed**.
The installer will not install Node or any other system package — it stops with a clear
message if Node is missing or older than 20.

```bash
curl -fsSL https://raw.githubusercontent.com/fileboin/tariffia-router/main/scripts/install.sh | sudo bash
```

What it does:

- clones (or updates) the repo in `/opt/tariffia-router` (or uses the checkout it is run
  from), runs `npm ci` and `npm run build`;
- writes `/etc/tariffia-router.env` (root-only, mode `0600`) with `TARIFFIA_HOST=0.0.0.0`,
  `TARIFFIA_PORT=8910`, `TARIFFIA_MODE=FREE_ONLY`, `TARIFFIA_REGISTRY`, and a generated
  `TARIFFIA_TOKEN`;
- installs and starts the systemd unit `tariffia-router.service`
  (`node dist/src/cli/index.js serve`) and verifies `/healthz`.

It is **idempotent**: re-running keeps the existing token, updates the build, and
restarts the service.

Where things live:

- Router directory: `/opt/tariffia-router`
- Listens on: `http://0.0.0.0:8910` (OpenAI-compatible base URL `http://<vps-ip>:8910/v1`)
- Env / token: `/etc/tariffia-router.env` (root only)
- Status: `systemctl status tariffia-router`
- Logs: `journalctl -u tariffia-router -f`
- Router URL and token: the installer prints them once; the token is also in the env file:
  `sudo grep TARIFFIA_TOKEN /etc/tariffia-router.env`

Provider API keys are **not** handled by the installer. Add them to the env file (using
the env names from your registry) and run `systemctl restart tariffia-router`.

## Licence

MIT (proposed — see [09-open-decisions.md](./docs/09-open-decisions.md)).
Vendored third-party code keeps its own licence and attribution; see
`NOTICE`/`THIRD_PARTY` once the core is imported.
