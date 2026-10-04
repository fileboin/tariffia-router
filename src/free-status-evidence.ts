/**
 * Read-only free-status evidence (pure).
 *
 * Records whether a candidate's free status has been *explicitly* verified, and
 * from what evidence. It never infers free status — not from a model name, not
 * from popularity, not from seed membership, and not from an HTTP 200 or a
 * successful `/models` probe. Free status is only ever the result of explicit,
 * human-checked evidence such as a provider's documented zero pricing or a
 * stated legitimate free tier.
 *
 * It does not activate providers, does not touch the active registry or routing,
 * makes no network call, stores no API key, and never mutates its input.
 *
 * The result is designed to feed `ReviewableCandidate.freeStatusVerified` and a
 * reason, so review can treat it as separate from endpoint reachability.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { CandidateProvider } from './seed-candidates.js';

/** The kind of evidence behind a free-status determination. */
export type FreeEvidenceKind =
  | 'documented_zero_price'
  | 'documented_free_tier'
  | 'documented_paid_only'
  | 'none';

/** A single piece of free-status evidence, provided by a human/verifier. */
export interface FreeEvidence {
  kind: FreeEvidenceKind;
  /** Where the evidence was read (a documentation URL). Required for non-'none'. */
  source?: string;
  /** YYYY-MM-DD the evidence was checked. Required for non-'none'. */
  verifiedAt?: string;
  /** One line of provenance (e.g. "pricing page lists $0 for all models"). */
  note?: string;
}

/** The determination for one candidate. */
export type FreeStatus = 'verified_free' | 'verified_not_free' | 'unverified';

export interface FreeStatusResult {
  candidateId: string;
  /** 'verified_free' | 'verified_not_free' | 'unverified'. */
  status: FreeStatus;
  /**
   * True ONLY for 'verified_free'. This is the value that may be placed on
   * `ReviewableCandidate.freeStatusVerified`.
   */
  freeStatusVerified: boolean;
  /** The evidence kind actually used ('none' when nothing usable was supplied). */
  evidenceKind: FreeEvidenceKind;
  /** Machine-readable explanation. */
  reason:
    | 'documented_zero_price'
    | 'documented_free_tier'
    | 'documented_paid_only'
    | 'no_evidence'
    | 'insufficient_evidence';
  /** True when evidence was supplied but was not usable (missing source/date). */
  insufficient?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isUsable(evidence: FreeEvidence): { ok: boolean; why: string } {
  if (evidence.kind === 'none') return { ok: true, why: 'no evidence' };
  const hasSource = typeof evidence.source === 'string' && evidence.source.trim().length > 0;
  const hasDate = typeof evidence.verifiedAt === 'string' && DATE.test(evidence.verifiedAt);
  if (!hasSource || !hasDate) {
    return { ok: false, why: 'evidence needs both a source and a YYYY-MM-DD verifiedAt' };
  }
  return { ok: true, why: 'usable' };
}

/**
 * Determine free status from explicit evidence. Pure and total: absent or
 * unusable evidence yields 'unverified'. The candidate is read only; it is never
 * modified and no field is inferred from it.
 */
export function determineFreeStatus(
  candidate: CandidateProvider,
  evidence?: FreeEvidence,
): FreeStatusResult {
  const base = { candidateId: candidate.candidateId } as const;

  if (!evidence || evidence.kind === 'none') {
    return { ...base, status: 'unverified', freeStatusVerified: false, evidenceKind: 'none', reason: 'no_evidence' };
  }

  const usable = isUsable(evidence);
  if (!usable.ok) {
    return {
      ...base,
      status: 'unverified',
      freeStatusVerified: false,
      evidenceKind: evidence.kind,
      reason: 'insufficient_evidence',
      insufficient: true,
    };
  }

  if (evidence.kind === 'documented_zero_price') {
    return { ...base, status: 'verified_free', freeStatusVerified: true, evidenceKind: evidence.kind, reason: 'documented_zero_price' };
  }
  if (evidence.kind === 'documented_free_tier') {
    return { ...base, status: 'verified_free', freeStatusVerified: true, evidenceKind: evidence.kind, reason: 'documented_free_tier' };
  }
  // documented_paid_only
  return { ...base, status: 'verified_not_free', freeStatusVerified: false, evidenceKind: evidence.kind, reason: 'documented_paid_only' };
}

/**
 * Determine free status for a list, using a map of candidateId -> evidence.
 * Candidates without evidence are 'unverified'. Input is not mutated.
 */
export function determineFreeStatuses(
  candidates: CandidateProvider[],
  evidence?: Map<string, FreeEvidence> | Record<string, FreeEvidence>,
): FreeStatusResult[] {
  const lookup = (id: string): FreeEvidence | undefined => {
    if (!evidence) return undefined;
    return evidence instanceof Map ? evidence.get(id) : evidence[id];
  };
  return candidates.map((c) => determineFreeStatus(c, lookup(c.candidateId)));
}
