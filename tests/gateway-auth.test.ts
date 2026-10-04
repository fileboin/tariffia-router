import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { handleRequest } from '../src/core/gateway.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { FIXTURE_ENV, fakeFetch, fixtureProviders, okChat } from './helpers.js';

function gateway(tokens = new Set(['secret'])) {
  const { fetch } = fakeFetch(() => okChat('hi'));
  const mesh = new InferenceMesh({
    registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
    fetchImpl: fetch,
  });
  return (req: Request) => handleRequest(req, { mesh, tokens });
}

const anthropicBody = JSON.stringify({
  model: 'claude-sonnet-5-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'x' }],
});
const openAiBody = JSON.stringify({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });

function messages(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: anthropicBody,
  });
}
function chat(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: openAiBody,
  });
}

describe('gateway auth — Anthropic x-api-key compatibility', () => {
  test('valid Authorization: Bearer is accepted (OpenAI path unchanged)', async () => {
    const res = await gateway()(chat({ authorization: 'Bearer secret' }));
    assert.equal(res.status, 200);
  });

  test('valid x-api-key is accepted on /v1/messages (Anthropic path)', async () => {
    const res = await gateway()(messages({ 'x-api-key': 'secret' }));
    assert.equal(res.status, 200);
  });

  test('invalid x-api-key means 401', async () => {
    const res = await gateway()(messages({ 'x-api-key': 'nope' }));
    assert.equal(res.status, 401);
  });

  test('no credentials means 401', async () => {
    const res = await gateway()(messages());
    assert.equal(res.status, 401);
  });

  test('an invalid Authorization is NOT rescued by a valid x-api-key', async () => {
    const res = await gateway()(messages({ authorization: 'Bearer nope', 'x-api-key': 'secret' }));
    assert.equal(res.status, 401);
  });

  test('an empty token set rejects both headers (fail-closed)', async () => {
    const g = gateway(new Set());
    assert.equal((await g(chat({ authorization: 'Bearer secret' }))).status, 401);
    assert.equal((await g(messages({ 'x-api-key': 'secret' }))).status, 401);
  });

  test('Authorization still takes precedence when both are valid', async () => {
    // Both valid: Authorization is used first and accepted.
    const res = await gateway()(messages({ authorization: 'Bearer secret', 'x-api-key': 'secret' }));
    assert.equal(res.status, 200);
  });

  test('a malformed Authorization (no Bearer) means 401 even with x-api-key', async () => {
    const res = await gateway()(messages({ authorization: 'Basic secret', 'x-api-key': 'secret' }));
    assert.equal(res.status, 401);
  });

  test('the Bearer path is unchanged when both routes are used', async () => {
    // OpenAI clients send Bearer; Anthropic clients send x-api-key. Both work;
    // the Bearer path is untouched by adding the fallback.
    assert.equal((await gateway()(chat({ authorization: 'Bearer secret' }))).status, 200);
    assert.equal((await gateway()(chat({ authorization: 'Bearer nope' }))).status, 401);
  });
});
