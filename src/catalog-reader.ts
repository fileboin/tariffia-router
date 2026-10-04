/**
 * Generic OpenAI-compatible model catalog reader.
 *
 * Reads a documented `GET {baseUrl}/models` list from an OpenAI-compatible
 * provider and normalises it into a small internal catalog type. It is
 * deliberately narrow: it produces a catalog result and nothing else. It does
 * not touch the routing registry, does not assign pricing or free status, and
 * does not merge or persist anything.
 *
 * Facts only:
 *   - ids come from the provider verbatim;
 *   - context length is taken only when the response states it;
 *   - pricing is never invented (the field stays absent unless a future step
 *     maps an explicit, verified price);
 *   - a provider that fails to answer produces an error, never an empty success.
 *
 * Runtime-agnostic: it takes an injected `fetch` and never imports a Node
 * built-in, so it can run in Node, a Worker, Deno or Bun.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { FetchLike } from './core/providers/base.js';

/** A provider endpoint to read a model list from. */
export interface CatalogProvider {
  /** Provider id, used only for error messages and the result key. */
  id: string;
  /** Base URL, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /**
   * Credential to send, if any. An empty/absent key means the provider takes no
   * credential and no Authorization header is sent (never a malformed one).
   */
  apiKey?: string;
  /** Extra headers (e.g. a provider's attribution header). */
  headers?: Record<string, string>;
}

/** One model as the catalog reports it. Facts only; no pricing, no free status. */
export interface CatalogModel {
  /** Provider-native model id, verbatim. */
  id: string;
  /** Optional display name, when the response carries one. */
  name?: string;
  /** Context window in tokens, when the response states it. */
  contextWindow?: number;
}

export interface CatalogResult {
  /** Provider id the list was read from. */
  providerId: string;
  /** The endpoint that was called. */
  url: string;
  /** Models, in the order the provider returned them. */
  models: CatalogModel[];
}

export interface ReadCatalogOptions {
  /** Fetch implementation. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Abort signal. */
  signal?: AbortSignal;
}

/** Raised when a provider cannot be read: network, non-2xx, or bad payload. */
export class CatalogError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** `https://api.x/v1` -> `https://api.x/v1/models`; `https://api.x` -> `.../v1/models`. */
export function modelsEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/models`;
}

function headers(provider: CatalogProvider): Record<string, string> {
  return {
    accept: 'application/json',
    // Only send a credential when there is one; `Bearer ` is rejected by some.
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider.headers ?? {}),
  };
}

interface OpenAiModelObject {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  max_context_length?: unknown;
}

interface OpenAiModelsResponse {
  data?: unknown;
}

function readContextWindow(m: OpenAiModelObject): number | undefined {
  // Providers vary: context_length (OpenRouter/Nous), context_window (some NIM
  // gateways), max_context_length. Take the first finite, positive number.
  for (const candidate of [m.context_length, m.context_window, m.max_context_length]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return undefined;
}

/**
 * Parse an OpenAI `/models` response body. Throws CatalogError when the shape is
 * wrong; an empty `data: []` is valid and returns an empty list.
 */
export function parseOpenAiModels(body: unknown): CatalogModel[] {
  if (typeof body !== 'object' || body === null) {
    throw new CatalogError('catalog: response is not a JSON object');
  }
  const data = (body as OpenAiModelsResponse).data;
  if (!Array.isArray(data)) {
    throw new CatalogError("catalog: response has no 'data' array");
  }
  const models: CatalogModel[] = [];
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) {
      throw new CatalogError('catalog: model entry is not an object');
    }
    const m = raw as OpenAiModelObject;
    if (typeof m.id !== 'string' || m.id.length === 0) {
      throw new CatalogError('catalog: model entry has no string id');
    }
    const model: CatalogModel = { id: m.id };
    if (typeof m.name === 'string' && m.name.length > 0) model.name = m.name;
    const ctx = readContextWindow(m);
    if (ctx !== undefined) model.contextWindow = ctx;
    models.push(model);
  }
  return models;
}

/**
 * Read the model catalog of one OpenAI-compatible provider.
 *
 * Fails clearly on network error, non-2xx, unreadable JSON or a bad schema.
 * Never returns an empty success for a provider that did not answer.
 */
export async function readOpenAiCatalog(
  provider: CatalogProvider,
  options: ReadCatalogOptions = {},
): Promise<CatalogResult> {
  const url = modelsEndpoint(provider.baseUrl);
  const doFetch = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: headers(provider),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CatalogError(`catalog: cannot reach provider '${provider.id}' at ${url} (${reason})`, err);
  }

  if (!res.ok) {
    throw new CatalogError(
      `catalog: provider '${provider.id}' at ${url} answered ${res.status} ${res.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CatalogError(`catalog: provider '${provider.id}' at ${url} returned unreadable JSON (${reason})`, err);
  }

  const models = parseOpenAiModels(body);
  return { providerId: provider.id, url, models };
}
