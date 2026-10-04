import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSeed, SeedError } from '../src/seed-import.js';
import { validateRegistryFile } from '../src/core/config.js';

// Compiled tests run from dist/tests; the seed lives at the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function loadSeed(): Promise<unknown> {
  const text = await readFile(resolve(REPO_ROOT, 'seed/awesome-free-llm-apis.data.json'), 'utf8');
  return JSON.parse(text) as unknown;
}

describe('seed import — the shipped CC0 seed', () => {
  test('the seed parses', async () => {
    const seed = parseSeed(await loadSeed());
    assert.ok(seed.providers.length > 0);
    assert.match(seed.lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('provider and model records are preserved', async () => {
    const seed = parseSeed(await loadSeed());
    // Every provider keeps its name and models; every model keeps an id, and no
    // null-id summary row is smuggled in as a model.
    for (const p of seed.providers) {
      assert.ok(p.name.length > 0);
      for (const m of p.models) assert.ok(m.id.length > 0, `${p.name} has a model with an id`);
    }
    // Spot-check a known entry without hard-coding the whole list.
    const anyWithBase = seed.providers.find((p) => p.baseUrl);
    assert.ok(anyWithBase?.baseUrl?.startsWith('http'));
    const totalModels = seed.providers.reduce((n, p) => n + p.models.length, 0);
    assert.ok(totalModels > 0);
  });

  test('a model row preserves its published fields', async () => {
    const seed = parseSeed(await loadSeed());
    const model = seed.providers.flatMap((p) => p.models).find((m) => m.context.length > 0);
    assert.ok(model, 'at least one model states a context');
    assert.equal(typeof model?.id, 'string');
    assert.equal(typeof model?.rateLimit, 'string');
  });

  test('the seed is candidate data only: it is NOT a loadable Tariffia registry', async () => {
    const raw = await loadSeed();
    // The seed has no `providers[].kind/apiKeyEnv/maxPrivacy/models[].price`, so
    // it must fail the active-registry validator. This proves it cannot be
    // mistaken for (or accidentally loaded as) the active registry.
    assert.throws(() => validateRegistryFile(raw), /registry:/);
  });
});

describe('seed import — malformed input fails clearly', () => {
  test('a non-object document is rejected', () => {
    assert.throws(() => parseSeed(42), (e: unknown) => e instanceof SeedError);
    assert.throws(() => parseSeed(null), /must be an object/);
  });

  test('a missing providers array is rejected', () => {
    assert.throws(() => parseSeed({ lastUpdated: '2026-01-01' }), /no 'providers' array/);
  });

  test('a provider without a name is rejected', () => {
    assert.throws(() => parseSeed({ providers: [{ models: [] }] }), /name/);
  });

  test('provider models must be an array', () => {
    assert.throws(() => parseSeed({ providers: [{ name: 'X', models: 'nope' }] }), /models must be an array/);
  });

  test('a model with a non-string id is rejected', () => {
    assert.throws(
      () => parseSeed({ providers: [{ name: 'X', models: [{ id: 42, name: 'bad-id' }] }] }),
      /model\[0\]\.id/,
    );
  });

  test('a null-id summary row is kept as a note, not a model', () => {
    const seed = parseSeed({
      providers: [{ name: 'X', models: [{ id: null, name: '+ 72 more models' }, { id: 'real' }] }],
    });
    assert.deepEqual(seed.providers[0]?.models.map((m) => m.id), ['real']);
    assert.deepEqual(seed.providers[0]?.notes.map((n) => n.name), ['+ 72 more models']);
  });

  test('an empty providers list is valid', () => {
    const seed = parseSeed({ providers: [] });
    assert.deepEqual(seed.providers, []);
  });
});

describe('seed import — active registry is untouched', () => {
  test('parsing the seed never yields a Tariffia ProviderConfig', async () => {
    const seed = parseSeed(await loadSeed());
    for (const p of seed.providers) {
      assert.ok(!('kind' in p), 'no provider kind is produced');
      assert.ok(!('apiKeyEnv' in p), 'no credential reference is produced');
      for (const m of p.models) {
        assert.ok(!('price' in m), 'no price is produced');
        assert.ok(!('free' in m));
      }
    }
  });
});
