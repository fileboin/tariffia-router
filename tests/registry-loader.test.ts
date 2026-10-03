import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRegistry, DEFAULT_REGISTRY_PATH } from '../src/registry-loader.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { NoCandidateError, type ProviderConfig } from '../src/core/types.js';
import { fakeFetch, okChat } from './helpers.js';

async function tempRegistry(contents: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'tariffia-reg-'));
  const path = join(dir, 'registry.json');
  await writeFile(path, contents, 'utf8');
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const VALID_OLLAMA = JSON.stringify({
  providers: [
    {
      id: 'ollama',
      kind: 'openai-compat',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: 'OLLAMA_API_KEY',
      apiKeyOptional: true,
      maxPrivacy: 'highly_confidential',
      models: [
        { id: 'local-7b', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 0, outPerMTok: 0 } },
      ],
    },
  ],
});

describe('runtime registry loader', () => {
  test('the shipped Ollama registry loads', async () => {
    const registry = await loadRegistry();
    assert.equal(registry.providers.length, 1);
    assert.equal(registry.providers[0]?.id, 'ollama');
    assert.ok(registry.candidates.length > 0);
  });

  test('DEFAULT_REGISTRY_PATH points at the shipped file', () => {
    assert.match(DEFAULT_REGISTRY_PATH, /registry[/\\]ollama\.json$/);
  });

  test('OLLAMA_API_KEY stays optional: loads with an empty environment', async () => {
    const registry = await loadRegistry({ env: {} });
    assert.equal(registry.providers.length, 1);
    assert.equal(registry.apiKey('ollama'), '');
  });

  test('a missing file fails closed', async () => {
    await assert.rejects(() => loadRegistry({ path: '/nonexistent/registry.json' }), /cannot read registry/);
  });

  test('malformed JSON fails closed', async () => {
    const { path, cleanup } = await tempRegistry('{ not json');
    try {
      await assert.rejects(() => loadRegistry({ path }), /not valid JSON/);
    } finally {
      await cleanup();
    }
  });

  test('invalid registry data fails closed (no silent fallback)', async () => {
    const { path, cleanup } = await tempRegistry(JSON.stringify({ providers: [{ id: 'x' }] }));
    try {
      await assert.rejects(() => loadRegistry({ path }), /registry:/);
    } finally {
      await cleanup();
    }
  });

  test('loaded Ollama provider/model data reaches the router and serves a request', async () => {
    const registry = await loadRegistry({ env: {} });
    const { fetch, calls } = fakeFetch(() => okChat('local ok'));
    const mesh = new InferenceMesh({ registry, fetchImpl: fetch, enforceFreeOnly: true });
    const res = await mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(res.mesh?.served_by.startsWith('ollama/'), 'routes to a loaded Ollama model');
    assert.ok(calls[0]?.url.startsWith('http://127.0.0.1:11434/v1/'));
  });

  test('FREE_ONLY still rejects an explicitly paid model from a loaded registry', async () => {
    const { path, cleanup } = await tempRegistry(
      JSON.stringify({
        providers: [
          {
            id: 'ollama',
            kind: 'openai-compat',
            baseUrl: 'http://127.0.0.1:11434/v1',
            apiKeyEnv: 'OLLAMA_API_KEY',
            apiKeyOptional: true,
            maxPrivacy: 'internal',
            models: [
              {
                id: 'paid-local',
                capabilities: ['text'],
                contextWindow: 8192,
                price: { inPerMTok: 1, outPerMTok: 1 },
                priceVerifiedAt: '2026-10-01',
              },
            ],
          } as ProviderConfig,
        ],
      }),
    );
    try {
      const registry = await loadRegistry({ path, env: {} });
      const { fetch, calls } = fakeFetch(() => okChat('ok'));
      const mesh = new InferenceMesh({ registry, fetchImpl: fetch, enforceFreeOnly: true });
      await assert.rejects(
        () => mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] }),
        (err: unknown) => err instanceof NoCandidateError,
      );
      assert.equal(calls.length, 0);
    } finally {
      await cleanup();
    }
  });
});
