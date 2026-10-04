/**
 * Verified-provider registry merge (pure).
 *
 * Adds or replaces a SINGLE, already-verified `ProviderConfig` in a list of
 * provider configs and returns a new list plus a deterministic change summary.
 * It is the last pure step before a (separate, later) registry write.
 *
 * This module does not: touch the network, load catalogs, discover providers,
 * activate routing, handle API keys/secrets, or call itself. It never mutates its
 * inputs and never invents a missing field.
 *
 * Safety:
 *   - the incoming provider must pass the existing registry validator;
 *   - replacement happens ONLY when the provider id matches exactly, and the
 *     kind must not change (a same-id, different-kind entry is refused);
 *   - verified metadata is never downgraded: a replace never turns a
 *     paid/verified entry into a free/unverified one, nor lowers privacy, nor
 *     clears a recorded risk.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import { validateRegistryFile } from './core/config.js';
import type { PrivacyLevel, ProviderConfig } from './core/types.js';

export interface RegistryMergeResult {
  /** New provider list; the input list and its objects are untouched. */
  providers: ProviderConfig[];
  /** Deterministic summary. */
  summary: {
    /** Provider ids added. */
    added: string[];
    /** Provider ids replaced. */
    replaced: string[];
    /** Provider ids present and left unchanged. */
    unchanged: string[];
  };
}

export type RegistryMergeOk = { ok: true } & RegistryMergeResult;
export type RegistryMergeFailure = { ok: false; reason: string };
export type RegistryMergeOutcome = RegistryMergeOk | RegistryMergeFailure;

const PRIVACY_RANK: Record<PrivacyLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  highly_confidential: 3,
};

function isPaid(p: ProviderConfig): boolean {
  return p.models.some((m) => m.price.inPerMTok !== 0 || m.price.outPerMTok !== 0);
}

function lowerPrivacy(a: PrivacyLevel, b: PrivacyLevel): PrivacyLevel {
  return PRIVACY_RANK[a] <= PRIVACY_RANK[b] ? a : b;
}

/**
 * Validate that replacing `existing` with `incoming` is not a downgrade.
 *
 * Returns null when the replacement is acceptable, or a reason string when it
 * would weaken verified metadata.
 */
function replacementIssue(existing: ProviderConfig, incoming: ProviderConfig): string | null {
  if (existing.kind !== incoming.kind) {
    return `kind mismatch for '${existing.id}': '${existing.kind}' -> '${incoming.kind}'`;
  }
  // Never downgrade a verified paid provider to free.
  if (isPaid(existing) && !isPaid(incoming)) {
    return `would downgrade verified paid provider '${existing.id}' to free`;
  }
  // Never lower the privacy ceiling.
  if (!incoming.maxPrivacy) return `incoming '${incoming.id}' has no maxPrivacy`;
  if (PRIVACY_RANK[incoming.maxPrivacy] < PRIVACY_RANK[existing.maxPrivacy]) {
    return `would lower privacy of '${existing.id}': ${existing.maxPrivacy} -> ${incoming.maxPrivacy}`;
  }
  // Never clear a recorded risk disposition.
  if (existing.risk !== undefined && incoming.risk === undefined) {
    return `would clear recorded risk of '${existing.id}' (${existing.risk})`;
  }
  void lowerPrivacy;
  return null;
}

/**
 * Merge one verified provider config into a provider list. Pure and
 * fail-closed on invalid input or an unsafe replacement.
 */
export function mergeProviderConfig(
  providers: ProviderConfig[],
  incoming: ProviderConfig,
): RegistryMergeOutcome {
  if (!incoming || typeof incoming !== 'object') {
    return { ok: false, reason: 'incoming provider is not an object' };
  }

  // Validate the incoming provider with the existing validator, on its own.
  try {
    validateRegistryFile({ providers: [incoming] });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `invalid ProviderConfig: ${reason}` };
  }

  const index = providers.findIndex((p) => p.id === incoming.id);
  const added: string[] = [];
  const replaced: string[] = [];
  const unchanged: string[] = [];

  if (index === -1) {
    // New provider.
    const next = [...providers, incoming];
    added.push(incoming.id);
    for (const p of providers) unchanged.push(p.id);
    return { ok: true, providers: next, summary: { added, replaced, unchanged } };
  }

  const existing = providers[index] as ProviderConfig;
  const issue = replacementIssue(existing, incoming);
  if (issue) return { ok: false, reason: issue };

  // Replace only this exact id; everything else keeps its reference.
  const next = providers.map((p, i) => (i === index ? incoming : p));
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i] as ProviderConfig;
    if (i === index) replaced.push(p.id);
    else unchanged.push(p.id);
  }
  return { ok: true, providers: next, summary: { added, replaced, unchanged } };
}
