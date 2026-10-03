/**
 * Deterministic task analysis.
 *
 * Turns an incoming internal request into structured routing requirements from
 * signals that are already present in the request — nothing is inferred by a
 * model and no external call is made. It is deliberately pure and free of any
 * provider or credential knowledge, so it can run before scoring and be unit
 * tested on plain objects.
 *
 * It does not select a model or change scoring. It only states what the request
 * objectively needs: whether it streams, uses tools, carries images, asks for a
 * structured output shape, how large it is, and what output budget it set.
 *
 * Tariffia addition (2026-10-03). See THIRD_PARTY_NOTICES.md.
 */

import type { Capability, ChatContentPart, ChatMessage, ChatRequest } from './types.js';

/** Wire protocol the request arrived on. `openai` is the internal default. */
export type Protocol = 'openai' | 'anthropic';

export interface AnalyzeOptions {
  /** Supplied by the transport that received the request. */
  protocol?: Protocol;
}

export interface TaskRequirements {
  protocol: Protocol;
  streaming: boolean;
  /** The request declares tools, a tool choice, tool calls, or tool results. */
  needsTools: boolean;
  /** The request contains an image part (OpenAI or Anthropic normalized). */
  needsVision: boolean;
  /** The request asks for `json_object` / `json_schema` output. */
  needsStructuredOutput: boolean;
  /** Capabilities a candidate must have. Always includes `text`. */
  requiredCapabilities: Capability[];
  /** Rough input size, using the same heuristic as the mesh token estimate. */
  estimatedInputTokens: number;
  /** The requested output budget, when the request set one. */
  maxOutputTokens?: number;
  /** Input plus requested output, as a context-size hint. */
  estimatedContextTokens: number;
}

function messagesOf(req: ChatRequest | undefined | null): ChatMessage[] {
  const messages = req?.messages;
  return Array.isArray(messages) ? messages : [];
}

function hasTools(req: ChatRequest, messages: ChatMessage[]): boolean {
  if (Array.isArray(req.tools) && req.tools.length > 0) return true;
  if (req.tool_choice !== undefined && req.tool_choice !== null) return true;
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') return true;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
  }
  return false;
}

function hasVision(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content as ChatContentPart[]) {
      if (part && part.type === 'image_url') return true;
    }
  }
  return false;
}

function hasStructuredOutput(req: ChatRequest): boolean {
  const format = req.response_format as { type?: string } | undefined;
  if (!format || typeof format.type !== 'string') return false;
  return format.type === 'json_object' || format.type === 'json_schema';
}

/**
 * Same heuristic as the mesh's admission estimate: ASCII at four characters
 * per token, everything else at one. Kept locally so the analyzer depends on no
 * other core module. It over-counts non-ASCII slightly, which is the harmless
 * direction for a size hint.
 */
function estimateInputTokens(messages: ChatMessage[]): number {
  let tokens = 0;
  const count = (text: string): void => {
    let ascii = 0;
    for (const ch of text) {
      if ((ch.codePointAt(0) ?? 0) < 128) ascii += 1;
      else tokens += 1;
    }
    tokens += Math.ceil(ascii / 4);
  };
  for (const m of messages) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      count(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content as ChatContentPart[]) {
        if (part && part.type === 'text' && typeof part.text === 'string') count(part.text);
      }
    }
  }
  return tokens;
}

/**
 * Analyze a request. Pure and total: a missing or malformed request yields the
 * empty analysis rather than throwing.
 */
export function analyzeRequest(
  req: ChatRequest | undefined | null,
  opts: AnalyzeOptions = {},
): TaskRequirements {
  const safe = (req ?? {}) as ChatRequest;
  const messages = messagesOf(safe);
  const protocol: Protocol = opts.protocol ?? 'openai';

  const needsTools = hasTools(safe, messages);
  const needsVision = hasVision(messages);
  const needsStructuredOutput = hasStructuredOutput(safe);

  const requiredCapabilities: Capability[] = ['text'];
  if (needsTools) requiredCapabilities.push('tools');
  if (needsVision) requiredCapabilities.push('vision');
  if (needsStructuredOutput) requiredCapabilities.push('json');

  const estimatedInputTokens = estimateInputTokens(messages);
  const maxOutputTokens =
    typeof safe.max_tokens === 'number' && Number.isFinite(safe.max_tokens) && safe.max_tokens > 0
      ? safe.max_tokens
      : undefined;

  return {
    protocol,
    streaming: safe.stream === true,
    needsTools,
    needsVision,
    needsStructuredOutput,
    requiredCapabilities,
    estimatedInputTokens,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    estimatedContextTokens: estimatedInputTokens + (maxOutputTokens ?? 0),
  };
}
