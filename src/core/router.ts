/**
 * Routing: turn a RouteRequest into a ranked fallback chain.
 *
 * Two rules shape everything here:
 *
 *  1. Hard constraints are filters, soft preferences are weights. Privacy,
 *     capability and context are correctness — a model that cannot see an image
 *     is not "a worse choice" for a vision request, it is not a choice.
 *
 *  2. Never return an empty chain because of a *soft* signal. If every
 *     candidate's breaker is open, health is ignored rather than answering 503:
 *     a probably-down provider still beats a certainly-absent one.
 *
 * Routing does not touch the network and does not consume quota, so it is pure
 * and cheap to unit-test.
 */

import {
  blendedPrice,
  hasCapabilities,
  isFree,
  languageScore,
  maxPrivacyOf,
  qualityScore,
  servesPrivacy,
  type Registry,
} from './registry.js';
import type { HealthTracker } from './health.js';
import { rankCandidates, type RankingInput, type ScoreWeights } from './scorer.js';
import type { Candidate, ModelEntry, RouteDecision, Rejection, RouteRequest, ScoredCandidate } from './types.js';

export interface RouterOptions {
  health?: HealthTracker;
  /** Server-owned maximum USD rate per 1M input and output tokens. */
  maxPricePerMTok?: number;
  /**
   * Optional synchronous lookup of remaining quota headroom (0..1) for a
   * candidate key. When absent (or returning undefined) every candidate scores
   * headroom 1, so routing is unchanged. Kept synchronous so scoring stays pure
   * and deterministic; the caller supplies a snapshot.
   */
  headroom?: (key: string) => number | undefined;
}

/** Hard eligibility check shared by pre-score routing and the execution guard. */
export function priceCapRejectionReason(
  model: ModelEntry,
  maxPricePerMTok: number | undefined,
): string | null {
  const price = model.price;
  const input = price?.inPerMTok;
  const output = price?.outPerMTok;
  if (
    typeof input !== 'number' || !Number.isFinite(input) || input < 0 ||
    typeof output !== 'number' || !Number.isFinite(output) || output < 0
  ) {
    return 'price_cap: model pricing is missing or invalid';
  }

  if (input === 0 && output === 0) return null;

  if (
    typeof maxPricePerMTok !== 'number' ||
    !Number.isFinite(maxPricePerMTok) ||
    maxPricePerMTok < 0
  ) {
    return 'price_cap: paid candidates require a valid server price cap';
  }

  if (input > maxPricePerMTok || output > maxPricePerMTok) {
    return `price_cap: input ${input} or output ${output} USD/MTok exceeds cap ${maxPricePerMTok}`;
  }
  return null;
}

export class Router {
  constructor(
    private readonly registry: Registry,
    private readonly opts: RouterOptions = {},
  ) {}

  route(req: RouteRequest): RouteDecision {
    const profile = this.registry.profile(req.mesh);
    const privacy = req.privacy ?? 'public';
    const rejected: Rejection[] = [];

    const required = [...(req.capabilities ?? []), ...(profile.requireCapabilities ?? [])];

    let pool: Candidate[] = [];
    for (const c of this.registry.candidates) {
      if (req.pin && c.key !== req.pin) continue;
      const priceRejection = priceCapRejectionReason(c.model, this.opts.maxPricePerMTok);
      if (priceRejection) {
        rejected.push({ key: c.key, reason: priceRejection });
        continue;
      }
      if (!servesPrivacy(c, privacy)) {
        rejected.push({
          key: c.key,
          reason: `privacy: needs ${privacy}, serves up to ${maxPrivacyOf(c)}`,
        });
        continue;
      }
      if (!hasCapabilities(c.model, required)) {
        const missing = required.filter((x) => !c.model.capabilities.includes(x));
        rejected.push({ key: c.key, reason: `capability: missing ${missing.join(',')}` });
        continue;
      }
      if (req.minContext !== undefined && c.model.contextWindow < req.minContext) {
        rejected.push({
          key: c.key,
          reason: `context: ${c.model.contextWindow} < ${req.minContext}`,
        });
        continue;
      }
      // Price limits are the profile's *preference*, and a caller who named a
      // specific model has already overridden the profile. Privacy, capability
      // and context above are correctness and still apply — a pin may not be
      // used to smuggle confidential text into a public-tier provider.
      if (!req.pin) {
        if (profile.freeOnly && !isFree(c.model)) {
          rejected.push({ key: c.key, reason: `profile ${profile.name}: not free` });
          continue;
        }
        if (profile.maxPricePerMTok !== undefined && blendedPrice(c.model) > profile.maxPricePerMTok) {
          rejected.push({
            key: c.key,
            reason: `profile ${profile.name}: ${blendedPrice(c.model)} > ${profile.maxPricePerMTok} /MTok`,
          });
          continue;
        }
      }
      pool.push(c);
    }

    if (req.pin && pool.length === 0 && !this.registry.find(req.pin)) {
      rejected.push({ key: req.pin, reason: 'pin: no such provider/model in registry' });
    }

    // Soft filter: drop candidates whose breaker is open, unless that empties
    // the pool — see rule 2 above.
    const health = this.opts.health;
    if (health && pool.length > 0) {
      const healthy = pool.filter((c) => !health.isOpen(c.key));
      if (healthy.length > 0) {
        for (const c of pool) {
          if (!healthy.includes(c)) {
            rejected.push({ key: c.key, reason: `health: breaker open ${health.openFor(c.key)}ms` });
          }
        }
        pool = healthy;
      }
    }

    return { ranked: this.score(pool, req, profile.name), rejected, profile };
  }

  private score(pool: Candidate[], req: RouteRequest, profileName: string): ScoredCandidate[] {
    if (pool.length === 0) return [];
    const profile = this.registry.profile(profileName);
    const weights = profile.weights as ScoreWeights;

    const prices = pool.map((c) => blendedPrice(c.model));
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    const health = this.opts.health;
    const latencies = pool.map((c) => health?.latencyMs(c.key) ?? null);
    const known = latencies.filter((l): l is number => l !== null);
    const minLatencyMs = known.length ? Math.min(...known) : null;
    const maxLatencyMs = known.length ? Math.max(...known) : null;

    // What the request needs, so the scorer can express fit. `req.capabilities`
    // already carries the analyzer's required capabilities (the mesh merged
    // them), and the profile may add its own.
    const requiredCapabilities = [...(req.capabilities ?? []), ...(profile.requireCapabilities ?? [])];

    const inputs: RankingInput[] = pool.map((c, i) => ({
      candidate: c,
      price: prices[i] as number,
      minPrice,
      maxPrice,
      quality: qualityScore(c.model),
      languageFit: languageScore(c.model, req.language),
      latencyMs: latencies[i] ?? null,
      minLatencyMs,
      maxLatencyMs,
      untried: (health?.attempts(c.key) ?? 0) === 0,
      successRate: health?.successRate(c.key) ?? null,
      requiredCapabilities,
      ...(req.minContext === undefined ? {} : { minContext: req.minContext }),
      ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
      ...(this.opts.headroom === undefined ? {} : { headroom: this.opts.headroom(c.key) }),
    }));

    return rankCandidates(inputs, weights);
  }
}
