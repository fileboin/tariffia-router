/**
 * Verified provider catalog ingestion (pure).
 *
 * Reads a LOCAL, explicitly verified catalog value and, for each provider
 * record, runs the existing pipeline: validate the built `ProviderConfig`
 * (via the builder + merge) and apply the safe registry merge. It performs no
 * network call, no discovery, no routing change, and no automatic activation:
 * merging a record into the returned in-memory registry list is not the same as
 * activating it for routing, and nothing here writes to disk.
 *
 * Every provider and model must carry EXPLICIT verification metadata. Nothing is
 * inferred: free status, pricing, privacy and risk are taken only from the
 * record, and a record missing them is rejected.
 *
 * Catalog data is untrusted until the builder + merge validate it, and an unsafe
 * replacement (identity/kind mismatch, paid->free, privacy lowering, risk
 * clearing) is rejected by the merge.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { ProviderConfig } from './core/types.js';
import type { CandidateProvider } from './seed-candidates.js';
import type { ActivationResult } from './activation-gate.js';
import { buildProviderConfig, type VerifiedModelSpec, type VerifiedProviderSpec } from './provider-builder.js';
import { mergeProviderConfig } from './registry-merge.js';

/** One verified provider record from the catalog. */
export interface CatalogProviderRecord {
  /** The candidate identity the record refers to (for reference/provenance). */
  candidate: CandidateProvider;
  /** The explicit verification verdict for this candidate. */
  activation: ActivationResult;
  /** Verified provider identity/config. */
  provider: VerifiedProviderSpec;
  /** Verified models. */
  models: VerifiedModelSpec[];
  /**
   * Explicit proof that free status was verified, required to match a
   * `verified_free` activation. Must be the literal `true`.
   */
  freeStatusVerified: boolean;
  /**
   * Explicit proof that API compatibility was independently verified. Must be
   * the literal `true`. (The activation gate separately requires eligibility.)
   */
  compatibilityVerified: boolean;
}

export interface CatalogFile {
  providers: CatalogProviderRecord[];
}

export interface IngestRejection {
  /** Best-known id for the record (providerId or candidateId). */
  id: string;
  reason: string;
}

export interface IngestSummary {
  added: string[];
  replaced: string[];
  rejected: IngestRejection[];
}

export interface IngestResult {
  /** Accepted, verified providers (in catalog order). */
  accepted: ProviderConfig[];
  /** Rejected records with deterministic reasons (in catalog order). */
  rejected: IngestRejection[];
  /** Registry after applying accepted providers (merge rules), as a value. */
  registry: ProviderConfig[];
  summary: IngestSummary;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function recordId(r: unknown, index: number): string {
  if (isObject(r)) {
    const p = r['provider'];
    if (isObject(p) && typeof p['providerId'] === 'string') return p['providerId'];
    const c = r['candidate'];
    if (isObject(c) && typeof c['candidateId'] === 'string') return c['candidateId'];
  }
  return `record[${index}]`;
}

/**
 * Ingest a verified catalog into a provider list. Pure and fail-closed on any
 * malformed or incomplete record; the input catalog and registry are never
 * mutated.
 */
export function ingestVerifiedCatalog(registry: ProviderConfig[], catalog: unknown): IngestResult {
  const accepted: ProviderConfig[] = [];
  const rejected: IngestRejection[] = [];

  if (!isObject(catalog) || !Array.isArray(catalog['providers'])) {
    return {
      accepted,
      rejected: [{ id: 'catalog', reason: 'catalog is not an object with a providers array' }],
      registry,
      summary: { added: [], replaced: [], rejected: [{ id: 'catalog', reason: 'catalog is not an object with a providers array' }] },
    };
  }

  // Merge incrementally so later records see earlier accepted ones and unsafe
  // replacements are caught against the growing registry.
  let working = registry;

  const records = catalog['providers'] as unknown[];
  records.forEach((raw, index) => {
    const id = recordId(raw, index);
    if (!isObject(raw)) {
      rejected.push({ id, reason: 'record is not an object' });
      return;
    }
    const rec = raw as Partial<CatalogProviderRecord>;

    // Explicit verification metadata is mandatory.
    if (rec.freeStatusVerified !== true) {
      rejected.push({ id, reason: 'freeStatusVerified is not explicitly true' });
      return;
    }
    if (rec.compatibilityVerified !== true) {
      rejected.push({ id, reason: 'compatibilityVerified is not explicitly true' });
      return;
    }
    if (!rec.candidate || !isObject(rec.candidate)) {
      rejected.push({ id, reason: 'missing candidate' });
      return;
    }
    if (!rec.activation || rec.activation.eligible !== true) {
      rejected.push({ id, reason: 'candidate is not activation-eligible' });
      return;
    }
    if (!rec.provider || !isObject(rec.provider)) {
      rejected.push({ id, reason: 'missing provider identity' });
      return;
    }
    if (!Array.isArray(rec.models) || rec.models.length === 0) {
      rejected.push({ id, reason: 'no models' });
      return;
    }

    const built = buildProviderConfig({
      candidate: rec.candidate,
      activation: rec.activation,
      provider: rec.provider,
      models: rec.models,
    });
    if (!built.ok) {
      rejected.push({ id, reason: built.reason });
      return;
    }

    const merged = mergeProviderConfig(working, built.config);
    if (!merged.ok) {
      rejected.push({ id, reason: merged.reason });
      return;
    }
    working = merged.providers;
    accepted.push(built.config);
  });

  // Build the summary by replaying accepted merges from the original registry.
  let summaryRegistry = registry;
  const added: string[] = [];
  const replaced: string[] = [];
  for (const config of accepted) {
    const m = mergeProviderConfig(summaryRegistry, config);
    if (!m.ok) continue; // cannot happen: already merged successfully
    summaryRegistry = m.providers;
    added.push(...m.summary.added);
    replaced.push(...m.summary.replaced);
  }

  return {
    accepted,
    rejected,
    registry: working,
    summary: { added, replaced, rejected },
  };
}
