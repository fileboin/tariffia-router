import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRegistryFile } from '../src/core/config.js';
import { Registry, isFree } from '../src/core/registry.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { NoCandidateError, type ProviderConfig } from '../src/core/types.js';
import { fakeFetch, okChat } from './helpers.js';

const REGISTRY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../registry');

async function load(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(REGISTRY_DIR, name), 'utf8'));
}

describe('Tariffia-owned provider registry', () => {
  test('registry/ollama.json loads and validates', async () => {
    const raw = await load('ollama.json');
    const validated = validateRegistryFile(raw);
    assert.deepEqual(
      validated.providers.map((p) => p.id).sort(),
      ['deepinfra', 'ollama', 'openai', 'openrouter'],
    );
    assert.equal(validated.providers[0]?.id, 'ollama');
  });

  test('the Ollama provider uses the documented local configuration', async () => {
    const validated = validateRegistryFile(await load('ollama.json'));
    const p = validated.providers[0]!;
    assert.equal(p.kind, 'openai-compat');
    assert.equal(p.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(p.apiKeyOptional, true, 'Ollama needs no credential');
    assert.equal(p.maxPrivacy, 'highly_confidential', 'local bytes never leave the machine');
  });

  test('the optional-key configuration means it loads with no environment', async () => {
    const validated = validateRegistryFile(await load('ollama.json'));
    const registry = new Registry(validated.providers, { env: {} });
    assert.equal(registry.providers.length, 1, 'loaded despite no OLLAMA_API_KEY');
    assert.equal(registry.apiKey('ollama'), '', 'empty string means no credential is sent');
    assert.ok(registry.candidates.length > 0);
  });

  test('every Ollama model records explicit 0/0 pricing (nothing free by omission)', async () => {
    const validated = validateRegistryFile(await load('ollama.json'));
    for (const m of validated.providers[0]!.models) {
      assert.deepEqual(m.price, { inPerMTok: 0, outPerMTok: 0 });
      assert.equal(isFree(m), true);
    }
  });

  test('example model entries are clearly marked unverified', async () => {
    const validated = validateRegistryFile(await load('ollama.json'));
    for (const m of validated.providers[0]!.models) {
      assert.equal((m as unknown as Record<string, unknown>)['unverified'], true);
      assert.match(m.note ?? '', /EXAMPLE|UNVERIFIED/i);
    }
  });
});

describe('malformed Ollama entries are rejected by the existing contract', () => {
  test('a non-numeric context window is rejected', () => {
    assert.throws(
      () =>
        validateRegistryFile({
          providers: [
            {
              id: 'ollama',
              kind: 'openai-compat',
              baseUrl: 'http://127.0.0.1:11434/v1',
              apiKeyEnv: 'OLLAMA_API_KEY',
              apiKeyOptional: true,
              maxPrivacy: 'internal',
              models: [{ id: 'm', capabilities: ['text'], contextWindow: 'big', price: { inPerMTok: 0, outPerMTok: 0 } }],
            },
          ],
        }),
      /invalid contextWindow/,
    );
  });

  test('a missing price is rejected (never treated as free)', () => {
    assert.throws(
      () =>
        validateRegistryFile({
          providers: [
            {
              id: 'ollama',
              kind: 'openai-compat',
              baseUrl: 'http://127.0.0.1:11434/v1',
              apiKeyEnv: 'OLLAMA_API_KEY',
              apiKeyOptional: true,
              maxPrivacy: 'internal',
              models: [{ id: 'm', capabilities: ['text'], contextWindow: 8192 }],
            },
          ],
        }),
      /invalid price/,
    );
  });
});

describe('FREE_ONLY treats only explicit 0/0 models as free', () => {
  test('a registry with an explicit paid Ollama entry cannot execute under FREE_ONLY', async () => {
    const paid: ProviderConfig = {
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
    } as ProviderConfig;
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = new InferenceMesh({
      registry: new Registry([paid], { env: {} }),
      fetchImpl: fetch,
      enforceFreeOnly: true,
    });
    mesh.setOllamaAvailable(true);
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => err instanceof NoCandidateError,
    );
    assert.equal(calls.length, 0, 'the paid model was never executed');
  });

  test('the shipped Ollama registry routes a request in FREE_ONLY', async () => {
    const validated = validateRegistryFile(await load('ollama.json'));
    const { fetch, calls } = fakeFetch(() => okChat('local ok'));
    const mesh = new InferenceMesh({
      registry: new Registry(validated.providers, { env: {} }),
      fetchImpl: fetch,
      enforceFreeOnly: true,
    });
    mesh.setOllamaAvailable(true);
    const res = await mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(res.mesh?.served_by.startsWith('ollama/'));
    assert.ok(calls[0]?.url.startsWith('http://127.0.0.1:11434/v1/'));
  });
});
