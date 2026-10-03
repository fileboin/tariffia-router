# 03 — Client / app decision

## Decision

**Core first, headless.** Build one router core and one local HTTP server. The
CLI is the first interface; a PWA is the first optional UI; Android and desktop
are later *thin wrappers* over the same local server, never a second core.

### Chosen stack

| Piece | Decision | Why |
|---|---|---|
| Core language | **TypeScript on Node 20+**, minimal/zero runtime deps | The chosen routing core (InferenceMesh) is TypeScript and dependency-free; it runs on Node, Bun, Deno and Workers, which also covers Termux and VPS. |
| Primary interface | **CLI** | Smallest surface, works on desktop, Termux, VPS and in scripts. |
| Local API | **HTTP server**, OpenAI + Anthropic compatible | This is the integration contract for every AI tool. |
| Optional UI | **PWA served by the same local server** | No separate frontend framework for the MVP. Static assets only. |
| Android | **Termux (Node) first**; optional thin wrapper later | Termux already runs the core. A wrapper is only justified if the PWA/Termux UX is not enough. |
| Desktop | **Optional thin wrapper later** (e.g. Tauri/Electron over the local server) | No second implementation of the core. |

## Why not APK / native first

- An APK would force a second runtime (or a rewritten core) before the routing
  logic is proven.
- A PWA over a local server gives an installable UI on both desktop and Android
  with no extra framework.
- Android *is* covered early through Termux, where the same Node core runs.

## The rule

> Any graphical or mobile client is a **view over the local HTTP server**. It
> contains no routing logic. If the server is unavailable, the client has no
> opinions about models.

## Open questions

See [09-open-decisions.md](./09-open-decisions.md): the PWA is the *proposed*
first UI; whether to also ship a native Android wrapper is deferred until the
core and CLI are working.
