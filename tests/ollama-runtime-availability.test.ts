import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { handleRequest } from '../src/core/gateway.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { NoCandidateError, type ProviderConfig } from '../src/core/types.js';
import { fakeFetch, okChat } from './helpers.js';

function providers(): ProviderConfig[] {
  return ['ollama', 'other'].map((id) => ({
    id,
    kind: 'openai-compat',
    baseUrl: `https://${id}.test/v1`,
    apiKeyEnv: `${id.toUpperCase()}_KEY`,
    apiKeyOptional: true,
    maxPrivacy: 'public',
    models: [
      {
        id: `${id}-model`,
        capabilities: ['text'],
        contextWindow: 8192,
        price: { inPerMTok: 0, outPerMTok: 0 },
      },
    ],
  }));
}

function makeMesh() {
  const { fetch, calls } = fakeFetch(() => okChat('ok'));
  const mesh = new InferenceMesh({ registry: new Registry(providers(), { env: {} }), fetchImpl: fetch });
  return { mesh, calls };
}

async function chat(mesh: InferenceMesh, model: string) {
  return mesh.chat({ model, messages: [{ role: 'user', content: 'ping' }] });
}

function availabilityRequest(
  body: unknown,
  headers: Record<string, string> = { authorization: 'Bearer router-token' },
): Request {
  return new Request('http://127.0.0.1:8910/internal/runtime/ollama-availability', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function gateway(mesh: InferenceMesh, keySync = true) {
  return (request: Request) => handleRequest(request, { mesh, tokens: new Set(['router-token']), keySync });
}

describe('Ollama runtime availability gate', () => {
  test('Ollama is unavailable by default and rejected before provider execution', async () => {
    const { mesh, calls } = makeMesh();
    await assert.rejects(chat(mesh, 'ollama/ollama-model'), (error: unknown) => {
      assert.ok(error instanceof NoCandidateError);
      assert.equal(error.code, 'no_candidate');
      assert.ok(error.rejected.some((r) => r.key === 'ollama/ollama-model' && r.reason.includes('tunnel unavailable')));
      return true;
    });
    assert.equal(calls.length, 0);
  });

  test('Ollama can be enabled, disabled again, and re-enabled without mesh reinitialization', async () => {
    const { mesh, calls } = makeMesh();

    mesh.setOllamaAvailable(true);
    await chat(mesh, 'ollama/ollama-model');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://ollama.test/v1/chat/completions');

    mesh.setOllamaAvailable(false);
    await assert.rejects(chat(mesh, 'ollama/ollama-model'), (error: unknown) => error instanceof NoCandidateError);
    assert.equal(calls.length, 1);

    mesh.setOllamaAvailable(true);
    await chat(mesh, 'ollama/ollama-model');
    assert.equal(calls.length, 2);
  });

  test('non-Ollama providers remain routable while Ollama is unavailable', async () => {
    const { mesh, calls } = makeMesh();
    await chat(mesh, 'other/other-model');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://other.test/v1/chat/completions');
  });

  test('new mesh initialization resets Ollama availability to unavailable', async () => {
    const first = makeMesh();
    first.mesh.setOllamaAvailable(true);
    await chat(first.mesh, 'ollama/ollama-model');

    const restarted = makeMesh();
    await assert.rejects(chat(restarted.mesh, 'ollama/ollama-model'), (error: unknown) => error instanceof NoCandidateError);
    assert.equal(restarted.calls.length, 0);
  });
});

describe('Ollama runtime availability control endpoint', () => {
  test('requires the existing Router authentication', async () => {
    const { mesh } = makeMesh();
    const response = await gateway(mesh)(availabilityRequest({ available: true }, {}));
    assert.equal(response.status, 401);
    await assert.rejects(chat(mesh, 'ollama/ollama-model'), (error: unknown) => error instanceof NoCandidateError);
  });

  test('is forbidden when loopback-only runtime control is disabled', async () => {
    const { mesh } = makeMesh();
    const response = await gateway(mesh, false)(availabilityRequest({ available: true }));
    assert.equal(response.status, 403);
    await assert.rejects(chat(mesh, 'ollama/ollama-model'), (error: unknown) => error instanceof NoCandidateError);
  });

  test('accepts only an availability boolean and toggles only Ollama', async () => {
    const { mesh, calls } = makeMesh();
    const send = gateway(mesh);

    const enabled = await send(availabilityRequest({ available: true }));
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { ok: true, provider: 'ollama', available: true });
    await chat(mesh, 'ollama/ollama-model');
    await chat(mesh, 'other/other-model');
    assert.equal(calls.length, 2);

    const disabled = await send(availabilityRequest({ available: false }));
    assert.equal(disabled.status, 200);
    await assert.rejects(chat(mesh, 'ollama/ollama-model'), (error: unknown) => error instanceof NoCandidateError);
    await chat(mesh, 'other/other-model');
    assert.equal(calls.length, 3);

    const invalid = await send(availabilityRequest({ available: true, key: 'must-not-be-accepted' }));
    assert.equal(invalid.status, 400);
  });
});
