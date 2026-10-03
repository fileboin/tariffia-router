# Third-party notices

**No third-party source has been imported yet.** This file records the locked
vendoring decision and the attribution that must be reproduced at import time.

## Planned: InferenceMesh (core, not yet imported)

- Upstream: https://github.com/gdalabs/inferencemesh
- Pinned commit: `5e3004b6b4c01a6b72353515d82d2796e43d3972`
- Licence: MIT
- Copyright: `Copyright (c) 2026 GDA Labs`
- Import target: `src/core/`
- Decision record: [docs/10-vendor-decision-inferencemesh.md](./docs/10-vendor-decision-inferencemesh.md)

No files have been copied. When they are, each vendored file keeps its original
licence header and the following MIT notice is reproduced in full:

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
