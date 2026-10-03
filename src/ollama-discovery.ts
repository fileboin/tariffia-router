/**
 * Read-only Ollama model discovery (Node).
 *
 * Asks a local Ollama instance which models are actually installed and reports
 * how that lines up with the registry. It never writes to the registry, never
 * marks a model verified or free, and never invents capabilities, context,
 * quality or pricing — routing metadata stays owned by the registry.
 *
 * The only thing discovery answers is: "for this registry model, is it installed
 * on this machine?". Ollama serves only pulled models, so a listed registry model
 * may be absent; this tells you which ones are present.
 *
 * This is Node-specific (it uses fetch + a base URL) and lives outside
 * `src/core/`, which must stay runtime-agnostic.
 *
 * Tariffia addition (2026-10-03). See THIRD_PARTY_NOTICES.md.
 */

import type { Registry } from './core/registry.js';

/** Default Ollama API root (no `/v1`; that suffix is the OpenAI-compat shim). */
export const DEFAULT_OLLAMA_API_URL = 'http://127.0.0.1:11434';

/** One registry model's installation status. */
export interface ModelStatus {
  /** `provider/model` registry key. */
  key: string;
  /** Provider-native model id as recorded in the registry. */
  id: string;
  /** True when Ollama reports this model as installed. */
  installed: boolean;
}

export interface DiscoveryResult {
  /** Ollama's own version string, when it reported one. */
  version?: string;
  /** The model names Ollama returned, verbatim. */
  installed: string[];
  /** Every registered model of the discovered provider, with its status. */
  models: ModelStatus[];
}

export interface DiscoverOptions {
  /** Ollama API root. Defaults to http://127.0.0.1:11434. */
  baseUrl?: string;
  /** Provider id to check in the registry. Defaults to 'ollama'. */
  providerId?: string;
  /** Fetch implementation, for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort signal. */
  signal?: AbortSignal;
}

/** Raised when Ollama cannot be reached or answers with an error. */
export class OllamaUnreachableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'OllamaUnreachableError';
  }
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Extract model names from an Ollama `/api/tags` response.
 *
 * Ollama returns both `name` and `model` (aliases); `name` is the one to use,
 * with `model` as a fallback for older/newer shapes.
 */
export function parseInstalledModels(body: unknown): string[] {
  const data = body as OllamaTagsResponse;
  const list = Array.isArray(data?.models) ? data.models : [];
  const out: string[] = [];
  for (const m of list) {
    const name = m?.name ?? m?.model;
    if (typeof name === 'string' && name.length > 0) out.push(name);
  }
  return out;
}

/**
 * Compare Ollama's installed names against the registry provider's models.
 *
 * Matching is exact on the registry model id. Ollama reports names like
 * `qwen2.5-coder:7b`; a registry id without a tag is matched only if Ollama
 * lists it verbatim or with the implied `:latest` tag, so a `:latest` install
 * still counts.
 */
export function compareToRegistry(installed: string[], registry: Registry, providerId: string): ModelStatus[] {
  const set = new Set(installed);
  const provider = registry.providers.find((p) => p.id === providerId);
  if (!provider) return [];
  return provider.models.map((m) => ({
    key: `${providerId}/${m.id}`,
    id: m.id,
    installed: set.has(m.id) || set.has(`${m.id}:latest`),
  }));
}

/**
 * Discover installed models from a local Ollama instance.
 *
 * Fails clearly when Ollama is unreachable: no silent fallback to another
 * provider, no empty success. Returns only what Ollama reported plus the
 * registry comparison; it does not modify the registry.
 */
export async function discoverOllama(registry: Registry, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_API_URL).replace(/\/$/, '');
  const providerId = options.providerId ?? 'ollama';
  const doFetch = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new OllamaUnreachableError(
      `tariffia: cannot reach Ollama at ${baseUrl} (${reason}). Is it running?`,
      err,
    );
  }

  if (!res.ok) {
    throw new OllamaUnreachableError(`tariffia: Ollama at ${baseUrl} answered ${res.status} ${res.statusText}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new OllamaUnreachableError(`tariffia: Ollama at ${baseUrl} returned unreadable JSON (${reason})`, err);
  }

  const version = (body as { version?: string })?.version;
  const installed = parseInstalledModels(body);
  const models = compareToRegistry(installed, registry, providerId);

  return {
    ...(typeof version === 'string' ? { version } : {}),
    installed,
    models,
  };
}
