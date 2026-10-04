import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { auditCatalogProvenance } from '../src/provenance-audit.js';
import type { CatalogProviderRecord } from '../src/catalog-ingest.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function record(over: Partial<CatalogProviderRecord> = {}): CatalogProviderRecord {
  return {
    candidate: {
      candidateId: 'p',
      name: 'P',
      unverified: true,
      baseUrl: 'https://p.test/v1',
      url: 'https://p.test/keys',
      description: 'free',
      models: [{ id: 'm1' }],
      notes: [],
      provenance: {
        source: 'https://github.com/mnfst/awesome-free-llm-apis',
        license: 'CC0-1.0',
        lastUpdated: '2026-08-21',
        category: 'provider_api',
        retrievedAt: '2026-10-04',
      },
    },
    activation: { candidateId: 'p', eligible: true, reasons: ['eligible'] },
    provider: { providerId: 'p', kind: 'openai-compat', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal', risk: 'ok', riskVerifiedAt: '2026-10-01' },
    models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 0.5 }],
    freeStatusVerified: true,
    compatibilityVerified: true,
    ...over,
  };
}

const codes = (r: { errors: { code: string }[]; warnings: { code: string }[] }) => ({
  errors: r.errors.map((e) => e.code).sort(),
  warnings: r.warnings.map((w) => w.code).sort(),
});

describe('verification provenance audit', () => {
  test('1. fully evidenced provider/model is valid', () => {
    const r = auditCatalogProvenance([record()]);
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.summary.providers, 1);
    assert.equal(r.summary.models, 1);
  });

  test('2. missing provider provenance is invalid', () => {
    const rec = record();
    delete (rec.candidate as { provenance?: unknown }).provenance;
    const r = auditCatalogProvenance([rec]);
    assert.equal(r.valid, false);
    assert.ok(codes(r).errors.includes('missing_source'));
  });

  test('3. missing model price evidence is invalid', () => {
    // Non-zero price with no priceVerifiedAt.
    const rec = record({
      models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 1, outPerMTok: 2 } }],
    });
    const r = auditCatalogProvenance([rec]);
    assert.equal(r.valid, false);
    assert.ok(codes(r).errors.includes('missing_price_evidence'));
  });

  test('4. missing free-status evidence is invalid', () => {
    const r = auditCatalogProvenance([record({ freeStatusVerified: false })]);
    assert.equal(r.valid, false);
    assert.ok(codes(r).errors.includes('missing_free_status_evidence'));
  });

  test('5. missing compatibility evidence is invalid', () => {
    const r = auditCatalogProvenance([record({ compatibilityVerified: false })]);
    assert.equal(r.valid, false);
    assert.ok(codes(r).errors.includes('missing_compatibility_evidence'));
  });

  test('6. missing verification date is invalid', () => {
    const rec = record();
    delete (rec.provider as { riskVerifiedAt?: unknown }).riskVerifiedAt;
    // retrieveAt is the fallback; remove it too to force the error.
    delete (rec.candidate.provenance as { retrievedAt?: unknown }).retrievedAt;
    const r = auditCatalogProvenance([rec]);
    assert.equal(r.valid, false);
    assert.ok(codes(r).errors.includes('missing_verification_date'));
  });

  test('7. incomplete model evidence is invalid (missing price/caps/context)', () => {
    const rec = record({
      models: [{ id: 'm1', capabilities: [], contextWindow: 0 } as never],
    });
    const r = auditCatalogProvenance([rec]);
    assert.equal(r.valid, false);
    const c = codes(r).errors;
    assert.ok(c.includes('missing_price'));
    assert.ok(c.includes('missing_capabilities'));
    assert.ok(c.includes('missing_context'));
  });

  test('8. warnings do not become errors', () => {
    const rec = record();
    delete (rec.provider as { risk?: unknown }).risk; // optional -> warning
    delete (rec.models[0] as { quality?: unknown }).quality; // optional -> warning
    const r = auditCatalogProvenance([rec]);
    assert.equal(r.valid, true, 'still valid: only optional fields are missing');
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => w.code === 'missing_risk'));
    assert.ok(r.warnings.some((w) => w.code === 'missing_quality'));
  });

  test('9. no mutation', () => {
    const rec = record();
    const before = clone(rec);
    auditCatalogProvenance([rec]);
    assert.deepEqual(clone(rec), before);
  });

  test('10. deterministic result', () => {
    const rec = record();
    assert.deepEqual(auditCatalogProvenance([rec]), auditCatalogProvenance([rec]));
  });

  test('an empty catalog is valid with zero counts', () => {
    const r = auditCatalogProvenance([]);
    assert.equal(r.valid, true);
    assert.deepEqual(r.summary, { providers: 0, models: 0, errors: 0, warnings: 0 });
  });
});
