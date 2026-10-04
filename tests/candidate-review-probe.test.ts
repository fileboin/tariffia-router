import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { reviewCandidate, reviewCandidates } from '../src/candidate-review.js';
import type { CandidateProvider } from '../src/seed-candidates.js';
import type { ProbeResult } from '../src/candidate-probe.js';

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

const probe = (status: ProbeResult['status'], reason: ProbeResult['reason']): ProbeResult => ({
  candidateId: 'p',
  status,
  reason,
});

describe('review with probe evidence', () => {
  test('successful probe satisfies endpoint/compatibility; free status still needs review', () => {
    const { bucket, reviewed } = reviewCandidate(candidate(), probe('reachable', 'ok'));
    assert.equal(bucket, 'needsReview');
    assert.ok(!reviewed.reasons.includes('unknown_compatibility'), 'probe proves compatibility');
    assert.ok(reviewed.reasons.includes('free_status_unverified'), 'probe does NOT prove free');
  });

  test('successful probe + explicitly verified free status is eligible', () => {
    const c = { ...candidate(), freeStatusVerified: true } as CandidateProvider;
    const { bucket, reviewed } = reviewCandidate(c, probe('reachable', 'ok'));
    assert.equal(bucket, 'eligible');
    assert.deepEqual(reviewed.reasons, ['ok']);
  });

  test('unreachable probe keeps the candidate in needsReview with a reason', () => {
    const { bucket, reviewed } = reviewCandidate(candidate(), probe('unreachable', 'server_error'));
    assert.equal(bucket, 'needsReview');
    assert.ok(reviewed.reasons.includes('probe_unreachable'));
    assert.ok(reviewed.reasons.includes('free_status_unverified'));
  });

  test('invalid probe keeps the candidate in needsReview with a reason', () => {
    const { bucket, reviewed } = reviewCandidate(candidate(), probe('invalid', 'invalid_schema'));
    assert.equal(bucket, 'needsReview');
    assert.ok(reviewed.reasons.includes('probe_invalid'));
  });

  test('unsupported / no baseUrl is needsReview with a probe reason', () => {
    const c = candidate();
    delete (c as { baseUrl?: string }).baseUrl;
    const { bucket, reviewed } = reviewCandidate(c, probe('unsupported', 'no_base_url'));
    assert.equal(bucket, 'needsReview');
    assert.ok(reviewed.reasons.includes('missing_base_url'));
    assert.ok(reviewed.reasons.includes('probe_unsupported'));
  });

  test('a successful probe does NOT mark the provider as free', () => {
    const c = candidate();
    const { reviewed } = reviewCandidate(c, probe('reachable', 'ok'));
    // no free claim is created anywhere on the candidate or the review
    assert.equal((c as { freeStatusVerified?: boolean }).freeStatusVerified, undefined);
    assert.ok(reviewed.reasons.includes('free_status_unverified'));
    assert.ok(!reviewed.reasons.includes('ok'));
  });

  test('a probe cannot rescue a structurally rejected candidate', () => {
    const { bucket, reviewed } = reviewCandidate(candidate({ models: [] }), probe('reachable', 'ok'));
    assert.equal(bucket, 'rejected');
    assert.ok(reviewed.reasons.includes('no_models'));
  });

  test('behavior is unchanged when no probe evidence is supplied', () => {
    const c = candidate();
    const without = reviewCandidate(c);
    assert.equal(without.bucket, 'needsReview');
    assert.ok(without.reviewed.reasons.includes('unknown_compatibility'));
    assert.ok(without.reviewed.reasons.includes('free_status_unverified'));
    // No probe-specific reasons appear.
    for (const r of without.reviewed.reasons) assert.ok(!r.startsWith('probe_'));
  });

  test('reviewCandidates accepts a probe map and preserves per-candidate behavior', () => {
    const list = [candidate({ candidateId: 'a' }), candidate({ candidateId: 'b' })];
    const probes = new Map<string, ProbeResult>([
      ['a', { candidateId: 'a', status: 'reachable', reason: 'ok' }],
      ['b', { candidateId: 'b', status: 'unreachable', reason: 'network_error' }],
    ]);
    const result = reviewCandidates(list, probes);
    assert.equal(result.needsReview.length, 2);
    assert.ok(result.needsReview[0]?.reasons.includes('free_status_unverified'));
    assert.ok(!result.needsReview[0]?.reasons.includes('probe_unreachable'));
    assert.ok(result.needsReview[1]?.reasons.includes('probe_unreachable'));
  });

  test('reviewCandidates with no probes matches the original behavior', () => {
    const list = [candidate(), candidate({ name: '' })];
    const a = reviewCandidates(list);
    const b = reviewCandidates(list, undefined);
    assert.deepEqual(a.rejected.length, b.rejected.length);
    assert.deepEqual(a.needsReview.length, b.needsReview.length);
  });
});
