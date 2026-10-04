import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { parseSeed } from '../src/seed-import.js';
import { toCandidates, type CandidateProvider } from '../src/seed-candidates.js';
import { reviewCandidate } from '../src/candidate-review.js';
import { determineFreeStatus } from '../src/free-status-evidence.js';
import { evaluateActivation, type ActivationIdentity } from '../src/activation-gate.js';
import { buildProviderConfig } from '../src/provider-builder.js';
import { mergeProviderConfig } from '../src/registry-merge.js';
import { activateProvider } from '../src/provider-activation.js';
import { validateRegistryFile } from '../src/core/config.js';
import type { ProbeResult } from '../src/candidate-probe.js';
import type { ProviderConfig } from '../src/core/types.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/**
 * The whole pipeline from one seed provider, using mock evidence only.
 * No network, no discovery, no routing.
 */
function seedCandidate(): CandidateProvider {
  const seed = parseSeed({
    lastUpdated: '2026-08-21',
    providers: [
      {
        name: 'Example Free',
        category: 'provider_api',
        country: 'US',
        flag: '',
        url: 'https://example.test/keys',
        baseUrl: 'https://example.test/v1',
        description: 'Permanent free tier, no credit card required.',
        models: [{ id: 'ex-1', name: 'ex-1', context: '32K', maxOutput: '8K', modality: 'Text', rateLimit: '20 RPM' }],
        notes: [],
      },
    ],
  });
  const [c] = toCandidates(seed);
  assert.ok(c);
  return c;
}

const reachable: ProbeResult = { candidateId: 'example-free', status: 'reachable', reason: 'ok' };
const verifiedFree = {
  kind: 'documented_zero_price' as const,
  source: 'https://example.test/pricing',
  verifiedAt: '2026-10-01',
};
const identity: ActivationIdentity = { providerId: 'example-free', kind: 'openai-compat', apiKeyEnv: 'EXAMPLE_FREE_KEY' };
const models = [{ id: 'ex-1', capabilities: ['text' as const], contextWindow: 32768, price: { inPerMTok: 0, outPerMTok: 0 } }];

/** Run steps 1-5: review, probe evidence, free evidence, gate. */
function gate(candidate: CandidateProvider, probe: ProbeResult | undefined, free: ReturnType<typeof determineFreeStatus>) {
  const review = reviewCandidate(candidate, probe);
  const status = free;
  const activation = evaluateActivation({
    candidate,
    compatibilityVerified: true, // a human verified compatibility; probe also reachable in the success path
    probe,
    freeStatus: status,
    identity,
  });
  return { review, status, activation };
}

describe('verified provider pipeline (end to end, mock evidence)', () => {
  test('1. fully verified free candidate + approved -> activated', () => {
    const c = seedCandidate();
    const free = determineFreeStatus(c, verifiedFree);
    const { activation } = gate(c, reachable, free);
    assert.equal(activation.eligible, true);

    const built = buildProviderConfig({
      candidate: c,
      activation,
      provider: { providerId: identity.providerId!, kind: identity.kind!, apiKeyEnv: identity.apiKeyEnv!, maxPrivacy: 'internal' },
      models,
    });
    assert.equal(built.ok, true);

    const merged = built.ok ? mergeProviderConfig([], built.config) : undefined;
    assert.equal(merged?.ok, true);

    const activated = activateProvider([], {
      approved: true,
      candidate: c,
      activation,
      provider: { providerId: 'example-free', kind: 'openai-compat', apiKeyEnv: 'EXAMPLE_FREE_KEY', maxPrivacy: 'internal' },
      models,
    });
    assert.equal(activated.ok, true);
    assert.deepEqual(activated.registry.map((p) => p.id), ['example-free']);
    assert.doesNotThrow(() => validateRegistryFile({ providers: activated.registry }));
  });

  test('2. reachable but free status unverified -> rejected', () => {
    const c = seedCandidate();
    const free = determineFreeStatus(c); // no evidence
    const { activation } = gate(c, reachable, free);
    assert.equal(activation.eligible, false);
    assert.ok(activation.reasons.includes('free_status_not_verified'));
    const activated = activateProvider([], {
      approved: true,
      candidate: c,
      activation,
      provider: { providerId: 'example-free', kind: 'openai-compat', apiKeyEnv: 'EXAMPLE_FREE_KEY', maxPrivacy: 'internal' },
      models,
    });
    assert.equal(activated.ok, false);
  });

  test('3. reachable + verified paid -> rejected', () => {
    const c = seedCandidate();
    const free = determineFreeStatus(c, { kind: 'documented_paid_only', source: 'https://example.test/pricing', verifiedAt: '2026-10-01' });
    const { activation } = gate(c, reachable, free);
    assert.equal(activation.eligible, false);
    assert.ok(activation.reasons.includes('free_status_conflict'));
  });

  test('4. unreachable candidate -> rejected', () => {
    const c = seedCandidate();
    const free = determineFreeStatus(c, verifiedFree);
    const { activation } = gate(c, { candidateId: c.candidateId, status: 'unreachable', reason: 'network_error' }, free);
    assert.equal(activation.eligible, false);
    assert.ok(activation.reasons.includes('probe_not_reachable'));
  });

  test('5. compatibility unverified -> rejected', () => {
    const c = seedCandidate();
    const free = determineFreeStatus(c, verifiedFree);
    const activation = evaluateActivation({
      candidate: c,
      compatibilityVerified: false,
      probe: reachable,
      freeStatus: free,
      identity,
    });
    assert.equal(activation.eligible, false);
    assert.ok(activation.reasons.includes('compatibility_unverified'));
  });

  test('6. approved=false -> rejected even when eligible', () => {
    const c = seedCandidate();
    const free = determineFreeStatus(c, verifiedFree);
    const { activation } = gate(c, reachable, free);
    assert.equal(activation.eligible, true);
    const activated = activateProvider([], {
      approved: false,
      candidate: c,
      activation,
      provider: { providerId: 'example-free', kind: 'openai-compat', apiKeyEnv: 'EXAMPLE_FREE_KEY', maxPrivacy: 'internal' },
      models,
    });
    assert.equal(activated.ok, false);
    assert.match(activated.reason ?? '', /not approved/);
  });

  test('7. invalid provider metadata -> rejected', () => {
    const c = seedCandidate();
    const free = determineFreeStatus(c, verifiedFree);
    const { activation } = gate(c, reachable, free);
    const activated = activateProvider([], {
      approved: true,
      candidate: c,
      activation,
      provider: { providerId: 'example-free', kind: 'grpc', apiKeyEnv: 'EXAMPLE_FREE_KEY', maxPrivacy: 'internal' },
      models,
    });
    assert.equal(activated.ok, false);
    assert.match(activated.reason ?? '', /unsupported provider kind/);
  });

  test('8. existing registry is protected from an unsafe downgrade', () => {
    const existing: ProviderConfig[] = [
      {
        id: 'example-free',
        kind: 'openai-compat',
        baseUrl: 'https://example.test/v1',
        apiKeyEnv: 'EXAMPLE_FREE_KEY',
        maxPrivacy: 'confidential',
        models: [
          { id: 'ex-1', capabilities: ['text'], contextWindow: 32768, price: { inPerMTok: 1, outPerMTok: 2 }, priceVerifiedAt: '2026-10-01' },
        ],
      },
    ];
    const c = seedCandidate();
    const free = determineFreeStatus(c, verifiedFree);
    const { activation } = gate(c, reachable, free);
    // The incoming provider is free + lower privacy: both a downgrade.
    const activated = activateProvider(existing, {
      approved: true,
      candidate: c,
      activation,
      provider: { providerId: 'example-free', kind: 'openai-compat', apiKeyEnv: 'EXAMPLE_FREE_KEY', maxPrivacy: 'internal' },
      models,
    });
    assert.equal(activated.ok, false);
    assert.match(activated.reason ?? '', /downgrade verified paid|lower privacy/);
    // The existing registry is returned unchanged.
    assert.deepEqual(activated.registry, existing);
  });

  test('9. no input mutation across the whole pipeline', () => {
    const c = seedCandidate();
    const beforeC = clone(c);
    const free = determineFreeStatus(c, verifiedFree);
    const { activation } = gate(c, reachable, free);
    const providers: ProviderConfig[] = [];
    const beforeProviders = clone(providers);
    activateProvider(providers, {
      approved: true,
      candidate: c,
      activation,
      provider: { providerId: 'example-free', kind: 'openai-compat', apiKeyEnv: 'EXAMPLE_FREE_KEY', maxPrivacy: 'internal' },
      models,
    });
    assert.deepEqual(clone(c), beforeC, 'candidate unchanged');
    assert.deepEqual(clone(providers), beforeProviders, 'registry unchanged');
  });

  test('10. deterministic final registry', () => {
    const run = () => {
      const c = seedCandidate();
      const free = determineFreeStatus(c, verifiedFree);
      const { activation } = gate(c, reachable, free);
      return activateProvider([], {
        approved: true,
        candidate: c,
        activation,
        provider: { providerId: 'example-free', kind: 'openai-compat', apiKeyEnv: 'EXAMPLE_FREE_KEY', maxPrivacy: 'internal' },
        models,
      });
    };
    assert.deepEqual(run(), run());
  });
});
