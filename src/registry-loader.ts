/**
 * Runtime registry loader (Node).
 *
 * Reads a Tariffia registry JSON file, validates it with the existing
 * `validateRegistryFile`, and builds a `Registry`. It exists so the shipped
 * registry is data, not code: no provider or model is hardcoded in TypeScript,
 * and a missing or invalid file fails closed instead of silently falling back.
 *
 * This is Node-specific (it uses the filesystem) and therefore lives outside
 * `src/core/`, which must stay runtime-agnostic.
 *
 * Tariffia addition (2026-10-03). See THIRD_PARTY_NOTICES.md.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateRegistryFile, type RegistryFile } from './core/config.js';
import { Registry, type RegistryOptions } from './core/registry.js';
import { resolveMode, type RoutingMode } from './routing-mode.js';

/** The registry Tariffia ships with. Overridable per call. */
export const DEFAULT_REGISTRY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../registry/ollama.json',
);

export interface LoadRegistryOptions extends RegistryOptions {
  /** Path to the registry file. Defaults to the shipped `registry/ollama.json`. */
  path?: string;
  /**
   * Routing mode. When set, its profile and enforcement overlay are applied on
   * top of the file's own `profiles`/`defaultProfile` (mode wins). When unset,
   * the file's settings apply unchanged.
   */
  mode?: RoutingMode;
}

/**
 * Read, validate and build a registry from a file.
 *
 * Fails closed: a missing file, unreadable file, malformed JSON or a registry
 * that fails validation all throw. There is no fallback to an embedded or empty
 * registry — a typo in a path must not be answered with a different registry
 * than the one asked for.
 */
export async function loadRegistryFile(path: string = DEFAULT_REGISTRY_PATH): Promise<RegistryFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`tariffia: cannot read registry '${path}': ${reason}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`tariffia: registry '${path}' is not valid JSON: ${reason}`);
  }

  return validateRegistryFile(raw);
}

export async function loadRegistry(options: LoadRegistryOptions = {}): Promise<Registry> {
  const path = options.path ?? DEFAULT_REGISTRY_PATH;
  const file: RegistryFile = await loadRegistryFile(path);
  const opts: RegistryOptions = {};
  if (options.env) opts.env = options.env;
  if (options.profiles) opts.profiles = options.profiles;
  if (options.defaultProfile) opts.defaultProfile = options.defaultProfile;

  if (options.mode) {
    // The mode is server-owned. It overlays the file's profile settings; the
    // file provides providers, the mode provides the routing posture.
    const settings = resolveMode(options.mode);
    opts.profiles = { ...(opts.profiles ?? {}), ...(settings.profiles ?? {}) };
    opts.defaultProfile = settings.defaultProfile;
  }

  return new Registry(file.providers, opts);
}
