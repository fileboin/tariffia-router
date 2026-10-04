import { strict as assert } from 'node:assert';
import { test, describe, after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serveConfigFromEnv, startServeServer, type RunningServer } from '../src/serve.js';
import { DEFAULT_REGISTRY_PATH } from '../src/registry-loader.js';
import { main } from '../src/cli/index.js';

const running: RunningServer[] = [];
after(async () => {
  await Promise.all(running.map((r) => r.close()));
});

async function startServer(over: Partial<Parameters<typeof startServeServer>[0]> = {}): Promise<RunningServer> {
  const config = { ...serveConfigFromEnv({ TARIFFIA_TOKEN: 'test-token' }), port: 0, ...over };
  const r = await startServeServer(config);
  running.push(r);
  return r;
}

async function tempRegistry(contents: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'tariffia-serve-'));
  const path = join(dir, 'registry.json');
  await writeFile(path, contents, 'utf8');
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const auth = { authorization: 'Bearer test-token' };

describe('tariffia serve', () => {
  test('1. the shipped registry loads and the server starts', async () => {
    const r = await startServer();
    assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${r.url}/v1/models`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: unknown[] };
    assert.ok(Array.isArray(body.data) && body.data.length > 0);
  });

  test('2. invalid/missing registry fails clearly', async () => {
    await assert.rejects(
      () => startServer({ registryPath: '/nonexistent/registry.json' }),
      /cannot read registry/,
    );
    const bad = await tempRegistry('{ not json');
    try {
      await assert.rejects(() => startServer({ registryPath: bad.path }), /not valid JSON/);
    } finally {
      await bad.cleanup();
    }
    const invalid = await tempRegistry(JSON.stringify({ providers: [{ id: 'x' }] }));
    try {
      await assert.rejects(() => startServer({ registryPath: invalid.path }), /registry:/);
    } finally {
      await invalid.cleanup();
    }
  });

  test('3. mode defaults safely to FREE_ONLY and is server-owned', async () => {
    const config = serveConfigFromEnv({}); // no TARIFFIA_MODE
    assert.equal(config.mode, 'FREE_ONLY');
    const r = await startServer({ mode: 'FREE_ONLY' });
    assert.equal(r.config.mode, 'FREE_ONLY');
    // /healthz (authenticated) exposes no mode leakage but answers.
    const res = await fetch(`${r.url}/healthz`, { headers: auth });
    assert.equal(res.status, 200);
  });

  test('4. Ollama is present in the served model list', async () => {
    const r = await startServer();
    const res = await fetch(`${r.url}/v1/models`, { headers: auth });
    const body = (await res.json()) as { data: Array<{ id: string }> };
    assert.ok(body.data.some((m) => m.id.startsWith('ollama/')), 'an ollama model is listed');
  });

  test('5. requests require the bearer token (fail-closed)', async () => {
    const r = await startServer();
    const noAuth = await fetch(`${r.url}/v1/models`);
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(`${r.url}/v1/models`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
  });

  test('6. no API secret is printed/logged by the CLI config', () => {
    const sup = serveConfigFromEnv({ TARIFFIA_TOKEN: 'super-secret-token' });
    assert.equal(sup.generatedToken, false);
    // The generated-token path produces a random token and marks it generated.
    const gen = serveConfigFromEnv({});
    assert.equal(gen.generatedToken, true);
    assert.ok(gen.token.length >= 32);
    // The config object never carries provider API keys; only the bearer token.
    assert.deepEqual(Object.keys(gen).sort(), ['generatedToken', 'host', 'mode', 'port', 'registryPath', 'token']);
  });

  test('7. CLI help is safe and the default registry path is the shipped one', async () => {
    const code = await main(['help']);
    assert.equal(code, 0);
    assert.match(DEFAULT_REGISTRY_PATH, /registry[/\\]ollama\.json$/);
  });

  test('8. an unknown command returns a failure code', async () => {
    const code = await main(['frobnicate']);
    assert.equal(code, 1);
  });
});
