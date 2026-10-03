import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { InferenceMesh, type MeshEvent } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { Router } from '../src/core/router.js';
import { MeshError, NoCandidateError, type ProviderConfig, type ScoredCandidate } from '../src/core/types.js';
import { errorResponse, fakeFetch, okChat, type Responder } from './helpers.js';

const user = { role: 'user' as const, content: 'x' };

function provider(id: string, host: string, opts: { price?: number; caps?: ('text' | 'tools' | 'vision' | 'json')[] } = {}): ProviderConfig {
  const price = opts.price ?? 0;
  return {
    id,
    kind: 'openai-compat',
    baseUrl: `https://${host}/v1`,
    apiKeyEnv: `${id.toUpperCase().replace(/-/g, '_')}_KEY`,
    maxPrivacy: 'internal',
    models: [
      {
        id: 'm',
        capabilities: opts.caps ?? ['text'],
        contextWindow: 200000,
        price: { inPerMTok: price, outPerMTok: price },
        quality: 0.5,
        ...(price > 0 ? { priceVerifiedAt: '2026-10-01' } : {}),
      },
    ],
  } as ProviderConfig;
}

function meshWith(providers: ProviderConfig[], responder: Responder, opts: { enforceFreeOnly?: boolean; events?: MeshEvent[] } = {}) {
  const env = Object.fromEntries(providers.map((p) => [p.apiKeyEnv, 'k']));
  const { fetch, calls } = fakeFetch(responder);
  const mesh = new InferenceMesh({
    registry: new Registry(providers, { env }),
    fetchImpl: fetch,
    ...(opts.enforceFreeOnly ? { enforceFreeOnly: true } : {}),
    ...(opts.events ? { onEvent: (e) => opts.events!.push(e) } : {}),
  });
  return { mesh, calls };
}

const hostOf = (url: string) => url.replace(/^https?:\/\//, '').split('/')[0] ?? '';
const order = (calls: Array<{ url: string }>) => calls.map((c) => hostOf(c.url));

describe('fallback execution', () => {
  test('first candidate succeeds -> no fallback', async () => {
    // a/m and b/m both free and identical; tie-break by key picks a/m first.
    const { mesh, calls } = meshWith([provider('a', 'a.test'), provider('b', 'b.test')], () => okChat('ok'));
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'a/m');
    assert.deepEqual(order(calls), ['a.test']);
  });

  test('first candidate fails retryably -> second candidate executes', async () => {
    const { mesh, calls } = meshWith(
      [provider('a', 'a.test'), provider('b', 'b.test')],
      (_call, n) => (n === 1 ? errorResponse(500, 'boom') : okChat('ok')),
    );
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'b/m');
    assert.deepEqual(order(calls), ['a.test', 'b.test']);
    assert.equal(res.mesh?.attempts.length, 1, 'the failed attempt is recorded');
    assert.equal(res.mesh?.attempts[0]?.status, 500);
  });

  test('multiple candidates fail -> continues in rank order', async () => {
    const { mesh, calls } = meshWith(
      [provider('a', 'a.test'), provider('b', 'b.test'), provider('c', 'c.test')],
      (_call, n) => (n < 3 ? errorResponse(503, 'down') : okChat('ok')),
    );
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'c/m');
    assert.deepEqual(order(calls), ['a.test', 'b.test', 'c.test']);
  });

  test('non-retryable failure stops correctly (400 does not walk the chain)', async () => {
    const { mesh, calls } = meshWith(
      [provider('a', 'a.test'), provider('b', 'b.test')],
      () => errorResponse(400, 'bad request'),
    );
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [user] }),
      (err: unknown) => {
        assert.ok(err instanceof MeshError);
        assert.equal((err as MeshError).status, 400);
        assert.equal((err as MeshError).code, 'provider_error');
        return true;
      },
    );
    assert.deepEqual(order(calls), ['a.test'], 'no further candidate is tried');
  });

  test('401 is retryable and falls through to the next candidate', async () => {
    // 401 is this key's fault, which the next provider does not share.
    const { mesh, calls } = meshWith(
      [provider('a', 'a.test'), provider('b', 'b.test')],
      (_call, n) => (n === 1 ? errorResponse(401, 'bad key') : okChat('ok')),
    );
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'b/m');
    assert.deepEqual(order(calls), ['a.test', 'b.test']);
  });

  test('same candidate is not retried unnecessarily (one call per candidate)', async () => {
    const events: MeshEvent[] = [];
    const { mesh, calls } = meshWith(
      [provider('a', 'a.test'), provider('b', 'b.test')],
      (_call, n) => (n < 2 ? errorResponse(500, 'boom') : okChat('ok')),
      { events },
    );
    await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.deepEqual(order(calls), ['a.test', 'b.test']);
    const called = calls.map((c) => hostOf(c.url));
    assert.equal(new Set(called).size, called.length, 'no provider called twice');
    const attemptsForA = events.filter((e) => e.type === 'attempt' && e.key === 'a/m');
    assert.equal(attemptsForA.length, 1, 'a/m attempted once');
  });
});

describe('execution-boundary guards', () => {
  test('a paid candidate injected into the ranked chain is blocked by FREE_ONLY', async () => {
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = new InferenceMesh({
      registry: new Registry([provider('free', 'free.test'), provider('paid', 'paid.test', { price: 5 })], {
        env: { FREE_KEY: 'f', PAID_KEY: 'p' },
      }),
      fetchImpl: fetch,
      enforceFreeOnly: true,
    });
    // Simulate a future ranking/filter regression: splice a paid candidate into
    // the ranked chain after routing, then execute it directly.
    const decision = mesh['router'].route({ mesh: 'free' });
    const paid = new Registry([provider('paid', 'paid.test', { price: 5 })], { env: { PAID_KEY: 'p' } }).candidates[0]!;
    const injected: ScoredCandidate = { candidate: paid, score: 999, terms: {}, components: [] };
    const tampered = { ...decision, ranked: [injected, ...decision.ranked] };
    const original = mesh['router'].route.bind(mesh['router']);
    (mesh['router'] as unknown as { route: () => typeof tampered }).route = () => tampered;
    try {
      const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
      assert.equal(res.mesh?.served_by, 'free/m', 'the free candidate served');
      assert.ok(!calls.some((c) => c.url.includes('paid.test')), 'the paid candidate never reached an adapter');
      original;
    } finally {
      (mesh['router'] as unknown as { route: unknown }).route = original;
    }
  });

  test('a capability-ineligible candidate cannot execute (tampered chain)', async () => {
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = new InferenceMesh({
      registry: new Registry([provider('text', 'text.test'), provider('tools', 'tools.test', { caps: ['text', 'tools'] })], {
        env: { TEXT_KEY: 't', TOOLS_KEY: 't' },
      }),
      fetchImpl: fetch,
    });
    const decision = mesh['router'].route({ mesh: 'free' });
    // Put a text-only candidate first for a tools request.
    const textOnly = new Registry([provider('text', 'text.test')], { env: { TEXT_KEY: 't' } }).candidates[0]!;
    const injected: ScoredCandidate = { candidate: textOnly, score: 999, terms: {}, components: [] };
    const toolsOnly = decision.ranked.filter((r) => r.candidate.key !== 'text/m');
    const tampered = { ...decision, ranked: [injected, ...toolsOnly] };
    const original = mesh['router'].route.bind(mesh['router']);
    (mesh['router'] as unknown as { route: () => typeof tampered }).route = () => tampered;
    try {
      const res = await mesh.chat({
        model: 'mesh/free',
        messages: [user],
        tools: [{ type: 'function', function: { name: 'f' } }],
      });
      assert.equal(res.mesh?.served_by, 'tools/m');
      assert.ok(!calls.some((c) => c.url.includes('text.test')), 'text-only candidate never executed');
    } finally {
      (mesh['router'] as unknown as { route: unknown }).route = original;
    }
  });

  test('existing pin behavior remains unchanged', async () => {
    const { mesh, calls } = meshWith([provider('a', 'a.test'), provider('b', 'b.test')], () => okChat('ok'));
    const res = await mesh.chat({ model: 'b/m', messages: [user] });
    assert.equal(res.mesh?.served_by, 'b/m');
    assert.deepEqual(order(calls), ['b.test']);
  });

  test('all retryable candidates failing yields a clear exhausted error', async () => {
    const { mesh } = meshWith(
      [provider('a', 'a.test'), provider('b', 'b.test')],
      () => errorResponse(500, 'down'),
    );
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [user] }),
      (err: unknown) => {
        assert.ok(err instanceof MeshError);
        assert.equal((err as MeshError).code, 'all_providers_failed');
        assert.equal((err as MeshError).status, 503);
        return true;
      },
    );
  });

  test('a pin to a model that fails retryably does not fall to others (single pin)', async () => {
    const { mesh, calls } = meshWith(
      [provider('a', 'a.test'), provider('b', 'b.test')],
      () => errorResponse(500, 'down'),
    );
    await assert.rejects(() => mesh.chat({ model: 'a/m', messages: [user] }), (e: unknown) => e instanceof MeshError);
    // A pin restricts the pool to that one candidate; it must not silently use b.
    assert.deepEqual(order(calls), ['a.test']);
  });
});

// Keep the import used (NoCandidateError is referenced by sibling suites but not
// here); assert it is exported to catch accidental removal.
test('NoCandidateError is exported', () => {
  assert.equal(typeof NoCandidateError, 'function');
});
