import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSeed } from '../src/seed-import.js';
import { toCandidates, type CandidateProvider } from '../src/seed-candidates.js';
import { buildVerificationQueue } from '../src/verification-queue.js';
import type { FreeEvidence } from '../src/free-status-evidence.js';
import type { ProbeResult } from '../src/candidate-probe.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

async function shippedCandidates() {
  const text = await readFile(resolve(REPO_ROOT, 'seed/awesome-free-llm-apis.data.json'), 'utf8');
  const seed = parseSeed(JSON.parse(text) as unknown);
  return { seed, candidates: toCandidates(seed) };
}

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

describe('verification queue', () => {
  test('1. a valid seed candidate enters the queue', async () => {
    const { seed, candidates } = await shippedCandidates();
    const q = buildVerificationQueue(candidates, seed.lastUpdated);
    assert.equal(q.items.length, candidates.length);
    assert.ok(q.items.length > 0);
    for (const item of q.items) assert.equal(item.requiresVerification, true);
  });

  test('2. missing baseUrl remains unverified', () => {
    const c = candidate();
    delete (c as { baseUrl?: string }).baseUrl;
    const q = buildVerificationQueue([c], '2026-08-21');
    assert.equal(q.items[0]?.baseUrl, undefined);
    assert.ok(q.items[0]?.reasons.includes('missing_base_url'));
    assert.equal(q.items[0]?.fullyVerified, false);
  });

  test('3. missing model id remains rejected/reviewable', () => {
    const q = buildVerificationQueue([candidate({ models: [{ id: '' }] })], '2026-08-21');
    assert.equal(q.items[0]?.bucket, 'rejected');
    assert.ok(q.items[0]?.reasons.includes('model_without_id'));
  });

  test('4. seed membership does not imply free', async () => {
    const { seed, candidates } = await shippedCandidates();
    const q = buildVerificationQueue(candidates, seed.lastUpdated);
    for (const item of q.items) {
      assert.equal(item.freeStatus, 'unverified', `${item.name} must not be marked free by seed membership`);
      assert.equal(item.fullyVerified, false);
    }
    assert.equal(q.summary.fullyVerified, 0);
  });

  test('5. seed membership does not imply compatibility', async () => {
    const { seed, candidates } = await shippedCandidates();
    const q = buildVerificationQueue(candidates, seed.lastUpdated);
    for (const item of q.items) assert.equal(item.compatibilityVerified, false);
  });

  test('6. provenance is preserved', async () => {
    const { seed, candidates } = await shippedCandidates();
    const q = buildVerificationQueue(candidates, seed.lastUpdated);
    assert.equal(q.lastUpdated, seed.lastUpdated);
    assert.equal(q.license, 'CC0-1.0');
    for (let i = 0; i < q.items.length; i++) {
      assert.deepEqual(q.items[i]?.provenance, candidates[i]?.provenance);
    }
  });

  test('7. no ProviderConfig is generated', async () => {
    const { seed, candidates } = await shippedCandidates();
    const q = buildVerificationQueue(candidates, seed.lastUpdated);
    for (const item of q.items) {
      assert.ok(!('kind' in (item as object)), 'no provider kind');
      assert.ok(!('maxPrivacy' in (item as object)), 'no privacy');
      assert.ok(!('apiKeyEnv' in (item as object)), 'no api key env');
      for (const m of item.models) assert.ok(!('price' in (m as object)), 'no price on models');
    }
  });

  test('8. no registry change (module has no registry input/output)', async () => {
    const { seed, candidates } = await shippedCandidates();
    const q = buildVerificationQueue(candidates, seed.lastUpdated);
    assert.ok(!('registry' in (q as object)));
    assert.ok(!('providers' in (q as object)));
  });

  test('9. input immutability', async () => {
    const { seed, candidates } = await shippedCandidates();
    const beforeSeed = clone(seed);
    const beforeCandidates = clone(candidates);
    buildVerificationQueue(candidates, seed.lastUpdated);
    assert.deepEqual(clone(seed), beforeSeed);
    assert.deepEqual(clone(candidates), beforeCandidates);
  });

  test('10. deterministic output', async () => {
    const { seed, candidates } = await shippedCandidates();
    assert.deepEqual(
      buildVerificationQueue(candidates, seed.lastUpdated),
      buildVerificationQueue(candidates, seed.lastUpdated),
    );
  });

  test('an entry with explicit probe + free + compatibility evidence becomes fully verified', () => {
    const c = candidate();
    const probe: ProbeResult = { candidateId: 'p', status: 'reachable', reason: 'ok' };
    const free: FreeEvidence = { kind: 'documented_zero_price', source: 'https://p.test/pricing', verifiedAt: '2026-10-01' };
    const q = buildVerificationQueue([c], '2026-08-21', {
      probes: new Map([['p', probe]]),
      freeEvidence: new Map([['p', free]]),
      compatibilityVerified: new Map([['p', true]]),
    });
    assert.equal(q.items[0]?.fullyVerified, true);
    assert.equal(q.items[0]?.freeStatus, 'verified_free');
    assert.equal(q.items[0]?.endpointVerified, true);
    assert.equal(q.summary.fullyVerified, 1);
  });
});
