import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  resolveMode,
  modeFromEnv,
  BALANCED_PROFILE,
  RoutingModeError,
  ROUTING_MODES,
  type RoutingMode,
} from '../src/routing-mode.js';
import { createModeMesh, registryForMode } from '../src/mode-mesh.js';
import { Registry } from '../src/core/registry.js';
import { NoCandidateError, type ProviderConfig, type ChatRequest } from '../src/core/types.js';
import { errorResponse, fakeFetch, fixtureProviders, FIXTURE_ENV, okChat } from './helpers.js';

const user = { role: 'user' as const, content: 'x' };

function meshFor(mode: RoutingMode, responder = () => okChat('ok'), providers = fixtureProviders()) {
  const registry = new Registry(providers, { env: FIXTURE_ENV });
  const { fetch, calls } = fakeFetch(responder);
  const mesh = createModeMesh({ registry, mode, fetchImpl: fetch });
  return { mesh, calls };
}

const paidCalled = (calls: Array<{ url: string }>) => calls.some((c) => c.url.includes('paid.test'));

describe('routing mode resolution', () => {
  test('the mode type exposes all four names', () => {
    assert.deepEqual(ROUTING_MODES, ['FREE_ONLY', 'BALANCED', 'FREE_FIRST', 'CUSTOM']);
  });

  test('FREE_ONLY resolves to the free profile with enforcement on', () => {
    const s = resolveMode('FREE_ONLY');
    assert.equal(s.defaultProfile, 'free');
    assert.equal(s.enforceFreeOnly, true);
  });

  test('BALANCED resolves to the explicit balanced profile with enforcement off', () => {
    const s = resolveMode('BALANCED');
    assert.equal(s.defaultProfile, 'balanced');
    assert.equal(s.enforceFreeOnly, false);
    assert.deepEqual(s.profiles?.['balanced'], BALANCED_PROFILE);
  });

  test('reserved and unknown modes fail closed', () => {
    // FREE_FIRST is now implemented; CUSTOM remains reserved.
    assert.throws(() => resolveMode('CUSTOM'), /reserved and not implemented/);
    assert.throws(() => resolveMode('nonsense'), (e: unknown) => e instanceof RoutingModeError);
  });

  test('modeFromEnv reads server config, defaults safe, rejects unknown', () => {
    assert.equal(modeFromEnv({}), 'FREE_ONLY', 'absent -> safe default');
    assert.equal(modeFromEnv({ TARIFFIA_MODE: '' }), 'FREE_ONLY');
    assert.equal(modeFromEnv({ TARIFFIA_MODE: 'balanced' }), 'BALANCED');
    assert.equal(modeFromEnv({ TARIFFIA_MODE: 'free_first' }), 'FREE_FIRST');
    // A reserved-but-known mode (CUSTOM) is returned by the parser and rejected
    // when resolved, so configuring it fails closed without a silent downgrade.
    assert.equal(modeFromEnv({ TARIFFIA_MODE: 'custom' }), 'CUSTOM');
    assert.throws(() => resolveMode(modeFromEnv({ TARIFFIA_MODE: 'custom' })), /reserved/);
    assert.throws(() => modeFromEnv({ TARIFFIA_MODE: 'turbo' }), /not a known mode/);
  });
});

describe('FREE_ONLY is server-authoritative', () => {
  test('a paid request is served by a free model; paid never called', async () => {
    const { mesh, calls } = meshFor('FREE_ONLY');
    const res = await mesh.chat({ model: 'paid/paid-pro', messages: [user] });
    assert.ok(res.mesh?.served_by.startsWith('alpha/'));
    assert.ok(!paidCalled(calls));
  });

  test('a client cannot switch FREE_ONLY to BALANCED via body.mesh.mesh', async () => {
    const { mesh, calls } = meshFor('FREE_ONLY');
    const body = { model: 'mesh/balanced', messages: [user], mesh: { mesh: 'balanced' } } as unknown as ChatRequest;
    const res = await mesh.chat(body);
    assert.equal(res.mesh?.profile, 'free', 'server forced the free profile');
    assert.ok(!paidCalled(calls));
  });

  test('a client cannot pin a paid model under FREE_ONLY', async () => {
    const { mesh, calls } = meshFor('FREE_ONLY');
    const res = await mesh.chat({ model: 'mesh/free', messages: [user], mesh: { pin: 'paid/paid-pro' } });
    assert.ok(res.mesh?.served_by.startsWith('alpha/'));
    assert.ok(!paidCalled(calls));
  });

  test('FREE_ONLY paid fallback is impossible (free providers fail -> error)', async () => {
    const { mesh, calls } = meshFor('FREE_ONLY', () => errorResponse(500, 'down'));
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [user] }),
      (e: unknown) => e instanceof NoCandidateError || e instanceof Error,
    );
    assert.ok(!paidCalled(calls));
  });

  test('enforcement survives a client pinning a paid model and asking for a profile', async () => {
    const { mesh, calls } = meshFor('FREE_ONLY');
    const res = await mesh.chat({ model: 'paid/paid-pro', messages: [user] });
    assert.equal(res.mesh?.profile, 'free');
    assert.ok(!paidCalled(calls));
  });
});

describe('BALANCED routes by its explicit configuration', () => {
  test('the mode registry uses the balanced profile by default', () => {
    const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
    const modeRegistry = registryForMode(registry, 'BALANCED');
    assert.equal(modeRegistry.defaultProfile, 'balanced');
    assert.deepEqual(modeRegistry.profiles['balanced'], BALANCED_PROFILE);
    assert.equal(modeRegistry.providers.length, registry.providers.length, 'providers preserved');
  });

  test('BALANCED applies its explicit weights: it prefers a cheap free model where the best profile would pay', async () => {
    // fixture paid/paid-pro: quality 0.95 but expensive; alpha/alpha-free: quality
    // 0.5, price 0. Under BALANCED (cost weight 0.3) the free model wins on total
    // score. This is the point of an explicit config: the same registry ranks
    // differently under BALANCED than under a quality-only preset, and BALANCED
    // does not enforce free-only.
    const { mesh, calls } = meshFor('BALANCED');
    const res = await mesh.chat({ model: 'mesh/balanced', messages: [user] });
    assert.equal(res.mesh?.served_by, 'alpha/alpha-free');
    assert.ok(!paidCalled(calls), 'the cheap free model won on balanced weights');

    // The same fixtures under the quality-heavy 'best' profile select the paid model.
    const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
    const regBest = registry.withProfiles({}, 'best');
    const { fetch: bf } = fakeFetch(() => okChat('ok'));
    const best = new (await import('../src/core/mesh.js')).InferenceMesh({ registry: regBest, fetchImpl: bf });
    const bestRes = await best.chat({ model: 'mesh/best', messages: [user] });
    assert.equal(bestRes.mesh?.served_by, 'paid/paid-pro', 'best is quality-heavy and picks the paid model');
  });

  test('a client cannot pin past a profile the way FREE_ONLY would block; BALANCED honours a pin', async () => {
    const { mesh } = meshFor('BALANCED');
    const res = await mesh.chat({ model: 'beta/beta-free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'beta/beta-free');
  });
});

describe('mode layer is opt-in and does not change default behavior', () => {
  test('without createModeMesh, the existing default (free profile) is unchanged', async () => {
    const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = new (await import('../src/core/mesh.js')).InferenceMesh({ registry, fetchImpl: fetch });
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    assert.equal(res.mesh?.served_by, 'alpha/alpha-free');
    // No enforcement: a pin to paid is honoured, as before the mode layer.
    const pinned = await mesh.chat({ model: 'paid/paid-pro', messages: [user] });
    assert.equal(pinned.mesh?.served_by, 'paid/paid-pro');
    assert.ok(paidCalled(calls));
  });
});
