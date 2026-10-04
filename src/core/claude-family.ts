/**
 * Claude-family classifier (pure).
 *
 * Claude Code (and other Anthropic-compatible clients) send a Claude model id
 * verbatim on `/v1/messages` (e.g. `claude-sonnet-5-5`, or a future
 * `claude-<tier>-<version>`). Tariffia does not serve Anthropic cloud models, so
 * such an id must NOT become a routing pin (which would match no candidate).
 * This module recognises a Claude-family id and extracts a tier when one is
 * clearly present, so the mesh can map it to a routing target instead.
 *
 * Rules:
 *   - generic: recognises any id that looks like Claude, without a fixed list of
 *     today's model ids;
 *   - tier is extracted only when clearly identifiable (`opus`/`sonnet`/`haiku`);
 *   - any other Claude id (unknown/future tier) is `default` — never guessed;
 *   - a non-Claude id returns `null` (caller leaves it untouched).
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

export type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'default';

/** The tiers a family policy may key on ("default" is the catch-all). */
export const CLAUDE_FAMILIES: readonly ClaudeFamily[] = ['opus', 'sonnet', 'haiku', 'default'];

/**
 * The routing target for a family.
 *   - a profile name (routes through that named profile), or
 *   - `{ pin: 'provider/model' }` (routes to a specific backend model), or
 *   - `'auto'` (no profile, no pin: the active profile/default decides).
 */
export type ClaudeFamilyTarget = string | { pin: string };

export interface ClaudeFamilyPolicy {
  opus?: ClaudeFamilyTarget;
  sonnet?: ClaudeFamilyTarget;
  haiku?: ClaudeFamilyTarget;
  /** Catch-all for any other Claude id (unknown/future tier). */
  default?: ClaudeFamilyTarget;
}

/** The resolved routing intent for a Claude-family model. */
export interface ClaudeRouting {
  family: ClaudeFamily;
  /** Profile name to route through, or undefined to use the active default. */
  mesh?: string;
  /** Explicit `provider/model` pin, or undefined to let the scorer decide. */
  pin?: string;
}

/**
 * Resolve a model id to a routing intent using the policy. Returns `null` for a
 * non-Claude id (caller leaves it untouched). A target of `'auto'` (or a family
 * with no configured target) yields no `mesh` and no `pin`, so the existing
 * routing/scoring pipeline selects the backend — the safe default.
 */
export function resolveClaudeRouting(
  model: string | undefined | null,
  policy: ClaudeFamilyPolicy = {},
): ClaudeRouting | null {
  const family = classifyClaudeFamily(model);
  if (family === null) return null;

  const target = policy[family];
  if (target === undefined || target === 'auto') return { family };
  if (typeof target === 'string') return { family, mesh: target };
  if (target && typeof target === 'object' && typeof target.pin === 'string' && target.pin.length > 0) {
    return { family, pin: target.pin };
  }
  // A malformed target is treated as auto rather than guessed.
  return { family };
}

/** True when the id looks like an Anthropic/Claude model at all. */
export function isClaudeModel(model: string | undefined | null): boolean {
  if (typeof model !== 'string') return false;
  return model.trim().toLowerCase().startsWith('claude');
}

/**
 * Classify a model id into a Claude family, or `null` when it is not a Claude id.
 *
 * `opus`/`sonnet`/`haiku` are matched as substrings of the lowercased id. A
 * planning-style alias that merely *contains* "opus" but is not a real opus tier
 * (e.g. an `opusplan`-style id) is deliberately routed to `default`, matching the
 * proven behaviour of server-side Claude-family mappers: the catch-all is safer
 * than a wrong tier.
 */
export function classifyClaudeFamily(model: string | undefined | null): ClaudeFamily | null {
  if (!isClaudeModel(model)) return null;
  const m = (model as string).trim().toLowerCase();

  // A planning/unknown alias that is not a concrete tier must not be guessed.
  // (Kept generic: any "plan" token routes to default.)
  if (m.includes('plan')) return 'default';

  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';

  // A Claude id with no recognisable tier: safe catch-all, never a guess.
  return 'default';
}
