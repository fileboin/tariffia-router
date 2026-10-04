import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { validateRegistryFile } from '../src/core/config.js';
import { Registry } from '../src/core/registry.js';

function provider(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p',
    kind: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnv: 'EXAMPLE_API_KEY',
    maxPrivacy: 'internal',
    models: [
      {
        id: 'm',
        capabilities: ['text'],
        contextWindow: 8192,
        price: { inPerMTok: 0, outPerMTok: 0 },
      },
    ],
    ...over,
  };
}

const file = (p: Record<string, unknown>) => validateRegistryFile({ providers: [p] }).providers[0]!;

describe('provider risk metadata', () => {
  test('valid risk "ok" passes and is preserved', () => {
    const p = file(provider({ risk: 'ok', riskVerifiedAt: '2026-10-01' }));
    assert.equal(p.risk, 'ok');
    assert.equal(p.riskVerifiedAt, '2026-10-01');
  });

  test('valid risk "caution" passes', () => {
    assert.equal(file(provider({ risk: 'caution' })).risk, 'caution');
  });

  test('valid risk "avoid" with a note passes', () => {
    const p = file(provider({ risk: 'avoid', riskNote: 'subscription-credential reuse; against terms' }));
    assert.equal(p.risk, 'avoid');
    assert.equal(p.riskNote, 'subscription-credential reuse; against terms');
  });

  test('risk "avoid" without a note is rejected', () => {
    assert.throws(() => validateRegistryFile({ providers: [provider({ risk: 'avoid' })] }), /no riskNote/);
    assert.throws(
      () => validateRegistryFile({ providers: [provider({ risk: 'avoid', riskNote: '   ' })] }),
      /no riskNote/,
    );
  });

  test('invalid risk value is rejected', () => {
    assert.throws(
      () => validateRegistryFile({ providers: [provider({ risk: 'blocked' })] }),
      /unknown risk/,
    );
  });

  test('invalid riskVerifiedAt is rejected', () => {
    assert.throws(
      () => validateRegistryFile({ providers: [provider({ risk: 'ok', riskVerifiedAt: 'yesterday' })] }),
      /invalid riskVerifiedAt/,
    );
  });

  test('an old registry without risk fields still loads unchanged', () => {
    const p = file(provider());
    assert.equal(p.risk, undefined);
    assert.equal(p.riskNote, undefined);
    assert.equal(p.riskVerifiedAt, undefined);
    // And it builds a working registry.
    const registry = new Registry([p], { env: { EXAMPLE_API_KEY: 'k' } });
    assert.equal(registry.providers.length, 1);
  });

  test('risk metadata does not change routing/selection (schema only)', () => {
    // Two providers differing only in risk still both load as candidates; the
    // field is not consumed by the router yet.
    const ok = provider({ id: 'a', risk: 'ok' });
    const caution = provider({ id: 'b', risk: 'caution' });
    const validated = validateRegistryFile({ providers: [ok, caution] });
    const registry = new Registry(validated.providers, { env: { EXAMPLE_API_KEY: 'k' } });
    assert.equal(registry.candidates.length, 2);
  });
});
