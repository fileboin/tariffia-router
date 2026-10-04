/**
 * Catalog -> registry merge (pure).
 *
 * Takes the existing provider configs and a normalised `CatalogResult` and
 * returns NEW configs plus a deterministic report. It never mutates its inputs,
 * never touches HTTP, the filesystem, Node APIs or a specific provider, and it
 * never invents pricing, free status, privacy, risk or quota.
 *
 * What the catalog may change: only fields the normalised catalog actually
 * provides (today: `contextWindow`, and a display `label` from `name`). Rich
 * catalog fields are intentionally NOT modelled yet, so most metadata a
 * registry already holds is preserved verbatim.
 *
 * Safety rules encoded here:
 *   - a discovered model does NOT become FREE_ONLY eligible (its price is left
 *     exactly as the registry had it, or it is not added at all);
 *   - a NEW model with no pricing information is NOT added (leave it out for
 *     now) — so no model is ever created free by omission;
 *   - a model that disappears from the catalog is disabled, never deleted, and
 *     keeps all its metadata;
 *   - provider identity/config (id, kind, baseUrl, apiKeyEnv, risk, privacy,
 *     headers, quota, ...) is never changed.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { CatalogResult } from './catalog-reader.js';
import type { ModelEntry, ProviderConfig } from './core/types.js';

/** The merge outcome for one model key (`providerId/modelId`). */
export interface CatalogChange {
  key: string;
  reason: string;
}

export interface SyncReport {
  /** Provider the catalog belonged to. */
  providerId: string;
  /** Models added to the registry (empty in this step: unknown pricing is not added). */
  added: CatalogChange[];
  /** Existing models whose metadata the catalog updated. */
  updated: CatalogChange[];
  /** Existing models absent from the catalog, now `disabled: true`. */
  disabled: CatalogChange[];
  /** Existing models present in the catalog with nothing to change. */
  unchanged: CatalogChange[];
  /** Catalog models deliberately not added (no pricing information). */
  skipped: CatalogChange[];
}

export interface SyncResult {
  /** New provider configs; the input array and its objects are untouched. */
  providers: ProviderConfig[];
  /** Deterministic report for a later CLI / logging step. */
  report: SyncReport;
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/**
 * Merge one provider's catalog into that provider's config.
 *
 * Returns the (possibly identical) config and the per-model change lists. The
 * provider is matched by `id`; a catalog for an unknown provider is a no-op.
 */
export function mergeCatalogIntoProvider(
  provider: ProviderConfig,
  catalog: CatalogResult,
): { provider: ProviderConfig; report: SyncReport } {
  const report: SyncReport = {
    providerId: provider.id,
    added: [],
    updated: [],
    disabled: [],
    unchanged: [],
    skipped: [],
  };

  if (catalog.providerId !== provider.id) {
    // Not this provider's catalog: leave untouched, report nothing changed.
    return { provider, report };
  }

  const byId = new Map(catalog.models.map((m) => [m.id, m]));
  const nextModels: ModelEntry[] = [];

  for (const existing of provider.models) {
    const found = byId.get(existing.id);
    const key = modelKey(provider.id, existing.id);

    if (!found) {
      // Disappeared from the catalog: disable, do not delete, keep metadata.
      if (existing.disabled) {
        nextModels.push(existing);
        report.unchanged.push({ key, reason: 'absent from catalog, already disabled' });
      } else {
        nextModels.push({ ...existing, disabled: true });
        report.disabled.push({ key, reason: 'no longer in the catalog' });
      }
      continue;
    }

    byId.delete(existing.id);

    // Only the fields the normalized catalog actually carries are eligible.
    const patch: Partial<ModelEntry> = {};
    if (found.contextWindow !== undefined && found.contextWindow !== existing.contextWindow) {
      patch.contextWindow = found.contextWindow;
    }
    if (found.name !== undefined && found.name !== existing.label) {
      patch.label = found.name;
    }

    if (Object.keys(patch).length === 0) {
      nextModels.push(existing);
      report.unchanged.push({ key, reason: 'catalog matches registry' });
    } else {
      nextModels.push({ ...existing, ...patch });
      report.updated.push({ key, reason: `catalog updated ${Object.keys(patch).join(', ')}` });
    }
  }

  // Remaining catalog models are new. Without pricing information they are NOT
  // added, so a discovered model can never be created free by omission.
  for (const fresh of byId.values()) {
    const key = modelKey(provider.id, fresh.id);
    report.skipped.push({ key, reason: 'new model has no pricing information; not added' });
  }

  const provider2: ProviderConfig =
    nextModels.length === provider.models.length &&
    nextModels.every((m, i) => m === provider.models[i])
      ? provider
      : { ...provider, models: nextModels };

  return { provider: provider2, report };
}

/**
 * Merge a catalog into a list of provider configs.
 *
 * Returns a new array of configs (only the matching provider may change) and a
 * single report. The input array and every input object are left untouched.
 */
export function mergeCatalogIntoRegistry(
  providers: ProviderConfig[],
  catalog: CatalogResult,
): SyncResult {
  let report: SyncReport = {
    providerId: catalog.providerId,
    added: [],
    updated: [],
    disabled: [],
    unchanged: [],
    skipped: [],
  };

  const next = providers.map((p) => {
    const result = mergeCatalogIntoProvider(p, catalog);
    // Capture the report from the matching provider by id, not by reference:
    // an unchanged provider keeps the same reference, and its report still
    // describes every model as unchanged.
    if (p.id === catalog.providerId) report = result.report;
    return result.provider;
  });

  return { providers: next, report };
}
