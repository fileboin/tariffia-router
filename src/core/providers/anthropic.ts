/**
 * Adapter for the Anthropic Messages API (`/v1/messages`).
 *
 * The core speaks one internal, OpenAI-shaped representation; this adapter
 * translates an internal request to the Anthropic wire, calls the provider
 * once, and translates the answer back. It never retries or falls back — that
 * belongs to the mesh. It also never sends an empty credential: a provider with
 * no key sends no credential header rather than `x-api-key: `.
 *
 * Auth note: Anthropic uses `x-api-key` plus `anthropic-version`. Providers
 * that speak Anthropic's shape but expect a bearer token (some compatible
 * gateways) can override both via the registry entry's `headers`.
 *
 * Tariffia addition (2026-10-03). See THIRD_PARTY_NOTICES.md.
 */

import {
  toProviderError,
  type Adapter,
  type AdapterContext,
} from './base.js';
import {
  anthropicResponseToInternal,
  anthropicSseStreamToOpenAI,
  internalToAnthropicBody,
  type AnthropicResponse,
} from './anthropic-wire.js';
import type { ChatResponse } from '../types.js';

const ANTHROPIC_VERSION = '2023-06-01';

/** `.../v1` -> `.../v1/messages`; a bare host -> `.../v1/messages`. */
function endpoint(ctx: AdapterContext): string {
  const base = ctx.candidate.provider.baseUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

function headers(ctx: AdapterContext): Record<string, string> {
  return {
    'content-type': 'application/json',
    // Only send a credential when there is one; `x-api-key: ` is rejected.
    ...(ctx.apiKey ? { 'x-api-key': ctx.apiKey } : {}),
    'anthropic-version': ANTHROPIC_VERSION,
    // Registry `headers` wins, so a compatible gateway can swap in a bearer
    // token or a different version without a code change.
    ...(ctx.candidate.provider.headers ?? {}),
  };
}

export class AnthropicAdapter implements Adapter {
  readonly kind = 'anthropic';

  async chat(ctx: AdapterContext): Promise<ChatResponse> {
    const body = internalToAnthropicBody(ctx.request, ctx.candidate.model.id);
    const res = await ctx.fetchImpl(endpoint(ctx), {
      method: 'POST',
      headers: headers(ctx),
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw await toProviderError(res);
    const data = (await res.json()) as AnthropicResponse;
    return anthropicResponseToInternal(data, ctx.candidate.model.id);
  }

  async stream(ctx: AdapterContext): Promise<ReadableStream<Uint8Array>> {
    const body = { ...internalToAnthropicBody(ctx.request, ctx.candidate.model.id), stream: true };
    const res = await ctx.fetchImpl(endpoint(ctx), {
      method: 'POST',
      headers: { ...headers(ctx), accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok || !res.body) throw await toProviderError(res);
    const id = `mesh-${ctx.candidate.provider.id}-${Date.now()}`;
    return anthropicSseStreamToOpenAI(res.body, id, ctx.candidate.model.id);
  }
}
