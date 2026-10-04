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
    provider: {
      providerId: 'p',
      kind: 'openai-compat',
      apiKeyEnv: 'P_KEY',
      maxPrivacy: 'internal',
      risk: 'ok',
      riskVerifiedAt: '2026-10-01',
    },
    models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 0, outPerMTok: 0 } }],
    freeStatusVerified: true,
    compatibilityVerified: true,
    ...over,
  };
}

const catalog = (providers: unknown[]) => ({ providers });

describe('catalog ingestion gated by the provenance audit', () => {
  test('1. valid fully evidenced catalog is accepted', () => {
    const r = ingestVerifiedCatalog([], catalog([record()]));
    assert.deepEqual(r.rejected, []);
    assert.deepEqual(r.accepted.map((p) => p.id), ['p']);
    assert.doesNotThrow(() => validateRegistryFile({ providers: r.registry }));
  });

  test('2. missing provider provenance is rejected', () => {
    const rec = record();
    delete (rec.candidate as { provenance?: unknown }).provenance;
    const r = ingestVerifiedCatalog([], catalog([rec]));
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? '', /missing_source/);
  });

  test('3. missing verification date is rejected', () => {
    const rec = record();
    delete (rec.provider as { riskVerifiedAt?: unknown }).riskVerifiedAt;
    delete (rec.candidate.provenance as { retrievedAt?: unknown }).retrievedAt;
    const r = ingestVerifiedCatalog([], catalog([rec]));
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? '', /missing_verification_date/);
  });

  test('4. missing free-status evidence is rejected', () => {
    const r = ingestVerifiedCatalog([], catalog([{ ...record(), freeStatusVerified: false }]));
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? '', /freeStatusVerified/);
  });

  test('5. missing model price evidence is rejected', () => {
    const rec = record({
      models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 1, outPerMTok: 2 } }],
    });
    const r = ingestVerifiedCatalog([], catalog([rec]));
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? '', /provenance audit failed: missing_price_evidence/);
  });

  test('6. warnings only do not block ingestion', () => {
    const rec = record();
    // Drop optional fields -> warnings (missing_risk, missing_quality), no errors.
    delete (rec.provider as { risk?: unknown }).risk;
    const r = ingestVerifiedCatalog([], catalog([rec]));
    assert.deepEqual(r.rejected, []);
    assert.deepEqual(r.accepted.map((p) => p.id), ['p']);
  });

  test('7. existing unsafe replacement protections still work', () => {
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
    const r = ingestVerifiedCatalog(existing, catalog([record()])); // free -> would downgrade paid
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? '', /downgrade verified paid/);
    assert.deepEqual(r.registry, existing);
  });

  test('8. a malformed catalog is rejected', () => {
    for (const bad of [null, 42, {}, { providers: 'x' }]) {
      const r = ingestVerifiedCatalog([], bad);
      assert.equal(r.accepted.length, 0);
      assert.match(r.rejected[0]?.reason ?? '', /providers array/);
    }
  });

  test('9. no input mutation', () => {
    const reg: ProviderConfig[] = [];
    const cat = catalog([record()]);
    const beforeCat = clone(cat);
    const beforeReg = clone(reg);
    ingestVerifiedCatalog(reg, cat);
    assert.deepEqual(clone(cat), beforeCat);
    assert.deepEqual(clone(reg), beforeReg);
  });

  test('10. deterministic result', () => {
    const cat = catalog([record()]);
    assert.deepEqual(ingestVerifiedCatalog([], cat), ingestVerifiedCatalog([], cat));
  });
});
