import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { InferenceMesh } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import { NoCandidateError, type Capability, type ProviderConfig } from '../src/core/types.js';
import { fakeFetch, okChat } from './helpers.js';

const user = { role: 'user' as const, content: 'x' };
const image = {
  role: 'user' as const,
  content: [{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } }],
};
const toolDef = { type: 'function' as const, function: { name: 'f' } };

function mk(id: string, caps: Capability[], opts: { price?: number; quality?: number } = {}): ProviderConfig {
  const price = opts.price ?? 0;
  return {
    id,
    kind: 'openai-compat',
    baseUrl: `https://${id}.test/v1`,
    apiKeyEnv: `${id.toUpperCase().replace(/-/g, '_')}_KEY`,
    maxPrivacy: 'internal',
    models: [
      {
        id: 'm',
        capabilities: caps,
        contextWindow: 200000,
        price: { inPerMTok: price, outPerMTok: price },
        quality: opts.quality ?? 0.5,
        ...(price > 0 ? { priceVerifiedAt: '2026-10-01' } : {}),
      },
    ],
  } as ProviderConfig;
}

function build(providers: ProviderConfig[], opts: { enforceFreeOnly?: boolean } = {}) {
  const env = Object.fromEntries(providers.map((p) => [p.apiKeyEnv, 'k']));
  const { fetch, calls } = fakeFetch(() => okChat('ok'));
  const mesh = new InferenceMesh({
    registry: new Registry(providers, { env }),
    fetchImpl: fetch,
    enforceFreeOnly: opts.enforceFreeOnly ?? false,
  });
  return { mesh, calls };
}

const contacted = (calls: Array<{ url: string }>, host: string) => calls.some((c) => c.url.includes(host));

describe('capability-aware candidate filtering', () => {
  test('a tools request excludes candidates without tools', async () => {
    const { mesh, calls } = build([mk('text-only', ['text']), mk('with-tools', ['text', 'tools'])]);
    const res = await mesh.chat({ model: 'mesh/free', messages: [user], tools: [toolDef] });
    assert.equal(res.mesh?.served_by, 'with-tools/m');
    assert.ok(!contacted(calls, 'text-only.test'), 'text-only candidate must be excluded');
  });

  test('a vision request excludes candidates without vision', async () => {
    const { mesh, calls } = build([mk('text-only', ['text']), mk('with-vision', ['text', 'vision'])]);
    const res = await mesh.chat({ model: 'mesh/free', messages: [image] });
    assert.equal(res.mesh?.served_by, 'with-vision/m');
    assert.ok(!contacted(calls, 'text-only.test'));
  });

  test('a JSON request excludes candidates without JSON support', async () => {
    const { mesh, calls } = build([mk('text-only', ['text']), mk('with-json', ['text', 'json'])]);
    const res = await mesh.chat({
      model: 'mesh/free',
      messages: [user],
      response_format: { type: 'json_object' },
    });
    assert.equal(res.mesh?.served_by, 'with-json/m');
    assert.ok(!contacted(calls, 'text-only.test'));
  });

  test('combined requirements require every capability', async () => {
    const { mesh } = build([
      mk('text-only', ['text']),
      mk('with-tools', ['text', 'tools']),
      mk('with-json', ['text', 'json']),
      mk('with-all', ['text', 'tools', 'vision', 'json']),
    ]);
    const res = await mesh.chat({
      model: 'mesh/free',
      messages: [image],
      tools: [toolDef],
      response_format: { type: 'json_schema' },
    });
    assert.equal(res.mesh?.served_by, 'with-all/m');
  });

  test('a normal text request preserves existing routing', async () => {
    const { mesh } = build([
      mk('a-text', ['text'], { quality: 0.6 }),
      mk('b-tools', ['text', 'tools'], { quality: 0.5 }),
    ]);
    const res = await mesh.chat({ model: 'mesh/free', messages: [user] });
    // Only 'text' is required, so scoring picks the higher-quality candidate.
    assert.equal(res.mesh?.served_by, 'a-text/m');
  });

  test('no capability match returns a clear error naming the requirement', async () => {
    const { mesh } = build([mk('text-only', ['text'])]);
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [image] }),
      (err: unknown) => {
        assert.ok(err instanceof NoCandidateError, 'a routing error is raised');
        assert.match((err as Error).message, /vision/);
        assert.match((err as Error).message, /Required capabilities/);
        assert.ok(
          (err as NoCandidateError).rejected.some((r) => r.reason.startsWith('capability')),
          'the rejection explains the missing capability',
        );
        return true;
      },
    );
  });

  test('FREE_ONLY still blocks paid candidates, even when only paid satisfies the requirement', async () => {
    const { mesh, calls } = build(
      [mk('free-tools', ['text', 'tools']), mk('paid-all', ['text', 'tools', 'vision', 'json'], { price: 5 })],
      { enforceFreeOnly: true },
    );

    // Vision is only offered by the paid provider, so this must fail, not pay.
    await assert.rejects(
      () => mesh.chat({ model: 'mesh/free', messages: [image] }),
      (err: unknown) => err instanceof NoCandidateError,
    );
    assert.ok(!contacted(calls, 'paid-all.test'), 'the paid provider must never be called');

    // A capability the free provider does have is served normally.
    const res = await mesh.chat({ model: 'mesh/free', messages: [user], tools: [toolDef] });
    assert.equal(res.mesh?.served_by, 'free-tools/m');
  });
});

describe('pin behavior outside FREE_ONLY', () => {
  test('a pin to a capable model is still honoured and bypasses scoring', async () => {
    const { mesh } = build([mk('a', ['text', 'tools'], { quality: 0.3 }), mk('b', ['text'], { quality: 0.9 })]);
    const res = await mesh.chat({ model: 'a/m', messages: [user], tools: [toolDef] });
    assert.equal(res.mesh?.served_by, 'a/m');
  });

  test('a pin to a model that cannot satisfy the request is rejected, not silently downgraded', async () => {
    const { mesh } = build([mk('text-only', ['text'])]);
    await assert.rejects(
      () => mesh.chat({ model: 'text-only/m', messages: [user], tools: [toolDef] }),
      (err: unknown) => {
        assert.ok(err instanceof NoCandidateError);
        assert.ok((err as NoCandidateError).rejected.some((r) => r.reason.startsWith('capability')));
        return true;
      },
    );
  });
});
