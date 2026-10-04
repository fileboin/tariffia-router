import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { ingestVerifiedCatalog, type CatalogProviderRecord } from '../src/catalog-ingest.js';
import { validateRegistryFile } from '../src/core/config.js';
import type { CandidateProvider } from '../src/seed-candidates.js';
import type { ActivationResult } from '../src/activation-gate.js';
import type { ProviderConfig } from '../src/core/types.js';

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

function record(over: Partial<CatalogProviderRecord> = {}): CatalogProviderRecord {
  return {
    candidate: candidate(),
    activation: eligible,
    provider: { providerId: 'p', kind: 'openai-compat', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal' },
    models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 0, outPerMTok: 0 } }],
    freeStatusVerified: true,
    compatibilityVerified: true,
    ...over,
  };
}

const catalog = (providers: unknown[]) => ({ providers });

describe('verified catalog ingestion', () => {
  test('1. a valid verified catalog is accepted', () => {
    const r = ingestVerifiedCatalog([], catalog([record()]));
    assert.deepEqual(r.rejected, []);
    assert.deepEqual(r.accepted.map((p) => p.id), ['p']);
    assert.deepEqual(r.summary.added, ['p']);
    assert.deepEqual(r.registry.map((p) => p.id), ['p']);
    assert.doesNotThrow(() => validateRegistryFile({ providers: r.registry }));
  });

  test('2. missing verification metadata is rejected', () => {
    const noFree = ingestVerifiedCatalog([], catalog([{ ...record(), freeStatusVerified: false }]));
    assert.equal(noFree.accepted.length, 0);
    assert.match(noFree.rejected[0]?.reason ?? '', /freeStatusVerified/);

    const noCompat = ingestVerifiedCatalog([], catalog([{ ...record(), compatibilityVerified: false }]));
    assert.match(noCompat.rejected[0]?.reason ?? '', /compatibilityVerified/);
  });

  test('3. a model missing a price is rejected', () => {
    // Cast away the type to simulate an incomplete record on disk.
    const bad = record({ models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192 } as never] });
    const r = ingestVerifiedCatalog([], catalog([bad]));
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? '', /no verified price/);
  });

  test('4. a model missing context/capabilities is rejected', () => {
    const noCtx = ingestVerifiedCatalog([], catalog([record({ models: [{ id: 'm1', capabilities: ['text'], price: { inPerMTok: 0, outPerMTok: 0 } } as never] })]));
    assert.match(noCtx.rejected[0]?.reason ?? '', /no verified contextWindow/);

    const noCaps = ingestVerifiedCatalog([], catalog([record({ models: [{ id: 'm1', capabilities: [], contextWindow: 8192, price: { inPerMTok: 0, outPerMTok: 0 } }] })]));
    assert.match(noCaps.rejected[0]?.reason ?? '', /no verified capabilities/);
  });

  test('5. an unsupported provider kind is rejected', () => {
    const r = ingestVerifiedCatalog([], catalog([record({ provider: { providerId: 'p', kind: 'grpc', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal' } })]));
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? '', /unsupported provider kind/);
  });

  test('6. an invalid baseUrl is rejected', () => {
    const r = ingestVerifiedCatalog(
      [],
      catalog([record({ candidate: candidate({ baseUrl: 'not-a-url' }), provider: { providerId: 'p', kind: 'openai-compat', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal', baseUrl: 'not-a-url' } })]),
    );
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? '', /invalid baseUrl/);
  });

  test('7. a paid provider remains paid (price preserved)', () => {
    const r = ingestVerifiedCatalog(
      [],
      catalog([record({ models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 1, outPerMTok: 2 }, priceVerifiedAt: '2026-10-01' }] })]),
    );
    assert.equal(r.accepted.length, 1);
    assert.deepEqual(r.accepted[0]?.models[0]?.price, { inPerMTok: 1, outPerMTok: 2 });
  });

  test('8. a free provider requires explicit free evidence', () => {
    const withoutEvidence = ingestVerifiedCatalog([], catalog([{ ...record(), freeStatusVerified: undefined }]));
    assert.equal(withoutEvidence.accepted.length, 0);
    const withEvidence = ingestVerifiedCatalog([], catalog([record({ freeStatusVerified: true })]));
    assert.equal(withEvidence.accepted.length, 1);
  });

  test('9. a malformed catalog is rejected wholesale', () => {
    for (const bad of [null, 42, {}, { providers: 'x' }]) {
      const r = ingestVerifiedCatalog([], bad);
      assert.equal(r.accepted.length, 0);
      assert.equal(r.rejected.length, 1);
      assert.match(r.rejected[0]?.reason ?? '', /providers array/);
    }
  });

  test('10. input immutability', () => {
    const reg: ProviderConfig[] = [];
    const rec = record();
    const cat = catalog([rec]);
    const beforeCat = clone(cat);
    const beforeReg = clone(reg);
    ingestVerifiedCatalog(reg, cat);
    assert.deepEqual(clone(cat), beforeCat);
    assert.deepEqual(clone(reg), beforeReg);
  });

  test('11. deterministic output', () => {
    const cat = catalog([record()]);
    assert.deepEqual(ingestVerifiedCatalog([], cat), ingestVerifiedCatalog([], cat));
  });

  test('12. an unsafe replacement is rejected', () => {
    const existing: ProviderConfig[] = [
      {
        id: 'p',
        kind: 'openai-compat',
        baseUrl: 'https://p.test/v1',
        apiKeyEnv: 'P_KEY',
        maxPrivacy: 'internal',
        models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 1, outPerMTok: 2 }, priceVerifiedAt: '2026-10-01' }],
      },
    ];
    // Incoming free model would downgrade the verified paid provider.
    const r = ingestVerifiedCatalog(existing, catalog([record()]));
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? '', /downgrade verified paid/);
    assert.deepEqual(r.registry, existing, 'registry unchanged on rejection');
  });
});
