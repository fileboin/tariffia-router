/**
 * Verification evidence schema (pure).
 *
 * One strict, reusable description of WHY a provider or model is considered
 * verified. It is data plus a pure validator: no network request, no provider
 * activation, no registry change, no routing change, and no inference of a
 * missing value (a missing required field is an error, never a default).
 *
 * Provider evidence must state: source URL, verification date, and explicit
 * compatibility / free-status / privacy / risk evidence.
 * Model evidence must state: source URL, verification date, and explicit price /
 * context-window / capabilities evidence.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

/** A single piece of evidence: where it was read and when. */
export interface EvidenceRef {
  /** Documentation/source URL. Must be http(s). */
  source: string;
  /** YYYY-MM-DD the evidence was checked. */
  verifiedAt: string;
  /** Optional one-line note. */
  note?: string;
}

/** Provider-level verification evidence. */
export interface ProviderEvidence {
  source: string;
  verifiedAt: string;
  /** Explicit evidence an OpenAI/Anthropic/etc. compatible API exists. */
  compatibility: EvidenceRef;
  /** Explicit free-tier / zero-price evidence. */
  freeStatus: EvidenceRef;
  /** Explicit privacy/retention evidence. */
  privacy: EvidenceRef;
  /** Explicit risk/ToS evidence. */
  risk: EvidenceRef;
  note?: string;
}

/** Model-level verification evidence. */
export interface ModelEvidence {
  source: string;
  verifiedAt: string;
  /** Explicit pricing evidence. */
  price: EvidenceRef;
  /** Explicit context-window evidence. */
  contextWindow: EvidenceRef;
  /** Explicit capabilities evidence. */
  capabilities: EvidenceRef;
  note?: string;
}

export interface VerificationEvidence {
  provider: ProviderEvidence;
  models: Record<string, ModelEvidence>;
}

export type EvidenceScope = 'provider' | 'model';

export interface EvidenceProblem {
  scope: EvidenceScope;
  /** Field path, e.g. 'provider.source' or 'models.m1.price'. */
  path: string;
  message: string;
}

export interface EvidenceValidation {
  valid: boolean;
  errors: EvidenceProblem[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-empty string. */
function str(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** A YYYY-MM-DD calendar date, validated by round-tripping through Date. */
function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a `VerificationEvidence` value. Pure and deterministic; returns all
 * problems rather than throwing. Missing required evidence is an error.
 */
export function validateVerificationEvidence(value: unknown): EvidenceValidation {
  const errors: EvidenceProblem[] = [];
  const add = (scope: EvidenceScope, path: string, message: string): void => {
    errors.push({ scope, path, message });
  };

  if (!isObject(value)) {
    add('provider', '', 'evidence is not an object');
    return { valid: false, errors };
  }

  // ---- provider ----
  const provider = value['provider'];
  if (!isObject(provider)) {
    add('provider', 'provider', 'missing provider evidence');
  } else {
    checkSourceDate(provider, 'provider', 'provider', add);
    for (const key of ['compatibility', 'freeStatus', 'privacy', 'risk'] as const) {
      const ref = provider[key];
      if (!isObject(ref)) {
        add('provider', `provider.${key}`, `missing ${key} evidence`);
        continue;
      }
      checkRef(ref, `provider.${key}`, (path, msg) => add('provider', path, msg));
    }
  }

  // ---- models ----
  const models = value['models'];
  if (!isObject(models)) {
    add('model', 'models', 'missing models evidence');
  } else {
    const entries = Object.entries(models);
    if (entries.length === 0) {
      add('model', 'models', 'no model evidence');
    }
    for (const [modelId, model] of entries) {
      const base = `models.${modelId}`;
      if (!isObject(model)) {
        add('model', base, 'model evidence is not an object');
        continue;
      }
      checkSourceDate(model, base, 'model', add);
      for (const key of ['price', 'contextWindow', 'capabilities'] as const) {
        const ref = model[key];
        if (!isObject(ref)) {
          add('model', `${base}.${key}`, `missing ${key} evidence`);
          continue;
        }
        checkRef(ref, `${base}.${key}`, (path, msg) => add('model', path, msg));
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function checkSourceDate(
  obj: Record<string, unknown>,
  base: string,
  scope: EvidenceScope,
  add: (scope: EvidenceScope, path: string, message: string) => void,
): void {
  if (!str(obj['source'])) {
    add(scope, `${base}.source`, 'missing or empty source');
  } else if (!isHttpUrl(obj['source'])) {
    add(scope, `${base}.source`, 'source must be a valid http(s) URL');
  }
  if (!str(obj['verifiedAt'])) {
    add(scope, `${base}.verifiedAt`, 'missing verification date');
  } else if (!isDate(obj['verifiedAt'])) {
    add(scope, `${base}.verifiedAt`, 'verifiedAt must be a valid YYYY-MM-DD date');
  }
}

function checkRef(ref: Record<string, unknown>, base: string, add: (path: string, msg: string) => void): void {
  if (!str(ref['source'])) {
    add(`${base}.source`, 'missing or empty source');
  } else if (!isHttpUrl(ref['source'])) {
    add(`${base}.source`, 'source must be a valid http(s) URL');
  }
  if (!str(ref['verifiedAt'])) {
    add(`${base}.verifiedAt`, 'missing verification date');
  } else if (!isDate(ref['verifiedAt'])) {
    add(`${base}.verifiedAt`, 'verifiedAt must be a valid YYYY-MM-DD date');
  }
}
