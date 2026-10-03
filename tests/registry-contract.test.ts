import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { validateRegistryFile, VALID_CAPABILITIES } from '../src/core/config.js';
import { Registry, isFree } from '../src/core/registry.js';
import { InferenceMesh } from '../src/core/mesh.js';
import { NoCandidateError, type ProviderConfig } from '../src/core/types.js';
import { fakeFetch, okChat } from './helpers.js';

function model(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm',
    capabilities: ['text'],
    contextWindow: 8192,
    price: { inPerMTok: 0, outPerMTok: 0 },
    quality: 0.5,
    ...over,
  };
}

function provider(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p',
    kind: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnv: 'EXAMPLE_API_KEY',
    maxPrivacy: 'internal',
    models: [model()],
    ...over,
  };
}

function file(providers: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { providers, ...extra };
}

describe('registry contract — minimal valid entry', () => {
  test('a valid provider/model entry passes validation', () => {
    const validated = validateRegistryFile(file([provider()]));
    assert.equal(validated.providers[0]?.id, 'p');
    const registry = new Registry(validated.providers, { env: { EXAMPLE_API_KEY: 'k' } });
    assert.equal(registry.candidates.length, 1);
    assert.equal(registry.candidates[0]?.key, 'p/m');
  });

  test('a keyless provider (Ollama-style) is valid without a credential', () => {
    const ollama = provider({
      id: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: 'OLLAMA_API_KEY',
      apiKeyOptional: true,
    });
    assert.doesNotThrow(() => validateRegistryFile(file([ollama])));
    const registry = new Registry(validateRegistryFile(file([ollama])).providers, { env: {} });
    assert.equal(registry.candidates.length, 1, 'loaded with no key because apiKeyOptional');
  });

  test('Anthropic kind and a future free-tier openai-compat endpoint are accepted', () => {
    assert.doesNotThrow(() =>
      validateRegistryFile(
        file([
          provider({ id: 'anth', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
          provider({ id: 'free-tier', baseUrl: 'https://free.example.com/v1', apiKeyEnv: 'FREE_TIER_KEY' }),
        ]),
      ),
    );
  });
});

describe('registry contract — rejected entries', () => {
  test('duplicate provider identity is rejected', () => {
    assert.throws(() => validateRegistryFile(file([provider({ id: 'dup' }), provider({ id: 'dup' })])), /duplicate provider id/);
  });

  test('duplicate model identity within a provider is rejected', () => {
    const p = provider({ models: [model({ id: 'm' }), model({ id: 'm' })] });
    assert.throws(() => validateRegistryFile(file([p])), /duplicate model/);
  });

  test('unknown capability is rejected', () => {
    const p = provider({ models: [model({ capabilities: ['text', 'tols'] })] });
    assert.throws(() => validateRegistryFile(file([p])), /unknown capability/);
  });

  test('invalid pricing (negative or non-numeric) is rejected', () => {
    assert.throws(
      () => validateRegistryFile(file([provider({ models: [model({ price: { inPerMTok: -1, outPerMTok: 0 } })] })])),
      /invalid price/,
    );
    assert.throws(
      () => validateRegistryFile(file([provider({ models: [model({ price: { inPerMTok: '0', outPerMTok: 0 } })] })])),
      /invalid price/,
    );
  });

  test('missing pricing metadata is rejected outright (never treated as free)', () => {
    const noPrice = model();
    delete (noPrice as Record<string, unknown>)['price'];
    assert.throws(() => validateRegistryFile(file([provider({ models: [noPrice] })])), /invalid price/);
    // And with a partial price object:
    assert.throws(
      () => validateRegistryFile(file([provider({ models: [model({ price: { inPerMTok: 0 } })] })])),
      /invalid price/,
    );
  });

  test('invalid context window is rejected', () => {
    for (const bad of [0, -1, NaN, Infinity, '8000']) {
      assert.throws(
        () => validateRegistryFile(file([provider({ models: [model({ contextWindow: bad })] })])),
        /invalid contextWindow/,
        `contextWindow ${String(bad)}`,
      );
    }
  });

  test('invalid provider kind is rejected', () => {
    assert.throws(() => validateRegistryFile(file([provider({ kind: 'grpc' })])), /unknown kind/);
  });

  test('a malformed credential reference is rejected', () => {
    for (const bad of ['', 'my key', 'KEY-WITH-DASH', 'sk-live-abc123', 123]) {
      assert.throws(
        () => validateRegistryFile(file([provider({ apiKeyEnv: bad })])),
        /apiKeyEnv|environment-variable name/,
        `apiKeyEnv ${JSON.stringify(bad)}`,
      );
    }
    assert.throws(
      () => validateRegistryFile(file([provider({ accountIdEnv: 'bad-name' })])),
      /environment-variable name/,
    );
  });

  test('an invalid baseUrl is rejected', () => {
    assert.throws(() => validateRegistryFile(file([provider({ baseUrl: 'api.example.com' })])), /invalid baseUrl/);
    assert.throws(() => validateRegistryFile(file([provider({ baseUrl: 'ftp://x' })])), /invalid baseUrl/);
  });
});

describe('registry contract — secrets are never registry data', () => {
  test('a credential value in apiKeyEnv is rejected, with a clear hint', () => {
    assert.throws(
      () => validateRegistryFile(file([provider({ apiKeyEnv: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })])),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /environment-variable name/);
        assert.match(err.message, /looks like a secret value/);
        return true;
      },
    );
  });

  test('raw headers/fields are only stored as references; no key material is read', () => {
    // The schema has no place for a literal key: only `apiKeyEnv` (a NAME) is
    // accepted. A provider carrying an unknown `apiKey` field is not rejected,
    // but that field is never read by the Registry — only `apiKeyEnv` is.
    const withStray = provider({ apiKey: 'sk-should-never-be-used' });
    const registry = new Registry(validateRegistryFile(file([withStray])).providers, { env: { EXAMPLE_API_KEY: 'env-key' } });
    assert.equal(registry.apiKey('p'), 'env-key', 'only the env reference is read');
  });
});

describe('registry contract — FREE_ONLY uses explicit pricing only', () => {
  test('a zero-priced model is free; a non-zero model is not', () => {
    const free = validateRegistryFile(file([provider({ models: [model({ price: { inPerMTok: 0, outPerMTok: 0 } })] })]))
      .providers[0]!.models[0]!;
    const paid = validateRegistryFile(
      file([provider({ models: [model({ price: { inPerMTok: 1, outPerMTok: 1 }, priceVerifiedAt: '2026-10-01' })] })]),
    ).providers[0]!.models[0]!;
    assert.equal(isFree(free), true);
    assert.equal(isFree(paid), false);
  });

  test('FREE_ONLY cannot classify an unknown/malformed entry as free', async () => {
    // A malformed entry cannot even load, so it can never be free.
    const malformed = model();
    delete (malformed as Record<string, unknown>)['price'];
    assert.throws(() => validateRegistryFile(file([provider({ models: [malformed] })])), /invalid price/);

    // And a paid entry explicitly marked non-zero never executes under FREE_ONLY.
    const paid = provider({
      id: 'paid',
      models: [model({ price: { inPerMTok: 2, outPerMTok: 4 }, priceVerifiedAt: '2026-10-01' })],
    }) as unknown as ProviderConfig;
    const { fetch, calls } = fakeFetch(() => okChat('ok'));
    const mesh = new InferenceMesh({
      registry: new Registry([paid], { env: { EXAMPLE_API_KEY: 'k' } }),
      fetchImpl: fetch,
      enforceFreeOnly: true,
    });
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => err instanceof NoCandidateError,
    );
    assert.equal(calls.length, 0, 'no provider call for a non-free candidate');
  });

  test('the valid capability vocabulary is the documented set', () => {
    for (const cap of ['text', 'tools', 'vision', 'json']) assert.ok(VALID_CAPABILITIES.has(cap));
  });
});
