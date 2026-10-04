/**
 * Verified queue -> catalog file (pure).
 *
 * Converts fully-verified verification-queue items into the existing
 * `CatalogFile` format consumed by `catalog-ingest`. It includes ONLY items whose
 * `fullyVerified === true`; every other item is skipped, never promoted.
 *
 * A `VerificationQueueItem` does not itself carry the provider identity/config
 * or the priced models a `CatalogProviderRecord` requires. Those values must be
 * supplied EXPLICITLY (per candidateId) as a "verified payload"; the converter
 * never invents a kind, apiKeyEnv, maxPrivacy, risk, price, context window or
 * capability. An item with no matching payload is skipped.
 *
 * It does not create a `ProviderConfig`, write the registry, activate providers,
 * make a network call, change routing, or mutate its inputs.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { ActivationResult } from './activation-gate.js';
import type { CatalogFile, CatalogProviderRecord } from './catalog-ingest.js';
import type { VerifiedModelSpec, VerifiedProviderSpec } from './provider-builder.js';
import type { VerificationQueueItem } from './verification-queue.js';

/** The explicit, verified payload a queue item needs to become a record. */
export interface VerifiedQueuePayload {
  /** The explicit activation verdict (must be eligible === true). */
  activation: ActivationResult;
  /** Verified provider identity/config. */
  provider: VerifiedProviderSpec;
  /** Verified models with explicit price/context/capabilities. */
  models: VerifiedModelSpec[];
  /**
   * Explicit proof that free status was verified (must be literal `true`). The
   * converter does not set this from `item.freeStatus`; it must be given.
   */
  freeStatusVerified: boolean;
  /**
   * Explicit proof that compatibility was verified (must be literal `true`).
   */
  compatibilityVerified: boolean;
}

export interface QueueToCatalogResult {
  catalog: CatalogFile;
  /** candidateIds included. */
  included: string[];
  /** candidateIds skipped, with a deterministic reason. */
  skipped: Array<{ candidateId: string; reason: string }>;
}

export interface BuildCatalogOptions {
  /** Explicit verified payloads, keyed by candidateId. */
  payloads: Map<string, VerifiedQueuePayload> | Record<string, VerifiedQueuePayload>;
}

function lookupPayload(
  payloads: Map<string, VerifiedQueuePayload> | Record<string, VerifiedQueuePayload>,
  id: string,
): VerifiedQueuePayload | undefined {
  return payloads instanceof Map ? payloads.get(id) : payloads[id];
}

/**
 * Build a CatalogFile from fully-verified queue items. Pure, total and
 * fail-closed: an item that is not fully verified, or that lacks an explicit
 * verified payload, is skipped with a reason.
 */
export function queueToCatalog(items: VerificationQueueItem[], options: BuildCatalogOptions): QueueToCatalogResult {
  const catalog: CatalogFile = { providers: [] };
  const included: string[] = [];
  const skipped: Array<{ candidateId: string; reason: string }> = [];

  for (const item of items) {
    if (item.fullyVerified !== true) {
      skipped.push({ candidateId: item.candidateId, reason: 'not fully verified' });
      continue;
    }

    const payload = lookupPayload(options.payloads, item.candidateId);
    if (!payload) {
      skipped.push({ candidateId: item.candidateId, reason: 'no explicit verified payload supplied' });
      continue;
    }
    if (payload.activation?.eligible !== true) {
      skipped.push({ candidateId: item.candidateId, reason: 'payload activation is not eligible' });
      continue;
    }
    if (payload.freeStatusVerified !== true) {
      skipped.push({ candidateId: item.candidateId, reason: 'payload free status is not explicitly verified' });
      continue;
    }
    if (payload.compatibilityVerified !== true) {
      skipped.push({ candidateId: item.candidateId, reason: 'payload compatibility is not explicitly verified' });
      continue;
    }
    if (!Array.isArray(payload.models) || payload.models.length === 0) {
      skipped.push({ candidateId: item.candidateId, reason: 'payload has no verified models' });
      continue;
    }

    // Compose the record from the queue item (identity/provenance) and the
    // explicit verified payload — nothing is invented.
    const candidate = {
      candidateId: item.candidateId,
      name: item.name,
      unverified: true as const,
      models: item.models.map((m) => ({ ...m })),
      notes: [] as string[],
      provenance: { ...item.provenance },
      ...(item.baseUrl !== undefined ? { baseUrl: item.baseUrl } : {}),
    };

    const record: CatalogProviderRecord = {
      candidate,
      activation: payload.activation,
      provider: payload.provider,
      models: payload.models.map((m) => ({ ...m })),
      freeStatusVerified: true,
      compatibilityVerified: true,
    };
    catalog.providers.push(record);
    included.push(item.candidateId);
  }

  return { catalog, included, skipped };
}
