import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  mergeCatalogIntoRegistry,
  mergeCatalogIntoProvider,
} from '../src/catalog-sync.js';
import type { CatalogResult } from '../src/catalog-reader.js';
import type { ProviderConfig } from '../src/core/types.js';

function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p',
    kind: 'openai-compat',
    baseUrl: 'https://p.test/v1',
    apiKeyEnv: 'P_KEY',
    maxPrivacy: 'internal',
    risk: 'caution',
    headers: { 'x-title': 'tariffia' },
    quota: { requestsPerMinute: 10 },
    models: [
      {
        id: 'a',
        capabilities: ['text'],
        contextWindow: 8000,
        price: { inPerMTok: 0, outPerMTok: 0 },
        quality: 0.5,
        languages: { en: 0.9 },
      },
      {
        id: 'b',
        capabilities: ['text', 'tools'],
        contextWindow: 32000,
        price: { inPerMTok: 1, outPerMTok: 2 },
        priceVerifiedAt: '2026-10-01',
      },
    ],
    ...over,
  } as ProviderConfig;
}

function catalog(models: CatalogResult['models'], providerId = 'p'): CatalogResult {
  return { providerId, url: `https://${providerId}.test/v1/models`, models };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('mergeCatalogIntoProvider', () => {
  test('an existing model is unchanged when the catalog matches', () => {
    const p = provider();
    const { provider: out, report } = mergeCatalogIntoProvider(
      p,
      catalog([{ id: 'a', contextWindow: 8000 }, { id: 'b', contextWindow: 32000 }]),
    );
    assert.equal(out, p, 'same reference when nothing changed');
    assert.ok(report.unchanged.some((c) => c.key === 'p/a'));
    assert.equal(report.updated.length, 0);
  });

  test('context updates when the catalog provides a new value', () => {
    const p = provider();
    const { provider: out, report } = mergeCatalogIntoProvider(p, catalog([{ id: 'a', contextWindow: 16384 }]));
    assert.equal(out.models.find((m) => m.id === 'a')?.contextWindow, 16384);
    assert.ok(report.updated.some((c) => c.key === 'p/a'));
    // Original untouched.
    assert.equal(p.models[0]?.contextWindow, 8000);
  });

  test('metadata the catalog does not supply is preserved', () => {
    const p = provider();
    const { provider: out } = mergeCatalogIntoProvider(p, catalog([{ id: 'a', contextWindow: 16384 }]));
    const a = out.models.find((m) => m.id === 'a')!;
    assert.deepEqual(a.capabilities, ['text']);
    assert.equal(a.quality, 0.5);
    assert.deepEqual(a.languages, { en: 0.9 });
    assert.deepEqual(a.price, { inPerMTok: 0, outPerMTok: 0 });
  });

  test('a display name updates the label only, nothing else', () => {
    const p = provider();
    const { provider: out } = mergeCatalogIntoProvider(p, catalog([{ id: 'a', name: 'Model A' }]));
    assert.equal(out.models.find((m) => m.id === 'a')?.label, 'Model A');
  });

  test('a NEW catalog model is NOT added (pricing unknown)', () => {
    const p = provider();
    const { provider: out, report } = mergeCatalogIntoProvider(p, catalog([{ id: 'a' }, { id: 'b' }, { id: 'new-model' }]));
    assert.equal(out.models.length, 2, 'no new model is added');
    assert.ok(!out.models.some((m) => m.id === 'new-model'));
    assert.ok(report.skipped.some((c) => c.key === 'p/new-model'));
    assert.equal(report.added.length, 0);
  });

  test('a missing existing model is disabled, not deleted', () => {
    const p = provider();
    const { provider: out, report } = mergeCatalogIntoProvider(p, catalog([{ id: 'a' }]));
    const b = out.models.find((m) => m.id === 'b');
    assert.ok(b, 'b is kept');
    assert.equal(b?.disabled, true);
    assert.ok(report.disabled.some((c) => c.key === 'p/b'));
  });

  test('a disabled model keeps its old metadata', () => {
    const p = provider();
    const { provider: out } = mergeCatalogIntoProvider(p, catalog([{ id: 'a' }]));
    const b = out.models.find((m) => m.id === 'b')!;
    assert.deepEqual(b.capabilities, ['text', 'tools']);
    assert.deepEqual(b.price, { inPerMTok: 1, outPerMTok: 2 });
    assert.equal(b.priceVerifiedAt, '2026-10-01');
    assert.equal(b.disabled, true);
  });

  test('the catalog cannot invent a price', () => {
    const p = provider();
    const { provider: out } = mergeCatalogIntoProvider(p, catalog([{ id: 'a', contextWindow: 9000 }]));
    // No price field appeared anywhere that did not have one.
    for (const m of out.models) assert.ok(m.price, 'every model still has its registry price');
    assert.deepEqual(out.models.find((m) => m.id === 'a')?.price, { inPerMTok: 0, outPerMTok: 0 });
  });

  test('the catalog cannot turn a paid model into free', () => {
    const p = provider();
    // Catalog offers a smaller context but no pricing.
    const { provider: out } = mergeCatalogIntoProvider(p, catalog([{ id: 'b', contextWindow: 40000 }]));
    const b = out.models.find((m) => m.id === 'b')!;
    assert.deepEqual(b.price, { inPerMTok: 1, outPerMTok: 2 }, 'b stays paid');
    assert.equal(b.contextWindow, 40000);
  });

  test('a catalog for another provider is a no-op', () => {
    const p = provider();
    const { provider: out, report } = mergeCatalogIntoProvider(p, catalog([{ id: 'a' }], 'other'));
    assert.equal(out, p);
    assert.equal(report.updated.length + report.disabled.length + report.skipped.length, 0);
  });

  test('an already-disabled model absent from the catalog stays unchanged', () => {
    const p = provider({ models: [{ id: 'a', capabilities: ['text'], contextWindow: 8000, price: { inPerMTok: 0, outPerMTok: 0 }, disabled: true }] });
    const { provider: out, report } = mergeCatalogIntoProvider(p, catalog([]));
    assert.equal(out, p);
    assert.equal(report.disabled.length, 0);
    assert.ok(report.unchanged.some((c) => c.key === 'p/a'));
  });
});

describe('mergeCatalogIntoRegistry', () => {
  test('does not mutate the input providers (deep) and returns new configs', () => {
    const providers = [provider(), provider({ id: 'q', apiKeyEnv: 'Q_KEY', baseUrl: 'https://q.test/v1' })];
    const before = clone(providers);
    const { providers: out, report } = mergeCatalogIntoRegistry(providers, catalog([{ id: 'a', contextWindow: 99999 }]));
    assert.deepEqual(clone(providers), before, 'inputs unchanged');
    assert.notEqual(out, providers);
    // Only the matching provider changed.
    assert.notEqual(out[0], providers[0]);
    assert.equal(out[1], providers[1]);
    assert.ok(report.updated.some((c) => c.key === 'p/a'));
  });

  test('provider identity/config is never changed by the merge', () => {
    const providers = [provider()];
    const original = providers[0]!;
    const { providers: out } = mergeCatalogIntoRegistry(providers, catalog([{ id: 'a', contextWindow: 12345 }]));
    const p = out[0]!;
    assert.equal(p.id, original.id);
    assert.equal(p.kind, original.kind);
    assert.equal(p.baseUrl, original.baseUrl);
    assert.equal(p.apiKeyEnv, original.apiKeyEnv);
    assert.equal(p.risk, original.risk);
    assert.equal(p.maxPrivacy, original.maxPrivacy);
    assert.deepEqual(p.headers, original.headers);
    assert.deepEqual(p.quota, original.quota);
  });

  test('multiple models produce deterministic added/updated/disabled/unchanged results', () => {
    const p = provider();
    const result = mergeCatalogIntoProvider(
      p,
      catalog([{ id: 'a', contextWindow: 8000 }, { id: 'b', contextWindow: 40000 }, { id: 'c' }]),
    );
    const r = result.report;
    assert.deepEqual(r.unchanged.map((c) => c.key), ['p/a']);
    assert.deepEqual(r.updated.map((c) => c.key), ['p/b']);
    assert.deepEqual(r.disabled, []);
    assert.deepEqual(r.skipped.map((c) => c.key), ['p/c']);
    assert.deepEqual(r.added, []);
  });

  test('a fully identical catalog reports everything unchanged and keeps references', () => {
    const providers = [provider()];
    const { providers: out, report } = mergeCatalogIntoRegistry(
      providers,
      catalog([{ id: 'a', contextWindow: 8000 }, { id: 'b', contextWindow: 32000 }]),
    );
    // A new array is always returned; the element references are preserved.
    assert.notEqual(out, providers);
    assert.equal(out[0], providers[0], 'unchanged provider keeps its reference');
    assert.equal(report.unchanged.length, 2);
    assert.equal(report.updated.length + report.disabled.length + report.skipped.length, 0);
  });
});
