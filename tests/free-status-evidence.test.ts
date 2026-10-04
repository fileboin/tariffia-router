import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { determineFreeStatus, determineFreeStatuses } from '../src/free-status-evidence.js';
import { reviewCandidate } from '../src/candidate-review.js';
import { toCandidates } from '../src/seed-candidates.js';
import { parseSeed } from '../src/seed-import.js';
import type { CandidateProvider } from '../src/seed-candidates.js';
import type { ProbeResult } from '../src/candidate-probe.js';

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

const reachable: ProbeResult = { candidateId: 'p', status: 'reachable', reason: 'ok' };

describe('free-status evidence', () => {
  test('explicit verified free evidence (documented zero price)', () => {
    const r = determineFreeStatus(candidate(), {
      kind: 'documented_zero_price',
      source: 'https://p.test/pricing',
      verifiedAt: '2026-10-01',
      note: 'all models $0/MTok',
    });
    assert.equal(r.status, 'verified_free');
    assert.equal(r.freeStatusVerified, true);
    assert.equal(r.reason, 'documented_zero_price');
  });

  test('explicit verified free evidence (documented free tier)', () => {
    const r = determineFreeStatus(candidate(), {
      kind: 'documented_free_tier',
      source: 'https://p.test/docs/free',
      verifiedAt: '2026-10-01',
    });
    assert.equal(r.freeStatusVerified, true);
    assert.equal(r.reason, 'documented_free_tier');
  });

  test('explicit non-free evidence', () => {
    const r = determineFreeStatus(candidate(), {
      kind: 'documented_paid_only',
      source: 'https://p.test/pricing',
      verifiedAt: '2026-10-01',
    });
    assert.equal(r.status, 'verified_not_free');
    assert.equal(r.freeStatusVerified, false);
    assert.equal(r.reason, 'documented_paid_only');
  });

  test('missing evidence remains unverified', () => {
    const r = determineFreeStatus(candidate());
    assert.equal(r.status, 'unverified');
    assert.equal(r.freeStatusVerified, false);
    assert.equal(r.reason, 'no_evidence');
    assert.equal(r.evidenceKind, 'none');
  });

  test('insufficient evidence (no source/date) remains unverified', () => {
    const r = determineFreeStatus(candidate(), { kind: 'documented_free_tier' });
    assert.equal(r.status, 'unverified');
    assert.equal(r.freeStatusVerified, false);
    assert.equal(r.reason, 'insufficient_evidence');
    assert.equal(r.insufficient, true);
  });

  test('a successful /models probe does NOT imply free', () => {
    // Pass the same candidate through review with a reachable probe and no free
    // evidence: it must still be flagged free_status_unverified.
    const { reviewed } = reviewCandidate(candidate(), reachable);
    assert.ok(reviewed.reasons.includes('free_status_unverified'));
    // And free-status determination with no evidence is unverified regardless.
    assert.equal(determineFreeStatus(candidate()).freeStatusVerified, false);
  });

  test('seed membership does NOT imply free', () => {
    const seed = parseSeed({
      lastUpdated: '2026-08-21',
      providers: [
        { name: 'SeedFree', category: 'provider_api', country: '', flag: '', url: '', description: 'permanently free', models: [{ id: 'm' }], notes: [] },
      ],
    });
    const [c] = toCandidates(seed);
    assert.ok(c);
    const r = determineFreeStatus(c);
    assert.equal(r.freeStatusVerified, false, 'being in the seed list is not free evidence');
    assert.equal(r.reason, 'no_evidence');
  });

  test('free-status determination does not mutate the candidate', () => {
    const c = candidate();
    const before = clone(c);
    determineFreeStatus(c, { kind: 'documented_zero_price', source: 'https://x', verifiedAt: '2026-10-01' });
    assert.deepEqual(clone(c), before);
  });

  test('an explicit verified-free result can satisfy review when combined with a reachable probe', () => {
    const c = candidate();
    const free = determineFreeStatus(c, { kind: 'documented_free_tier', source: 'https://x', verifiedAt: '2026-10-01' });
    const withFree = { ...c, freeStatusVerified: free.freeStatusVerified } as CandidateProvider;
    const { bucket, reviewed } = reviewCandidate(withFree, reachable);
    assert.equal(bucket, 'eligible');
    assert.deepEqual(reviewed.reasons, ['ok']);
  });

  test('determineFreeStatuses maps evidence per candidate and leaves the rest unverified', () => {
    const list = [candidate({ candidateId: 'a' }), candidate({ candidateId: 'b' })];
    const evidence = new Map([
      ['a', { kind: 'documented_zero_price' as const, source: 'https://a', verifiedAt: '2026-10-01' }],
    ]);
    const results = determineFreeStatuses(list, evidence);
    assert.equal(results[0]?.status, 'verified_free');
    assert.equal(results[1]?.status, 'unverified');
  });
});
