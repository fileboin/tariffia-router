/**
 * Deterministic candidate activation gate (pure).
 *
 * Decides whether a candidate has enough *verified* evidence to be eligible for
 * activation into the active registry. This is an eligibility decision only: it
 * does not activate anything, write to the registry, change routing, make a
 * network call, or infer any missing evidence.
 *
 * A candidate is eligible only when ALL of the following hold:
 *   1. structural review has no blocking rejection (name, models, model ids,
 *      well-formed);
 *   2. the endpoint probe status is 'reachable';
 *   3. the free status is 'verified_free' (explicit evidence, never inferred);
 *   4. API compatibility is verified;
 *   5. the required provider identity/config fields are present.
 *
 * It fails closed: any missing, unavailable or conflicting evidence makes the
 * candidate not eligible. A paid or unverified candidate is never eligible.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { CandidateProvider } from './seed-candidates.js';
import type { ProbeResult } from './candidate-probe.js';
import type { FreeStatusResult } from './free-status-evidence.js';

/** Why a candidate is or is not eligible. Machine-readable, deterministic. */
export type ActivationReason =
  | 'eligible'
  | 'structural_rejection'
  | 'probe_not_reachable'
  | 'free_status_not_verified'
  | 'free_status_conflict'
  | 'compatibility_unverified'
  | 'missing_identity';

export interface ActivationResult {
  candidateId: string;
  eligible: boolean;
  /** The reasons, ordered; `['eligible']` alone means eligible. */
  reasons: ActivationReason[];
}

/** Identity/config a candidate must carry before it could be activated. */
export interface ActivationIdentity {
  /** The provider id that would be written to the registry. */
  providerId?: string;
  /** The provider kind (e.g. 'openai-compat', 'anthropic', 'gemini'). */
  kind?: string;
  /** The credential environment variable name (never a value). */
  apiKeyEnv?: string;
}

/**
 * Inputs to the gate. `review` is the structural verdict for this candidate, and
 * `freeStatus` the explicit free-status determination. `probe` is the endpoint
 * evidence. `identity` is the provider identity/config fields that would be
 * required to write a registry entry.
 */
export interface ActivationInput {
  candidate: CandidateProvider;
  /** True when the candidate declares API compatibility verified. */
  compatibilityVerified?: boolean;
  probe?: ProbeResult;
  freeStatus?: Pick<FreeStatusResult, 'status' | 'freeStatusVerified'>;
  identity?: ActivationIdentity;
}

function hasIdentity(identity: ActivationIdentity | undefined): boolean {
  if (!identity) return false;
  const filled = (v: string | undefined): boolean => typeof v === 'string' && v.trim().length > 0;
  return filled(identity.providerId) && filled(identity.kind) && filled(identity.apiKeyEnv);
}

function isStructurallyRejected(candidate: CandidateProvider, compatibilityVerified: boolean | undefined, probe: ProbeResult | undefined): boolean {
  const c = candidate as Partial<CandidateProvider>;
  if (typeof c.name !== 'string' || c.name.trim().length === 0) return true;
  if (!Array.isArray(c.models) || c.models.length === 0) return true;
  if (c.models.some((m) => !m || typeof m.id !== 'string' || m.id.length === 0)) return true;
  if (typeof c.candidateId !== 'string' || !c.provenance || typeof c.provenance !== 'object') return true;
  void compatibilityVerified;
  void probe;
  return false;
}

/**
 * Decide activation eligibility. Pure and total: any missing evidence fails
 * closed. Inputs are never mutated and no field is inferred.
 */
export function evaluateActivation(input: ActivationInput): ActivationResult {
  const { candidate, probe, freeStatus, identity } = input;
  const compatibilityVerified = input.compatibilityVerified === true;
  const reasons: ActivationReason[] = [];

  // 1. Structural.
  const structural = isStructurallyRejected(candidate, input.compatibilityVerified, probe);
  if (structural) reasons.push('structural_rejection');

  // 2. Endpoint reachability.
  if (probe?.status !== 'reachable') reasons.push('probe_not_reachable');

  // 3. Free status: must be explicitly verified; paid or unverified fails.
  if (freeStatus?.status !== 'verified_free' || freeStatus.freeStatusVerified !== true) {
    // Distinguish a contradicting "verified_not_free" from mere absence.
    if (freeStatus?.status === 'verified_not_free') reasons.push('free_status_conflict');
    else reasons.push('free_status_not_verified');
  }

  // 4. Compatibility.
  if (!compatibilityVerified) reasons.push('compatibility_unverified');

  // 5. Identity/config.
  if (!hasIdentity(identity)) reasons.push('missing_identity');

  if (reasons.length === 0) return { candidateId: candidate.candidateId, eligible: true, reasons: ['eligible'] };
  return { candidateId: candidate.candidateId, eligible: false, reasons };
}
