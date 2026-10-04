import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSeed } from '../src/seed-import.js';
import { toCandidates, candidateIdFromName, SEED_PROVENANCE } from '../src/seed-candidates.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function shippedSeed() {
  const text = await readFile(resolve(REPO_ROOT, 'seed/awesome-free-llm-apis.data.json'), 'utf8');
  return parseSeed(JSON.parse(text) as unknown);
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('seed -> candidates', () => {
  test('valid provider mapping', () => {
    const [c] = toCandidates({
      lastUpdated: '2026-08-21',
      providers: [
        {
          name: 'Aion Labs',
          category: 'provider_api',
          country: 'IL',
          flag: 'X',
          url: 'https://aion.example/keys',
          baseUrl: 'https://api.aion.example/v1',
          description: 'Permanent free tier, no credit card required.',
          models: [{ id: 'aion-2.0', name: 'aion-2.0', context: '128K', maxOutput: '32K', modality: 'Text', rateLimit: '15 RPM' }],
          notes: [],
        },
      ],
    });
    assert.ok(c);
    assert.equal(c?.name, 'Aion Labs');
    assert.equal(c?.candidateId, 'aion-labs');
    assert.equal(c?.unverified, true);
    assert.equal(c?.baseUrl, 'https://api.aion.example/v1');
    assert.equal(c?.url, 'https://aion.example/keys');
    assert.equal(c?.models.length, 1);
    assert.equal(c?.models[0]?.id, 'aion-2.0');
    assert.equal(c?.models[0]?.context, '128K');
    assert.equal(c?.models[0]?.rateLimit, '15 RPM');
  });

  test('multiple models are all mapped', () => {
    const [c] = toCandidates({
      lastUpdated: '',
      providers: [
        {
          name: 'M',
          category: 'inference_provider',
          country: '',
          flag: '',
          url: '',
          description: '',
          models: [
            { id: 'm1', name: '', context: '', maxOutput: '', modality: '', rateLimit: '' },
            { id: 'm2', name: 'M2', context: '8K', maxOutput: '', modality: 'Text', rateLimit: '' },
          ],
          notes: [],
        },
      ],
    });
    assert.deepEqual(c?.models.map((m) => m.id), ['m1', 'm2']);
  });

  test('missing baseUrl stays absent (not invented)', () => {
    const [c] = toCandidates({
      lastUpdated: '',
      providers: [
        { name: 'NoBase', category: '', country: '', flag: '', url: '', description: '', models: [], notes: [] },
      ],
    });
    assert.ok(!('baseUrl' in (c as object)), 'baseUrl is absent, not empty');
    assert.ok(!('url' in (c as object)), 'url absent when not given');
  });

  test('model ids are always present and preserved', async () => {
    const seed = await shippedSeed();
    const candidates = toCandidates(seed);
    for (const c of candidates) {
      for (const m of c.models) assert.ok(m.id.length > 0, `${c.name} model has an id`);
    }
  });

  test('source provenance is preserved', () => {
    const [c] = toCandidates({
      lastUpdated: '2026-07-01',
      providers: [
        { name: 'P', category: 'provider_api', country: '', flag: '', url: '', description: '', models: [], notes: [] },
      ],
    });
    assert.equal(c?.provenance.source, SEED_PROVENANCE.source);
    assert.equal(c?.provenance.license, 'CC0-1.0');
    assert.equal(c?.provenance.lastUpdated, '2026-07-01');
    assert.equal(c?.provenance.retrievedAt, '2026-10-04');
    assert.equal(c?.provenance.category, 'provider_api');
  });

  test('no price/free/risk/privacy fields are invented', () => {
    const [c] = toCandidates({
      lastUpdated: '',
      providers: [
        {
          name: 'P',
          category: 'provider_api',
          country: '',
          flag: '',
          url: '',
          description: 'free',
          models: [{ id: 'x', name: '', context: '', maxOutput: '', modality: '', rateLimit: '' }],
          notes: [],
        },
      ],
    });
    const forbidden = ['price', 'free', 'freeTier', 'risk', 'maxPrivacy', 'privacy', 'apiKeyEnv', 'kind', 'quota'];
    for (const f of forbidden) {
      assert.ok(!(f in (c as object)), `candidate must not carry '${f}'`);
      assert.ok(!(f in (c?.models[0] as object)), `candidate model must not carry '${f}'`);
    }
  });

  test('the mapper does not mutate its input', async () => {
    const seed = await shippedSeed();
    const before = clone(seed);
    toCandidates(seed);
    assert.deepEqual(clone(seed), before, 'input SeedData unchanged');
  });

  test('the shipped seed maps fully and every candidate is marked unverified', async () => {
    const candidates = toCandidates(await shippedSeed());
    assert.ok(candidates.length >= 1);
    for (const c of candidates) {
      assert.equal(c.unverified, true);
      assert.equal(c.provenance.license, 'CC0-1.0');
      assert.match(c.provenance.source, /awesome-free-llm-apis/);
    }
    // No candidate is a routed ProviderConfig.
    for (const c of candidates) assert.ok(!('kind' in (c as object)));
  });
});

describe('candidateIdFromName', () => {
  test('produces a review-safe slug', () => {
    assert.equal(candidateIdFromName('Aion Labs'), 'aion-labs');
    assert.equal(candidateIdFromName('Z AI (Zhipu AI)'), 'z-ai-zhipu-ai');
    assert.equal(candidateIdFromName('  '), 'unnamed-provider');
  });
});
