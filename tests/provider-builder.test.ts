import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { buildProviderConfig, type BuildProviderInput, type VerifiedModelSpec } from '../src/provider-builder.js';
import { validateRegistryFile } from '../src/core/config.js';
import type { CandidateProvider } from '../src/seed-candidates.js';
import type { ActivationResult } from '../src/activation-gate.js';

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
const ineligible: ActivationResult = {
  candidateId: 'p',
  eligible: false,
  reasons: ['free_status_not_verified'],
};

const verifiedModel: VerifiedModelSpec = {
  id: 'm1',
  capabilities: ['text'],
  contextWindow: 8192,
  price: { inPerMTok: 0, outPerMTok: 0 },
};

function input(over: Partial<BuildProviderInput> = {}): BuildProviderInput {
  return {
    candidate: candidate(),
    activation: eligible,
    provider: { providerId: 'p', kind: 'openai-compat', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal' },
    models: [verifiedModel],
    ...over,
  };
}

describe('provider builder', () => {
  test('eligible candidate builds a valid ProviderConfig that passes validation', () => {
    const r = buildProviderConfig(input());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.config.id, 'p');
    assert.equal(r.config.kind, 'openai-compat');
    assert.equal(r.config.baseUrl, 'https://p.test/v1');
    assert.equal(r.config.apiKeyEnv, 'P_KEY');
    assert.equal(r.config.maxPrivacy, 'internal');
    assert.equal(r.config.models.length, 1);
    // It must satisfy the real registry validator.
    assert.doesNotThrow(() => validateRegistryFile({ providers: [r.config] }));
  });

  test('ineligible candidate is rejected', () => {
    const r = buildProviderConfig(input({ activation: ineligible }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /not activation-eligible/);
  });

  test('missing identity is rejected', () => {
    const r = buildProviderConfig(
      input({ provider: { providerId: '', kind: 'openai-compat', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal' } }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /missing providerId/);
  });

  test('unsupported kind is rejected', () => {
    const r = buildProviderConfig(
      input({ provider: { providerId: 'p', kind: 'grpc', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal' } }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /unsupported provider kind/);
  });

  test('no API key value is stored; only an env name is allowed', () => {
    // A pasted key as apiKeyEnv is rejected with a hint.
    const r = buildProviderConfig(
      input({ provider: { providerId: 'p', kind: 'openai-compat', apiKeyEnv: 'sk-live-abcdef', maxPrivacy: 'internal' } }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /environment-variable NAME/);

    // And the built config carries only the name.
    const ok = buildProviderConfig(input());
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.config.apiKeyEnv, 'P_KEY');
      assert.ok(!JSON.stringify(ok.config).includes('sk-'));
    }
  });

  test('no invented pricing or free status', () => {
    // A model with no explicit price is rejected, not defaulted to free.
    const r = buildProviderConfig(input({ models: [{ ...verifiedModel, price: undefined as never }] }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /no verified price/);
  });

  test('missing contextWindow/capabilities are rejected (not invented)', () => {
    const noCtx = buildProviderConfig(input({ models: [{ ...verifiedModel, contextWindow: undefined as never }] }));
    assert.equal(noCtx.ok, false);
    const noCaps = buildProviderConfig(input({ models: [{ ...verifiedModel, capabilities: [] }] }));
    assert.equal(noCaps.ok, false);
  });

  test('missing maxPrivacy is rejected (no default invented)', () => {
    const r = buildProviderConfig(
      input({ provider: { providerId: 'p', kind: 'openai-compat', apiKeyEnv: 'P_KEY', maxPrivacy: undefined as never } }),
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /missing maxPrivacy/);
  });

  test('input is not mutated', () => {
    const inp = input();
    const before = clone(inp);
    buildProviderConfig(inp);
    assert.deepEqual(clone(inp), before);
  });

  test('output is deterministic', () => {
    const a = buildProviderConfig(input());
    const b = buildProviderConfig(input());
    assert.deepEqual(a, b);
  });

  test('a free price is preserved only when explicitly supplied', () => {
    const r = buildProviderConfig(input({ models: [{ ...verifiedModel, price: { inPerMTok: 0, outPerMTok: 0 } }] }));
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.config.models[0]?.price, { inPerMTok: 0, outPerMTok: 0 });
  });

  test('a paid price is preserved as paid, never converted', () => {
    const r = buildProviderConfig(
      input({ models: [{ ...verifiedModel, price: { inPerMTok: 1, outPerMTok: 2 }, priceVerifiedAt: '2026-10-01' }] }),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.config.models[0]?.price, { inPerMTok: 1, outPerMTok: 2 });
  });
});
