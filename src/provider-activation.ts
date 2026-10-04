/**
 * Explicit provider activation (pure).
 *
 * Composes the existing activation gate, provider builder and safe registry
 * merge into a single, explicit step. Activation requires an operator to pass
 * `approved: true`; anything else fails closed. It never discovers providers,
 * makes no network call, does not activate routing, handles no secret values,
 * does not bypass FREE_ONLY verification, and never mutates its inputs.
 *
 * Order of operations, all delegated to the existing modules:
 *   1. require `approved === true`;
 *   2. require `activation.eligible === true`;
 *   3. build a ProviderConfig (`buildProviderConfig`);
 *   4. merge it with the safe rules (`mergeProviderConfig`).
 *
 * A discovered candidate is never activated automatically: without `approved:
 * true` this returns a failure and leaves the registry list unchanged.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { ProviderConfig } from './core/types.js';
import type { ActivationResult } from './activation-gate.js';
import {
  buildProviderConfig,
  type VerifiedModelSpec,
  type VerifiedProviderSpec,
} from './provider-builder.js';
import { mergeProviderConfig } from './registry-merge.js';
import type { CandidateProvider } from './seed-candidates.js';

export interface ActivateProviderInput {
  /**
   * Explicit operator approval. Must be literally `true`; any other value
   * (false, undefined) fails closed.
   */
  approved: boolean;
  candidate: CandidateProvider;
  /** The activation gate's verdict for this candidate. */
  activation: ActivationResult;
  /** Verified provider spec (identity/config). */
  provider: VerifiedProviderSpec;
  /** Verified model specs. */
  models: VerifiedModelSpec[];
}

export interface ActivateProviderResult {
  ok: boolean;
  /** The resulting provider list (unchanged on failure). */
  registry: ProviderConfig[];
  /** Merge summary when the merge ran; absent on earlier failure. */
  summary?: { added: string[]; replaced: string[]; unchanged: string[] };
  /** Deterministic reason on failure. */
  reason?: string;
}

/**
 * Activate one verified provider into a provider list. Pure and fail-closed.
 * On any failure the returned `registry` is the input list by reference (no
 * change). On success it is the new list produced by the merge.
 */
export function activateProvider(
  providers: ProviderConfig[],
  input: ActivateProviderInput,
): ActivateProviderResult {
  // 1. Explicit approval.
  if (input.approved !== true) {
    return { ok: false, registry: providers, reason: 'activation not approved' };
  }

  // 2. Gate eligibility.
  if (!input.activation || input.activation.eligible !== true) {
    return { ok: false, registry: providers, reason: 'candidate is not activation-eligible' };
  }

  // 3. Build (never invents pricing/free/privacy/risk; fails closed on gaps).
  const built = buildProviderConfig({
    candidate: input.candidate,
    activation: input.activation,
    provider: input.provider,
    models: input.models,
  });
  if (!built.ok) {
    return { ok: false, registry: providers, reason: built.reason };
  }

  // 4. Safe merge (validates, refuses downgrades).
  const merged = mergeProviderConfig(providers, built.config);
  if (!merged.ok) {
    return { ok: false, registry: providers, reason: merged.reason };
  }

  return { ok: true, registry: merged.providers, summary: merged.summary };
}
