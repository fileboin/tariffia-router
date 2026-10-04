import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { QuotaLedger, MemoryStorage } from '../src/core/ledger.js';
import { quotaPoolKey } from '../src/core/registry.js';
import { scoreCandidate, type RankingInput, type ScoreWeights } from '../src/core/scorer.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { fakeClock, fakeFetch, okChat } from './helpers.js';
import type { ProviderConfig } from '../src/core/types.js';

// ---------------------------------------------------------------- TPM
describe('ledger — tokens per minute (TPM)', () => {
  test('a TPM cap admits by estimated tokens then refuses', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { tokensPerMinute: 100 };
    assert.equal((await l.admit('k', quota, 60)).ok, true);
    const second = await l.admit('k', quota, 60);
    assert.equal(second.ok, false);
    assert.match(second.reason ?? '', /tpm 60\/100/);
  });

  test('refund gives back the minute reservation', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { tokensPerMinute: 100 };
    await l.admit('k', quota, 80);
    assert.equal((await l.admit('k', quota, 80)).ok, false);
    await l.refund('k');
    assert.equal((await l.admit('k', quota, 80)).ok, true);
  });

  test('record replaces the estimate with real tokens in the minute', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { tokensPerMinute: 100 };
    await l.admit('k', quota, 90);
    await l.record('k', 10); // real usage far below the estimate
    // 10 real tokens used; another 50 fits (60 <= 100).
    assert.equal((await l.admit('k', quota, 50)).ok, true);
  });

  test('the TPM window rolls after 60s', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { tokensPerMinute: 100 };
    await l.admit('k', quota, 90);
    assert.equal((await l.admit('k', quota, 90)).ok, false);
    clock.advance(60_001);
    assert.equal((await l.admit('k', quota, 90)).ok, true);
  });

  test('no TPM means unchanged behavior (tokensPerDay gates on booked usage)', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { tokensPerDay: 100 };
    assert.equal((await l.admit('k', quota, 60)).ok, true);
    await l.record('k', 90);
    assert.equal((await l.admit('k', quota, 60)).ok, false);
  });

  test('utilization reports minute and day fractions', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { tokensPerMinute: 100, tokensPerDay: 1000 };
    await l.admit('k', quota, 50);
    await l.record('k', 50);
    const u = await l.utilization('k', quota);
    assert.equal(u.minute, 0.5);
    assert.equal(u.day, 0.05);
  });
});

// ---------------------------------------------------------- quotaPool
describe('quota pool key', () => {
  test('defaults to the provider id when quotaPool is unset', () => {
    const p = { id: 'groq' } as ProviderConfig;
    assert.equal(quotaPoolKey(p), 'groq');
  });

  test('uses the explicit quotaPool when set', () => {
    const p = { id: 'groq-free', quotaPool: 'groq-account' } as ProviderConfig;
    assert.equal(quotaPoolKey(p), 'groq-account');
  });

  test('an empty/whitespace quotaPool falls back to the id', () => {
    const p = { id: 'x', quotaPool: '   ' } as ProviderConfig;
    assert.equal(quotaPoolKey(p), 'x');
  });

  test('models behind one pool draw on the same account budget', async () => {
    // Two providers sharing a quotaPool; each has a small account-wide RPM cap.
    const shared: ProviderConfig[] = [
      {
        id: 'free-a',
        kind: 'openai-compat',
        baseUrl: 'https://a.test/v1',
        apiKeyEnv: 'A_KEY',
        maxPrivacy: 'internal',
        quotaPool: 'shared-account',
        quota: { requestsPerMinute: 1 },
        models: [{ id: 'm', capabilities: ['text'], contextWindow: 8000, price: { inPerMTok: 0, outPerMTok: 0 } }],
      } as ProviderConfig,
      {
        id: 'free-b',
        kind: 'openai-compat',
        baseUrl: 'https://b.test/v1',
        apiKeyEnv: 'B_KEY',
        maxPrivacy: 'internal',
        quotaPool: 'shared-account',
        quota: { requestsPerMinute: 1 },
        models: [{ id: 'm', capabilities: ['text'], contextWindow: 8000, price: { inPerMTok: 0, outPerMTok: 0 } }],
      } as ProviderConfig,
    ];
    const { fetch } = fakeFetch(() => okChat('ok'));
    const mesh = new InferenceMesh({
      registry: new Registry(shared, { env: { A_KEY: 'a', B_KEY: 'b' } }),
      fetchImpl: fetch,
    });
    // First call consumes the shared account slot (pool cap = 1/min).
    const r1 = await mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.ok(r1.mesh?.served_by);
    // Second call must be rejected by the SHARED pool, not a per-provider cap.
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] }),
      /account rpm 1\/1/,
    );
  });
});

// ------------------------------------------------------------ headroom
describe('scorer — quota headroom', () => {
  const weights: ScoreWeights = { quality: 0.4, cost: 0.3, latency: 0.1, language: 0.1, reliability: 0.1 };

  function input(key: string, headroom?: number): RankingInput {
    return {
      candidate: {
        key,
        provider: { id: 'p', kind: 'openai-compat', baseUrl: 'https://p.test/v1', apiKeyEnv: 'K', maxPrivacy: 'internal', models: [] } as unknown as ProviderConfig,
        model: { id: 'm', capabilities: ['text'], contextWindow: 8000, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 0.5 },
      },
      price: 0,
      minPrice: 0,
      maxPrice: 0,
      quality: 0.5,
      languageFit: 1,
      latencyMs: null,
      minLatencyMs: null,
      maxLatencyMs: null,
      untried: true,
      successRate: null,
      requiredCapabilities: ['text'],
      ...(headroom === undefined ? {} : { headroom }),
    };
  }

  test('a headroom component is present with a reason', () => {
    const s = scoreCandidate(input('p/m', 0.25), weights);
    const c = s.components.find((x) => x.key === 'headroom');
    assert.ok(c);
    assert.equal(c?.value, 0.25);
    assert.match(c?.reason ?? '', /headroom 0\.25/);
  });

  test('absent headroom is treated as 1 (no effect)', () => {
    const s = scoreCandidate(input('p/m'), weights);
    assert.equal(s.components.find((x) => x.key === 'headroom')?.value, 1);
    assert.equal(s.terms['headroom'], 1);
  });

  test('lower headroom lowers the score deterministically', () => {
    const full = scoreCandidate(input('p/m', 1), weights);
    const low = scoreCandidate(input('p/m', 0), weights);
    assert.ok(low.score < full.score);
    assert.equal(low.terms['headroom'], 0);
  });

  test('contributions still sum to the score', () => {
    const s = scoreCandidate(input('p/m', 0.4), weights);
    const sum = s.components.reduce((a, c) => a + c.contribution, 0);
    assert.ok(Math.abs(sum - s.score) < 1e-9);
  });
});
