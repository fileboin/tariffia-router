/**
 * Tariffia routing modes.
 *
 * A mode is a server-owned preset over the existing profile/scoring mechanism.
 * It is resolved at construction time from server configuration and is never
 * read from a client request, so a request cannot switch or weaken the mode the
 * server chose.
 *
 * Implemented: FREE_ONLY and BALANCED.
 * Reserved (type only, not implemented): FREE_FIRST and CUSTOM. Selecting one
 * of those fails closed rather than silently behaving like another mode.
 *
 * Tariffia addition (2026-10-03). See THIRD_PARTY_NOTICES.md.
 */

import type { MeshProfile } from './core/types.js';

export type RoutingMode = 'FREE_ONLY' | 'BALANCED' | 'FREE_FIRST' | 'CUSTOM';

export const ROUTING_MODES: readonly RoutingMode[] = ['FREE_ONLY', 'BALANCED', 'FREE_FIRST', 'CUSTOM'];

/**
 * The BALANCED profile.
 *
 * Tariffia owns this explicitly so "balanced" is a defined, reproducible
 * weighting rather than an implicit choice. The weights reuse the existing
 * scorer's signals and are the documented balanced posture:
 *
 *   quality 0.4  — the answer's quality matters most
 *   cost    0.3  — but price is a close second
 *   latency 0.1  — responsiveness is a tie-breaker, not the goal
 *   language 0.1 — competence in the requested language
 *   reliability 0.1 — observed success, so a flaky model does not win on paper
 *
 * They are deliberately close to the upstream `best`/`cheap` shapes and sum to
 * 1.0; a "balanced" preset that priced free tiers out entirely (or ignored cost)
 * would not be balanced. No new scoring term is introduced.
 */
export const BALANCED_PROFILE: MeshProfile = {
  name: 'balanced',
  weights: { quality: 0.4, cost: 0.3, latency: 0.1, language: 0.1, reliability: 0.1 },
};

/** The profile name FREE_ONLY forces (the built-in free-only profile). */
export const FREE_ONLY_PROFILE_NAME = 'free';

export interface ModeSettings {
  /**
   * The default profile the server routes through when a request does not name
   * a profile. Set to the mode's profile so `mesh/<mode-profile>` and the
   * default agree.
   */
  defaultProfile: string;
  /** Extra profiles the mode needs (e.g. BALANCED). Merged into the registry. */
  profiles?: Record<string, MeshProfile>;
  /** Server-authoritative FREE_ONLY enforcement. */
  enforceFreeOnly: boolean;
}

export class RoutingModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingModeError';
  }
}

/**
 * Resolve a mode into server settings. Fails closed on an unknown or reserved
 * mode: an unrecognised string must not default to a more permissive mode.
 */
export function resolveMode(mode: RoutingMode | string): ModeSettings {
  switch (mode) {
    case 'FREE_ONLY':
      return {
        defaultProfile: FREE_ONLY_PROFILE_NAME,
        enforceFreeOnly: true,
      };
    case 'BALANCED':
      return {
        defaultProfile: BALANCED_PROFILE.name,
        profiles: { [BALANCED_PROFILE.name]: BALANCED_PROFILE },
        enforceFreeOnly: false,
      };
    case 'FREE_FIRST':
    case 'CUSTOM':
      throw new RoutingModeError(
        `tariffia: routing mode '${mode}' is reserved and not implemented yet`,
      );
    default:
      throw new RoutingModeError(
        `tariffia: unknown routing mode '${String(mode)}'. Known: ${ROUTING_MODES.join(', ')}`,
      );
  }
}

/**
 * Read the mode from server configuration (an environment object). Defaults to
 * FREE_ONLY — the safe default: a misconfigured or absent setting must never
 * silently allow paid routing. This value is read once, by the server, and never
 * from a request.
 */
export function modeFromEnv(env: Record<string, string | undefined> = {}): RoutingMode {
  const raw = env['TARIFFIA_MODE'];
  if (raw === undefined || raw === '') return 'FREE_ONLY';
  const mode = raw.toUpperCase();
  if ((ROUTING_MODES as readonly string[]).includes(mode)) return mode as RoutingMode;
  throw new RoutingModeError(
    `tariffia: TARIFFIA_MODE='${raw}' is not a known mode. Known: ${ROUTING_MODES.join(', ')}`,
  );
}
