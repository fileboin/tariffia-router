/**
 * Deterministic, explainable model scorer.
 *
 * Pure: it takes already-computed signals and returns a ranking. It performs no
 * network call, reads no clock, and holds no state, so the same input always
 * produces the same output. It runs only on candidates that already passed the
 * hard filters (capability, privacy, context, FREE_ONLY eligibility) — it never
 * re-admits a candidate those filters removed.
 *
 * Every score is decomposed into `components`, each with a normalised value, a
 * weight, a contribution and a machine-readable reason. The contributions sum
 * to the final `score`.
 *
 * Signals, all deterministic and already available:
 *   - capability fit    requested capabilities present on the model
 *   - context fit       context-window headroom above the required context
 *   - output fit        context window large enough for the requested output
 *   - cost              blended price (cheaper is better)
 *   - quality           the registry's hand-maintained quality score
 *   - latency           observed latency (optimistic when untried)
 *   - language          per-language competence
 *   - availability      observed success rate (optimistic when untried)
 *
 * The fit terms are about the request, not about preferring one provider: they
 * are identical for every candidate that fits equally well, so they only reorder
 * candidates when a fit genuinely differs.
 *
 * Tariffia addition (2026-10-03). See THIRD_PARTY_NOTICES.md.
 */

import type { Candidate, Capability, ScoreComponent, ScoredCandidate } from './types.js';

export interface ScoreWeights {
  quality: number;
  cost: number;
  /** Rewards low observed latency. */
  latency: number;
  /** Rewards competence in the requested language. */
  language: number;
  /** Rewards a high observed success rate. Optional for older configs. */
  reliability?: number;
  /** Fit weights; small fixed values when a profile does not set them. */
  capabilityFit?: number;
  contextFit?: number;
  outputFit?: number;
}

/** One candidate plus every pre-computed signal the scorer needs. */
export interface RankingInput {
  candidate: Candidate;
  /** Blended price, USD per million tokens. */
  price: number;
  minPrice: number;
  maxPrice: number;
  /** Hand-maintained quality, 0..1. */
  quality: number;
  /** Language competence for the requested language, 0..1. */
  languageFit: number;
  latencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  /** True when this candidate has never been tried. */
  untried: boolean;
  successRate: number | null;
  requiredCapabilities: Capability[];
  minContext?: number;
  maxOutputTokens?: number;
}

/**
 * Fixed weights for the fit terms when a profile does not name them. Small on
 * purpose: fit breaks ties and orders candidates that differ in fit, but it must
 * not dominate quality or cost, which are the caller's stated intent.
 */
const DEFAULT_FIT_WEIGHTS = { capabilityFit: 0.1, contextFit: 0.1, outputFit: 0.1 } as const;

/**
 * How much better an untried candidate is assumed to be than the best measured
 * one, so every candidate gets sampled. Small: it decides ties, it must not let
 * an unknown model outrank a genuinely better measured one.
 */
const EXPLORE_MARGIN = 0.05;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function scoreCandidate(input: RankingInput, weights: ScoreWeights): ScoredCandidate {
  const wCap = weights.capabilityFit ?? DEFAULT_FIT_WEIGHTS.capabilityFit;
  const wCtx = weights.contextFit ?? DEFAULT_FIT_WEIGHTS.contextFit;
  const wOut = weights.outputFit ?? DEFAULT_FIT_WEIGHTS.outputFit;
  const wRel = weights.reliability ?? 0;
  const wsum =
    weights.quality + weights.cost + weights.latency + weights.language + wRel + wCap + wCtx + wOut || 1;

  const model = input.candidate.model;
  const caps = model.capabilities;
  const matched = input.requiredCapabilities.filter((c) => caps.includes(c)).length;
  const capabilityFit =
    input.requiredCapabilities.length === 0 ? 1 : matched / input.requiredCapabilities.length;

  const need = input.minContext ?? 0;
  const cw = model.contextWindow;
  // More headroom above the required context is a better fit. With no explicit
  // requirement this is 1 for everyone, so it cannot reorder a plain request.
  const contextFit = need > 0 ? clamp01(1 - need / cw) : 1;

  const out = input.maxOutputTokens ?? 0;
  const outputFit = out > 0 ? clamp01(cw / out) : 1;

  const price = input.price;
  const costTerm =
    input.maxPrice === input.minPrice ? 1 : 1 - (price - input.minPrice) / (input.maxPrice - input.minPrice);

  const lat = input.latencyMs;
  const measuredLat =
    lat === null || input.minLatencyMs === null || input.maxLatencyMs === null || input.maxLatencyMs === input.minLatencyMs
      ? 0.5
      : 1 - (lat - input.minLatencyMs) / (input.maxLatencyMs - input.minLatencyMs);
  const latencyTerm = input.untried ? 1 : Math.min(measuredLat, 1 - EXPLORE_MARGIN);

  const availabilityTerm = input.untried ? 1 : Math.min(input.successRate ?? 1, 1 - EXPLORE_MARGIN);

  const qualityTerm = input.quality;
  const languageTerm = input.languageFit;

  const component = (key: ScoreComponent['key'], value: number, weight: number, reason: string): ScoreComponent => ({
    key,
    value,
    weight,
    contribution: (weight * value) / wsum,
    reason,
  });

  const components: ScoreComponent[] = [
    component(
      'capability',
      capabilityFit,
      wCap,
      input.requiredCapabilities.length > 0
        ? `${matched}/${input.requiredCapabilities.length} required capabilities present`
        : 'no explicit capability requirement',
    ),
    component(
      'context',
      contextFit,
      wCtx,
      need > 0 ? `context window ${cw} for requested ${need}` : 'no explicit context requirement',
    ),
    component(
      'output',
      outputFit,
      wOut,
      out > 0 ? `context window ${cw} for requested output ${out}` : 'no explicit output limit',
    ),
    component('cost', costTerm, weights.cost, `blended price ${price}/MTok`),
    component('quality', qualityTerm, weights.quality, `quality ${qualityTerm}`),
    component(
      'latency',
      latencyTerm,
      weights.latency,
      input.untried ? 'untried, scored optimistically' : `observed latency ${lat ?? 'n/a'}ms`,
    ),
    component('language', languageTerm, weights.language, `language fit ${languageTerm}`),
    component(
      'availability',
      availabilityTerm,
      wRel,
      input.untried ? 'untried, scored optimistically' : `observed success rate ${input.successRate ?? 'n/a'}`,
    ),
  ];

  const score = components.reduce((sum, c) => sum + c.contribution, 0);
  const terms: Record<string, number> = {
    quality: qualityTerm,
    cost: costTerm,
    latency: latencyTerm,
    language: languageTerm,
    reliability: availabilityTerm,
    capabilityFit,
    contextFit,
    outputFit,
  };

  return { candidate: input.candidate, score, terms, components };
}

/**
 * Rank survivors best-first. Ties are broken by candidate key so a decision is
 * reproducible across processes and independent of registry order, exactly as
 * before.
 */
export function rankCandidates(inputs: RankingInput[], weights: ScoreWeights): ScoredCandidate[] {
  const scored = inputs.map((input) => scoreCandidate(input, weights));
  scored.sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key));
  return scored;
}
