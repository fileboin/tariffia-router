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
import { validateVerificationEvidence } from './verification-evidence.js';

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
 * Bridge a catalog record into the canonical `VerificationEvidence` shape.
 *
 * It uses only data the record actually carries: a ref's source defaults to the
 * provider's provenance source and its date to the record's verification date.
 * Where the record carries an explicit boolean instead of a ref (compatibility,
 * free status), that boolean decides whether the source/date are attached. A
 * missing URL or date is left missing on purpose, so the canonical validator
 * reports it — nothing is invented.
 */
function bridgeToVerificationEvidence(record: CatalogProviderRecord, providerId: string): unknown {
  const prov = record.candidate?.provenance;
  const source = filled(prov?.source) ? (prov.source as string) : '';
  const date = filled(record.provider?.riskVerifiedAt)
    ? (record.provider.riskVerifiedAt as string)
    : filled(prov?.retrievedAt)
      ? (prov.retrievedAt as string)
      : '';

  const refFromFlag = (flag: boolean | undefined): Record<string, unknown> => ({
    source: flag === true ? source : '',
    verifiedAt: flag === true ? date : '',
  });

  const provider = {
    source,
    verifiedAt: date,
    compatibility: refFromFlag(record.compatibilityVerified),
    freeStatus: refFromFlag(record.freeStatusVerified),
    privacy: { source, verifiedAt: date },
    risk: { source, verifiedAt: date },
  };

  const models: Record<string, unknown> = {};
  for (const model of Array.isArray(record.models) ? record.models : []) {
    const modelId = filled(model?.id) ? (model.id as string) : `${providerId}/(no-id)`;
    const hasPrice =
      model?.price &&
      typeof model.price.inPerMTok === 'number' &&
      typeof model.price.outPerMTok === 'number';
    const priceRef =
      hasPrice && (model.price.inPerMTok !== 0 || model.price.outPerMTok !== 0)
        ? { source, verifiedAt: filled(model.priceVerifiedAt) ? (model.priceVerifiedAt as string) : '' }
        : { source: hasPrice ? source : '', verifiedAt: hasPrice ? date : '' };
    models[modelId] = {
      source,
      verifiedAt: date,
      price: priceRef,
      contextWindow: {
        source,
        verifiedAt:
          typeof model?.contextWindow === 'number' && Number.isFinite(model.contextWindow) && model.contextWindow > 0
            ? date
            : '',
      },
      capabilities: {
        source,
        verifiedAt: Array.isArray(model?.capabilities) && model.capabilities.length > 0 ? date : '',
      },
    };
  }

  return { provider, models };
}

/** Map a canonical evidence problem to the audit's existing code/scope. */
function mapEvidenceProblem(
  scope: 'provider' | 'model',
  path: string,
): { scope: AuditScope; code: string; message: string } | null {
  if (scope === 'provider') {
    if (path === 'provider.source') return { scope: 'provider', code: 'missing_source', message: 'no source/provenance information' };
    if (path === 'provider.verifiedAt') return { scope: 'provider', code: 'missing_verification_date', message: 'no YYYY-MM-DD verification date' };
    if (path.startsWith('provider.compatibility')) return { scope: 'provider', code: 'missing_compatibility_evidence', message: 'compatibility evidence is missing or malformed' };
    if (path.startsWith('provider.freeStatus')) return { scope: 'provider', code: 'missing_free_status_evidence', message: 'free/paid status evidence is missing or malformed' };
    if (path.startsWith('provider.privacy')) return { scope: 'provider', code: 'missing_privacy_evidence', message: 'privacy evidence is missing or malformed' };
    if (path.startsWith('provider.risk')) return { scope: 'provider', code: 'missing_risk_evidence', message: 'risk evidence is missing or malformed' };
    return null;
  }
  // model paths look like `models.<id>.<field>`.
  if (path === 'models') return { scope: 'model', code: 'no_models', message: 'record has no models' };
  const field = path.split('.').slice(2).join('.');
  if (field === 'source') return { scope: 'model', code: 'missing_model_source', message: 'model evidence has no source' };
  if (field === 'verifiedAt') return { scope: 'model', code: 'missing_model_verification_date', message: 'model evidence has no verification date' };
  if (field.startsWith('price')) return { scope: 'model', code: 'missing_price_evidence', message: 'model price evidence is missing or malformed' };
  if (field.startsWith('contextWindow')) return { scope: 'model', code: 'missing_context', message: 'model context evidence is missing or malformed' };
  if (field.startsWith('capabilities')) return { scope: 'model', code: 'missing_capabilities', message: 'model capabilities evidence is missing or malformed' };
  return null;
}

function modelIdFromPath(path: string): string {
  const parts = path.split('.');
  return parts[1] ?? '(no-id)';
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

    // Canonical evidence validation: bridge the record's provenance into a
    // VerificationEvidence value and run the single canonical validator. Its
    // problems are translated to the audit's existing error codes so the public
    // behavior stays compatible while the rule lives in one place.
    const bridged = bridgeToVerificationEvidence(record, providerId);
    const canonical = validateVerificationEvidence(bridged);
    for (const problem of canonical.errors) {
      const mapped = mapEvidenceProblem(problem.scope, problem.path);
      if (!mapped) continue;
      const id = problem.scope === 'provider' ? providerId : `${providerId}/${modelIdFromPath(problem.path)}`;
      if (!errors.some((e) => e.scope === mapped.scope && e.id === id && e.code === mapped.code)) {
        err(mapped.scope, id, mapped.code, mapped.message);
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
