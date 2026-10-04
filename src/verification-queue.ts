/**
 * Seed -> verification queue (pure).
 *
 * Converts parsed seed candidates into a deterministic work queue for human
 * verification. It composes the existing modules (seed review, probe evidence,
 * free-status evidence) but produces NO `ProviderConfig`, writes NOTHING to the
 * registry, activates nothing, and makes no network call.
 *
 * Core invariant: membership in the seed list is NOT evidence. Being in the seed
 * never marks a provider free, compatible, or verified. A queue entry is only
 * "verified" when explicit evidence says so; otherwise it is marked as requiring
 * verification, with the reasons.
 *
 * Unknown/unverified fields are preserved as-is (provenance, license, published
 * context strings, notes). Nothing is invented: no provider kind, pricing,
 * privacy, risk, api key env, or context token count.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { CandidateModel, CandidateProvider, CandidateProvenance } from './seed-candidates.js';
import { reviewCandidate, type ReviewReason } from './candidate-review.js';
import type { ProbeResult } from './candidate-probe.js';
import { determineFreeStatus, type FreeStatusResult } from './free-status-evidence.js';

/** One queue entry: a candidate plus its current verification state. */
export interface VerificationQueueItem {
  candidateId: string;
  name: string;
  baseUrl?: string;
  models: CandidateModel[];
  provenance: CandidateProvenance;
  /** Always true: a queue entry exists to be verified. */
  requiresVerification: true;
  /** The review bucket: 'eligible' | 'needsReview' | 'rejected'. */
  bucket: 'eligible' | 'needsReview' | 'rejected';
  /** Whether endpoint reachability is proven (only from a reachable probe). */
  endpointVerified: boolean;
  /** Whether API compatibility is proven (only from explicit evidence). */
  compatibilityVerified: boolean;
  /** Free-status determination (never inferred from the seed). */
  freeStatus: FreeStatusResult['status'];
  /** All reasons the entry is not fully verified; empty only when verified. */
  reasons: ReviewReason[];
  /** True only when endpoint, compatibility and free status are all verified. */
  fullyVerified: boolean;
}

export interface VerificationQueue {
  /** The seed file's own timestamp, preserved. */
  lastUpdated: string;
  /** Source license, preserved. */
  license: string;
  items: VerificationQueueItem[];
  summary: { total: number; eligible: number; needsReview: number; rejected: number; fullyVerified: number };
}

export interface BuildQueueOptions {
  /** Explicit reliability evidence, by candidateId. Absent means unverified. */
  probes?: Map<string, ProbeResult> | Record<string, ProbeResult>;
  /** Explicit free-status evidence, by candidateId. Absent means unverified. */
  freeEvidence?: Map<string, import('./free-status-evidence.js').FreeEvidence> | Record<string, import('./free-status-evidence.js').FreeEvidence>;
  /** Explicitly verified compatibility, by candidateId. Absent means unverified. */
  compatibilityVerified?: Map<string, boolean> | Record<string, boolean>;
}

function lookup<T>(map: Map<string, T> | Record<string, T> | undefined, id: string): T | undefined {
  if (!map) return undefined;
  return map instanceof Map ? map.get(id) : map[id];
}

/**
 * Build the verification queue from seed candidates. Pure and deterministic;
 * the input candidates are not mutated.
 */
export function buildVerificationQueue(
  candidates: CandidateProvider[],
  seedLastUpdated: string,
  options: BuildQueueOptions = {},
): VerificationQueue {
  const items: VerificationQueueItem[] = candidates.map((candidate) => {
    const probe = lookup(options.probes, candidate.candidateId);
    const compatibilityVerified = lookup(options.compatibilityVerified, candidate.candidateId) === true;
    const free = determineFreeStatus(candidate, lookup(options.freeEvidence, candidate.candidateId));

    // Review with the probe evidence that is actually present.
    const { bucket, reviewed } = reviewCandidate(candidate, probe);

    const endpointVerified = probe?.status === 'reachable';
    const fullyVerified =
      bucket !== 'rejected' && endpointVerified && compatibilityVerified && free.status === 'verified_free';

    const item: VerificationQueueItem = {
      candidateId: candidate.candidateId,
      name: candidate.name,
      models: candidate.models.map((m) => ({ ...m })),
      provenance: { ...candidate.provenance },
      requiresVerification: true,
      bucket,
      endpointVerified,
      compatibilityVerified,
      freeStatus: free.status,
      reasons: reviewed.reasons,
      fullyVerified,
    };
    if (candidate.baseUrl !== undefined) item.baseUrl = candidate.baseUrl;
    return item;
  });

  const summary = {
    total: items.length,
    eligible: items.filter((i) => i.bucket === 'eligible').length,
    needsReview: items.filter((i) => i.bucket === 'needsReview').length,
    rejected: items.filter((i) => i.bucket === 'rejected').length,
    fullyVerified: items.filter((i) => i.fullyVerified).length,
  };

  return {
    lastUpdated: seedLastUpdated,
    license: candidates[0]?.provenance.license ?? 'CC0-1.0',
    items,
    summary,
  };
}
