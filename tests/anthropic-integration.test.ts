import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { handleRequest } from '../src/core/gateway.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { QuotaLedger, MemoryStorage } from '../src/core/ledger.js';
import { AnthropicAdapter } from '../src/core/providers/anthropic.js';
import { MeshError, type Candidate, type ProviderConfig } from '../src/core/types.js';
import {
  FIXTURE_ENV,
  fakeClock,
  fakeFetch,
  fixtureProviders,
  okChat,
  readAll,
} from './helpers.js';

const user = { role: 'user' as const, content: 'hello' };

function anthropicMessage(text: string): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-x',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 2, output_tokens: 1 },
  };
}

function anthropicProvider(over: Partial<ProviderConfig> & { id: string; baseUrl: string; apiKeyEnv: string }): ProviderConfig {
  return {
    kind: 'anthropic',
    maxPrivacy: 'internal',
    models: [
      {
        id: 'claude-free',
        capabilities: ['text'],
        contextWindow: 200000,
        price: { inPerMTok: 0, outPerMTok: 0 },
        quality: 0.6,
      },
    ],
    ...over,
  } as ProviderConfig;
}

describe('outbound Anthropic adapter', () => {
  test('translates the request and returns the internal response', async () => {
    const provider = anthropicProvider({ id: 'anth', baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTH_KEY' });
    const candidate: Candidate = { provider, model: provider.models[0]!, key: 'anth/claude-free' };
    const { fetch, calls } = fakeFetch(
      () => new Response(JSON.stringify(anthropicMessage('hi')), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const adapter = new AnthropicAdapter();
    const res = await adapter.chat({
      candidate,
      apiKey: 'sk-test',
      request: { model: 'claude-free', messages: [{ role: 'user', content: 'hello' }] },
      fetchImpl: fetch,
    });
    assert.equal(res.choices[0]?.message.content, 'hi');
    assert.equal(res.usage?.prompt_tokens, 2);
    assert.equal(calls[0]?.url, 'https://api.anthropic.test/v1/messages');
    assert.equal(calls[0]?.headers['x-api-key'], 'sk-test');
    assert.equal(calls[0]?.headers['anthropic-version'], '2023-06-01');
    const sent = calls[0]?.body as { model: string; messages: Array<{ content: unknown }> };
    assert.equal(sent.model, 'claude-free');
    assert.equal(sent.messages[0]?.content, 'hello');
  });
});

describe('inbound POST /v1/messages', () => {
  test('non-streaming: an Anthropic request is served as an Anthropic message', async () => {
    const { fetch } = fakeFetch(() => okChat('hi'));
    const mesh = new InferenceMesh({
      registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
      fetchImpl: fetch,
    });
    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mesh/free', system: 'be nice', max_tokens: 64, messages: [user] }),
    });
    const res = await handleRequest(req, { mesh, tokens: new Set(['secret']) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mesh-served-by'), 'alpha/alpha-free');
    const body = (await res.json()) as {
      type: string;
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };
    assert.equal(body.type, 'message');
    assert.equal(body.content[0]?.text, 'hi');
    assert.equal(body.usage.input_tokens, 10);
    assert.equal(body.usage.output_tokens, 5);
    assert.equal(body.stop_reason, 'end_turn');
  });

  test('streaming: an Anthropic request yields Anthropic SSE events', async () => {
    const openAiSse = [
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"x","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"x","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const { fetch } = fakeFetch(
      () => new Response(openAiSse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const mesh = new InferenceMesh({
      registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
      fetchImpl: fetch,
    });
    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mesh/free', max_tokens: 64, stream: true, messages: [user] }),
    });
    const res = await handleRequest(req, { mesh, tokens: new Set(['secret']) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await readAll(res.body as ReadableStream<Uint8Array>);
    assert.match(text, /event: message_start/);
    assert.match(text, /"type":"text_delta"/);
    assert.match(text, /"text":"Hi"/);
    assert.match(text, /event: message_stop/);
  });
});

describe('FREE_ONLY and Anthropic candidates', () => {
  const free = anthropicProvider({ id: 'free-anth', baseUrl: 'https://free-anth.test', apiKeyEnv: 'FREE_ANTH_KEY' });
  const paid = anthropicProvider({
    id: 'paid-anth',
    baseUrl: 'https://paid-anth.test',
    apiKeyEnv: 'PAID_ANTH_KEY',
    maxPrivacy: 'highly_confidential',
    models: [
      {
        id: 'claude-paid',
        capabilities: ['text'],
        contextWindow: 200000,
        price: { inPerMTok: 3, outPerMTok: 15 },
        quality: 0.99,
        priceVerifiedAt: '2026-10-01',
      },
    ],
  });
  const env = { FREE_ANTH_KEY: 'f', PAID_ANTH_KEY: 'p' };

  test('a paid Anthropic pin cannot execute under FREE_ONLY', async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(JSON.stringify(anthropicMessage('free')), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const mesh = new InferenceMesh({
      registry: new Registry([free, paid], { env }),
      fetchImpl: fetch,
      ledger: new QuotaLedger(new MemoryStorage(), fakeClock().now),
      enforceFreeOnly: true,
    });
    const res = await mesh.chat({ model: 'paid-anth/claude-paid', messages: [user] });
    assert.equal(res.mesh?.served_by, 'free-anth/claude-free');
    assert.ok(!calls.some((c) => c.url.includes('paid-anth.test')), 'paid Anthropic provider must not be called');
  });

  test('with only a paid Anthropic candidate, FREE_ONLY rejects and never calls it', async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(JSON.stringify(anthropicMessage('x')), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const mesh = new InferenceMesh({
      registry: new Registry([paid], { env }),
      fetchImpl: fetch,
      enforceFreeOnly: true,
    });
    await assert.rejects(
      () => mesh.chat({ model: 'paid-anth/claude-paid', messages: [user] }),
      (err: unknown) => err instanceof MeshError,
    );
    assert.equal(calls.length, 0, 'no provider call may happen');
  });
});
