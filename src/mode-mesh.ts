/**
 * Build an InferenceMesh configured for a Tariffia routing mode.
 *
 * This is the single place a mode turns into enforcement. The mode is resolved
 * from server configuration and applied here at construction; nothing in a
 * request can change it. FREE_ONLY sets `enforceFreeOnly: true` (the mesh's
 * server-authoritative, execution-boundary guarantee) and routes through the
 * free profile. BALANCED routes through the explicit balanced profile with no
 * free-only enforcement. FREE_FIRST sets `freeFirst: true`, which tries free
 * candidates before paid ones and drops a client pin to a paid model so it
 * cannot force paid-first behavior.
 *
 * Tariffia addition (2026-10-03). See THIRD_PARTY_NOTICES.md.
 */

import { InferenceMesh, type MeshOptions } from './core/mesh.js';
import { Registry } from './core/registry.js';
import { resolveMode, type RoutingMode } from './routing-mode.js';

export interface ModeMeshOptions extends Omit<MeshOptions, 'registry' | 'enforceFreeOnly' | 'freeFirst'> {
  /** Base registry (providers + any file profiles). Mode profile is merged in. */
  registry: Registry;
  /** Server-selected routing mode. */
  mode: RoutingMode;
}

/**
 * Return a Registry whose profile set and default match the mode, preserving the
 * input's providers and environment. The mode's enforcement flag is returned
 * alongside so the caller cannot forget to apply it to the mesh.
 */
export function registryForMode(registry: Registry, mode: RoutingMode): Registry {
  const settings = resolveMode(mode);
  // Overlay the mode's profiles on the existing registry without rebuilding it,
  // so providers, candidates, credentials and warnings are preserved exactly.
  return registry.withProfiles(settings.profiles ?? {}, settings.defaultProfile);
}

/** Build an InferenceMesh for a mode. The mode cannot be overridden by a request. */
export function createModeMesh(options: ModeMeshOptions): InferenceMesh {
  const { registry, mode, ...rest } = options;
  const settings = resolveMode(mode);
  const modeRegistry = registryForMode(registry, mode);
  return new InferenceMesh({
    ...rest,
    registry: modeRegistry,
    enforceFreeOnly: settings.enforceFreeOnly,
    freeFirst: settings.freeFirst,
  });
}
