import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { InferenceMesh } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { QuotaLedger, MemoryStorage } from '../src/core/ledger.js';
import { MeshError, type ChatRequest } from '../src/core/types.js';
import {
  FIXTURE_ENV,
  errorResponse,
  fakeClock,
  fakeFetch,
  fixtureProviders,
  okChat,
  type Responder,
} from './helpers.js';

/**
 * Server-authoritative FREE_ONLY.
 *
 * The mode is a property of the mesh instance (set by the server, never by a
 * request). The fixtures are the standard ones: `alpha/alpha-free`,
 * `beta/beta-free` and `keyless/open-tier` are free; `paid/paid-pro` costs
 * money. With FREE_ONLY on, no request shape may cause the paid model to be
 * executed.
 */
const user = { role: 'user' as const, content: 'x' };

function build(opts: { enforceFreeOnly?: boolean; responder?: Responder } = {}) {
  const { fetch, calls } = fakeFetch(opts.responder ?? (() => okChat('hi')));
  const mesh = new InferenceMesh({
    registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
    fetchImpl: fetch,
    ledger: new QuotaLedger(new MemoryStorage(), fakeClock().now),
    enforceFreeOnly: opts.enforceFreeOnly ?? false,
  });
  return { mesh, calls };
}

const paidCalled = (calls: Array<{ url: string }>) => calls.some((c) => c.url.includes('paid.test'));

describe('FREE_ONLY — server-authoritative enforcement', () => {
  test('a client pin to a paid model is not executed; a free candidate serves', async () => {
    const { mesh, calls } = build({ enforceFreeOnly: true });
    const res = await mesh.chat({ model: 'paid/paid-pro', messages: [user] });
    assert.equal(res.mesh?.served_by, 'alpha/alpha-free');
    assert.ok(!paidCalled(calls), 'the paid provider must never be called');
  });

  test('body.mesh.pin to a paid model does not bypass FREE_ONLY', async () => {
    const { mesh, calls } = build({ enforceFreeOnly: true });
    const res = await mesh.chat({
      model: 'mesh/free',
      messages: [user],
      mesh: { pin: 'paid/paid-pro' },
    });
    assert.equal(res.mesh?.served_by, 'alpha/alpha-free');
    assert.ok(!paidCalled(calls), 'the paid provider must never be called');
  });

  test('a body.mesh profile override cannot select a paid model under FREE_ONLY', async () => {
    const { mesh, calls } = build({ enforceFreeOnly: true });
    // `mesh` is not in ChatRequest.mesh's type, but a client can still send it
    // as JSON; the server must not let it through.
    const body = { model: 'anything', messages: [user], mesh: { mesh: 'best' } } as unknown as ChatRequest;
    const res = await mesh.chat(body);
    assert.ok(res.mesh?.served_by, 'a model was served');
    assert.ok(!res.mesh?.served_by.startsWith('paid/'), 'the paid model must not serve');
    assert.ok(!paidCalled(calls), 'the paid provider must never be called');
  });

  test('fallback cannot execute a paid candidate under FREE_ONLY', async () => {
    // Every free provider fails; the request must end in an error, never in a
    // fallback to the paid provider.
    const { mesh, calls } = build({
      enforceFreeOnly: true,
      responder: () => errorResponse(500, 'provider down'),
    });
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [user] }),
      (err: unknown) => err instanceof MeshError,
    );
    assert.ok(calls.length > 0, 'free providers were tried');
    assert.ok(!paidCalled(calls), 'fallback must never reach the paid provider');
  });

  test('a normal free request still routes successfully', async () => {
    const { mesh } = build({ enforceFreeOnly: true });
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'alpha/alpha-free');
    assert.equal(res.mesh?.profile, 'free');
  });

  test('a pin to a free model is still honoured under FREE_ONLY', async () => {
    const { mesh, calls } = build({ enforceFreeOnly: true });
    const res = await mesh.chat({ model: 'beta/beta-free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'beta/beta-free');
    assert.equal(calls[0]?.url.startsWith('https://beta.test'), true);
  });

  test('an unknown pin under FREE_ONLY routes to a free candidate instead of erroring', async () => {
    const { mesh, calls } = build({ enforceFreeOnly: true });
    const res = await mesh.chat({ model: 'ghost/model', messages: [user] });
    assert.equal(res.mesh?.served_by, 'alpha/alpha-free');
    assert.ok(!paidCalled(calls));
  });

  test('only the named free domain is ever contacted for a paid pin', async () => {
    const { mesh, calls } = build({ enforceFreeOnly: true });
    await mesh.chat({ model: 'paid/paid-pro', messages: [user] });
    for (const call of calls) {
      assert.ok(!call.url.includes('paid.test'), `unexpected call to ${call.url}`);
    }
  });
});

describe('FREE_ONLY off — behavior is unchanged', () => {
  test('a pin to a paid model is honoured when FREE_ONLY is off', async () => {
    const { mesh, calls } = build({ enforceFreeOnly: false });
    const res = await mesh.chat({ model: 'paid/paid-pro', messages: [user] });
    assert.equal(res.mesh?.served_by, 'paid/paid-pro');
    assert.equal(calls[0]?.url.startsWith('https://paid.test'), true);
  });

  test('mesh/best can still select the paid model when FREE_ONLY is off', async () => {
    const { mesh } = build({ enforceFreeOnly: false });
    const res = await mesh.chat({ model: 'mesh/best', messages: [user] });
    assert.equal(res.mesh?.served_by, 'paid/paid-pro');
  });

  test('body.mesh.pin to a paid model is honoured when FREE_ONLY is off', async () => {
    const { mesh, calls } = build({ enforceFreeOnly: false });
    const res = await mesh.chat({
      model: 'mesh/free',
      messages: [user],
      mesh: { pin: 'paid/paid-pro' },
    });
    assert.equal(res.mesh?.served_by, 'paid/paid-pro');
    assert.ok(paidCalled(calls));
  });
});
