import { strict as assert } from 'node:assert';
import { test, describe, after } from 'node:test';
import { createServer, type Server } from 'node:http';

import { discoverOllama, parseInstalledModels, compareToRegistry, OllamaUnreachableError } from '../src/ollama-discovery.js';
import { Registry } from '../src/core/registry.js';
import type { ProviderConfig } from '../src/core/types.js';

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

const registry = () => new Registry([OLLAMA], { env: {} });

/** A tiny mock Ollama HTTP server. */
async function mockOllama(handler: (req: { url?: string }) => { status: number; body: string }): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const { status, body } = handler({ url: req.url });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(servers.map((c) => c()));
});

describe('Ollama discovery', () => {
  test('Ollama returns installed models', async () => {
    const s = await mockOllama(() => ({
      status: 200,
      body: JSON.stringify({ version: '0.3.0', models: [{ name: 'llama3.2:latest' }, { name: 'mistral:7b' }] }),
    }));
    servers.push(s.close);
    const result = await discoverOllama(registry(), { baseUrl: s.url });
    assert.deepEqual(result.installed, ['llama3.2:latest', 'mistral:7b']);
    assert.equal(result.version, '0.3.0');
  });

  test('a matching registry model is detected as installed', async () => {
    const s = await mockOllama(() => ({
      status: 200,
      body: JSON.stringify({ models: [{ name: 'llama3.2' }, { name: 'qwen2.5-coder:7b' }] }),
    }));
    servers.push(s.close);
    const result = await discoverOllama(registry(), { baseUrl: s.url });
    const byKey = Object.fromEntries(result.models.map((m) => [m.key, m.installed]));
    assert.equal(byKey['ollama/llama3.2'], true);
    assert.equal(byKey['ollama/qwen2.5-coder:7b'], true);
  });

  test('an uninstalled registry model is reported as unavailable', async () => {
    const s = await mockOllama(() => ({ status: 200, body: JSON.stringify({ models: [{ name: 'llama3.2' }] }) }));
    servers.push(s.close);
    const result = await discoverOllama(registry(), { baseUrl: s.url });
    const coder = result.models.find((m) => m.key === 'ollama/qwen2.5-coder:7b');
    assert.equal(coder?.installed, false);
  });

  test('a ":latest" install still counts for an untagged registry id', async () => {
    const s = await mockOllama(() => ({ status: 200, body: JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }) }));
    servers.push(s.close);
    const result = await discoverOllama(registry(), { baseUrl: s.url });
    assert.equal(result.models.find((m) => m.key === 'ollama/llama3.2')?.installed, true);
  });

  test('Ollama unreachable fails clearly', async () => {
    // A port with nothing listening.
    await assert.rejects(
      () => discoverOllama(registry(), { baseUrl: 'http://127.0.0.1:9' }),
      (err: unknown) => {
        assert.ok(err instanceof OllamaUnreachableError);
        assert.match((err as Error).message, /cannot reach Ollama/);
        return true;
      },
    );
  });

  test('a non-2xx Ollama answer fails clearly', async () => {
    const s = await mockOllama(() => ({ status: 500, body: '{}' }));
    servers.push(s.close);
    await assert.rejects(() => discoverOllama(registry(), { baseUrl: s.url }), /answered 500/);
  });

  test('discovery never changes registry data', async () => {
    const reg = registry();
    const before = JSON.stringify(reg.providers);
    const beforeCandidates = reg.candidates.map((c) => c.key);
    const s = await mockOllama(() => ({ status: 200, body: JSON.stringify({ models: [{ name: 'something-else:1b' }] }) }));
    servers.push(s.close);
    await discoverOllama(reg, { baseUrl: s.url });
    assert.equal(JSON.stringify(reg.providers), before, 'providers unchanged');
    assert.deepEqual(reg.candidates.map((c) => c.key), beforeCandidates, 'candidates unchanged');
  });

  test('parseInstalledModels handles the model alias field', () => {
    assert.deepEqual(parseInstalledModels({ models: [{ model: 'a:1b' }, { name: 'b:2b' }] }), ['a:1b', 'b:2b']);
    assert.deepEqual(parseInstalledModels({}), []);
  });

  test('compareToRegistry returns [] for an unknown provider', () => {
    assert.deepEqual(compareToRegistry(['x'], registry(), 'nope'), []);
  });
});
