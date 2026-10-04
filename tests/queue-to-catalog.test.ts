import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { queueToCatalog, type VerifiedQueuePayload } from '../src/queue-to-catalog.js';
import { ingestVerifiedCatalog } from '../src/catalog-ingest.js';
import type { VerificationQueueItem } from '../src/verification-queue.js';
import type { ActivationResult } from '../src/activation-gate.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function item(over: Partial<VerificationQueueItem> = {}): VerificationQueueItem {
  return {
    candidateId: 'p',
    name: 'P',
    baseUrl: 'https://p.test/v1',
    models: [{ id: 'm1' }],
    provenance: {
      source: 'https://github.com/mnfst/awesome-free-llm-apis',
      license: 'CC0-1.0',
      lastUpdated: '2026-08-21',
      category: 'provider_api',
      retrievedAt: '2026-10-04',
    },
    requiresVerification: true,
    bucket: 'eligible',
    endpointVerified: true,
    compatibilityVerified: true,
    freeStatus: 'verified_free',
    reasons: ['ok'],
    fullyVerified: true,
    ...over,
  };
}

const eligible: ActivationResult = { candidateId: 'p', eligible: true, reasons: ['eligible'] };

function payload(over: Partial<VerifiedQueuePayload> = {}): VerifiedQueuePayload {
  return {
    activation: eligible,
    provider: { providerId: 'p', kind: 'openai-compat', apiKeyEnv: 'P_KEY', maxPrivacy: 'internal' },
    models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 0, outPerMTok: 0 } }],
    freeStatusVerified: true,
    compatibilityVerified: true,
    ...over,
  };
}

const payloads = (p: VerifiedQueuePayload) => new Map([['p', p]]);

describe('queue -> verified catalog', () => {
  test('1. fully verified item becomes a catalog record', () => {
    const r = queueToCatalog([item()], { payloads: payloads(payload()) });
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.included, ['p']);
    assert.equal(r.catalog.providers.length, 1);
    assert.equal(r.catalog.providers[0]?.provider.providerId, 'p');
    // And it is consumable by the existing ingestion layer.
    const ingested = ingestVerifiedCatalog([], r.catalog);
    assert.deepEqual(ingested.accepted.map((x) => x.id), ['p']);
  });

  test('2. an unverified item is excluded', () => {
    const r = queueToCatalog([item({ fullyVerified: false })], { payloads: payloads(payload()) });
    assert.equal(r.catalog.providers.length, 0);
    assert.deepEqual(r.skipped, [{ candidateId: 'p', reason: 'not fully verified' }]);
  });

  test('3. a partially verified item is excluded', () => {
    // freeStatus not verified, but fullyVerified accidentally true -> payload
    // gate still refuses because the payload must be explicit.
    const r = queueToCatalog([item()], { payloads: payloads({ ...payload(), freeStatusVerified: false }) });
    assert.equal(r.catalog.providers.length, 0);
    assert.match(r.skipped[0]?.reason ?? '', /free status is not explicitly verified/);
  });

  test('4. a fully verified item without a payload is excluded (missing required metadata)', () => {
    const r = queueToCatalog([item()], { payloads: new Map() });
    assert.equal(r.catalog.providers.length, 0);
    assert.match(r.skipped[0]?.reason ?? '', /no explicit verified payload/);
  });

  test('5. no inferred fields are added', () => {
    const r = queueToCatalog([item()], { payloads: payloads(payload()) });
    const rec = r.catalog.providers[0]!;
    // The record only carries what was supplied; no invented kind if omitted is
    // impossible (kind is required), but no price/privacy/risk is added beyond
    // the payload.
    assert.deepEqual(Object.keys(rec).sort(), ['activation', 'candidate', 'compatibilityVerified', 'freeStatusVerified', 'models', 'provider']);
    assert.ok(!('risk' in (rec.provider as object)));
    assert.ok(!('quota' in (rec.provider as object)));
  });

  test('6. free status remains explicit', () => {
    const r = queueToCatalog([item()], { payloads: payloads(payload()) });
    assert.equal(r.catalog.providers[0]?.freeStatusVerified, true);
    assert.deepEqual(r.catalog.providers[0]?.models[0]?.price, { inPerMTok: 0, outPerMTok: 0 });
  });

  test('7. paid status remains explicit (never converted to free)', () => {
    const p = payload({ models: [{ id: 'm1', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 1, outPerMTok: 2 }, priceVerifiedAt: '2026-10-01' }] });
    const r = queueToCatalog([item()], { payloads: payloads(p) });
    assert.deepEqual(r.catalog.providers[0]?.models[0]?.price, { inPerMTok: 1, outPerMTok: 2 });
  });

  test('8. provenance is preserved', () => {
    const it = item();
    const r = queueToCatalog([it], { payloads: payloads(payload()) });
    assert.deepEqual(r.catalog.providers[0]?.candidate.provenance, it.provenance);
  });

  test('9. input immutability', () => {
    const items = [item()];
    const p = payload();
    const beforeItems = clone(items);
    const beforePayload = clone(p);
    queueToCatalog(items, { payloads: payloads(p) });
    assert.deepEqual(clone(items), beforeItems);
    assert.deepEqual(clone(p), beforePayload);
  });

  test('10. deterministic output', () => {
    const items = [item()];
    assert.deepEqual(
      queueToCatalog(items, { payloads: payloads(payload()) }),
      queueToCatalog(items, { payloads: payloads(payload()) }),
    );
  });

  test('an ineligible payload activation is skipped', () => {
    const r = queueToCatalog([item()], { payloads: payloads({ ...payload(), activation: { candidateId: 'p', eligible: false, reasons: ['missing_identity'] } }) });
    assert.match(r.skipped[0]?.reason ?? '', /activation is not eligible/);
  });
});
