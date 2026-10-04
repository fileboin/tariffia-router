/**
 * Deterministic candidate review filter (pure).
 *
 * Sorts `CandidateProvider[]` into three lists: `eligible`, `needsReview` and
 * `rejected`. It reads only what a candidate already carries and never invents
 * price, free status, privacy, risk or credentials. It performs no network or
 * filesystem access, does not touch the registry, does not activate anything,
 * and never mutates its input.
 *
 * A candidate cannot be `eligible` on this data alone: "API compatibility is
 * unknown" and "free status is not explicitly verified" are always true for seed
 * candidates, so every seed candidate lands in `needsReview` until there is a
 * field to say otherwise. `eligible` exists for later, richer records (a
 * reviewed/verified candidate) and is returned when a candidate explicitly
 * declares compatibility and verified free status.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { CandidateProvider } from './seed-candidates.js';
import type { ProbeResult } from './candidate-probe.js';

/** Reasons a candidate was placed in a list. Machine-readable, deterministic. */
export type ReviewReason =
  | 'no_provider_name'
  | 'no_models'
  | 'model_without_id'
  | 'malformed'
  | 'missing_base_url'
  | 'unknown_compatibility'
  | 'free_status_unverified'
  | 'missing_description'
  | 'missing_source_url'
  | 'probe_unsupported'
  | 'probe_unreachable'
  | 'probe_invalid'
  | 'ok';

export interface ReviewedCandidate {
  candidate: CandidateProvider;
  reasons: ReviewReason[];
}

export interface ReviewResult {
  eligible: ReviewedCandidate[];
  needsReview: ReviewedCandidate[];
  rejected: ReviewedCandidate[];
}

/**
 * Optional, richer facts an already-reviewed candidate may carry. Seed
 * candidates never have these; a later review step may attach them. Nothing here
 * is inferred — absent means unknown.
 */
export interface ReviewableCandidate extends CandidateProvider {
  /** True only when a human has verified the API is OpenAI-compatible. */
  compatibilityVerified?: boolean;
  /** True only when a human has verified a legitimate free tier. */
  freeStatusVerified?: boolean;
}

function isRejected(c: object): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  const anyC = c as Partial<ReviewableCandidate>;

  if (typeof anyC.name !== 'string' || anyC.name.trim().length === 0) {
    reasons.push('no_provider_name');
  }
  if (!Array.isArray(anyC.models) || anyC.models.length === 0) {
    reasons.push('no_models');
  } else if (anyC.models.some((m) => !m || typeof m.id !== 'string' || m.id.length === 0)) {
    reasons.push('model_without_id');
  }
  // A structurally broken provider (no candidateId or no provenance) is malformed.
  if (typeof anyC.candidateId !== 'string' || !anyC.provenance || typeof anyC.provenance !== 'object') {
    reasons.push('malformed');
  }
  return reasons;
}

function reviewReasons(c: ReviewableCandidate, probe?: ProbeResult): ReviewReason[] {
  const reasons: ReviewReason[] = [];

  // Endpoint / reachability. A successful probe is positive evidence that the
  // documented baseUrl answers a usable OpenAI-compatible /models endpoint, so it
  // satisfies the endpoint and API-compatibility parts of review. It says
  // nothing about free status, which is handled separately below.
  const probeReachable = probe?.status === 'reachable';
  if (typeof c.baseUrl !== 'string' || c.baseUrl.length === 0) {
    reasons.push('missing_base_url');
  }
  if (probe) {
    if (probe.status === 'unsupported') reasons.push('probe_unsupported');
    else if (probe.status === 'unreachable') reasons.push('probe_unreachable');
    else if (probe.status === 'invalid') reasons.push('probe_invalid');
  }
  // API compatibility: a reachable probe proves it; otherwise a human must.
  if (!probeReachable && c.compatibilityVerified !== true) reasons.push('unknown_compatibility');

  // Free status is NEVER inferred from a probe. Probe success only means the
  // endpoint answered; it is not evidence of a free tier.
  if (c.freeStatusVerified !== true) reasons.push('free_status_unverified');

  if (typeof c.description !== 'string' || c.description.trim().length === 0) reasons.push('missing_description');
  if (typeof c.url !== 'string' || c.url.length === 0) reasons.push('missing_source_url');
  return reasons;
}

/**
 * Classify one candidate. Deterministic: the same input (and optional probe
 * evidence) always yields the same list and the same reasons. The candidate is
 * returned by reference, unchanged.
 *
 * `probe` is optional. When omitted, behavior is exactly as before; when given,
 * a `reachable` result satisfies the endpoint/compatibility part of review but
 * never the free-status part.
 */
export function reviewCandidate(
  candidate: CandidateProvider,
  probe?: ProbeResult,
): { bucket: keyof ReviewResult; reviewed: ReviewedCandidate } {
  const rejected = isRejected(candidate);
  if (rejected.length > 0) {
    // A probe cannot rescue a structurally broken candidate.
    return { bucket: 'rejected', reviewed: { candidate, reasons: rejected } };
  }

  const needs = reviewReasons(candidate as ReviewableCandidate, probe);
  if (needs.length > 0) {
    return { bucket: 'needsReview', reviewed: { candidate, reasons: needs } };
  }

  return { bucket: 'eligible', reviewed: { candidate, reasons: ['ok'] } };
}

/**
 * Classify a list of candidates, preserving input order within each list.
 * `probes` maps a candidateId to probe evidence; candidates without evidence are
 * reviewed exactly as before.
 */
export function reviewCandidates(
  candidates: CandidateProvider[],
  probes?: Map<string, ProbeResult> | Record<string, ProbeResult>,
): ReviewResult {
  const result: ReviewResult = { eligible: [], needsReview: [], rejected: [] };
  const lookup = (id: string): ProbeResult | undefined => {
    if (!probes) return undefined;
    return probes instanceof Map ? probes.get(id) : probes[id];
  };
  for (const candidate of candidates) {
    const { bucket, reviewed } = reviewCandidate(candidate, lookup(candidate.candidateId));
    result[bucket].push(reviewed);
  }
  return result;
}
