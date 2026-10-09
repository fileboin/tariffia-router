import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { createModeMesh } from '../src/mode-mesh.js';
import { Router } from '../src/core/router.js';
import { Registry } from '../src/core/registry.js';
import { NoCandidateError, type ProviderConfig, type ScoredCandidate } from '../src/core/types.js';
import { errorResponse, fakeFetch, okChat } from './helpers.js';

const user = { role: 'user' as const, content: 'x' };

function provider(
  id: string,
  inPerMTok: number,
  outPerMTok: number,
  capabilities: Array<'text' | 'vision'> = ['text'],
): ProviderConfig {
  return {
    id,
    kind: 'openai-compat',
    baseUrl: `https://${id}.test/v1`,
    apiKeyEnv: `${id.toUpperCase()}_KEY`,
    maxPrivacy: 'internal',
    models: [
      {
        id: 'm',
        capabilities,
        contextWindow: 100_000,
        price: { inPerMTok, outPerMTok },
        ...(inPerMTok > 0 || outPerMTok > 0 ? { priceVerifiedAt: '2026-10-01' } : {}),
      },
    ],
  };
}

function registry(providers: ProviderConfig[]): Registry {
  return new Registry(providers, {
    env: Object.fromEntries(providers.map((p) => [p.apiKeyEnv, 'test-key'])),
  });
}

function build(
  mode: 'FREE_ONLY' | 'FREE_FIRST' | 'BALANCED',
  providers: ProviderConfig[],
  cap: number | undefined,
  responder: Parameters<typeof fakeFetch>[0] = () => okChat('ok'),
) {
  const { fetch, calls } = fakeFetch(responder);
  const mesh = createModeMesh({
    registry: registry(providers),
    mode,
    maxPricePerMTok: cap,
    fetchImpl: fetch,
  });
  return { mesh, calls };
}

const hosts = (calls: Array<{ url: string }>): string[] => calls.map((call) => new URL(call.url).host);
const paidAndFree = [provider('free', 0, 0), provider('paid', 3, 15)];

describe('server-owned price-rate cap', () => {
  test('FREE_ONLY blocks a paid pin even when a cap is configured', async () => {
    const { mesh, calls } = build('FREE_ONLY', paidAndFree, 20);
    const response = await mesh.chat({ model: 'paid/m', messages: [user] });
    assert.equal(response.mesh?.served_by, 'free/m');
    assert.deepEqual(hosts(calls), ['free.test']);
  });

  test('FREE_ONLY blocks paid fallback even when a cap is configured', async () => {
    const { mesh, calls } = build('FREE_ONLY', paidAndFree, 20, () => errorResponse(500, 'down'));
    await assert.rejects(() => mesh.chat({ model: 'mesh/free', messages: [user] }));
    assert.deepEqual(hosts(calls), ['free.test']);
  });

  test('FREE_ONLY remains blocked without a cap', async () => {
    const { mesh, calls } = build('FREE_ONLY', paidAndFree, undefined);
    const response = await mesh.chat({ model: 'paid/m', messages: [user] });
    assert.equal(response.mesh?.served_by, 'free/m');
    assert.deepEqual(hosts(calls), ['free.test']);
  });

  test('FREE_FIRST without a cap never calls paid candidates after free failure', async () => {
    const { mesh, calls } = build('FREE_FIRST', paidAndFree, undefined, () => errorResponse(500, 'down'));
    await assert.rejects(() => mesh.chat({ model: 'mesh/best', messages: [user] }));
    assert.deepEqual(hosts(calls), ['free.test']);
  });

  test('FREE_FIRST preserves free-first ordering and calls only an in-cap paid fallback', async () => {
    const providers = [provider('free-a', 0, 0), provider('free-b', 0, 0), provider('paid', 3, 15)];
    const { mesh, calls } = build(
      'FREE_FIRST',
      providers,
      15,
      (_call, n) => (n <= 2 ? errorResponse(500, 'free unavailable') : okChat('paid response')),
    );
    const response = await mesh.chat({ model: 'mesh/best', messages: [user] });
    assert.equal(response.mesh?.served_by, 'paid/m');
    assert.deepEqual(hosts(calls), ['free-a.test', 'free-b.test', 'paid.test']);
  });

  test('FREE_FIRST omits over-cap paid candidates after free candidates fail', async () => {
    const providers = [
      provider('free-a', 0, 0),
      provider('free-b', 0, 0),
      provider('paid-in-cap', 1, 10),
      provider('paid-over-cap', 1, 11),
    ];
    const { mesh, calls } = build('FREE_FIRST', providers, 10, () => errorResponse(500, 'down'));
    await assert.rejects(() => mesh.chat({ model: 'mesh/best', messages: [user] }));
    assert.deepEqual(hosts(calls), ['free-a.test', 'free-b.test', 'paid-in-cap.test']);
  });

  test('FREE_FIRST paid-only registry without a cap makes no provider call', async () => {
    const { mesh, calls } = build('FREE_FIRST', [provider('paid', 1, 1)], undefined);
    await assert.rejects(() => mesh.chat({ model: 'mesh/best', messages: [user] }), NoCandidateError);
    assert.deepEqual(calls, []);
  });

  test('FREE_FIRST paid-only capability match without a cap is rejected', async () => {
    const providers = [provider('free-text', 0, 0), provider('paid-vision', 1, 1, ['text', 'vision'])];
    const { mesh, calls } = build('FREE_FIRST', providers, undefined);
    await assert.rejects(
      () => mesh.chat({
        model: 'mesh/best',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
      }),
      NoCandidateError,
    );
    assert.deepEqual(calls, []);
  });

  test('FREE_FIRST paid pin without a cap is dropped and never called', async () => {
    const { mesh, calls } = build('FREE_FIRST', paidAndFree, undefined);
    const response = await mesh.chat({ model: 'mesh/best', messages: [user], mesh: { pin: 'paid/m' } });
    assert.equal(response.mesh?.served_by, 'free/m');
    assert.deepEqual(hosts(calls), ['free.test']);
  });

  test('BALANCED removes an over-cap candidate before scoring', async () => {
    const { mesh, calls } = build('BALANCED', paidAndFree, 14);
    const response = await mesh.chat({ model: 'mesh/balanced', messages: [user] });
    assert.equal(response.mesh?.served_by, 'free/m');
    assert.deepEqual(hosts(calls), ['free.test']);
  });

  test('BALANCED rejects an over-cap pinned candidate', async () => {
    const { mesh, calls } = build('BALANCED', paidAndFree, 14);
    await assert.rejects(() => mesh.chat({ model: 'paid/m', messages: [user] }), NoCandidateError);
    assert.deepEqual(calls, []);
  });

  test('a client mesh field cannot raise the server-owned cap', async () => {
    const { mesh, calls } = build('BALANCED', paidAndFree, 1);
    await assert.rejects(
      () => mesh.chat({
        model: 'paid/m',
        messages: [user],
        mesh: { maxPricePerMTok: 1000 } as never,
      }),
      NoCandidateError,
    );
    assert.deepEqual(calls, []);
  });

  test('an over-cap candidate is removed before scoring', () => {
    const decision = new Router(registry(paidAndFree), { maxPricePerMTok: 14 }).route({ mesh: 'best' });
    assert.deepEqual(decision.ranked.map((candidate) => candidate.candidate.key), ['free/m']);
    assert.ok(decision.rejected.some((item) => item.key === 'paid/m' && item.reason.startsWith('price_cap:')));
  });

  test('the execution guard still blocks an over-cap candidate injected after routing', async () => {
    const { mesh, calls } = build('BALANCED', paidAndFree, 14);
    const internalRouter = mesh['router'] as unknown as {
      route: (request: { mesh?: string }) => ReturnType<Router['route']>;
    };
    const originalRoute = internalRouter.route.bind(internalRouter);
    const decision = originalRoute({ mesh: 'balanced' });
    const overCap = registry([provider('injected', 15, 20)]).candidates[0]!;
    const injected: ScoredCandidate = { candidate: overCap, score: 999, terms: {}, components: [] };
    internalRouter.route = () => ({ ...decision, ranked: [injected, ...decision.ranked] });
    try {
      const response = await mesh.chat({ model: 'mesh/balanced', messages: [user] });
      assert.equal(response.mesh?.served_by, 'free/m');
      assert.deepEqual(hosts(calls), ['free.test']);
    } finally {
      internalRouter.route = originalRoute;
    }
  });

  test('exact input and output rate boundaries are accepted', async () => {
    for (const [id, input, output] of [['exact-input', 10, 5], ['exact-output', 5, 10]] as const) {
      const { mesh, calls } = build('BALANCED', [provider(id, input, output)], 10);
      const response = await mesh.chat({ model: `${id}/m`, messages: [user] });
      assert.equal(response.mesh?.served_by, `${id}/m`);
      assert.deepEqual(hosts(calls), [`${id}.test`]);
    }
  });

  test('either input or output rate above the cap is rejected', async () => {
    for (const [id, input, output] of [['high-input', 10.01, 5], ['high-output', 5, 10.01]] as const) {
      const { mesh, calls } = build('BALANCED', [provider(id, input, output)], 10);
      await assert.rejects(() => mesh.chat({ model: `${id}/m`, messages: [user] }), NoCandidateError);
      assert.deepEqual(calls, []);
    }
  });

  test('zero cap permits only 0/0 candidates', async () => {
    const providers = [provider('free', 0, 0), provider('nonzero-output', 0, 0.01)];
    const { mesh, calls } = build('BALANCED', providers, 0);
    const response = await mesh.chat({ model: 'mesh/balanced', messages: [user] });
    assert.equal(response.mesh?.served_by, 'free/m');
    assert.deepEqual(hosts(calls), ['free.test']);
  });

  test('missing, negative, NaN and Infinity caps reject paid candidates', async () => {
    for (const cap of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { mesh, calls } = build('BALANCED', [provider('paid', 1, 1)], cap);
      await assert.rejects(() => mesh.chat({ model: 'mesh/balanced', messages: [user] }), NoCandidateError);
      assert.deepEqual(calls, [], `paid adapter called with cap ${String(cap)}`);
    }
  });

  test('invalid model pricing cannot qualify as free', () => {
    const invalidPrices = [
      { inPerMTok: Number.NaN, outPerMTok: 0 },
      { inPerMTok: 0, outPerMTok: Number.POSITIVE_INFINITY },
      { inPerMTok: -1, outPerMTok: 0 },
      { inPerMTok: 0 },
    ];
    for (const price of invalidPrices) {
      const base = provider('malformed', 0, 0).models[0]!;
      const malformed = {
        ...provider('malformed', 0, 0),
        models: [{ ...base, price }],
      } as unknown as ProviderConfig;
      const decision = new Router(registry([malformed]), { maxPricePerMTok: 100 }).route({ mesh: 'free' });
      assert.deepEqual(decision.ranked, []);
      assert.ok(decision.rejected.some((r) => r.reason.includes('model pricing is missing or invalid')));
    }
  });

  test('the current global maxAttempts can stop before a later paid candidate', async () => {
    const freeProviders = Array.from({ length: 5 }, (_, i) => provider(`free-${i}`, 0, 0));
    const providers = [...freeProviders, provider('paid', 1, 1)];
    const { mesh, calls } = build('FREE_FIRST', providers, 10, () => errorResponse(500, 'down'));
    await assert.rejects(() => mesh.chat({ model: 'mesh/best', messages: [user] }));
    assert.equal(calls.length, 4, 'the existing global maxAttempts is four');
    assert.ok(calls.every((call) => new URL(call.url).host !== 'paid.test'));
  });
});
