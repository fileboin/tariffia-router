import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSeed } from '../src/seed-import.js';
import { toCandidates, type CandidateProvider } from '../src/seed-candidates.js';
import { reviewCandidate, reviewCandidates } from '../src/candidate-review.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
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

describe('candidate review — classification', () => {
  test('a complete seed candidate needs review (compat/free unverified)', () => {
    const { bucket, reviewed } = reviewCandidate(candidate());
    assert.equal(bucket, 'needsReview');
    assert.ok(reviewed.reasons.includes('unknown_compatibility'));
    assert.ok(reviewed.reasons.includes('free_status_unverified'));
    assert.ok(!reviewed.reasons.includes('missing_base_url'));
  });

  test('a candidate with verified compatibility and free status is eligible', () => {
    const c = { ...candidate(), compatibilityVerified: true, freeStatusVerified: true } as CandidateProvider;
    const { bucket, reviewed } = reviewCandidate(c);
    assert.equal(bucket, 'eligible');
    assert.deepEqual(reviewed.reasons, ['ok']);
  });

  test('missing baseUrl is needsReview, not rejected', () => {
    const c = candidate();
    delete (c as { baseUrl?: string }).baseUrl;
    const { bucket, reviewed } = reviewCandidate(c);
    assert.equal(bucket, 'needsReview');
    assert.ok(reviewed.reasons.includes('missing_base_url'));
  });

  test('missing models is rejected', () => {
    const { bucket, reviewed } = reviewCandidate(candidate({ models: [] }));
    assert.equal(bucket, 'rejected');
    assert.ok(reviewed.reasons.includes('no_models'));
  });

  test('unknown free status keeps a candidate out of eligible', () => {
    const c = { ...candidate(), compatibilityVerified: true } as CandidateProvider;
    const { bucket, reviewed } = reviewCandidate(c);
    assert.equal(bucket, 'needsReview');
    assert.ok(reviewed.reasons.includes('free_status_unverified'));
  });

  test('a model without an id is rejected', () => {
    const { bucket, reviewed } = reviewCandidate(candidate({ models: [{ id: '' }] }));
    assert.equal(bucket, 'rejected');
    assert.ok(reviewed.reasons.includes('model_without_id'));
  });

  test('a nameless provider is rejected', () => {
    const { bucket, reviewed } = reviewCandidate(candidate({ name: '' }));
    assert.equal(bucket, 'rejected');
    assert.ok(reviewed.reasons.includes('no_provider_name'));
  });

  test('a malformed candidate is rejected', () => {
    const broken = { name: 'X', models: [{ id: 'm' }] } as unknown as CandidateProvider;
    const { bucket, reviewed } = reviewCandidate(broken);
    assert.equal(bucket, 'rejected');
    assert.ok(reviewed.reasons.includes('malformed'));
  });
});

describe('candidate review — determinism and purity', () => {
  test('classification is deterministic', () => {
    const list = [candidate(), candidate({ name: '' }), candidate({ models: [] })];
    const a = reviewCandidates(list);
    const b = reviewCandidates(clone(list));
    assert.deepEqual(a.rejected.map((r) => r.candidate), b.rejected.map((r) => r.candidate));
    assert.deepEqual(a.needsReview.map((r) => r.candidate), b.needsReview.map((r) => r.candidate));
  });

  test('the input is not mutated', () => {
    const list = [candidate(), candidate({ name: '' })];
    const before = clone(list);
    reviewCandidates(list);
    assert.deepEqual(clone(list), before);
  });

  test('reviewed candidates are returned by reference, unchanged', () => {
    const c = candidate();
    const { reviewed } = reviewCandidate(c);
    assert.equal(reviewed.candidate, c);
  });

  test('the shipped seed classifies deterministically and never as eligible', async () => {
    const seed = parseSeed(JSON.parse(await readFile(resolve(REPO_ROOT, 'seed/awesome-free-llm-apis.data.json'), 'utf8')) as unknown);
    const result = reviewCandidates(toCandidates(seed));
    assert.equal(result.eligible.length, 0, 'seed candidates are unverified');
    assert.ok(result.needsReview.length > 0);
    // Every needsReview entry carries the unverified-free reason.
    for (const r of result.needsReview) assert.ok(r.reasons.includes('free_status_unverified'));
  });
});
