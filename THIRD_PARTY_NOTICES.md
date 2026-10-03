# Third-party notices

## Imported: InferenceMesh core (vendored into `src/core/`)

- Upstream: https://github.com/gdalabs/inferencemesh
- Pinned commit: `5e3004b6b4c01a6b72353515d82d2796e43d3972`
- Version at that commit: `0.1.0`
- Licence: MIT — `Copyright (c) 2026 GDA Labs`
- Decision record: [docs/10-vendor-decision-inferencemesh.md](./docs/10-vendor-decision-inferencemesh.md)

Imported files (mirroring the upstream `src/` layout):

```
src/core/types.ts
src/core/registry.ts
src/core/config.ts
src/core/router.ts
src/core/health.ts
src/core/ledger.ts
src/core/concurrency.ts
src/core/mesh.ts
src/core/gateway.ts        [modified — see below]
src/core/redact.ts
src/core/version.ts
src/core/index.ts
src/core/providers/base.ts
src/core/providers/openai-compat.ts
src/core/providers/gemini.ts
```

Modifications (MIT permits this; recorded for upstream tracking): in
`src/core/gateway.ts` the upstream `/setup` page route and the `/v1/keys` route
were removed, together with their imports of `setup-ui.ts` and
`validation-probe.ts` (both excluded from the approved import set). No routing
logic was changed. All other imported files are byte-identical to the pinned
upstream commit.

Held back (approved in `docs/10` but not imported in this step):
`embedded-registry.ts` + `providers.default.json` (separate ship decision), and
the upstream tests (require import-path adaptation and a TypeScript test
toolchain).

The full MIT notice for the imported code:

```
MIT License

Copyright (c) 2026 GDA Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Considered: FreeLLMAPI (patterns only, not imported)

- Upstream: https://github.com/tashfeenahmed/freellmapi — MIT
- Status: reference for fallback/cooldown/error-classification patterns only.
  No code imported; if any is used, its notice and commit hash are added here.

## How updates are tracked

The upstream commit is recorded here and in the import commit message, and in
[docs/05-inferencemesh-core.md](./docs/05-inferencemesh-core.md) and
[docs/10-vendor-decision-inferencemesh.md](./docs/10-vendor-decision-inferencemesh.md).
