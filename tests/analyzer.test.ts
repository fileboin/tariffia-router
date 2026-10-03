import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { analyzeRequest } from '../src/core/analyzer.js';
import { anthropicRequestToInternal } from '../src/core/providers/anthropic-wire.js';
import { InferenceMesh, type MeshEvent } from '../src/core/mesh.js';
import { Registry } from '../src/core/registry.js';
import type { ChatRequest } from '../src/core/types.js';
import { FIXTURE_ENV, fakeFetch, fixtureProviders, okChat } from './helpers.js';

describe('deterministic task analyzer', () => {
  test('plain text request', () => {
    const r = analyzeRequest({ model: 'm', messages: [{ role: 'user', content: 'hello world' }] });
    assert.equal(r.protocol, 'openai');
    assert.equal(r.streaming, false);
    assert.equal(r.needsTools, false);
    assert.equal(r.needsVision, false);
    assert.equal(r.needsStructuredOutput, false);
    assert.deepEqual(r.requiredCapabilities, ['text']);
    assert.ok(r.estimatedInputTokens > 0);
    assert.equal(r.maxOutputTokens, undefined);
    assert.equal(r.estimatedContextTokens, r.estimatedInputTokens);
  });

  test('streaming request', () => {
    const r = analyzeRequest({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.streaming, true);
  });

  test('tool request — declared tools', () => {
    const r = analyzeRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    });
    assert.equal(r.needsTools, true);
    assert.deepEqual(r.requiredCapabilities, ['text', 'tools']);
  });

  test('tool request — tool call and tool result already in the conversation', () => {
    const r = analyzeRequest({
      model: 'm',
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r' },
      ],
    });
    assert.equal(r.needsTools, true);
    assert.deepEqual(r.requiredCapabilities, ['text', 'tools']);
  });

  test('image/vision request', () => {
    const r = analyzeRequest({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    });
    assert.equal(r.needsVision, true);
    assert.deepEqual(r.requiredCapabilities, ['text', 'vision']);
    // The text part still counts toward the size estimate; the image does not.
    assert.ok(r.estimatedInputTokens > 0);
  });

  test('Anthropic request', () => {
    const internal = anthropicRequestToInternal({
      model: 'claude-x',
      system: 'be nice',
      max_tokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
    });
    const r = analyzeRequest(internal, { protocol: 'anthropic' });
    assert.equal(r.protocol, 'anthropic');
    assert.equal(r.needsTools, true);
    assert.equal(r.maxOutputTokens, 256);
    assert.ok(r.estimatedInputTokens > 0, 'system + user text counted');
  });

  test('large context request', () => {
    const big = 'a'.repeat(40000);
    const r = analyzeRequest({ model: 'm', max_tokens: 1000, messages: [{ role: 'user', content: big }] });
    assert.ok(r.estimatedInputTokens >= 9000, `got ${r.estimatedInputTokens}`);
    assert.equal(r.maxOutputTokens, 1000);
    assert.equal(r.estimatedContextTokens, r.estimatedInputTokens + 1000);
  });

  test('combined requirements', () => {
    const r = analyzeRequest({
      model: 'm',
      stream: true,
      max_tokens: 500,
      response_format: { type: 'json_schema' },
      tools: [{ type: 'function', function: { name: 'f' } }],
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      ],
    });
    assert.equal(r.streaming, true);
    assert.equal(r.needsTools, true);
    assert.equal(r.needsVision, true);
    assert.equal(r.needsStructuredOutput, true);
    assert.deepEqual(r.requiredCapabilities, ['text', 'tools', 'vision', 'json']);
    assert.equal(r.maxOutputTokens, 500);
  });

  test('structured output via json_object', () => {
    const r = analyzeRequest({ model: 'm', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.needsStructuredOutput, true);
    assert.deepEqual(r.requiredCapabilities, ['text', 'json']);
  });

  test('malformed/minimal request is total, not throwing', () => {
    const empty = analyzeRequest(undefined);
    assert.equal(empty.estimatedInputTokens, 0);
    assert.deepEqual(empty.requiredCapabilities, ['text']);
    assert.equal(empty.streaming, false);
    assert.equal(empty.needsTools, false);

    const noMessages = analyzeRequest({ model: 'm' } as ChatRequest);
    assert.equal(noMessages.estimatedInputTokens, 0);
    assert.deepEqual(noMessages.requiredCapabilities, ['text']);

    const badMessages = analyzeRequest({ model: 'm', messages: 'nope' } as unknown as ChatRequest);
    assert.equal(badMessages.estimatedInputTokens, 0);
  });
});

describe('analyzer is exposed to the routing pipeline without changing selection', () => {
  test('mesh.analyze returns the typed result and the route event carries it', async () => {
    const events: MeshEvent[] = [];
    const { fetch } = fakeFetch(() => okChat('hi'));
    const mesh = new InferenceMesh({
      registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
      fetchImpl: fetch,
      onEvent: (e) => events.push(e),
    });

    const withTools: ChatRequest = {
      model: 'mesh/free',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
    };
    assert.deepEqual(mesh.analyze(withTools).requiredCapabilities, ['text', 'tools']);

    // The analysis is emitted at the routing decision point.
    const res = await mesh.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    const route = events.find((e) => e.type === 'route');
    assert.ok(route?.analysis, 'the route event carries the analysis');
    assert.deepEqual(route.analysis.requiredCapabilities, ['text']);

    // A plain text request keeps selecting the same candidate as before.
    assert.equal(res.mesh?.served_by, 'alpha/alpha-free');
  });
});
