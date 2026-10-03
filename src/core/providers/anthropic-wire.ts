/**
 * Anthropic Messages wire translation and SSE conversion.
 *
 * The core speaks one internal, OpenAI-shaped chat representation. This module
 * is the pure boundary between that representation and Anthropic's
 * `/v1/messages` wire format, in both directions:
 *
 *   - `anthropicRequestToInternal`  Anthropic request  -> internal request
 *   - `internalToAnthropicBody`     internal request   -> Anthropic request
 *   - `anthropicResponseToInternal` Anthropic response -> internal response
 *   - `internalToAnthropicResponse` internal response  -> Anthropic response
 *   - `anthropicSseStreamToOpenAI`  Anthropic SSE      -> OpenAI SSE  (adapter)
 *   - `openAIStreamToAnthropic`     OpenAI SSE         -> Anthropic SSE (gateway)
 *
 * It is deliberately free of any network or environment access so both the
 * outbound adapter and the inbound gateway can share it and it can be unit
 * tested on plain objects.
 *
 * Tariffia addition (2026-10-03). See THIRD_PARTY_NOTICES.md.
 */

import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Usage,
} from '../types.js';
import { SSE_DONE, sseLine } from './base.js';

/** Anthropic requires `max_tokens`; used only when the caller omitted it. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

/* -------------------------------------------------------------------------- */
/* Anthropic wire types (the subset this adapter represents)                  */
/* -------------------------------------------------------------------------- */

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type?: string; data?: string }
    | { type: 'url'; url?: string };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicTextBlock[];
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool';
  name?: string;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface AnthropicRequest {
  model: string;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  [key: string]: unknown;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: AnthropicUsage;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function textOfContent(content: ChatMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  let out = '';
  for (const part of content as ChatContentPart[]) {
    if (part.type === 'text') out += part.text;
  }
  return out;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function imageUrlToAnthropic(url: string): AnthropicImageBlock {
  const m = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1] as string, data: m[2] as string } };
  return { type: 'image', source: { type: 'url', url } };
}

function anthropicImageToUrl(block: AnthropicImageBlock): string {
  if (block.source.type === 'base64') {
    return `data:${block.source.media_type ?? 'image/png'};base64,${block.source.data ?? ''}`;
  }
  return block.source.url ?? '';
}

function toolResultText(block: AnthropicToolResultBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map((b) => b.text).join('');
  return '';
}

/** Anthropic requires alternating roles; merge consecutive same-role turns. */
function mergeConsecutive(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      const a = Array.isArray(last.content) ? last.content : last.content ? [{ type: 'text' as const, text: last.content }] : [];
      const b = Array.isArray(m.content) ? m.content : m.content ? [{ type: 'text' as const, text: m.content }] : [];
      last.content = [...a, ...b];
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

function stopReasonToFinish(raw: string | null | undefined): string {
  switch (raw) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    case undefined:
    case null:
      return 'stop';
    default:
      return raw;
  }
}

function finishToStopReason(raw: string | null | undefined): string | null {
  switch (raw) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case 'stop':
      return 'end_turn';
    case null:
    case undefined:
      return null;
    default:
      return 'end_turn';
  }
}

function toAnthropicTools(tools: unknown[] | undefined): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const out: AnthropicTool[] = [];
  for (const tool of tools) {
    const t = tool as { name?: string; description?: string; input_schema?: unknown; function?: { name?: string; description?: string; parameters?: unknown } };
    if (t.input_schema !== undefined && t.name) {
      out.push({ name: t.name, description: t.description, input_schema: t.input_schema });
      continue;
    }
    const fn = t.function ?? {};
    if (!fn.name) continue;
    out.push({
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    });
  }
  return out.length > 0 ? out : undefined;
}

function internalToolChoiceToAnthropic(choice: unknown): AnthropicToolChoice | undefined {
  const c = choice as { type?: string; name?: string; function?: { name?: string } };
  if (!c || typeof c !== 'object') return undefined;
  if (c.type === 'auto') return { type: 'auto' };
  if (c.type === 'required' || c.type === 'any') return { type: 'any' };
  if (c.type === 'function') {
    const name = c.function?.name ?? c.name;
    return name ? { type: 'tool', name } : undefined;
  }
  return undefined;
}

function anthropicToolChoiceToInternal(choice: AnthropicToolChoice): unknown {
  if (choice.type === 'any') return { type: 'required' };
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } };
  return { type: 'auto' };
}

function usageToInternal(usage: AnthropicUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const prompt = usage.input_tokens ?? 0;
  const completion = usage.output_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/* -------------------------------------------------------------------------- */
/* Request translation                                                        */
/* -------------------------------------------------------------------------- */

/** Anthropic `/v1/messages` body -> the internal chat request. */
export function anthropicRequestToInternal(
  body: AnthropicRequest,
  opts: { stream?: boolean } = {},
): ChatRequest {
  const messages: ChatMessage[] = [];

  if (body.system !== undefined) {
    const system = Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : body.system;
    if (system) messages.push({ role: 'system', content: system });
  }

  for (const m of body.messages ?? []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    let pending: ChatContentPart[] = [];
    const flush = (): void => {
      if (pending.length > 0) {
        messages.push({ role: m.role, content: pending });
        pending = [];
      }
    };
    for (const block of m.content) {
      if (block.type === 'text') {
        pending.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        pending.push({ type: 'image_url', image_url: { url: anthropicImageToUrl(block) } });
      } else if (block.type === 'tool_use') {
        // An assistant tool call: OpenAI carries it as `tool_calls`, not content.
        flush();
        const call = {
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        };
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
        else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      } else if (block.type === 'tool_result') {
        // Anthropic nests tool results in a user turn; OpenAI uses role 'tool'.
        flush();
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolResultText(block) });
      }
    }
    flush();
  }

  const req: ChatRequest = { model: body.model, messages };
  if (body.max_tokens !== undefined) req.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (body.top_p !== undefined) req.top_p = body.top_p;
  if (body.stop_sequences !== undefined) req.stop = body.stop_sequences;
  if (body.tools !== undefined) {
    req.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
  }
  if (body.tool_choice !== undefined) req.tool_choice = anthropicToolChoiceToInternal(body.tool_choice);
  if (opts.stream ?? body.stream) req.stream = true;
  return req;
}

/** The internal chat request -> an Anthropic `/v1/messages` body. */
export function internalToAnthropicBody(req: ChatRequest, modelId: string): AnthropicRequest {
  const body: AnthropicRequest = {
    model: modelId,
    messages: [],
    max_tokens: req.max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
  };

  const systems: string[] = [];
  const out: AnthropicMessage[] = [];
  let lastToolResult: AnthropicMessage | null = null;

  for (const m of req.messages) {
    if (m.role === 'system') {
      const text = textOfContent(m.content);
      if (text) systems.push(text);
      continue;
    }
    if (m.role === 'tool') {
      const block: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: String(m.tool_call_id ?? ''),
        content: textOfContent(m.content),
      };
      if (lastToolResult) (lastToolResult.content as AnthropicContentBlock[]).push(block);
      else {
        const msg: AnthropicMessage = { role: 'user', content: [block] };
        out.push(msg);
        lastToolResult = msg;
      }
      continue;
    }
    lastToolResult = null;

    if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      const text = textOfContent(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const raw of (m.tool_calls ?? []) as Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>) {
        const fn = raw.function ?? {};
        blocks.push({
          type: 'tool_use',
          id: String(raw.id ?? ''),
          name: String(fn.name ?? ''),
          input: parseArgs(fn.arguments),
        });
      }
      if (blocks.length === 0) continue;
      const first = blocks[0];
      if (blocks.length === 1 && first && first.type === 'text') out.push({ role: 'assistant', content: first.text });
      else out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // user
    if (typeof m.content === 'string' || m.content === null || m.content === undefined) {
      out.push({ role: 'user', content: textOfContent(m.content) });
    } else {
      const blocks: AnthropicContentBlock[] = [];
      for (const part of m.content as ChatContentPart[]) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'image_url') blocks.push(imageUrlToAnthropic(part.image_url.url));
      }
      out.push({ role: 'user', content: blocks.length > 0 ? blocks : '' });
    }
  }

  if (systems.length > 0) body.system = systems.join('\n\n');
  body.messages = mergeConsecutive(out);
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.stop !== undefined) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  const tools = toAnthropicTools(req.tools);
  if (tools) body.tools = tools;
  const choice = internalToolChoiceToAnthropic(req.tool_choice);
  if (choice) body.tool_choice = choice;
  return body;
}

/* -------------------------------------------------------------------------- */
/* Response translation                                                       */
/* -------------------------------------------------------------------------- */

/** An Anthropic message response -> the internal chat response. */
export function anthropicResponseToInternal(resp: AnthropicResponse, fallbackModel: string): ChatResponse {
  let text = '';
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  for (const block of resp.content ?? []) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message: ChatMessage = { role: 'assistant', content: toolCalls.length > 0 ? text || null : text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const usage = usageToInternal(resp.usage);
  return {
    id: resp.id || `mesh-anthropic-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model || fallbackModel,
    choices: [{ index: 0, message, finish_reason: stopReasonToFinish(resp.stop_reason) }],
    ...(usage ? { usage } : {}),
  };
}

/** The internal chat response -> an Anthropic message response. */
export function internalToAnthropicResponse(res: ChatResponse, fallbackModel: string): AnthropicResponse {
  const choice = res.choices[0];
  const content: AnthropicContentBlock[] = [];
  if (choice) {
    const text = textOfContent(choice.message.content);
    if (text) content.push({ type: 'text', text });
    for (const raw of (choice.message.tool_calls ?? []) as Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>) {
      const fn = raw.function ?? {};
      content.push({ type: 'tool_use', id: String(raw.id ?? ''), name: String(fn.name ?? ''), input: parseArgs(fn.arguments) });
    }
  }
  const usage = res.usage
    ? { input_tokens: res.usage.prompt_tokens, output_tokens: res.usage.completion_tokens }
    : { input_tokens: 0, output_tokens: 0 };
  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: fallbackModel || res.model,
    content,
    stop_reason: finishToStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage,
  };
}

/* -------------------------------------------------------------------------- */
/* SSE                                                                        */
/* -------------------------------------------------------------------------- */

interface SseBlock {
  event?: string;
  data?: string;
}

function parseSseBlock(raw: string): SseBlock {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join('\n') };
}

function openAiChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage: Usage | undefined,
): unknown {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * Anthropic SSE (a provider's stream) -> OpenAI SSE (the internal stream every
 * adapter must produce). Text and tool-use deltas are translated; `usage` and
 * `stop_reason` are preserved into the terminal chunk.
 */
export function anthropicSseStreamToOpenAI(
  body: ReadableStream<Uint8Array>,
  id: string,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let sentRole = false;
  let done = false;
  let finishReason = 'stop';
  let usage: Usage | undefined;
  const toolIndexByBlock = new Map<number, number>();
  let nextToolIndex = 0;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const { event, data } = parseSseBlock(raw);
          if (!data) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = event ?? (typeof obj['type'] === 'string' ? (obj['type'] as string) : '');

          if (type === 'message_start') {
            const delta: Record<string, unknown> = {};
            if (!sentRole) {
              delta['role'] = 'assistant';
              sentRole = true;
            }
            controller.enqueue(sseLine(openAiChunk(id, created, model, delta, null, undefined)));
          } else if (type === 'content_block_start') {
            const block = obj['content_block'] as { type?: string; id?: string; name?: string } | undefined;
            if (block?.type === 'tool_use') {
              const blockIndex = typeof obj['index'] === 'number' ? (obj['index'] as number) : 0;
              const toolIndex = nextToolIndex++;
              toolIndexByBlock.set(blockIndex, toolIndex);
              controller.enqueue(
                sseLine(
                  openAiChunk(
                    id,
                    created,
                    model,
                    { tool_calls: [{ index: toolIndex, id: block.id ?? '', type: 'function', function: { name: block.name ?? '', arguments: '' } }] },
                    null,
                    undefined,
                  ),
                ),
              );
            }
          } else if (type === 'content_block_delta') {
            const delta = obj['delta'] as { type?: string; text?: string; partial_json?: string } | undefined;
            if (delta?.type === 'text_delta' && delta.text) {
              controller.enqueue(sseLine(openAiChunk(id, created, model, { content: delta.text }, null, undefined)));
            } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
              const blockIndex = typeof obj['index'] === 'number' ? (obj['index'] as number) : 0;
              const toolIndex = toolIndexByBlock.get(blockIndex) ?? 0;
              controller.enqueue(
                sseLine(openAiChunk(id, created, model, { tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }, null, undefined)),
              );
            }
          } else if (type === 'message_delta') {
            const delta = obj['delta'] as { stop_reason?: string | null } | undefined;
            if (delta?.stop_reason) finishReason = stopReasonToFinish(delta.stop_reason);
            const u = obj['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
            if (u) {
              const prompt = u.input_tokens ?? usage?.prompt_tokens ?? 0;
              const completion = u.output_tokens ?? usage?.completion_tokens ?? 0;
              usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
            }
          } else if (type === 'message_stop') {
            controller.enqueue(sseLine(openAiChunk(id, created, model, {}, finishReason, usage)));
            done = true;
          }
        }
      },
      flush(controller) {
        if (!done) controller.enqueue(sseLine(openAiChunk(id, created, model, {}, finishReason, usage)));
        controller.enqueue(SSE_DONE);
      },
    }),
  );
}

function parseOpenAiSse(raw: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}

/**
 * OpenAI SSE (the internal stream) -> Anthropic SSE (what an Anthropic client
 * reads). Emits the standard event sequence: message_start, content_block_*
 * events for text and tool use, message_delta with the stop reason and usage,
 * then message_stop.
 */
export function openAIStreamToAnthropic(stream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const msgId = `msg_${Date.now().toString(36)}`;
  let buffer = '';
  let started = false;
  let finishReason: string | null = null;
  let usage: Usage | undefined;
  let textBlockIndex: number | null = null;
  const toolBlockIndex = new Map<number, number>();
  const openBlocks: number[] = [];
  let nextIndex = 0;

  const event = (obj: Record<string, unknown>): Uint8Array =>
    encoder.encode(`event: ${String(obj['type'])}\ndata: ${JSON.stringify(obj)}\n\n`);

  const startMessage = (): Uint8Array =>
    event({
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!started) {
          controller.enqueue(startMessage());
          started = true;
        }
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = parseOpenAiSse(raw);
          if (!data || data === '[DONE]') continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (obj['usage']) usage = obj['usage'] as Usage;
          const choices = obj['choices'] as Array<Record<string, unknown>> | undefined;
          const choice = choices?.[0];
          if (!choice) continue;
          const delta = (choice['delta'] ?? {}) as Record<string, unknown>;

          if (typeof delta['content'] === 'string' && (delta['content'] as string).length > 0) {
            if (textBlockIndex === null) {
              textBlockIndex = nextIndex++;
              openBlocks.push(textBlockIndex);
              controller.enqueue(event({ type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } }));
            }
            controller.enqueue(event({ type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: delta['content'] } }));
          }

          const toolCalls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              const openaiIndex = typeof tc['index'] === 'number' ? (tc['index'] as number) : 0;
              let blockIndex = toolBlockIndex.get(openaiIndex);
              if (blockIndex === undefined) {
                blockIndex = nextIndex++;
                toolBlockIndex.set(openaiIndex, blockIndex);
                openBlocks.push(blockIndex);
                const fn = (tc['function'] ?? {}) as Record<string, unknown>;
                controller.enqueue(
                  event({
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'tool_use', id: tc['id'] ?? `toolu_${openaiIndex}`, name: fn['name'] ?? '', input: {} },
                  }),
                );
              }
              const fn = (tc['function'] ?? {}) as Record<string, unknown>;
              if (typeof fn['arguments'] === 'string' && fn['arguments'].length > 0) {
                controller.enqueue(event({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: fn['arguments'] } }));
              }
            }
          }

          if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason'] as string;
        }
      },
      flush(controller) {
        if (!started) {
          controller.enqueue(startMessage());
          started = true;
        }
        for (const blockIndex of openBlocks) {
          controller.enqueue(event({ type: 'content_block_stop', index: blockIndex }));
        }
        controller.enqueue(
          event({
            type: 'message_delta',
            delta: { stop_reason: finishToStopReason(finishReason), stop_sequence: null },
            usage: { output_tokens: usage?.completion_tokens ?? 0 },
          }),
        );
        controller.enqueue(event({ type: 'message_stop' }));
      },
    }),
  );
}
