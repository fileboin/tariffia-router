import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { activateProvider, type ActivateProviderInput } from '../src/provider-activation.js';
import type { CandidateProvider } from '../src/seed-candidates.js';
import type { ActivationResult } from '../src/activation-gate.js';
import type { ProviderConfig } from '../src/core/types.js';
import { validateRegistryFile } from '../src/core/config.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function candidate(over: Partial<CandidateProvider> = {}): CandidateProvider {
  return {
    candidateId: 'p',
    name: 'P',
    unverified: true,
    baseUrl: 'https://p.test/v1',
    url: 'https://p.test/keys',
    description: 'free tier',
    models: [{ id: 'm1' }],
    notes: [],
    provenance: {
      source: 'https://github.com/mnfst/awesome-free-llm-apis',
      license: 'CC0-1.0',
      lastUpdated: '2026-08-21',
      category: 'provider_api',
      retrievedAt: '2026-10-04',
    },
    ...over,
  };
}

const eligible: ActivationResult = { candidateId: 'p', eligible: true, reasons: ['eligible'] };
const ineligible: ActivationResult = { candidateId: 'p', eligible: false, reasons: ['free_status_not_verified'] };

function input(over: Partial<ActivateProviderInput> = {}): ActivateProviderInput {
  return {
    approved: true,
    candidate: candidate(),
    activation: eligible,
    provider: { providerId: 'p', kind: 'openai-compat', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal' },
    models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 0, outPerMTok: 0 } }],
    ...over,
  };
}

describe('explicit provider activation', () => {
  test('approved + eligible provider is activated in the returned registry', () => {
    const r = activateProvider([], input());
    assert.equal(r.ok, true);
    assert.deepEqual(r.registry.map((p) => p.id), ['p']);
    assert.deepEqual(r.summary?.added, ['p']);
    assert.doesNotThrow(() => validateRegistryFile({ providers: r.registry }));
  });

  test('approved missing fails closed', () => {
    const { approved, ...rest } = input();
    void approved;
    const r = activateProvider([], rest as ActivateProviderInput);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /not approved/);
  });

  test('approved false fails closed', () => {
    const r = activateProvider([], input({ approved: false }));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /not approved/);
  });

  test('ineligible candidate is rejected', () => {
    const r = activateProvider([], input({ activation: ineligible }));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /not activation-eligible/);
  });

  test('invalid provider config is rejected', () => {
    const r = activateProvider(
      [],
      input({ provider: { providerId: 'p', kind: 'grpc', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal' } }),
    );
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /unsupported provider kind/);
  });

  test('existing provider uses safe merge rules (replaces same id, refuses downgrade)', () => {
    const paid: ProviderConfig[] = [
      {
        id: 'p',
        kind: 'openai-compat',
        baseUrl: 'https://p.test/v1',
        apiKeyEnv: 'P_KEY',
        maxPrivacy: 'internal',
        models: [
          { id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 1, outPerMTok: 2 }, priceVerifiedAt: '2026-10-01' },
        ],
      },
    ];
    // Incoming zero-price model would be a paid->free downgrade: refused.
    const r = activateProvider(paid, input());
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /downgrade verified paid/);
  });

  test('paid provider cannot pass the FREE_ONLY activation gate', () => {
    // A paid candidate is not activation-eligible (free status conflict); even
    // with approved:true it is rejected, so it never reaches a free registry.
    const paidIneligible: ActivationResult = { candidateId: 'p', eligible: false, reasons: ['free_status_conflict'] };
    const r = activateProvider([], input({ activation: paidIneligible }));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /not activation-eligible/);
  });

  test('no input mutation (providers and inputs unchanged)', () => {
    const providers = [{ id: 'a', kind: 'openai-compat', baseUrl: 'https://a.test/v1', apiKeyEnv: 'A_KEY', maxPrivacy: 'internal', models: [{ id: 'm', capabilities: ['text'], contextWindow: 1, price: { inPerMTok: 0, outPerMTok: 0 } }] }] as ProviderConfig[];
    const beforeProviders = clone(providers);
    const inp = input();
    const beforeInput = clone(inp);
    activateProvider(providers, inp);
    assert.deepEqual(clone(providers), beforeProviders);
    assert.deepEqual(clone(inp), beforeInput);
  });

  test('deterministic result', () => {
    assert.deepEqual(activateProvider([], input()), activateProvider([], input()));
  });

  test('no network is used (activation is pure)', () => {
    // Replace global fetch with a spy that fails the test if called.
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error('fetch must not be called');
    }) as typeof fetch;
    try {
      const r = activateProvider([], input());
      assert.equal(r.ok, true);
      assert.equal(called, false, 'activation made no network call');
    } finally {
      globalThis.fetch = original;
    }
  });
});
