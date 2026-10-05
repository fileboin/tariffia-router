import { strict as assert } from 'node:assert';
import { test, describe, after } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serveConfigFromEnv, startServeServer, type RunningServer } from '../src/serve.js';

const running: RunningServer[] = [];
after(async () => {
  await Promise.all(running.map((r) => r.close()));
});

// A provider declared in the file but dropped at load (its env key is absent), so
// the allowlist must come from the file, not the loaded registry.
const REGISTRY = JSON.stringify({
  providers: [
    {
      id: 'syncprobe',
      kind: 'openai-compat',
      baseUrl: 'https://syncprobe.test/v1',
      apiKeyEnv: 'SYNC_TEST_PROBE_KEY',
      maxPrivacy: 'public',
      models: [
        {
          id: 'probe-model',
          capabilities: ['text'],
          contextWindow: 8000,
          price: { inPerMTok: 0, outPerMTok: 0 },
        },
      ],
    },
  ],
});

const KEY = 'dummy-sync-key-value-123';
const auth = { authorization: 'Bearer test-token' };

async function start(over: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tariffia-keysync-'));
  const path = join(dir, 'registry.json');
  await writeFile(path, REGISTRY, 'utf8');
  const config = {
    ...serveConfigFromEnv({ TARIFFIA_TOKEN: 'test-token' }),
    port: 0,
    registryPath: path,
    ...over,
  };
  const server = await startServeServer(config);
  running.push(server);
  return { server, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function keyUrl(url: string, providerId = 'syncprobe'): string {
  return `${url}/v1/providers/${providerId}/key`;
}

function put(url: string, body: unknown, headers: Record<string, string> = auth): Promise<Response> {
  return fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function healthProviders(url: string): Promise<string[]> {
  const res = await fetch(`${url}/healthz`, { headers: auth });
  const body = (await res.json()) as { providers: string[] };
  return body.providers;
}

describe('provider key sync', () => {
  test('1. valid provider + valid token accepts the key (loopback)', async () => {
    const { server, cleanup } = await start();
    try {
      const res = await put(keyUrl(server.url), { key: KEY });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; provider: string; configured: boolean };
      assert.deepEqual(body, { ok: true, provider: 'syncprobe', configured: true });
      // 4. the key is never echoed back.
      assert.ok(!JSON.stringify(body).includes(KEY), 'response must not contain the key');
    } finally {
      await cleanup();
    }
  });

  test('2. a wrong token is rejected', async () => {
    const { server, cleanup } = await start();
    try {
      const noAuth = await put(keyUrl(server.url), { key: KEY }, {});
      assert.equal(noAuth.status, 401);
      const wrong = await put(keyUrl(server.url), { key: KEY }, { authorization: 'Bearer nope' });
      assert.equal(wrong.status, 401);
    } finally {
      await cleanup();
    }
  });

  test('3. an unknown provider is rejected', async () => {
    const { server, cleanup } = await start();
    try {
      const res = await put(keyUrl(server.url, 'nope'), { key: KEY });
      assert.equal(res.status, 404);
    } finally {
      await cleanup();
    }
  });

  test('5. after sync /healthz reports the provider as active', async () => {
    const { server, cleanup } = await start();
    try {
      assert.deepEqual(await healthProviders(server.url), [], 'provider starts dropped');
      await put(keyUrl(server.url), { key: KEY });
      assert.ok((await healthProviders(server.url)).includes('syncprobe'));
    } finally {
      await cleanup();
    }
  });

  test('6. the key is not written to disk', async () => {
    const { server, path, cleanup } = await start();
    try {
      const before = await readFile(path, 'utf8');
      await put(keyUrl(server.url), { key: KEY });
      const after = await readFile(path, 'utf8');
      assert.equal(after, before, 'registry file must be unchanged');
      assert.ok(!after.includes(KEY), 'key must not appear on disk');
    } finally {
      await cleanup();
    }
  });

  test('7. a Router bound to 0.0.0.0 rejects key sync', async () => {
    const { server, cleanup } = await start({ host: '0.0.0.0' });
    try {
      const res = await put(keyUrl(server.url), { key: KEY });
      assert.equal(res.status, 403);
    } finally {
      await cleanup();
    }
  });

  test('8. a missing key body is rejected', async () => {
    const { server, cleanup } = await start();
    try {
      assert.equal((await put(keyUrl(server.url), {})).status, 400);
      assert.equal((await put(keyUrl(server.url), { key: '' })).status, 400);
    } finally {
      await cleanup();
    }
  });

  test('4b. the key is never logged', async () => {
    const { server, cleanup } = await start();
    const logged: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
    console.warn = (...a: unknown[]) => { logged.push(a.join(' ')); };
    try {
      await put(keyUrl(server.url), { key: KEY });
      assert.ok(!logged.join('\n').includes(KEY), 'key must not be logged');
    } finally {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
      await cleanup();
    }
  });
});
