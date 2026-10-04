import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { InferenceMesh } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { createModeMesh } from '../src/mode-mesh.js';
import { NoCandidateError, type ProviderConfig } from '../src/core/types.js';
import { FIXTURE_ENV, fakeFetch, fixtureProviders, okChat } from './helpers.js';

const user = { role: 'user' as const, content: 'hello' };
const paidCalled = (calls: Array<{ url: string }>) => calls.some((c) => c.url.includes('paid.test'));

function mesh(over: Record<string, unknown> = {}) {
  const { fetch, calls } = fakeFetch(() => okChat('ok'));
  const m = new InferenceMesh({
    registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
    fetchImpl: fetch,
    ...over,
  });
  return { m, calls };
}

describe('Claude-family routing through the existing pipeline', () => {
  test('a Claude model no longer pins to nothing; it routes via AUTO', async () => {
    const { m, calls } = mesh();
    // No policy: default is auto. The free profile default picks alpha/alpha-free.
    const res = await m.chat({ model: 'claude-sonnet-5-5', messages: [user] });
    assert.ok(res.mesh?.served_by, 'a backend served');
    assert.equal(res.mesh?.served_by, 'alpha/alpha-free');
    assert.ok(calls.length > 0);
  });

  test('an explicit family policy can route to a profile', async () => {
    const { m } = mesh({ claudeFamilyPolicy: { sonnet: 'best' } });
    const res = await m.chat({ model: 'claude-sonnet-5-5', messages: [user] });
    // 'best' is quality-heavy -> paid/paid-pro wins.
    assert.equal(res.mesh?.profile, 'best');
    assert.equal(res.mesh?.served_by, 'paid/paid-pro');
  });

  test('an explicit family policy can pin a backend model', async () => {
    const { m } = mesh({ claudeFamilyPolicy: { haiku: { pin: 'beta/beta-free' } } });
    const res = await m.chat({ model: 'claude-haiku-4-5', messages: [user] });
    assert.equal(res.mesh?.served_by, 'beta/beta-free');
  });

  test('a non-Claude model keeps its original pin behavior', async () => {
    const { m } = mesh();
    const res = await m.chat({ model: 'paid/paid-pro', messages: [user] });
    assert.equal(res.mesh?.served_by, 'paid/paid-pro', 'explicit pin still honored');
  });

  test('the client-visible model id is preserved at the Anthropic boundary', async () => {
    // The internal response reports the backend; the client boundary (gateway)
    // reports the requested Claude id. Assert the boundary that Claude Code sees.
    const { handleRequest } = await import('../src/core/gateway.js');
    const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
    const { fetch } = fakeFetch(() => okChat('ok'));
    const m = new InferenceMesh({ registry, fetchImpl: fetch });
    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 16, messages: [user] }),
    });
    const res = await handleRequest(req, { mesh: m, tokens: new Set(['t']) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mesh-served-by'), 'alpha/alpha-free', 'real backend is separate');
    const body = (await res.json()) as { model: string };
    assert.equal(body.model, 'claude-sonnet-5-5', 'client sees the requested Claude id');
  });

  test('Claude-family requests still respect tools capability filtering', async () => {
    // fixture: only beta/beta-free has 'vision'; alpha/alpha-free does not.
    const { m, calls } = mesh({ claudeFamilyPolicy: { sonnet: 'free' } });
    const res = await m.chat({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    });
    assert.equal(res.mesh?.served_by, 'beta/beta-free', 'capability filter selected the vision-capable free model');
    assert.ok(!calls.some((c) => c.url.includes('alpha.test')));
  });
});

describe('Claude-family routing preserves FREE_ONLY and FREE_FIRST', () => {
  test('FREE_ONLY still rejects paid candidates for a Claude request', async () => {
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const m = new InferenceMesh({
      registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
      fetchImpl: fetch,
      enforceFreeOnly: true,
    });
    const res = await m.chat({ model: 'claude-opus-4-1', messages: [user] });
    assert.ok(!res.mesh?.served_by.startsWith('paid/'), 'no paid backend under FREE_ONLY');
    assert.ok(!paidCalled(calls));

    // Even a Claude family policy that tries to pin a paid model is sanitized by
    // the existing FREE_ONLY enforcement (not a new exception).
  });

  test('FREE_FIRST prefers free candidates for a Claude request', async () => {
    const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const m = createModeMesh({ registry, mode: 'FREE_FIRST', fetchImpl: fetch });
    const res = await m.chat({ model: 'claude-sonnet-5-5', messages: [user] });
    assert.ok(!res.mesh?.served_by.startsWith('paid/'), 'free served first');
    assert.deepEqual(calls.map((c) => new URL(c.url).host), ['alpha.test']);
  });

  test('BALANCED behavior is unchanged for a Claude request', async () => {
    const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
    const { fetch } = fakeFetch(() => okChat('ok'));
    const m = createModeMesh({ registry, mode: 'BALANCED', fetchImpl: fetch });
    const res = await m.chat({ model: 'claude-sonnet-5-5', messages: [user] });
    assert.equal(res.mesh?.profile, 'balanced');
  });

  test('all-Claude-unknown with no eligible candidate still fails closed', async () => {
    const onlyPaid: ProviderConfig[] = [
      {
        id: 'paid',
        kind: 'openai-compat',
        baseUrl: 'https://paid.test/v1',
        apiKeyEnv: 'PAID_KEY',
        maxPrivacy: 'internal',
        models: [{ id: 'x', capabilities: ['text'], contextWindow: 8000, price: { inPerMTok: 1, outPerMTok: 1 }, priceVerifiedAt: '2026-10-01' }],
      } as ProviderConfig,
    ];
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const m = new InferenceMesh({
      registry: new Registry(onlyPaid, { env: { PAID_KEY: 'k' } }),
      fetchImpl: fetch,
      enforceFreeOnly: true,
    });
    await assert.rejects(
      () => m.chat({ model: 'claude-haiku-4-5', messages: [user] }),
      (e: unknown) => e instanceof NoCandidateError,
    );
    assert.equal(calls.length, 0);
  });
});
