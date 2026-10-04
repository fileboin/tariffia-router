import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  readOpenAiCatalog,
  parseOpenAiModels,
  modelsEndpoint,
  CatalogError,
} from '../src/catalog-reader.js';
import type { FetchLike } from '../src/core/providers/base.js';

/**
 * A recording fetch. Returns a scripted Response and records the requests. No
 * network is ever touched: the tests pass this in as `fetchImpl`.
 */
function recorder(response: Response | (() => Promise<Response>)): { fetchImpl: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    return typeof response === 'function' ? response() : response;
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const VALID = {
  object: 'list',
  data: [
    { id: 'llama-3.3-70b', object: 'model', owned_by: 'meta', context_length: 131072 },
    { id: 'mixtral-8x7b', object: 'model', owned_by: 'mistral', context_window: 32768 },
    { id: 'plain-model', object: 'model' },
  ],
};

describe('modelsEndpoint', () => {
  test('appends /models to a base URL', () => {
    assert.equal(modelsEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/models');
  });

  test('handles a trailing slash and a bare host', () => {
    assert.equal(modelsEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1/models');
    assert.equal(modelsEndpoint('https://api.example.com'), 'https://api.example.com/models');
    assert.equal(modelsEndpoint('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/models');
  });
});

describe('readOpenAiCatalog — success cases', () => {
  test('parses a valid OpenAI /models response', async () => {
    const { fetchImpl, calls } = recorder(jsonResponse(VALID));
    const result = await readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl });
    assert.equal(result.providerId, 'p');
    assert.equal(result.url, 'https://p.test/v1/models');
    assert.equal(result.models.length, 3);
    assert.equal(calls[0]?.url, 'https://p.test/v1/models');
    assert.equal(calls[0]?.init?.method, 'GET');
  });

  test('normalizes model ids and metadata', async () => {
    const { fetchImpl } = recorder(jsonResponse(VALID));
    const { models } = await readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl });
    assert.equal(models[0]?.id, 'llama-3.3-70b');
    assert.equal(models[0]?.contextWindow, 131072);
    assert.equal(models[1]?.id, 'mixtral-8x7b');
    assert.equal(models[1]?.contextWindow, 32768, 'context_window variant read');
    assert.equal(models[2]?.id, 'plain-model');
    assert.equal(models[2]?.contextWindow, undefined, 'no context field -> absent, not invented');
  });

  test('an empty model list is valid and returns []', async () => {
    const { fetchImpl } = recorder(jsonResponse({ object: 'list', data: [] }));
    const result = await readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl });
    assert.deepEqual(result.models, []);
  });

  test('multiple models preserve provider order', async () => {
    const { fetchImpl } = recorder(jsonResponse(VALID));
    const { models } = await readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl });
    assert.deepEqual(models.map((m) => m.id), ['llama-3.3-70b', 'mixtral-8x7b', 'plain-model']);
  });
});

describe('readOpenAiCatalog — auth', () => {
  test('a provider requiring a key sends Bearer', async () => {
    const { fetchImpl, calls } = recorder(jsonResponse(VALID));
    await readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1', apiKey: 'sk-abc' }, { fetchImpl });
    const h = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    assert.equal(h['authorization'], 'Bearer sk-abc');
  });

  test('an optional/keyless provider sends no Authorization header', async () => {
    const { fetchImpl, calls } = recorder(jsonResponse(VALID));
    await readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl });
    const h = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    assert.equal(h['authorization'], undefined, 'no malformed Bearer for a keyless provider');
    assert.equal(h['accept'], 'application/json');
  });

  test('extra provider headers are merged', async () => {
    const { fetchImpl, calls } = recorder(jsonResponse(VALID));
    await readOpenAiCatalog(
      { id: 'p', baseUrl: 'https://p.test/v1', apiKey: 'k', headers: { 'x-title': 'tariffia' } },
      { fetchImpl },
    );
    const h = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    assert.equal(h['x-title'], 'tariffia');
    assert.equal(h['authorization'], 'Bearer k');
  });
});

describe('readOpenAiCatalog — failure cases', () => {
  test('a non-2xx response fails clearly', async () => {
    const { fetchImpl } = recorder(jsonResponse({ error: 'nope' }, 500));
    await assert.rejects(
      () => readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl }),
      (e: unknown) => e instanceof CatalogError && /answered 500/.test((e as Error).message),
    );
  });

  test('a 401 fails clearly and is not treated as an empty success', async () => {
    const { fetchImpl } = recorder(jsonResponse({ error: 'unauthorized' }, 401));
    await assert.rejects(
      () => readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl }),
      /answered 401/,
    );
  });

  test('invalid JSON fails clearly', async () => {
    const { fetchImpl } = recorder(new Response('{ not json', { status: 200 }));
    await assert.rejects(
      () => readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl }),
      /unreadable JSON/,
    );
  });

  test('a malformed response (no data array) fails clearly', async () => {
    const { fetchImpl } = recorder(jsonResponse({ object: 'list' }));
    await assert.rejects(
      () => readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl }),
      /no 'data' array/,
    );
  });

  test('a model entry without an id fails clearly', async () => {
    const { fetchImpl } = recorder(jsonResponse({ data: [{ name: 'no-id' }] }));
    await assert.rejects(
      () => readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl }),
      /no string id/,
    );
  });

  test('a non-array data value fails clearly', async () => {
    const { fetchImpl } = recorder(jsonResponse({ data: 'nope' }));
    await assert.rejects(
      () => readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl }),
      /no 'data' array/,
    );
  });

  test('a network error fails clearly', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await assert.rejects(
      () => readOpenAiCatalog({ id: 'p', baseUrl: 'https://p.test/v1' }, { fetchImpl }),
      (e: unknown) => e instanceof CatalogError && /cannot reach provider/.test((e as Error).message),
    );
  });
});

describe('parseOpenAiModels (pure)', () => {
  test('does not invent pricing or free status', () => {
    const models = parseOpenAiModels(VALID);
    for (const m of models) {
      assert.ok(!('price' in m), 'no price field is added');
      assert.ok(!('free' in m), 'no free flag is added');
    }
    // The first entry has an id and a context window and nothing else.
    assert.deepEqual(Object.keys(models[0]!).sort(), ['contextWindow', 'id']);
    assert.deepEqual(Object.keys(models[2]!).sort(), ['id']);
  });

  test('rejects a null body', () => {
    assert.throws(() => parseOpenAiModels(null), /not a JSON object/);
  });

  test('an entry with a non-object value is rejected', () => {
    assert.throws(() => parseOpenAiModels({ data: [42] }), /not an object/);
  });
});
