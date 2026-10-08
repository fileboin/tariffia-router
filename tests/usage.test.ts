import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { UsageMeter } from '../src/core/usage.js';
import { handleRequest } from '../src/core/gateway.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { QuotaLedger, MemoryStorage } from '../src/core/ledger.js';
import {
  FIXTURE_ENV,
  errorResponse,
  fakeFetch,
  fixtureProviders,
  okChat,
  readAll,
} from './helpers.js';

const sample = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/* -------------------------------------------------------------------------- */
/* UsageMeter                                                                 */
/* -------------------------------------------------------------------------- */

describe('UsageMeter — accounting', () => {
  test('empty state', () => {
    const meter = new UsageMeter(() => 0);
    const snap = meter.snapshot();
    assert.deepEqual(snap.lifetime.totals, {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
    assert.deepEqual(snap.lifetime.providers, []);
    assert.equal(snap.today.totals.requests, 0);
  });

  test('one record', () => {
    const meter = new UsageMeter(() => 0);
    meter.record('openai', 'gpt-4o-mini', sample, 0.01);
    const snap = meter.snapshot();
    assert.equal(snap.lifetime.totals.requests, 1);
    assert.equal(snap.lifetime.totals.inputTokens, 10);
    assert.equal(snap.lifetime.totals.outputTokens, 5);
    assert.equal(snap.lifetime.totals.totalTokens, 15);
    assert.equal(snap.lifetime.totals.costUsd, 0.01);
    const provider = snap.lifetime.providers[0]!;
    assert.equal(provider.provider, 'openai');
    assert.equal(provider.models[0]!.model, 'openai/gpt-4o-mini');
    assert.equal(provider.models[0]!.totalTokens, 15);
  });

  test('same provider/model aggregates', () => {
    const meter = new UsageMeter(() => 0);
    meter.record('openai', 'gpt-4o-mini', sample, 0.01);
    meter.record('openai', 'gpt-4o-mini', sample, 0.02);
    const snap = meter.snapshot();
    assert.equal(snap.lifetime.totals.requests, 2);
    assert.equal(snap.lifetime.totals.totalTokens, 30);
    assert.equal(snap.lifetime.totals.costUsd, 0.03);
    assert.equal(snap.lifetime.providers.length, 1);
    assert.equal(snap.lifetime.providers[0]!.models.length, 1);
  });

  test('multiple providers and models: global + provider totals, deterministic order', () => {
    const meter = new UsageMeter(() => 0);
    meter.record('openai', 'gpt-4o-mini', sample, 0.01);
    meter.record('openai', 'gpt-4o', { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, 0.02);
    meter.record('deepinfra', 'qwen', { inputTokens: 4, outputTokens: 5, totalTokens: 9 }, 0.03);

    const snap = meter.snapshot();
    assert.equal(snap.lifetime.totals.requests, 3);
    assert.equal(snap.lifetime.totals.totalTokens, 27);
    assert.deepEqual(snap.lifetime.providers.map((p) => p.provider), ['deepinfra', 'openai']);
    const openai = snap.lifetime.providers.find((p) => p.provider === 'openai');
    assert.ok(openai);
    assert.equal(openai.requests, 2);
    assert.deepEqual(openai.models.map((m) => m.model), ['openai/gpt-4o', 'openai/gpt-4o-mini']);
    assert.equal(snap.lifetime.providers[0]!.provider, 'deepinfra');
  });

  test('free model keeps cost at 0 while still counting tokens', () => {
    const meter = new UsageMeter(() => 0);
    meter.record('ollama', 'llama3.2', sample, 0);
    const snap = meter.snapshot();
    assert.equal(snap.lifetime.totals.costUsd, 0);
    assert.equal(snap.lifetime.totals.totalTokens, 15);
    assert.equal(snap.lifetime.totals.requests, 1);
  });

  test('UTC day rollover resets today only; lifetime persists', () => {
    let t = Date.parse('2026-01-01T23:00:00Z');
    const meter = new UsageMeter(() => t);
    meter.record('openai', 'gpt-4o-mini', sample, 0.01);
    t = Date.parse('2026-01-02T01:00:00Z');
    meter.record('openai', 'gpt-4o-mini', sample, 0.01);
    const snap = meter.snapshot();
    assert.equal(snap.day, '2026-01-02');
    assert.equal(snap.lifetime.totals.requests, 2);
    assert.equal(snap.today.totals.requests, 1);
  });

  test('bounded state: many requests, no per-request history', () => {
    const meter = new UsageMeter(() => 0);
    for (let i = 0; i < 1000; i++) meter.record('openai', 'gpt-4o-mini', sample, 0.001);
    const snap = meter.snapshot();
    assert.equal(snap.lifetime.totals.requests, 1000);
    assert.equal(snap.lifetime.providers.length, 1);
    assert.equal(snap.lifetime.providers[0]!.models.length, 1);
    const text = JSON.stringify(snap);
    assert.equal(text.includes('"recent"'), false);
    assert.equal(text.includes('"recentTokens"'), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Gateway GET /v1/usage                                                      */
/* -------------------------------------------------------------------------- */

describe('gateway — GET /v1/usage', () => {
  function build(usage?: UsageMeter) {
    const { fetch } = fakeFetch(() => okChat('hi'));
    const mesh = new InferenceMesh({
      registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
      fetchImpl: fetch,
      ledger: new QuotaLedger(new MemoryStorage(), () => 0),
    });
    return (req: Request) =>
      handleRequest(req, { mesh, tokens: new Set(['secret']), ...(usage ? { usage } : {}) });
  }

  const get = (headers: Record<string, string> = {}) =>
    new Request('http://localhost/v1/usage', { headers });

  test('requires auth', async () => {
    const res = await build(new UsageMeter(() => 0))(get());
    assert.equal(res.status, 401);
  });

  test('404 when usage accounting is not enabled', async () => {
    const res = await build()(get({ authorization: 'Bearer secret' }));
    assert.equal(res.status, 404);
  });

  test('authenticated returns the bounded shape', async () => {
    const meter = new UsageMeter(() => 0);
    meter.record('openai', 'gpt-4o-mini', sample, 0.01);
    const res = await build(meter)(get({ authorization: 'Bearer secret' }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      since: string;
      day: string;
      lifetime: { totals: { totalTokens: number }; providers: unknown[] };
      today: { totals: { requests: number } };
    };
    assert.equal(typeof body.since, 'string');
    assert.equal(typeof body.day, 'string');
    assert.equal(body.lifetime.totals.totalTokens, 15);
    assert.equal(body.today.totals.requests, 1);
    assert.ok(Array.isArray(body.lifetime.providers));
  });

  test('empty state works', async () => {
    const res = await build(new UsageMeter(() => 0))(get({ authorization: 'Bearer secret' }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      lifetime: { totals: { requests: number }; providers: unknown[] };
    };
    assert.equal(body.lifetime.totals.requests, 0);
    assert.deepEqual(body.lifetime.providers, []);
  });

  test('response carries no raw arrays and no secret-looking fields', async () => {
    const meter = new UsageMeter(() => 0);
    meter.record('openai', 'gpt-4o-mini', sample, 0.01);
    const res = await build(meter)(get({ authorization: 'Bearer secret' }));
    const text = JSON.stringify(await res.json());
    assert.equal(text.includes('recent'), false);
    assert.equal(text.includes('recentTokens'), false);
    assert.equal(text.includes('apiKey'), false);
    assert.equal(text.includes('Authorization'), false);
    assert.equal(text.includes('Bearer'), false);
    assert.equal(text.includes('sk-'), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Mesh integration                                                           */
/* -------------------------------------------------------------------------- */

function meshWith(fetchImpl: ReturnType<typeof fakeFetch>['fetch'], usage: UsageMeter): InferenceMesh {
  return new InferenceMesh({
    registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
    fetchImpl,
    maxPricePerMTok: 100,
    ledger: new QuotaLedger(new MemoryStorage(), () => 0),
    usage,
  });
}

function sse(includeUsage: boolean): Response {
  const chunks = [
    'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    includeUsage
      ? 'data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
      : '',
    'data: [DONE]\n\n',
  ].join('');
  return new Response(chunks, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const req = { model: 'mesh/free', messages: [{ role: 'user' as const, content: 'x' }] };

describe('mesh — usage accounting', () => {
  test('successful non-streaming records tokens (free -> cost 0)', async () => {
    const meter = new UsageMeter(() => 0);
    const { fetch } = fakeFetch(() => okChat('hi', { prompt: 10, completion: 5 }));
    await meshWith(fetch, meter).chat(req);
    const snap = meter.snapshot();
    assert.equal(snap.lifetime.totals.requests, 1);
    assert.equal(snap.lifetime.totals.inputTokens, 10);
    assert.equal(snap.lifetime.totals.outputTokens, 5);
    assert.equal(snap.lifetime.totals.totalTokens, 15);
    assert.equal(snap.lifetime.totals.costUsd, 0);
  });

  test('cost is aggregated for a paid model', async () => {
    const meter = new UsageMeter(() => 0);
    const { fetch } = fakeFetch(() => okChat('hi', { prompt: 10, completion: 5 }));
    await meshWith(fetch, meter).chat({
      model: 'paid/paid-pro',
      messages: [{ role: 'user', content: 'x' }],
    });
    const snap = meter.snapshot();
    assert.equal(snap.lifetime.totals.requests, 1);
    // (10/1e6)*3 + (5/1e6)*15 = 0.000105
    assert.ok(Math.abs(snap.lifetime.totals.costUsd - 0.000105) < 1e-12);
    assert.equal(snap.lifetime.providers[0]!.provider, 'paid');
    assert.equal(snap.lifetime.providers[0]!.models[0]!.model, 'paid/paid-pro');
  });

  test('missing usage records nothing', async () => {
    const meter = new UsageMeter(() => 0);
    const noUsage = new Response(
      JSON.stringify({
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const { fetch } = fakeFetch(() => noUsage);
    await meshWith(fetch, meter).chat(req);
    assert.equal(meter.snapshot().lifetime.totals.requests, 0);
  });

  test('a failed attempt records nothing', async () => {
    const meter = new UsageMeter(() => 0);
    const { fetch } = fakeFetch(() => errorResponse(500, 'boom'));
    await assert.rejects(() => meshWith(fetch, meter).chat(req));
    assert.equal(meter.snapshot().lifetime.totals.requests, 0);
  });

  test('fallback records only the winning successful attempt', async () => {
    const meter = new UsageMeter(() => 0);
    const { fetch } = fakeFetch((_call, n) => (n === 1 ? errorResponse(500, 'first fails') : okChat('hi')));
    await meshWith(fetch, meter).chat(req);
    assert.equal(meter.snapshot().lifetime.totals.requests, 1);
  });

  test('streaming with usage records correctly', async () => {
    const meter = new UsageMeter(() => 0);
    const { fetch } = fakeFetch(() => sse(true));
    const { stream } = await meshWith(fetch, meter).stream({ ...req, stream: true });
    await readAll(stream);
    const snap = meter.snapshot();
    assert.equal(snap.lifetime.totals.requests, 1);
    assert.equal(snap.lifetime.totals.totalTokens, 15);
  });

  test('streaming without usage records nothing', async () => {
    const meter = new UsageMeter(() => 0);
    const { fetch } = fakeFetch(() => sse(false));
    const { stream } = await meshWith(fetch, meter).stream({ ...req, stream: true });
    await readAll(stream);
    assert.equal(meter.snapshot().lifetime.totals.requests, 0);
  });

  test('an aborted stream does not invent usage', async () => {
    const meter = new UsageMeter(() => 0);
    const encoder = new TextEncoder();
    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        // One chunk, then the source stays open so flush never runs unless it ends.
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'),
        );
      },
    });
    const { fetch } = fakeFetch(() => new Response(open, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const { stream } = await meshWith(fetch, meter).stream({ ...req, stream: true });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(meter.snapshot().lifetime.totals.requests, 0);
  });
});
