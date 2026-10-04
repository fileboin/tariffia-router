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

const errCodes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe('provenance audit reuses the canonical evidence validator', () => {
  test('1. valid evidence still passes', () => {
    const r = auditCatalogProvenance([record()]);
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  test('2. missing provider evidence fails', () => {
    const rec = record();
    delete (rec.candidate as { provenance?: unknown }).provenance;
    const r = auditCatalogProvenance([rec]);
    assert.equal(r.valid, false);
    assert.ok(errCodes(r).includes('missing_source'));
  });

  test('3. missing model evidence fails', () => {
    const r = auditCatalogProvenance([record({ models: [] })]);
    assert.equal(r.valid, false);
    assert.ok(errCodes(r).includes('no_models'));
  });

  test('4. malformed URL / date fails (canonical validation)', () => {
    // A provenance source that is not a URL is caught by the canonical validator
    // and mapped to missing_source.
    const rec = record();
    (rec.candidate.provenance as { source: string }).source = 'not a url';
    const r = auditCatalogProvenance([rec]);
    assert.equal(r.valid, false);
    assert.ok(errCodes(r).includes('missing_source'));

    // An invalid verification date is mapped to missing_verification_date.
    const rec2 = record();
    (rec2.candidate.provenance as { retrievedAt: string }).retrievedAt = 'not-a-date';
    delete (rec2.provider as { riskVerifiedAt?: unknown }).riskVerifiedAt;
    const r2 = auditCatalogProvenance([rec2]);
    assert.equal(r2.valid, false);
    assert.ok(errCodes(r2).includes('missing_verification_date'));
  });

  test('5. existing provenance error codes remain deterministic', () => {
    const rec = record({ freeStatusVerified: false, compatibilityVerified: false });
    const a = auditCatalogProvenance([rec]);
    const b = auditCatalogProvenance([clone(rec)]);
    assert.deepEqual(a, b);
    assert.ok(errCodes(a).includes('missing_free_status_evidence'));
    assert.ok(errCodes(a).includes('missing_compatibility_evidence'));
  });

  test('6. warnings remain non-blocking', () => {
    const rec = record();
    delete (rec.provider as { risk?: unknown }).risk; // warning
    delete (rec.models[0] as { quality?: unknown }).quality; // warning
    const r = auditCatalogProvenance([rec]);
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => w.code === 'missing_risk'));
  });

  test('7. inputs remain immutable', () => {
    const rec = record();
    const before = clone(rec);
    auditCatalogProvenance([rec]);
    assert.deepEqual(clone(rec), before);
  });

  test('8. no duplicate errors are emitted for the same code/id', () => {
    const rec = record();
    delete (rec.candidate as { provenance?: unknown }).provenance;
    const r = auditCatalogProvenance([rec]);
    const sourceErrors = r.errors.filter((e) => e.code === 'missing_source');
    assert.equal(sourceErrors.length, 1, 'missing_source is reported once');
  });
});
