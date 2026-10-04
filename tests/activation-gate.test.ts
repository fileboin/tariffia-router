import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { evaluateActivation, type ActivationInput } from '../src/activation-gate.js';
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
const free = { status: 'verified_free' as const, freeStatusVerified: true };
const identity = { providerId: 'p', kind: 'openai-compat', apiKeyEnv: 'P_KEY' };

function base(over: Partial<ActivationInput> = {}): ActivationInput {
  return {
    candidate: candidate(),
    compatibilityVerified: true,
    probe: reachable,
    freeStatus: free,
    identity,
    ...over,
  };
}

describe('activation gate', () => {
  test('fully verified candidate is eligible', () => {
    const r = evaluateActivation(base());
    assert.equal(r.eligible, true);
    assert.deepEqual(r.reasons, ['eligible']);
    assert.equal(r.candidateId, 'p');
  });

  test('missing free verification is not eligible', () => {
    const r = evaluateActivation(base({ freeStatus: undefined }));
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes('free_status_not_verified'));
  });

  test('endpoint unreachable is not eligible', () => {
    const r = evaluateActivation(base({ probe: { candidateId: 'p', status: 'unreachable', reason: 'network_error' } }));
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes('probe_not_reachable'));
  });

  test('compatibility unverified is not eligible', () => {
    const r = evaluateActivation(base({ compatibilityVerified: false }));
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes('compatibility_unverified'));
  });

  test('paid evidence is not eligible (conflict)', () => {
    const r = evaluateActivation(base({ freeStatus: { status: 'verified_not_free', freeStatusVerified: false } }));
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes('free_status_conflict'));
    assert.ok(!r.reasons.includes('free_status_not_verified'));
  });

  test('missing provider identity is not eligible', () => {
    const r = evaluateActivation(base({ identity: undefined }));
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes('missing_identity'));
  });

  test('incomplete identity (no apiKeyEnv) is not eligible', () => {
    const r = evaluateActivation(base({ identity: { providerId: 'p', kind: 'openai-compat' } }));
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes('missing_identity'));
  });

  test('conflicting evidence is not eligible (structural rejection + paid)', () => {
    const r = evaluateActivation(
      base({
        candidate: candidate({ models: [] }),
        freeStatus: { status: 'verified_not_free', freeStatusVerified: false },
      }),
    );
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes('structural_rejection'));
    assert.ok(r.reasons.includes('free_status_conflict'));
  });

  test('conflicting evidence: free verified but probe unreachable is not eligible', () => {
    const r = evaluateActivation(base({ probe: { candidateId: 'p', status: 'invalid', reason: 'invalid_schema' } }));
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes('probe_not_reachable'));
    assert.ok(!r.reasons.includes('free_status_not_verified'), 'free evidence stands on its own');
  });

  test('fail closed: an empty input is not eligible', () => {
    const r = evaluateActivation({ candidate: candidate() });
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.length >= 3);
  });

  test('the input is not mutated', () => {
    const input = base();
    const before = clone(input);
    evaluateActivation(input);
    assert.deepEqual(clone(input), before);
  });

  test('deterministic: the same input yields the same result', () => {
    const input = base();
    assert.deepEqual(evaluateActivation(input), evaluateActivation(input));
  });
});
