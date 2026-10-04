import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { mergeProviderConfig } from '../src/registry-merge.js';
import type { ProviderConfig } from '../src/core/types.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p',
    kind: 'openai-compat',
    baseUrl: 'https://p.test/v1',
    apiKeyEnv: 'P_KEY',
    maxPrivacy: 'internal',
    models: [
      { id: 'm', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 0, outPerMTok: 0 } },
    ],
    ...over,
  } as ProviderConfig;
}

describe('verified-provider registry merge', () => {
  test('adds a valid verified provider', () => {
    const existing = [provider({ id: 'a', apiKeyEnv: 'A_KEY' })];
    const incoming = provider({ id: 'b', apiKeyEnv: 'B_KEY', baseUrl: 'https://b.test/v1' });
    const r = mergeProviderConfig(existing, incoming);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.providers.map((p) => p.id), ['a', 'b']);
    assert.deepEqual(r.summary.added, ['b']);
    assert.deepEqual(r.summary.unchanged, ['a']);
    assert.equal(r.providers[1], incoming, 'incoming added by reference');
  });

  test('replaces the same providerId', () => {
    const existing = [provider({ id: 'a' })];
    const incoming = provider({ id: 'a', summary: 'updated' });
    const r = mergeProviderConfig(existing, incoming);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.providers.map((p) => p.id), ['a']);
    assert.deepEqual(r.summary.replaced, ['a']);
    assert.equal(r.providers[0], incoming);
  });

  test('preserves unrelated providers unchanged (same references)', () => {
    const a = provider({ id: 'a' });
    const b = provider({ id: 'b' });
    const existing = [a, b];
    const r = mergeProviderConfig(existing, provider({ id: 'b', summary: 'x' }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.providers[0], a, 'a untouched');
    assert.notEqual(r.providers[1], b, 'b replaced');
  });

  test('rejects an invalid ProviderConfig', () => {
    const bad = { id: 'x' } as unknown as ProviderConfig;
    const r = mergeProviderConfig([], bad);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /invalid ProviderConfig/);
  });

  test('rejects identity/kind mismatch on replacement', () => {
    const existing = [provider({ id: 'a', kind: 'openai-compat' })];
    const incoming = provider({ id: 'a', kind: 'gemini' });
    const r = mergeProviderConfig(existing, incoming);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /kind mismatch/);
  });

  test('does not downgrade verified paid -> free', () => {
    const existing = [
      provider({
        id: 'a',
        models: [
          { id: 'm', capabilities: ['text'], contextWindow: 8192, price: { inPerMTok: 1, outPerMTok: 2 }, priceVerifiedAt: '2026-10-01' },
        ],
      }),
    ];
    const incoming = provider({ id: 'a' }); // zero-price model
    const r = mergeProviderConfig(existing, incoming);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /downgrade verified paid/);
  });

  test('does not lower privacy', () => {
    const existing = [provider({ id: 'a', maxPrivacy: 'highly_confidential' })];
    const incoming = provider({ id: 'a', maxPrivacy: 'public' });
    const r = mergeProviderConfig(existing, incoming);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /lower privacy/);
  });

  test('does not clear a recorded risk disposition', () => {
    const existing = [provider({ id: 'a', risk: 'caution' })];
    const incoming = provider({ id: 'a' }); // no risk
    const r = mergeProviderConfig(existing, incoming);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /clear recorded risk/);
  });

  test('allows a same-or-higher-privacy replacement that keeps risk', () => {
    const existing = [provider({ id: 'a', risk: 'caution', maxPrivacy: 'internal' })];
    const incoming = provider({ id: 'a', risk: 'caution', maxPrivacy: 'confidential', summary: 'ok' });
    const r = mergeProviderConfig(existing, incoming);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.providers[0], incoming);
  });

  test('input registry is not mutated', () => {
    const existing = [provider({ id: 'a' }), provider({ id: 'b' })];
    const before = clone(existing);
    mergeProviderConfig(existing, provider({ id: 'c', baseUrl: 'https://c.test/v1', apiKeyEnv: 'C_KEY' }));
    mergeProviderConfig(existing, provider({ id: 'a', summary: 'x' }));
    assert.deepEqual(clone(existing), before);
  });

  test('deterministic result', () => {
    const existing = [provider({ id: 'a' })];
    const incoming = provider({ id: 'b', baseUrl: 'https://b.test/v1', apiKeyEnv: 'B_KEY' });
    assert.deepEqual(mergeProviderConfig(existing, incoming), mergeProviderConfig(existing, incoming));
  });

  test('empty registry add', () => {
    const r = mergeProviderConfig([], provider({ id: 'solo' }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.providers.map((p) => p.id), ['solo']);
    assert.deepEqual(r.summary.added, ['solo']);
    assert.deepEqual(r.summary.unchanged, []);
  });

  test('duplicate provider handling: no duplicate id is introduced', () => {
    const existing = [provider({ id: 'a' }), provider({ id: 'a', summary: 'dup' })];
    const r = mergeProviderConfig(existing, provider({ id: 'a', summary: 'new' }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // Replaces the first match only; the list is not grown.
    assert.equal(r.providers.length, 2);
    assert.equal(r.providers.filter((p) => p.id === 'a').length, 2, 'input duplicates are not de-duplicated by this step');
    assert.deepEqual(r.summary.replaced, ['a']);
  });
});
