/**
 * Read-only candidate endpoint probe.
 *
 * Checks whether a candidate's documented `baseUrl` exposes a working
 * OpenAI-compatible `/models` endpoint. It performs exactly one network call —
 * `GET {baseUrl}/models` — and nothing else: no chat/completions, no provider
 * activation, no registry change, no routing change, no price/free inference.
 * It never stores or exposes the credential it is handed (the key is only sent
 * as a header and appears in no result), and it never mutates the candidate.
 *
 * The response schema is validated with the existing generic catalog reader's
 * `parseOpenAiModels`, so this probe does not carry its own parser.
 *
 * This is the only module so far whose purpose is to make a live request; tests
 * always inject a fake `fetch`, so no test touches the network.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import { modelsEndpoint, parseOpenAiModels, CatalogError } from './catalog-reader.js';
import type { FetchLike } from './core/providers/base.js';
import type { CandidateProvider } from './seed-candidates.js';

/** The deterministic outcome of a probe. */
export type ProbeStatus = 'reachable' | 'unreachable' | 'invalid' | 'unsupported';

/** Machine-readable reason for a status. */
export type ProbeReason =
  | 'ok'
  | 'empty_model_list'
  | 'unauthorized'
  | 'not_found'
  | 'server_error'
  | 'http_error'
  | 'invalid_json'
  | 'invalid_schema'
  | 'network_error'
  | 'no_base_url';

export interface ProbeResult {
  candidateId: string;
  status: ProbeStatus;
  reason: ProbeReason;
  /** HTTP status when a response was received; absent on network failure. */
  httpStatus?: number;
  /** Number of models the endpoint listed, when it answered and parsed. */
  modelCount?: number;
}

export interface ProbeOptions {
  /**
   * Credential to send, if any. Passed as a header only; never echoed in the
   * result. Absent/empty means no Authorization header (keyless provider).
   */
  apiKey?: string;
  /** Extra headers merged into the request. */
  headers?: Record<string, string>;
  /** Fetch implementation. Defaults to global fetch (tests inject one). */
  fetchImpl?: FetchLike;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Per-request timeout in ms. Defaults to 15000; 0 disables. */
  timeoutMs?: number;
}

function headers(apiKey?: string, extra?: Record<string, string>): Record<string, string> {
  return {
    accept: 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(extra ?? {}),
  };
}

function classifyHttpStatus(status: number): ProbeReason {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server_error';
  return 'http_error';
}

/**
 * Probe one candidate. Deterministic for a given fetch behaviour. The candidate
 * is read only; it is never modified.
 */
export async function probeCandidate(
  candidate: CandidateProvider,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const base = candidate.baseUrl;
  if (typeof base !== 'string' || base.length === 0) {
    return { candidateId: candidate.candidateId, status: 'unsupported', reason: 'no_base_url' };
  }

  const url = modelsEndpoint(base);
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs) : undefined;
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: headers(options.apiKey, options.headers),
        signal: controller.signal,
      });
    } catch {
      return { candidateId: candidate.candidateId, status: 'unreachable', reason: 'network_error' };
    }

    if (!res.ok) {
      return {
        candidateId: candidate.candidateId,
        status: res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 404
          ? 'unreachable'
          : 'invalid',
        reason: classifyHttpStatus(res.status),
        httpStatus: res.status,
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { candidateId: candidate.candidateId, status: 'invalid', reason: 'invalid_json', httpStatus: res.status };
    }

    let count: number;
    try {
      count = parseOpenAiModels(body).length;
    } catch (err) {
      // A 2xx that is not an /models-shaped payload: the endpoint exists but is
      // not a usable OpenAI-compatible model list.
      void (err instanceof CatalogError);
      return { candidateId: candidate.candidateId, status: 'invalid', reason: 'invalid_schema', httpStatus: res.status };
    }

    return {
      candidateId: candidate.candidateId,
      status: 'reachable',
      reason: count === 0 ? 'empty_model_list' : 'ok',
      httpStatus: res.status,
      modelCount: count,
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Probe several candidates, preserving order. */
export async function probeCandidates(
  candidates: CandidateProvider[],
  options: ProbeOptions = {},
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const candidate of candidates) {
    results.push(await probeCandidate(candidate, options));
  }
  return results;
}
