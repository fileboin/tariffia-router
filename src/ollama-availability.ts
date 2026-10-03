/**
 * Ollama availability filter (Node).
 *
 * Turns a read-only `discoverOllama()` result into a registry in which Ollama
 * models that are not installed locally are disabled, so routing never selects
 * a model the local server cannot serve. It changes nothing else: pricing,
 * verification, capabilities, quality and FREE_ONLY semantics are untouched, and
 * the source registry is never mutated.
 *
 * It is optional. Without it, the core behaves exactly as before. When it is
 * used and Ollama is unreachable, it fails closed by throwing — it never removes
 * all Ollama models silently and never routes to a different provider behind the
 * caller's back.
 *
 * Node-specific (uses `discoverOllama`, which does network I/O), so it lives
 * outside `src/core/`.
 *
 * Tariffia addition (2026-10-03). See THIRD_PARTY_NOTICES.md.
 */

import { Registry, type RegistryOptions } from './core/registry.js';
import { discoverOllama, type DiscoverOptions } from './ollama-discovery.js';
import type { ProviderConfig } from './core/types.js';

export interface AvailabilityOptions extends DiscoverOptions {
  /** Registry to filter. */
  registry: Registry;
  /**
   * Environment used when rebuilding the registry (so keyed providers are not
   * dropped). Defaults to `process.env`, matching the Registry constructor.
   */
  env?: Record<string, string | undefined>;
}

function cloneConfigs(configs: ProviderConfig[]): ProviderConfig[] {
  return configs.map((p) => ({
    ...p,
    models: p.models.map((m) => ({ ...m })),
  }));
}

/**
 * Rebuild the registry with uninstalled models of `providerId` disabled.
 *
 * Only the `disabled` flag is changed, and only on models the discovery reports
 * as not installed. Everything else (price, quality, capabilities, context,
 * privacy, quota) is copied verbatim, so FREE_ONLY and scoring see the same
 * data they would have.
 */
export function applyOllamaAvailability(
  registry: Registry,
  installed: string[],
  providerId = 'ollama',
  env?: Record<string, string | undefined>,
): Registry {
  const installedSet = new Set(installed);
  const configs = cloneConfigs(registry.providers).map((p) => {
    if (p.id !== providerId) return p;
    return {
      ...p,
      models: p.models.map((m) => {
        const present = installedSet.has(m.id) || installedSet.has(`${m.id}:latest`);
        return present ? m : { ...m, disabled: true };
      }),
    };
  });
  const opts: RegistryOptions = {
    profiles: registry.profiles,
    defaultProfile: registry.defaultProfile,
  };
  // Preserve the caller's environment so keyed providers are not dropped when
  // the registry is rebuilt.
  opts.env = env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  return new Registry(configs, opts);
}

/**
 * Discover installed Ollama models and return an availability-filtered registry.
 *
 * Fails closed: if Ollama is unreachable the `OllamaUnreachableError` propagates
 * from `discoverOllama`; no unfiltered registry is returned in its place.
 */
export async function registryWithOllamaAvailability(options: AvailabilityOptions): Promise<Registry> {
  const { registry, env, ...discover } = options;
  const result = await discoverOllama(registry, discover);
  return applyOllamaAvailability(registry, result.installed, discover.providerId ?? 'ollama', env);
}
