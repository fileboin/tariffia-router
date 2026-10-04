import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { probeCandidate, probeCandidates } from '../src/candidate-probe.js';
import type { CandidateProvider } from '../src/seed-candidates.js';
import type { FetchLike } from '../src/core/providers/base.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function candidate(over: Partial<CandidateProvider> = {}): CandidateProvider {
  return {
    candidateId: 'p',
    name: 'P',
    unverified: true,
    baseUrl: 'https://p.test/v1',
    url: 'https://p.test/keys',
    description: 'free',
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

function recorder(response: Response | (() => Promise<Response>)): { fetchImpl: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    return typeof response === 'function' ? response() : response;
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('candidate probe', () => {
  test('a valid endpoint returns reachable', async () => {
    const { fetchImpl, calls } = recorder(json({ data: [{ id: 'a' }, { id: 'b' }] }));
    const r = await probeCandidate(candidate(), { fetchImpl });
    assert.equal(r.status, 'reachable');
    assert.equal(r.reason, 'ok');
    assert.equal(r.modelCount, 2);
    assert.equal(r.httpStatus, 200);
    assert.equal(calls[0]?.url, 'https://p.test/v1/models');
    assert.equal(calls[0]?.init?.method, 'GET');
  });

  test('a valid empty model list is reachable with an explicit reason', async () => {
    const { fetchImpl } = recorder(json({ data: [] }));
    const r = await probeCandidate(candidate(), { fetchImpl });
    assert.equal(r.status, 'reachable');
    assert.equal(r.reason, 'empty_model_list');
    assert.equal(r.modelCount, 0);
  });

  test('401 returns unreachable / unauthorized', async () => {
    const { fetchImpl } = recorder(json({ error: 'unauthorized' }, 401));
    const r = await probeCandidate(candidate(), { fetchImpl, apiKey: 'sk-secret' });
    assert.equal(r.status, 'unreachable');
    assert.equal(r.reason, 'unauthorized');
    assert.equal(r.httpStatus, 401);
  });

  test('404 returns unreachable / not_found', async () => {
    const { fetchImpl } = recorder(json({ error: 'not found' }, 404));
    const r = await probeCandidate(candidate(), { fetchImpl });
    assert.equal(r.status, 'unreachable');
    assert.equal(r.reason, 'not_found');
  });

  test('500 returns unreachable / server_error', async () => {
    const { fetchImpl } = recorder(json({ error: 'boom' }, 500));
    const r = await probeCandidate(candidate(), { fetchImpl });
    assert.equal(r.status, 'unreachable');
    assert.equal(r.reason, 'server_error');
    assert.equal(r.httpStatus, 500);
  });

  test('invalid JSON returns invalid / invalid_json', async () => {
    const { fetchImpl } = recorder(new Response('{ not json', { status: 200 }));
    const r = await probeCandidate(candidate(), { fetchImpl });
    assert.equal(r.status, 'invalid');
    assert.equal(r.reason, 'invalid_json');
  });

  test('a 2xx that is not a models payload returns invalid / invalid_schema', async () => {
    const { fetchImpl } = recorder(json({ hello: 'world' }));
    const r = await probeCandidate(candidate(), { fetchImpl });
    assert.equal(r.status, 'invalid');
    assert.equal(r.reason, 'invalid_schema');
  });

  test('a network failure returns unreachable / network_error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await probeCandidate(candidate(), { fetchImpl });
    assert.equal(r.status, 'unreachable');
    assert.equal(r.reason, 'network_error');
    assert.equal(r.httpStatus, undefined);
  });

  test('a candidate without baseUrl returns unsupported / no_base_url (no network)', async () => {
    const c = candidate();
    delete (c as { baseUrl?: string }).baseUrl;
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return json({ data: [] });
    };
    const r = await probeCandidate(c, { fetchImpl });
    assert.equal(r.status, 'unsupported');
    assert.equal(r.reason, 'no_base_url');
    assert.equal(called, false, 'no network on a candidate without a baseUrl');
  });

  test('the probe never mutates the candidate and never exposes the key', async () => {
    const c = candidate();
    const before = clone(c);
    const { fetchImpl } = recorder(json({ data: [{ id: 'a' }] }));
    const r = await probeCandidate(c, { fetchImpl, apiKey: 'sk-super-secret' });
    assert.deepEqual(clone(c), before, 'candidate unchanged');
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes('sk-super-secret'), 'the key never appears in the result');
  });

  test('probeCandidates preserves order and probes each once', async () => {
    const { fetchImpl, calls } = recorder(json({ data: [{ id: 'a' }] }));
    const results = await probeCandidates([candidate({ candidateId: 'a' }), candidate({ candidateId: 'b', baseUrl: 'https://b.test/v1' })], { fetchImpl });
    assert.deepEqual(results.map((x) => x.candidateId), ['a', 'b']);
    assert.equal(calls.length, 2);
  });

  test('a keyless candidate sends no Authorization header', async () => {
    const { fetchImpl, calls } = recorder(json({ data: [] }));
    await probeCandidate(candidate(), { fetchImpl });
    const h = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    assert.equal(h['authorization'], undefined);
  });
});
