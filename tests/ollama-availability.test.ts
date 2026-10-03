import { strict as assert } from 'node:assert';
import { test, describe, after } from 'node:test';
import { createServer, type Server } from 'node:http';

import { applyOllamaAvailability, registryWithOllamaAvailability } from '../src/ollama-availability.js';
import { OllamaUnreachableError } from '../src/ollama-discovery.js';
import { Registry } from '../src/core/registry.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { NoCandidateError, type ProviderConfig } from '../src/core/types.js';
import { fakeFetch, okChat } from './helpers.js';

const OLLAMA: ProviderConfig = {
  id: 'ollama',
  kind: 'openai-compat',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKeyEnv: 'OLLAMA_API_KEY',
  apiKeyOptional: true,
  maxPrivacy: 'internal',
  models: [
    { id: 'llama3.2', capabilities: ['text'], contextWindow: 131072, price: { inPerMTok: 0, outPerMTok: 0 } },
    { id: 'qwen2.5-coder:7b', capabilities: ['text'], contextWindow: 32768, price: { inPerMTok: 0, outPerMTok: 0 } },
  ],
} as unknown as ProviderConfig;

const OPENAI: ProviderConfig = {
  id: 'openai-compat',
  kind: 'openai-compat',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'EXAMPLE_API_KEY',
  maxPrivacy: 'internal',
  models: [{ id: 'cloud-model', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 0, outPerMTok: 0 } }],
} as unknown as ProviderConfig;

const registry = (providers: ProviderConfig[] = [OLLAMA, OPENAI]) =>
  new Registry(providers, { env: { EXAMPLE_API_KEY: 'k' } });

async function mockOllama(body: string, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

const servers: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(servers.map((c) => c()));
});

describe('Ollama availability filter', () => {
  test('an installed Ollama model remains routable', async () => {
    const filtered = applyOllamaAvailability(registry(), ['llama3.2'], "ollama", { EXAMPLE_API_KEY: "k" });
    assert.ok(filtered.candidates.some((c) => c.key === 'ollama/llama3.2'));
  });

  test('an uninstalled Ollama model is excluded', async () => {
    const filtered = applyOllamaAvailability(registry(), ['llama3.2'], "ollama", { EXAMPLE_API_KEY: "k" });
    assert.ok(!filtered.candidates.some((c) => c.key === 'ollama/qwen2.5-coder:7b'), 'coder excluded');
  });

  test('an unavailable Ollama model is never called', async () => {
    const filtered = applyOllamaAvailability(registry(), ['llama3.2'], "ollama", { EXAMPLE_API_KEY: "k" });
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    // Only llama3.2 is installed, so the request must go there, never to the coder model.
    const mesh = new InferenceMesh({ registry: filtered, fetchImpl: fetch });
    const res = await mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.mesh?.served_by, 'ollama/llama3.2');
    assert.ok(!calls.some((c) => (c.body as { model?: string })?.model === 'qwen2.5-coder:7b'));
  });

  test('with no Ollama model installed, a request does not silently leave Ollama', async () => {
    // Only Ollama is configured; filtering all its models leaves nothing, and
    // the router reports no candidate rather than reaching for a paid provider.
    const filtered = applyOllamaAvailability(registry([OLLAMA]), [], 'ollama', { EXAMPLE_API_KEY: 'k' });
    assert.equal(filtered.candidates.length, 0);
    const { fetch } = fakeFetch(() => okChat('ok'));
    const mesh = new InferenceMesh({ registry: filtered, fetchImpl: fetch, enforceFreeOnly: true });
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => err instanceof NoCandidateError,
    );
  });

  test('Ollama unreachable fails clearly (registryWithOllamaAvailability)', async () => {
    await assert.rejects(
      () => registryWithOllamaAvailability({ registry: registry(), baseUrl: 'http://127.0.0.1:9' }),
      (err: unknown) => {
        assert.ok(err instanceof OllamaUnreachableError);
        assert.match((err as Error).message, /cannot reach Ollama/);
        return true;
      },
    );
  });

  test('non-Ollama providers are unaffected', async () => {
    const before = registry();
    const filtered = applyOllamaAvailability(before, ['llama3.2'], 'ollama', { EXAMPLE_API_KEY: 'k' });
    assert.ok(filtered.candidates.some((c) => c.key === 'openai-compat/cloud-model'), 'cloud model kept');
    assert.equal(filtered.candidates.filter((c) => c.key.startsWith('openai-compat/')).length, 1);
  });

  test('the filter does not mutate the source registry', () => {
    const before = registry();
    const keysBefore = before.candidates.map((c) => c.key).sort();
    applyOllamaAvailability(before, ['llama3.2'], 'ollama', { EXAMPLE_API_KEY: 'k' });
    assert.deepEqual(before.candidates.map((c) => c.key).sort(), keysBefore, 'source unchanged');
    assert.ok(before.candidates.some((c) => c.key === 'ollama/qwen2.5-coder:7b'), 'coder still present in source');
  });

  test('FREE_ONLY behavior remains unchanged after filtering', async () => {
    // An explicitly paid Ollama model, installed, must still be blocked by FREE_ONLY.
    const paidRegistry = new Registry(
      [
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
      { env: {} },
    );
    const filtered = applyOllamaAvailability(paidRegistry, ['paid-local']);
    assert.ok(filtered.candidates.some((c) => c.key === 'ollama/paid-local'), 'installed paid model kept');
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = new InferenceMesh({ registry: filtered, fetchImpl: fetch, enforceFreeOnly: true });
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => err instanceof NoCandidateError,
    );
    assert.equal(calls.length, 0, 'the paid model was never called');
  });

  test('registryWithOllamaAvailability filters via a mock Ollama server', async () => {
    const s = await mockOllama(JSON.stringify({ models: [{ name: 'llama3.2' }] }));
    servers.push(s.close);
    const filtered = await registryWithOllamaAvailability({ registry: registry(), baseUrl: s.url, env: { EXAMPLE_API_KEY: 'k' } });
    assert.ok(filtered.candidates.some((c) => c.key === 'ollama/llama3.2'));
    assert.ok(!filtered.candidates.some((c) => c.key === 'ollama/qwen2.5-coder:7b'));
    assert.ok(filtered.candidates.some((c) => c.key === 'openai-compat/cloud-model'));
  });
});
