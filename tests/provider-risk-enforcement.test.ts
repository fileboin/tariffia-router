import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { InferenceMesh } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { createModeMesh } from '../src/mode-mesh.js';
import { allowAvoidFromEnv } from '../src/routing-mode.js';
import { NoCandidateError, type ProviderConfig } from '../src/core/types.js';
import { errorResponse, fakeFetch, okChat, type Responder } from './helpers.js';

const user = { role: 'user' as const, content: 'x' };

function provider(id: string, opts: { risk?: 'ok' | 'caution' | 'avoid'; price?: number; caps?: ('text' | 'vision')[]; host?: string } = {}): ProviderConfig {
  const price = opts.price ?? 0;
  return {
    id,
    kind: 'openai-compat',
    baseUrl: `https://${opts.host ?? id}.test/v1`,
    apiKeyEnv: `${id.toUpperCase().replace(/-/g, '_')}_KEY`,
    maxPrivacy: 'internal',
    ...(opts.risk ? { risk: opts.risk, ...(opts.risk === 'avoid' ? { riskNote: 'against provider terms' } : {}) } : {}),
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

function build(providers: ProviderConfig[], meshOpts: Record<string, unknown> = {}, responder?: Responder) {
  const env = Object.fromEntries(providers.map((p) => [p.apiKeyEnv, 'k']));
  const { fetch, calls } = fakeFetch(responder ?? (() => okChat('ok')));
  const mesh = new InferenceMesh({ registry: new Registry(providers, { env }), fetchImpl: fetch, ...meshOpts });
  return { mesh, calls };
}

const calledHosts = (calls: Array<{ url: string }>) => calls.map((c) => new URL(c.url).host);

describe('provider risk enforcement', () => {
  test('an avoid provider is excluded by default', async () => {
    const { mesh, calls } = build([provider('avoid-p', { risk: 'avoid' }), provider('safe', { risk: 'ok' })]);
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'safe/m');
    assert.ok(!calledHosts(calls).includes('avoid-p.test'));
  });

  test('ok provider remains available', () => {
    const { mesh } = build([provider('ok-p', { risk: 'ok' })]);
    assert.ok(mesh.registry.candidates.some((c) => c.key === 'ok-p/m'));
  });

  test('caution provider remains available', () => {
    const { mesh } = build([provider('c-p', { risk: 'caution' })]);
    assert.ok(mesh.registry.candidates.some((c) => c.key === 'c-p/m'));
  });

  test('a provider without a risk field is unaffected', () => {
    const { mesh } = build([provider('plain')]);
    assert.ok(mesh.registry.candidates.some((c) => c.key === 'plain/m'));
  });

  test('paid/free behavior is unchanged (free still chosen under the free profile)', async () => {
    const { mesh } = build([provider('free-ok', { risk: 'ok' }), provider('paid-ok', { risk: 'ok', price: 5 })]);
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'free-ok/m');
  });

  test('client pin cannot select an avoid provider', async () => {
    // A pin narrows the pool to that key; the avoided provider is not in the
    // registry, so the pin finds nothing and the request fails. It never
    // executes the avoided provider.
    const { mesh, calls } = build([provider('avoid-p', { risk: 'avoid' }), provider('safe', { risk: 'ok' })]);
    await assert.rejects(
      () => mesh.chat({ model: 'avoid-p/m', messages: [user] }),
      (err: unknown) => err instanceof NoCandidateError,
    );
    assert.ok(!calledHosts(calls).includes('avoid-p.test'));
  });

  test('client body.mesh.pin cannot select an avoid provider', async () => {
    const { mesh, calls } = build([provider('avoid-p', { risk: 'avoid' }), provider('safe', { risk: 'ok' })]);
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [user], mesh: { pin: 'avoid-p/m' } }),
      (err: unknown) => err instanceof NoCandidateError,
    );
    assert.ok(!calledHosts(calls).includes('avoid-p.test'));
  });

  test('if all candidates are avoid, the request fails (no silent avoid use)', async () => {
    const { mesh, calls } = build([provider('avoid-p', { risk: 'avoid' })]);
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [user] }),
      (err: unknown) => err instanceof NoCandidateError,
    );
    assert.equal(calls.length, 0);
  });

  test('explicit server opt-in allows avoid', async () => {
    const { mesh, calls } = build([provider('avoid-p', { risk: 'avoid' })], { allowAvoidRiskProviders: true });
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'avoid-p/m');
    assert.ok(calledHosts(calls).includes('avoid-p.test'));
  });

  test('the opt-in is server configuration, not a request field', async () => {
    // A client sending allowAvoidRiskProviders cannot turn it on.
    const { mesh, calls } = build([provider('avoid-p', { risk: 'avoid' }), provider('safe', { risk: 'ok' })]);
    const body = { model: 'mesh/free', messages: [user], allowAvoidRiskProviders: true, mesh: { allowAvoidRiskProviders: true } };
    const res = await mesh.chat(body as never);
    assert.equal(res.mesh?.served_by, 'safe/m');
    assert.ok(!calledHosts(calls).includes('avoid-p.test'));
  });

  test('allowAvoidFromEnv reads the server configuration knob', () => {
    assert.equal(allowAvoidFromEnv({}), false);
    assert.equal(allowAvoidFromEnv({ TARIFFIA_ALLOW_AVOID: '1' }), true);
    assert.equal(allowAvoidFromEnv({ TARIFFIA_ALLOW_AVOID: 'true' }), false);
  });

  test('FREE_ONLY still blocks paid models with risk filtering active', async () => {
    const { mesh, calls } = build([provider('paid-ok', { risk: 'ok', price: 5 })], { enforceFreeOnly: true });
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [user] }),
      (err: unknown) => err instanceof NoCandidateError,
    );
    assert.equal(calls.length, 0);
  });

  test('FREE_FIRST still prefers eligible free candidates', async () => {
    const registry = new Registry(
      [provider('free-ok', { risk: 'ok' }), provider('paid-ok', { risk: 'ok', price: 5, caps: ['text', 'vision'] })],
      { env: { FREE_OK_KEY: 'f', PAID_OK_KEY: 'p' } },
    );
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = createModeMesh({ registry, mode: 'FREE_FIRST', fetchImpl: fetch });
    await mesh.chat({ model: 'mesh/best', messages: [user] });
    assert.deepEqual(calledHosts(calls), ['free-ok.test'], 'free tried first, paid never called');
  });

  test('BALANCED is unchanged apart from risk filtering', async () => {
    const registry = new Registry(
      [provider('avoid-p', { risk: 'avoid', price: 0 }), provider('paid-ok', { risk: 'ok', price: 5 })],
      { env: { AVOID_P_KEY: 'a', PAID_OK_KEY: 'p' } },
    );
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = createModeMesh({ registry, mode: 'BALANCED', fetchImpl: fetch });
    const res = await mesh.chat({ model: 'mesh/best', messages: [user] });
    assert.equal(res.mesh?.served_by, 'paid-ok/m', 'avoid filtered; the remaining provider serves');
    assert.ok(!calledHosts(calls).includes('avoid-p.test'));
  });

  test('risk filtering does not mutate the source registry', () => {
    const registry = new Registry([provider('avoid-p', { risk: 'avoid' })], { env: { AVOID_P_KEY: 'a' } });
    const before = registry.candidates.length;
    new InferenceMesh({ registry, fetchImpl: async () => okChat('x') });
    assert.equal(registry.candidates.length, before, 'source registry unchanged');
  });
});
