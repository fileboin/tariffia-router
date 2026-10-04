/**
 * Candidate -> ProviderConfig builder (pure).
 *
 * Converts an activation-eligible candidate into a Tariffia `ProviderConfig`.
 * It is the last pure step before (a later, separate) registry write: it performs
 * no write, no routing change, no network call, and never mutates its input.
 *
 * It refuses to invent anything. A `ProviderConfig` requires `maxPrivacy`, and
 * each `ModelEntry` requires `capabilities`, `contextWindow` and `price`; a
 * candidate carries none of these as verified facts (the seed's `context` is a
 * display string, not a token count). So those values must be supplied as
 * EXPLICIT, VERIFIED inputs alongside the candidate. Missing any of them fails
 * closed — the builder never fills in a default price, a "free" flag, a privacy
 * tier or a quota on its own.
 *
 * Safety: only an `apiKeyEnv` NAME is accepted; an API-key value is rejected if
 * it looks like a value, and no key material is ever stored or echoed.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import type {
  Capability,
  ModelEntry,
  PrivacyLevel,
  ProviderConfig,
  ProviderKind,
} from './core/types.js';
import type { CandidateProvider } from './seed-candidates.js';
import type { ActivationResult } from './activation-gate.js';

/** The provider kinds Tariffia can write. Kept in step with config.ts. */
export const SUPPORTED_PROVIDER_KINDS: readonly ProviderKind[] = [
  'openai-compat',
  'anthropic',
  'gemini',
  'workers-ai',
];

/** Provider-level verified facts required to build a ProviderConfig. */
export interface VerifiedProviderSpec {
  /** Registry provider id. Required. */
  providerId: string;
  /** Adapter kind. Required and must be supported. */
  kind: ProviderKind | string;
  /** Base URL. Required (falls back to the candidate's baseUrl if omitted). */
  baseUrl?: string;
  /** Credential environment-variable NAME (never a value). Required. */
  apiKeyEnv: string;
  /** True when the provider takes no credential. Optional. */
  apiKeyOptional?: boolean;
  /** Highest sensitivity this provider may serve. Required (no default). */
  maxPrivacy: PrivacyLevel;
  /** Risk disposition, when a human recorded one. Optional; never inferred. */
  risk?: 'ok' | 'caution' | 'avoid';
  riskNote?: string;
  riskVerifiedAt?: string;
  signupUrl?: string;
  summary?: string;
  freeTierNote?: string;
}

/** A verified model entry: id plus the required fields, all explicit. */
export interface VerifiedModelSpec {
  id: string;
  label?: string;
  capabilities: Capability[];
  contextWindow: number;
  /** Explicit price. Both 0 means free; the builder never sets this itself. */
  price: { inPerMTok: number; outPerMTok: number };
  priceVerifiedAt?: string;
  quality?: number;
}

export interface BuildProviderInput {
  candidate: CandidateProvider;
  /** The activation gate's verdict for this candidate. */
  activation: ActivationResult;
  provider: VerifiedProviderSpec;
  models: VerifiedModelSpec[];
}

export type BuildResult =
  | { ok: true; config: ProviderConfig }
  | { ok: false; reason: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function looksLikeSecret(v: string): boolean {
  return v.startsWith('sk-') || v.startsWith('Bearer ') || v.includes('-----BEGIN') || v.length > 64;
}

function validBaseUrl(v: string | undefined): v is string {
  if (typeof v !== 'string' || v.length === 0) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Build a ProviderConfig from an eligible candidate and verified inputs. Fails
 * closed with a reason on any missing/unsupported/invented value.
 */
export function buildProviderConfig(input: BuildProviderInput): BuildResult {
  const { candidate, activation, provider, models } = input;

  // Gate: only an eligible activation may be built.
  if (!activation || activation.eligible !== true) {
    return { ok: false, reason: 'candidate is not activation-eligible' };
  }
  if (activation.candidateId !== candidate.candidateId) {
    return { ok: false, reason: 'activation result does not match the candidate' };
  }

  // Identity/config required.
  if (typeof provider.providerId !== 'string' || provider.providerId.trim().length === 0) {
    return { ok: false, reason: 'missing providerId' };
  }
  if (typeof provider.kind !== 'string' || !SUPPORTED_PROVIDER_KINDS.includes(provider.kind as ProviderKind)) {
    return { ok: false, reason: `unsupported provider kind '${String(provider.kind)}'` };
  }

  const baseUrl = provider.baseUrl ?? candidate.baseUrl;
  if (!validBaseUrl(baseUrl)) {
    return { ok: false, reason: 'missing or invalid baseUrl' };
  }

  // Credential reference: an env NAME only, never a value.
  if (typeof provider.apiKeyEnv !== 'string' || !ENV_NAME.test(provider.apiKeyEnv)) {
    const hint = typeof provider.apiKeyEnv === 'string' && looksLikeSecret(provider.apiKeyEnv)
      ? ' (apiKeyEnv must be an environment-variable NAME, not a key value)'
      : '';
    return { ok: false, reason: `missing or invalid apiKeyEnv${hint}` };
  }

  // Privacy is required and never defaulted.
  if (!provider.maxPrivacy) {
    return { ok: false, reason: 'missing maxPrivacy (no default is invented)' };
  }

  if (!Array.isArray(models) || models.length === 0) {
    return { ok: false, reason: 'at least one verified model is required' };
  }

  const entries: ModelEntry[] = [];
  for (const m of models) {
    if (typeof m.id !== 'string' || m.id.length === 0) return { ok: false, reason: 'model without an id' };
    if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
      return { ok: false, reason: `model '${m.id}' has no verified capabilities` };
    }
    if (typeof m.contextWindow !== 'number' || !Number.isFinite(m.contextWindow) || m.contextWindow <= 0) {
      return { ok: false, reason: `model '${m.id}' has no verified contextWindow` };
    }
    if (
      !m.price ||
      typeof m.price.inPerMTok !== 'number' ||
      typeof m.price.outPerMTok !== 'number' ||
      !Number.isFinite(m.price.inPerMTok) ||
      !Number.isFinite(m.price.outPerMTok) ||
      m.price.inPerMTok < 0 ||
      m.price.outPerMTok < 0
    ) {
      return { ok: false, reason: `model '${m.id}' has no verified price` };
    }
    const entry: ModelEntry = {
      id: m.id,
      capabilities: [...m.capabilities],
      contextWindow: m.contextWindow,
      price: { inPerMTok: m.price.inPerMTok, outPerMTok: m.price.outPerMTok },
    };
    if (m.label !== undefined) entry.label = m.label;
    if (m.quality !== undefined) entry.quality = m.quality;
    if (m.priceVerifiedAt !== undefined) entry.priceVerifiedAt = m.priceVerifiedAt;
    entries.push(entry);
  }

  const config: ProviderConfig = {
    id: provider.providerId,
    kind: provider.kind as ProviderKind,
    baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    maxPrivacy: provider.maxPrivacy,
    models: entries,
  };
  if (provider.apiKeyOptional !== undefined) config.apiKeyOptional = provider.apiKeyOptional;
  if (provider.risk !== undefined) config.risk = provider.risk;
  if (provider.riskNote !== undefined) config.riskNote = provider.riskNote;
  if (provider.riskVerifiedAt !== undefined) config.riskVerifiedAt = provider.riskVerifiedAt;
  if (provider.signupUrl !== undefined) config.signupUrl = provider.signupUrl;
  if (provider.summary !== undefined) config.summary = provider.summary;
  if (provider.freeTierNote !== undefined) config.freeTierNote = provider.freeTierNote;

  return { ok: true, config };
}
