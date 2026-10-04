import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { validateVerificationEvidence, type VerificationEvidence } from '../src/verification-evidence.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function evidence(over: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    provider: {
      source: 'https://p.test/docs',
      verifiedAt: '2026-10-01',
      compatibility: { source: 'https://p.test/docs/api', verifiedAt: '2026-10-01' },
      freeStatus: { source: 'https://p.test/pricing', verifiedAt: '2026-10-01' },
      privacy: { source: 'https://p.test/privacy', verifiedAt: '2026-10-01' },
      risk: { source: 'https://p.test/terms', verifiedAt: '2026-10-01' },
    },
    models: {
      m1: {
        source: 'https://p.test/docs/models',
        verifiedAt: '2026-10-01',
        price: { source: 'https://p.test/pricing', verifiedAt: '2026-10-01' },
        contextWindow: { source: 'https://p.test/docs/models', verifiedAt: '2026-10-01' },
        capabilities: { source: 'https://p.test/docs/models', verifiedAt: '2026-10-01' },
      },
    },
    ...over,
  };
}

const paths = (e: { path: string }[]) => e.map((x) => x.path).sort();

describe('verification evidence schema', () => {
  test('valid evidence passes', () => {
    const r = validateVerificationEvidence(evidence());
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  test('empty / non-object evidence fails', () => {
    for (const bad of [undefined, null, 42, 'x', []]) {
      const r = validateVerificationEvidence(bad);
      assert.equal(r.valid, false);
    }
  });

  test('missing provider evidence fails', () => {
    const r = validateVerificationEvidence({ models: evidence().models });
    assert.equal(r.valid, false);
    assert.ok(paths(r.errors).includes('provider'));
  });

  test('missing provider fields fail', () => {
    const e = evidence();
    delete (e.provider as { compatibility?: unknown }).compatibility;
    delete (e.provider as { privacy?: unknown }).privacy;
    const r = validateVerificationEvidence(e);
    assert.equal(r.valid, false);
    const p = paths(r.errors);
    assert.ok(p.includes('provider.compatibility'));
    assert.ok(p.includes('provider.privacy'));
  });

  test('missing model evidence fails', () => {
    const r = validateVerificationEvidence({ provider: evidence().provider });
    assert.equal(r.valid, false);
    assert.ok(paths(r.errors).includes('models'));
  });

  test('a model with no evidence entries fails', () => {
    const r = validateVerificationEvidence({ provider: evidence().provider, models: {} });
    assert.equal(r.valid, false);
    assert.ok(paths(r.errors).includes('models'));
  });

  test('missing model fields fail', () => {
    const e = evidence();
    delete (e.models['m1'] as { price?: unknown }).price;
    delete (e.models['m1'] as { capabilities?: unknown }).capabilities;
    const r = validateVerificationEvidence(e);
    assert.equal(r.valid, false);
    const p = paths(r.errors);
    assert.ok(p.includes('models.m1.price'));
    assert.ok(p.includes('models.m1.capabilities'));
  });

  test('malformed URLs fail', () => {
    const e = evidence();
    (e.provider as { source: string }).source = 'not a url';
    (e.models['m1'] as { price: { source: string } }).price.source = 'ftp://x';
    const r = validateVerificationEvidence(e);
    assert.equal(r.valid, false);
    const p = paths(r.errors);
    assert.ok(p.includes('provider.source'));
    assert.ok(p.includes('models.m1.price.source'));
  });

  test('invalid dates fail (format and calendar)', () => {
    const e = evidence();
    (e.provider as { verifiedAt: string }).verifiedAt = 'yesterday';
    (e.models['m1'] as { verifiedAt: string }).verifiedAt = '2026-13-40';
    const r = validateVerificationEvidence(e);
    assert.equal(r.valid, false);
    const p = paths(r.errors);
    assert.ok(p.includes('provider.verifiedAt'));
    assert.ok(p.includes('models.m1.verifiedAt'));
  });

  test('immutability: validation does not mutate the input', () => {
    const e = evidence();
    const before = clone(e);
    validateVerificationEvidence(e);
    assert.deepEqual(clone(e), before);
  });

  test('deterministic: same input gives the same result', () => {
    const e = evidence();
    assert.deepEqual(validateVerificationEvidence(e), validateVerificationEvidence(e));
  });
});
