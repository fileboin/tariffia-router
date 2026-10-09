import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { rankCandidates, scoreCandidate, type RankingInput, type ScoreWeights } from '../src/core/scorer.js';
import { Router } from '../src/core/router.js';
import { Registry } from '../src/core/registry.js';
import { HealthTracker } from '../src/core/health.js';
import { InferenceMesh } from '../src/core/mesh.js';
import type { Candidate, Capability, ProviderConfig } from '../src/core/types.js';
import { FIXTURE_ENV, fakeFetch, fixtureProviders, okChat } from './helpers.js';

function candidate(key: string, cw: number, caps: Capability[] = ['text'], quality = 0.5): Candidate {
  const [pid = 'p', mid = 'm'] = key.split('/');
  return {
    key,
    provider: {
      id: pid,
      kind: 'openai-compat',
      baseUrl: 'https://x.test/v1',
      apiKeyEnv: 'KEY',
      maxPrivacy: 'internal',
      models: [],
    } as ProviderConfig,
    model: { id: mid, capabilities: caps, contextWindow: cw, price: { inPerMTok: 0, outPerMTok: 0 }, quality },
  };
}

interface InputOpts {
  cw?: number;
  caps?: Capability[];
  required?: Capability[];
  quality?: number;
  price?: number;
  minPrice?: number;
  maxPrice?: number;
  need?: number;
  out?: number;
  untried?: boolean;
  successRate?: number | null;
  latencyMs?: number | null;
  minLatencyMs?: number | null;
  maxLatencyMs?: number | null;
}

function input(key: string, o: InputOpts = {}): RankingInput {
  const caps = o.caps ?? ['text'];
  return {
    candidate: candidate(key, o.cw ?? 8000, caps, o.quality ?? 0.5),
    price: o.price ?? 0,
    minPrice: o.minPrice ?? 0,
    maxPrice: o.maxPrice ?? 0,
    quality: o.quality ?? 0.5,
    languageFit: 1,
    latencyMs: o.latencyMs ?? null,
    minLatencyMs: o.minLatencyMs ?? null,
    maxLatencyMs: o.maxLatencyMs ?? null,
    untried: o.untried ?? true,
    successRate: o.successRate ?? null,
    requiredCapabilities: o.required ?? caps,
    ...(o.need === undefined ? {} : { minContext: o.need }),
    ...(o.out === undefined ? {} : { maxOutputTokens: o.out }),
  };
}

const fitOnly: ScoreWeights = { quality: 0, cost: 0, latency: 0, language: 0, reliability: 0 };
const balanced: ScoreWeights = { quality: 0.4, cost: 0.3, latency: 0.1, language: 0.1, reliability: 0.1 };

describe('deterministic model scorer', () => {
  test('higher context fit ranks above weaker fit', () => {
    const ranked = rankCandidates(
      [input('small/m', { cw: 8000, need: 1000 }), input('big/m', { cw: 200000, need: 1000 })],
      fitOnly,
    );
    assert.equal(ranked[0]?.candidate.key, 'big/m');
    const small = ranked[1]?.components.find((c) => c.key === 'context')?.value ?? 0;
    const big = ranked[0]?.components.find((c) => c.key === 'context')?.value ?? 0;
    assert.ok(big > small, `big ${big} should exceed small ${small}`);
  });

  test('lower-cost equivalent candidate ranks appropriately', () => {
    const weights: ScoreWeights = { quality: 0, cost: 1, latency: 0, language: 0, reliability: 0 };
    const ranked = rankCandidates(
      [input('pricey/m', { price: 5, minPrice: 1, maxPrice: 5 }), input('cheap/m', { price: 1, minPrice: 1, maxPrice: 5 })],
      weights,
    );
    assert.equal(ranked[0]?.candidate.key, 'cheap/m');
    const cheapCost = ranked[0]?.components.find((c) => c.key === 'cost')?.value ?? 0;
    const priceyCost = ranked[1]?.components.find((c) => c.key === 'cost')?.value ?? 0;
    assert.ok(cheapCost > priceyCost);
  });

  test('an unavailable candidate ranks below an available one', () => {
    const weights: ScoreWeights = { quality: 0, cost: 0, latency: 0, language: 0, reliability: 1 };
    const ranked = rankCandidates(
      [input('down/m', { untried: false, successRate: 0 }), input('up/m', { untried: false, successRate: 1 })],
      weights,
    );
    assert.equal(ranked[0]?.candidate.key, 'up/m');
  });

  test('deterministic: same input produces identical ranking', () => {
    const inputs = [input('b/m', { cw: 8000 }), input('a/m', { cw: 8000 }), input('c/m', { cw: 200000, need: 1000 })];
    const first = rankCandidates(inputs, balanced).map((r) => r.candidate.key);
    const second = rankCandidates(inputs, balanced).map((r) => r.candidate.key);
    assert.deepEqual(first, second);
  });

  test('equal scores break ties by candidate key', () => {
    const ranked = rankCandidates([input('b/m'), input('a/m')], balanced);
    assert.deepEqual(ranked.map((r) => r.candidate.key), ['a/m', 'b/m']);
  });

  test('the explanation contains every applied component with a reason', () => {
    const s = scoreCandidate(
      input('x/m', {
        cw: 8000,
        need: 1000,
        out: 100,
        price: 2,
        minPrice: 0,
        maxPrice: 4,
        untried: false,
        successRate: 1,
        latencyMs: 100,
        minLatencyMs: 50,
        maxLatencyMs: 150,
        quality: 0.7,
      }),
      balanced,
    );
    assert.deepEqual(
      s.components.map((c) => c.key).sort(),
      ['availability', 'capability', 'context', 'cost', 'headroom', 'language', 'latency', 'output', 'quality'],
    );
    for (const c of s.components) assert.ok(c.reason.length > 0, `${c.key} has a reason`);
    assert.match(s.components.find((c) => c.key === 'context')?.reason ?? '', /context/);
    const sum = s.components.reduce((acc, c) => acc + c.contribution, 0);
    assert.ok(Math.abs(sum - s.score) < 1e-9, `contributions ${sum} should sum to ${s.score}`);
    assert.ok(s.score >= 0 && s.score <= 1);
  });
});

describe('scorer operates only on hard-filtered survivors', () => {
  const registry = () => new Registry(fixtureProviders(), { env: FIXTURE_ENV });

  test('an insufficient-context candidate is already filtered before scoring', () => {
    const d = new Router(registry(), { maxPricePerMTok: 100 }).route({ mesh: 'best', minContext: 50000 });
    assert.ok(!d.ranked.some((r) => r.candidate.key === 'alpha/alpha-free'), 'alpha (8000) excluded');
    assert.ok(
      d.rejected.some((r) => r.key === 'alpha/alpha-free' && r.reason.startsWith('context')),
      'the rejection names context',
    );
    assert.ok(d.ranked.some((r) => r.candidate.key === 'beta/beta-free'));
  });

  test('an unavailable candidate is not selected', () => {
    const health = new HealthTracker({ failureThreshold: 1 }, () => 0);
    health.failure('alpha/alpha-free');
    const d = new Router(registry(), { health, maxPricePerMTok: 100 }).route({ mesh: 'free', language: 'en' });
    assert.notEqual(d.ranked[0]?.candidate.key, 'alpha/alpha-free');
    assert.ok(d.rejected.some((r) => r.key === 'alpha/alpha-free' && r.reason.startsWith('health')));
  });

  test('pin behavior is unchanged (a pin still bypasses price-based scoring)', () => {
    const d = new Router(registry(), { maxPricePerMTok: 100 }).route({ mesh: 'free', pin: 'paid/paid-pro' });
    assert.equal(d.ranked[0]?.candidate.key, 'paid/paid-pro');
  });

  test('FREE_ONLY still prevents paid execution after scoring', async () => {
    const providers = [
      {
        id: 'free',
        kind: 'openai-compat',
        baseUrl: 'https://free.test/v1',
        apiKeyEnv: 'FREE_KEY',
        maxPrivacy: 'internal',
        models: [{ id: 'm', capabilities: ['text'], contextWindow: 200000, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 0.4 }],
      },
      {
        id: 'paid',
        kind: 'openai-compat',
        baseUrl: 'https://paid.test/v1',
        apiKeyEnv: 'PAID_KEY',
        maxPrivacy: 'internal',
        models: [
          { id: 'm', capabilities: ['text'], contextWindow: 200000, price: { inPerMTok: 3, outPerMTok: 15 }, quality: 0.99, priceVerifiedAt: '2026-10-01' },
        ],
      },
    ] as ProviderConfig[];
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = new InferenceMesh({
      registry: new Registry(providers, { env: { FREE_KEY: 'f', PAID_KEY: 'p' } }),
      fetchImpl: fetch,
      enforceFreeOnly: true,
    });
    const res = await mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.mesh?.served_by, 'free/m');
    assert.ok(!calls.some((c) => c.url.includes('paid.test')));
  });
});
