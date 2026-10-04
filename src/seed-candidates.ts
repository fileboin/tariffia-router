/**
 * Seed -> provider candidates (pure).
 *
 * Maps parsed `SeedData` into flat candidate records for later human review and
 * import. It is deliberately NOT a Tariffia `ProviderConfig`: nothing here is
 * activated, has a price, a free flag, a privacy tier, a risk disposition, an
 * API key or a quota. Every candidate is marked `unverified` and carries the
 * source provenance it came from.
 *
 * Only fields actually present in the seed are mapped. A missing field is left
 * absent, never guessed. Free status is never derived here: the active registry
 * owns that through an explicit price of 0/0.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md and seed/README.md.
 */

import type { SeedData, SeedModel, SeedProvider } from './seed-import.js';

/** Where a candidate came from. */
export interface CandidateProvenance {
  /** Upstream repository the seed was taken from. */
  source: string;
  /** Licence of the source data. */
  license: string;
  /** The seed file's own `lastUpdated` value, if any. */
  lastUpdated: string;
  /** The seed provider's category ('provider_api' | 'inference_provider' | ...). */
  category: string;
  /** ISO date the seed was retrieved into this repository. */
  retrievedAt: string;
}

/** One candidate model. Facts as published; not verified. */
export interface CandidateModel {
  id: string;
  name?: string;
  /** Context length as published (a string like '128K'), not parsed to a number. */
  context?: string;
  maxOutput?: string;
  modality?: string;
  rateLimit?: string;
}

/** One candidate provider for review. NOT a routed ProviderConfig. */
export interface CandidateProvider {
  /** Stable, review-friendly id derived from the name (not a routing id). */
  candidateId: string;
  name: string;
  /** True: this is seed data, not a verified Tariffia provider. */
  unverified: true;
  /** API-key / signup page from the seed. */
  url?: string;
  /** Base URL from the seed, when present. */
  baseUrl?: string;
  description?: string;
  country?: string;
  flag?: string;
  models: CandidateModel[];
  /** The "more models" summary rows, kept verbatim. */
  notes: string[];
  provenance: CandidateProvenance;
}

/** Provenance stamped onto every candidate, fixed for this import. */
export const SEED_PROVENANCE: Omit<CandidateProvenance, 'category'> = {
  source: 'https://github.com/mnfst/awesome-free-llm-apis',
  license: 'CC0-1.0',
  lastUpdated: '',
  retrievedAt: '2026-10-04',
};

/** A filesystem/review-safe id from a provider name. */
export function candidateIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'unnamed-provider';
}

function mapModel(m: SeedModel): CandidateModel {
  const out: CandidateModel = { id: m.id };
  if (m.name) out.name = m.name;
  if (m.context) out.context = m.context;
  if (m.maxOutput) out.maxOutput = m.maxOutput;
  if (m.modality) out.modality = m.modality;
  if (m.rateLimit) out.rateLimit = m.rateLimit;
  return out;
}

function mapProvider(p: SeedProvider, lastUpdated: string): CandidateProvider {
  const out: CandidateProvider = {
    candidateId: candidateIdFromName(p.name),
    name: p.name,
    unverified: true,
    models: p.models.map(mapModel),
    notes: p.notes.map((n) => n.name),
    provenance: { ...SEED_PROVENANCE, lastUpdated, category: p.category },
  };
  if (p.url) out.url = p.url;
  if (p.baseUrl) out.baseUrl = p.baseUrl;
  if (p.description) out.description = p.description;
  if (p.country) out.country = p.country;
  if (p.flag) out.flag = p.flag;
  return out;
}

/**
 * Map a parsed seed into candidate providers. Pure: the input is never mutated
 * and no network, filesystem or registry access happens.
 */
export function toCandidates(seed: SeedData): CandidateProvider[] {
  return seed.providers.map((p) => mapProvider(p, seed.lastUpdated));
}
