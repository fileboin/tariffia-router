import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { resolveMode, modeFromEnv } from '../src/routing-mode.js';
import { createModeMesh } from '../src/mode-mesh.js';
import { Registry } from '../src/core/registry.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { NoCandidateError, type ProviderConfig, type ChatRequest } from '../src/core/types.js';
import { errorResponse, fakeFetch, FIXTURE_ENV, fixtureProviders, okChat, type Responder } from './helpers.js';

const user = { role: 'user' as const, content: 'x' };
const paidCalled = (calls: Array<{ url: string }>) => calls.some((c) => c.url.includes('paid.test'));

function meshFor(
  mode: 'FREE_FIRST' | 'FREE_ONLY' | 'BALANCED',
  responder?: Responder,
  maxPricePerMTok?: number,
) {
  const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
  const { fetch, calls } = fakeFetch(responder ?? (() => okChat('ok')));
  const mesh = createModeMesh({ registry, mode, fetchImpl: fetch, maxPricePerMTok });
  return { mesh, calls };
}

describe('FREE_FIRST mode resolution', () => {
  test('FREE_FIRST is enabled and resolves to free-first ordering', () => {
    const s = resolveMode('FREE_FIRST');
    assert.equal(s.enforceFreeOnly, false);
    assert.equal(s.freeFirst, true);
  });

  test('FREE_FIRST is selected only from server config', () => {
    assert.equal(modeFromEnv({ TARIFFIA_MODE: 'FREE_FIRST' }), 'FREE_FIRST');
    assert.equal(modeFromEnv({ TARIFFIA_MODE: 'free_first' }), 'FREE_FIRST');
  });

  test('no client field can switch the mode to FREE_FIRST', async () => {
    // A server on BALANCED must not become FREE_FIRST because a client asks.
    // Under BALANCED (quality/cost weighted) the paid model wins with a
    // quality request; if the client could switch to FREE_FIRST the paid model
    // would be held back. We assert the paid model is reachable, i.e. the mode
    // stayed BALANCED.
    const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = createModeMesh({ registry, mode: 'BALANCED', fetchImpl: fetch, maxPricePerMTok: 15 });
    const body = { model: 'mesh/best', messages: [user], mode: 'FREE_FIRST', mesh: { mode: 'FREE_FIRST' } } as unknown as ChatRequest;
    const res = await mesh.chat(body);
    assert.equal(res.mesh?.served_by, 'paid/paid-pro', 'BALANCED selected paid; not switched to FREE_FIRST');
    assert.ok(paidCalled(calls));
  });
});

describe('FREE_FIRST ordering', () => {
  test('a free candidate is selected before a higher-scoring paid candidate', async () => {
    // Under the default 'best'-quality path the paid model scores higher, but
    // FREE_FIRST must still try free first.
    const { mesh, calls } = meshFor('FREE_FIRST');
    const res = await mesh.chat({ model: 'mesh/best', messages: [user] });
    assert.ok(res.mesh?.served_by.startsWith('alpha/') || res.mesh?.served_by.startsWith('beta/') || res.mesh?.served_by.startsWith('keyless/'));
    assert.ok(!paidCalled(calls), 'paid never called while a free candidate can serve');
  });

  test('if a free candidate succeeds, the paid provider is never called', async () => {
    const { mesh, calls } = meshFor('FREE_FIRST');
    await mesh.chat({ model: 'mesh/best', messages: [user] });
    assert.deepEqual(calls.map((c) => new URL(c.url).host), ['alpha.test']);
  });

  test('paid is used only after eligible free candidates cannot serve', async () => {
    // Every free provider fails; then the paid candidate serves.
    const { mesh, calls } = meshFor(
      'FREE_FIRST',
      (_call, n) => (n <= 3 ? errorResponse(500, 'down') : okChat('paid ok')),
      15,
    );
    const res = await mesh.chat({ model: 'mesh/best', messages: [user] });
    assert.equal(res.mesh?.served_by, 'paid/paid-pro');
    // Free providers were tried first, then paid.
    const hosts = calls.map((c) => new URL(c.url).host);
    assert.ok(hosts.indexOf('paid.test') > hosts.findIndex((h) => h !== 'paid.test'), 'paid tried after free');
  });

  test('a free model cannot be masked as paid and vice versa: free is by explicit 0/0 price', async () => {
    const explicitPaid: ProviderConfig = {
      id: 'explicit-paid',
      kind: 'openai-compat',
      baseUrl: 'https://explicit-paid.test/v1',
      apiKeyEnv: 'EXPLICIT_PAID_KEY',
      maxPrivacy: 'internal',
      models: [{ id: 'm', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 1, outPerMTok: 1 }, priceVerifiedAt: '2026-10-01', quality: 0.99 }],
    } as ProviderConfig;
    const { fetch, calls } = fakeFetch(() => okChat('x'));
    const mesh = createModeMesh({
      registry: new Registry([explicitPaid], { env: { EXPLICIT_PAID_KEY: 'k' } }),
      mode: 'FREE_FIRST',
      fetchImpl: fetch,
      maxPricePerMTok: 1,
    });
    // It is the only candidate and it is paid, so it is used — but only because
    // no free candidate exists, and it is classified paid by its price.
    const res = await mesh.chat({ model: 'mesh/best', messages: [user] });
    assert.equal(res.mesh?.served_by, 'explicit-paid/m');
    assert.ok(calls.length > 0);
  });

  test('capability filters still apply under FREE_FIRST', async () => {
    // A free provider that lacks 'vision', and a paid provider that has it. The
    // vision request must reach paid (free-first cannot satisfy it), proving the
    // hard capability filter runs regardless of ordering.
    const freeNoVision: ProviderConfig = {
      id: 'free-text',
      kind: 'openai-compat',
      baseUrl: 'https://free-text.test/v1',
      apiKeyEnv: 'FREE_TEXT_KEY',
      maxPrivacy: 'internal',
      models: [{ id: 'm', capabilities: ['text'], contextWindow: 200000, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 0.5 }],
    } as ProviderConfig;
    const paidVision: ProviderConfig = {
      id: 'paid-vision',
      kind: 'openai-compat',
      baseUrl: 'https://paid-vision.test/v1',
      apiKeyEnv: 'PAID_VISION_KEY',
      maxPrivacy: 'internal',
      models: [{ id: 'm', capabilities: ['text', 'vision'], contextWindow: 200000, price: { inPerMTok: 1, outPerMTok: 1 }, priceVerifiedAt: '2026-10-01', quality: 0.9 }],
    } as ProviderConfig;
    const { fetch } = fakeFetch(() => okChat('ok'));
    const mesh = createModeMesh({
      registry: new Registry([freeNoVision, paidVision], { env: { FREE_TEXT_KEY: 'f', PAID_VISION_KEY: 'p' } }),
      mode: 'FREE_FIRST',
      fetchImpl: fetch,
      maxPricePerMTok: 1,
    });
    const res = await mesh.chat({
      model: 'mesh/best',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    });
    assert.equal(res.mesh?.served_by, 'paid-vision/m');
  });

  test('privacy/context filters still apply under FREE_FIRST', async () => {
    const { mesh } = meshFor('FREE_FIRST', undefined, 15);
    // highly_confidential only the paid provider serves; free-first must fall through.
    const res = await mesh.chat({ model: 'mesh/best', messages: [user], mesh: { privacy: 'highly_confidential' } });
    assert.equal(res.mesh?.served_by, 'paid/paid-pro');
  });

  test('a client pin cannot force paid-first behavior under FREE_FIRST', async () => {
    const { mesh, calls } = meshFor('FREE_FIRST');
    // Pin a paid model: it is dropped so a free candidate serves first.
    const res = await mesh.chat({ model: 'mesh/best', messages: [user], mesh: { pin: 'paid/paid-pro' } });
    assert.ok(!res.mesh?.served_by.startsWith('paid/'), 'paid pin dropped; free served');
    assert.ok(!paidCalled(calls));
  });

  test('a client pin to a free model is honoured under FREE_FIRST', async () => {
    const { mesh } = meshFor('FREE_FIRST');
    const res = await mesh.chat({ model: 'beta/beta-free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'beta/beta-free');
  });
});

describe('FREE_FIRST does not weaken FREE_ONLY and leaves BALANCED unchanged', () => {
  test('FREE_ONLY still blocks paid execution', async () => {
    const { mesh, calls } = meshFor('FREE_ONLY');
    const res = await mesh.chat({ model: 'paid/paid-pro', messages: [user] });
    assert.ok(!res.mesh?.served_by.startsWith('paid/'));
    assert.ok(!paidCalled(calls));
  });

  test('FREE_ONLY still forbids paid fallback', async () => {
    const { mesh, calls } = meshFor('FREE_ONLY', () => errorResponse(500, 'down'));
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [user] }),
      (e: unknown) => e instanceof NoCandidateError || e instanceof Error,
    );
    assert.ok(!paidCalled(calls));
  });

  test('BALANCED behavior is unchanged (can still select paid)', async () => {
    const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
    const { fetch } = fakeFetch(() => okChat('ok'));
    const mesh = createModeMesh({ registry, mode: 'BALANCED', fetchImpl: fetch, maxPricePerMTok: 15 });
    const res = await mesh.chat({ model: 'mesh/best', messages: [user] });
    assert.equal(res.mesh?.served_by, 'paid/paid-pro');
  });

  test('a plain mesh without freeFirst is unchanged (paid pin honoured)', async () => {
    const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
    const { fetch } = fakeFetch(() => okChat('ok'));
    const mesh = new InferenceMesh({ registry, fetchImpl: fetch, maxPricePerMTok: 15 });
    const res = await mesh.chat({ model: 'paid/paid-pro', messages: [user] });
    assert.equal(res.mesh?.served_by, 'paid/paid-pro');
  });
});
