/**
 * Verification provenance audit (pure).
 *
 * Audits verified catalog records to check that every provider/model marked as
 * verified actually carries the evidence to justify that claim. It is a
 * read-only check: no network call, no URL fetch, no activation, no registry
 * change, no inference of missing evidence, and the catalog is never modified.
 *
 * It is fail-closed: a missing piece of required evidence is an error. Anything
 * that is genuinely optional (a risk disposition that was never recorded, a
 * quality rating, a display label) is a warning, not an error.
 *
 * It distinguishes provider-level evidence (source/provenance, verification
 * date, compatibility, free/paid status) from model-level evidence (price,
 * capability and context evidence).
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type { CatalogProviderRecord } from './catalog-ingest.js';

export type AuditScope = 'provider' | 'model';

export interface AuditFinding {
  scope: AuditScope;
  /** Provider id, or `providerId/modelId` for a model finding. */
  id: string;
  /** Machine-readable code. */
  code: string;
  message: string;
}

export interface AuditSummary {
  providers: number;
  models: number;
  errors: number;
  warnings: number;
}

export interface AuditResult {
  valid: boolean;
  errors: AuditFinding[];
  warnings: AuditFinding[];
  summary: AuditSummary;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(v: unknown): v is string {
  return typeof v === 'string' && DATE.test(v);
}

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Audit one set of verified catalog records. Pure and deterministic; the input
 * is never modified.
 */
export function auditCatalogProvenance(records: CatalogProviderRecord[]): AuditResult {
  const errors: AuditFinding[] = [];
  const warnings: AuditFinding[] = [];
  let modelCount = 0;

  const err = (scope: AuditScope, id: string, code: string, message: string): void => {
    errors.push({ scope, id, code, message });
  };
  const warn = (scope: AuditScope, id: string, code: string, message: string): void => {
    warnings.push({ scope, id, code, message });
  };

  for (const record of records) {
    const providerId = filled(record.provider?.providerId) ? record.provider.providerId : record.candidate?.candidateId ?? '(unknown)';

    // --- Provider-level: source/provenance ---
    const prov = record.candidate?.provenance;
    if (!prov || !filled(prov.source)) {
      err('provider', providerId, 'missing_source', 'no source/provenance information');
    } else if (!filled(prov.license)) {
      warn('provider', providerId, 'missing_license', 'source has no license recorded');
    }

    // --- Provider-level: verification date ---
    // Prefer an explicit provider risk verification date; fall back to the
    // provenance retrievedAt as the date the record was checked.
    const verificationDate = record.provider?.riskVerifiedAt ?? prov?.retrievedAt;
    if (!isDate(verificationDate)) {
      err('provider', providerId, 'missing_verification_date', 'no YYYY-MM-DD verification date');
    }

    // --- Provider-level: compatibility evidence ---
    if (record.compatibilityVerified !== true) {
      err('provider', providerId, 'missing_compatibility_evidence', 'compatibility is not explicitly verified');
    }

    // --- Provider-level: free/paid status evidence ---
    if (record.freeStatusVerified !== true) {
      err('provider', providerId, 'missing_free_status_evidence', 'free/paid status is not explicitly verified');
    }

    // Optional provider metadata -> warnings only.
    if (record.provider?.risk === undefined) {
      warn('provider', providerId, 'missing_risk', 'no risk disposition recorded (optional)');
    }

    // --- Model-level ---
    const models = Array.isArray(record.models) ? record.models : [];
    if (models.length === 0) {
      err('provider', providerId, 'no_models', 'record has no models');
    }
    for (const model of models) {
      modelCount += 1;
      const modelId = `${providerId}/${filled(model?.id) ? model.id : '(no-id)'}`;

      // Pricing evidence.
      const hasPrice =
        model?.price &&
        typeof model.price.inPerMTok === 'number' &&
        typeof model.price.outPerMTok === 'number' &&
        Number.isFinite(model.price.inPerMTok) &&
        Number.isFinite(model.price.outPerMTok);
      if (!hasPrice) {
        err('model', modelId, 'missing_price', 'no verified price');
      } else if (model.price.inPerMTok !== 0 || model.price.outPerMTok !== 0) {
        // A non-zero price is only trustworthy with the date it was checked.
        if (!isDate(model.priceVerifiedAt)) {
          err('model', modelId, 'missing_price_evidence', 'non-zero price without a priceVerifiedAt date');
        }
      }

      // Capability evidence.
      if (!Array.isArray(model?.capabilities) || model.capabilities.length === 0) {
        err('model', modelId, 'missing_capabilities', 'no verified capabilities');
      }

      // Context evidence.
      if (typeof model?.contextWindow !== 'number' || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
        err('model', modelId, 'missing_context', 'no verified context window');
      }

      if (model?.quality === undefined) {
        warn('model', modelId, 'missing_quality', 'no quality rating recorded (optional)');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      providers: records.length,
      models: modelCount,
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}
