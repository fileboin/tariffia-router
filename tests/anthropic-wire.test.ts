import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  anthropicRequestToInternal,
  anthropicResponseToInternal,
  anthropicSseStreamToOpenAI,
  internalToAnthropicBody,
  internalToAnthropicResponse,
  openAIStreamToAnthropic,
  type AnthropicRequest,
  type AnthropicResponse,
} from '../src/core/providers/anthropic-wire.js';
import type { ChatRequest, ChatResponse } from '../src/core/types.js';
import { readAll } from './helpers.js';

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('Anthropic request -> internal', () => {
  test('preserves system, messages, sampling, stop and tools', () => {
    const body: AnthropicRequest = {
      model: 'claude-x',
      system: 'be nice',
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['STOP'],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
      tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    };
    const req = anthropicRequestToInternal(body);
    assert.equal(req.model, 'claude-x');
    assert.equal(req.max_tokens, 100);
    assert.equal(req.temperature, 0.5);
    assert.equal(req.top_p, 0.9);
    assert.deepEqual(req.stop, ['STOP']);
    assert.deepEqual(req.messages[0], { role: 'system', content: 'be nice' });
    assert.deepEqual(req.messages[1], { role: 'user', content: 'hi' });
    assert.deepEqual(req.messages[2], { role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
    assert.equal((req.tools?.[0] as { function: { name: string } }).function.name, 'get_weather');
    assert.deepEqual(
      (req.tools?.[0] as { function: { parameters: unknown } }).function.parameters,
      { type: 'object', properties: { city: { type: 'string' } } },
    );
    assert.deepEqual(req.tool_choice, { type: 'function', function: { name: 'get_weather' } });
  });

  test('tool_use and tool_result become assistant tool_calls and a tool message', () => {
    const body: AnthropicRequest = {
      model: 'claude-x',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
      ],
    };
    const req = anthropicRequestToInternal(body);
    const assistant = req.messages[0];
    assert.equal(assistant?.role, 'assistant');
    assert.deepEqual(assistant?.tool_calls, [
      { id: 'tu1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
    ]);
    assert.deepEqual(req.messages[1], { role: 'tool', tool_call_id: 'tu1', content: 'ok' });
  });
});

describe('internal request -> Anthropic', () => {
  test('preserves system, tools, stop and maps tool calls and results', () => {
    const req: ChatRequest = {
      model: 'm',
      max_tokens: 50,
      stop: ['Z'],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"x":2}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r' },
      ],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
    };
    const body = internalToAnthropicBody(req, 'prov/x');
    assert.equal(body.model, 'prov/x');
    assert.equal(body.system, 'sys');
    assert.equal(body.max_tokens, 50);
    assert.deepEqual(body.stop_sequences, ['Z']);
    assert.deepEqual(body.tools, [{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
    assert.deepEqual(body.messages[0], { role: 'user', content: 'u' });
    assert.deepEqual(body.messages[1], {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'f', input: { x: 2 } }],
    });
    assert.deepEqual(body.messages[2], {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }],
    });
  });

  test('defaults max_tokens because Anthropic requires it', () => {
    const body = internalToAnthropicBody({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, 'm');
    assert.equal(typeof body.max_tokens, 'number');
    assert.ok((body.max_tokens as number) > 0);
  });
});

describe('response translation', () => {
  test('Anthropic response -> internal preserves text, tools, usage and stop_reason', () => {
    const resp: AnthropicResponse = {
      id: 'msg1',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'tool_use', id: 'tu2', name: 'f', input: { y: 3 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 4 },
    };
    const res = anthropicResponseToInternal(resp, 'fallback');
    const choice = res.choices[0];
    assert.equal(res.model, 'claude-x');
    assert.equal(choice?.message.content, 'hello ');
    assert.deepEqual(choice?.message.tool_calls, [
      { id: 'tu2', type: 'function', function: { name: 'f', arguments: '{"y":3}' } },
    ]);
    assert.equal(choice?.finish_reason, 'tool_calls');
    assert.deepEqual(res.usage, { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 });
  });

  test('internal response -> Anthropic preserves content, usage and stop_reason', () => {
    const res: ChatResponse = {
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hi',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"z":1}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    const out = internalToAnthropicResponse(res, 'prov/x');
    assert.equal(out.type, 'message');
    assert.equal(out.model, 'prov/x');
    assert.equal(out.stop_reason, 'tool_use');
    assert.deepEqual(out.usage, { input_tokens: 3, output_tokens: 2 });
    assert.deepEqual(out.content, [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'c1', name: 'f', input: { z: 1 } },
    ]);
  });
});

describe('SSE translation', () => {
  test('Anthropic SSE -> OpenAI SSE carries text, stop reason and usage', async () => {
    const input = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const out = await readAll(anthropicSseStreamToOpenAI(streamOf(input), 'id1', 'm'));
    assert.match(out, /"role":"assistant"/);
    assert.match(out, /"content":"Hi"/);
    assert.match(out, /"finish_reason":"stop"/);
    assert.match(out, /data: \[DONE\]/);
  });

  test('Anthropic SSE tool_use -> OpenAI SSE tool_calls', async () => {
    const input = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"f"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const out = await readAll(anthropicSseStreamToOpenAI(streamOf(input), 'id1', 'm'));
    assert.match(out, /"tool_calls"/);
    assert.match(out, /"name":"f"/);
    assert.match(out, /"finish_reason":"tool_calls"/);
  });

  test('OpenAI SSE -> Anthropic SSE emits the event sequence', async () => {
    const input = [
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await readAll(openAIStreamToAnthropic(streamOf(input), 'm'));
    assert.match(out, /event: message_start/);
    assert.match(out, /event: content_block_start/);
    assert.match(out, /"type":"text_delta"/);
    assert.match(out, /"text":"Hi"/);
    assert.match(out, /event: message_delta/);
    assert.match(out, /"stop_reason":"end_turn"/);
    assert.match(out, /event: message_stop/);
  });
});
