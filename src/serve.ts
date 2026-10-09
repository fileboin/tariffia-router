/**
 * `tariffia serve` — the smallest runnable end-to-end path.
 *
 * Loads the provider registry, applies the server-selected routing mode (safe
 * default: FREE_ONLY), and serves the vendored core gateway over Node's HTTP
 * server. OpenAI-compatible (`/v1/chat/completions`, `/v1/models`,
 * `/healthz`) and Anthropic-compatible (`/v1/messages`) routes come from
 * `handleRequest`; this module only wires Node's transport to it.
 *
 * It adds no routing architecture of its own and does not print secrets.
 *
 * Configuration (environment, all optional):
 *   TARIFFIA_REGISTRY   path to the registry file (default: registry/ollama.json)
 *   TARIFFIA_MODE       FREE_ONLY | BALANCED | FREE_FIRST | CUSTOM (default FREE_ONLY)
 *   TARIFFIA_PORT       default 8910
 *   TARIFFIA_HOST       default 127.0.0.1
 *   TARIFFIA_TOKEN      required bearer token; generated if unset (never logged
 *                       to a non-TTY, and only announced when attached to a TTY)
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import { createModeMesh } from './mode-mesh.js';
import { loadRegistry, loadRegistryFile, DEFAULT_REGISTRY_PATH } from './registry-loader.js';
import { handleRequest, type KeyStore } from './core/gateway.js';
import { UsageMeter } from './core/usage.js';
import type { Registry } from './core/registry.js';
import type { ProviderConfig } from './core/types.js';
import { modeFromEnv, type RoutingMode } from './routing-mode.js';

export interface ServeConfig {
  registryPath: string;
  mode: RoutingMode;
  /** Server-owned maximum USD rate per 1M input and output tokens. */
  maxPricePerMTok?: number;
  host: string;
  port: number;
  token: string;
  /** True when the token was generated (not supplied by the operator). */
  generatedToken: boolean;
}

export interface RunningServer {
  server: Server;
  /** The address the server bound to. */
  url: string;
  config: ServeConfig;
  close: () => Promise<void>;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`tariffia: '${raw}' is not a valid port`);
  }
  return n;
}

/** Invalid or absent caps stay undefined, which makes paid candidates ineligible. */
function maxPricePerMTokFromEnv(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
  const cap = Number(value);
  return Number.isFinite(cap) && cap >= 0 ? cap : undefined;
}

/** Build the effective config from a server-owned environment object. */
export function serveConfigFromEnv(env: Record<string, string | undefined> = {}): ServeConfig {
  const mode = modeFromEnv(env);
  const supplied = (env['TARIFFIA_TOKEN'] ?? '').trim();
  const token = supplied.length > 0 ? supplied : randomBytes(32).toString('hex');
  const maxPricePerMTok = maxPricePerMTokFromEnv(env['TARIFFIA_MAX_PRICE_PER_MTOK']);
  return {
    registryPath: env['TARIFFIA_REGISTRY'] ?? DEFAULT_REGISTRY_PATH,
    mode,
    ...(maxPricePerMTok === undefined ? {} : { maxPricePerMTok }),
    host: env['TARIFFIA_HOST'] ?? '127.0.0.1',
    port: intFromEnv(env['TARIFFIA_PORT'], 8910),
    token,
    generatedToken: supplied.length === 0,
  };
}

/**
 * In-memory provider keys for the key-sync route.
 *
 * Nothing is written to disk: a key lives only for the life of the process and is
 * lost on restart (the Panel re-syncs it). [reload] rebuilds the registry from the
 * registry file plus every key seen so far, so a synced provider becomes active
 * without a restart. The raw configs come from the file, so a provider that was
 * dropped for a missing key is still accepted by the allowlist.
 */
class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, string>();

  private constructor(
    private readonly registryPath: string,
    private readonly mode: RoutingMode,
    private readonly configs: ProviderConfig[],
  ) {}

  static async create(registryPath: string, mode: RoutingMode): Promise<MemoryKeyStore> {
    const file = await loadRegistryFile(registryPath);
    return new MemoryKeyStore(registryPath, mode, file.providers);
  }

  async save(entries: Record<string, string>): Promise<void> {
    for (const [id, key] of Object.entries(entries)) {
      if (this.configs.some((p) => p.id === id)) this.keys.set(id, key);
    }
  }

  async reload(): Promise<Registry> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const [id, key] of this.keys) {
      const config = this.configs.find((p) => p.id === id);
      if (config) env[config.apiKeyEnv] = key;
    }
    return loadRegistry({ path: this.registryPath, env, mode: this.mode });
  }

  providerConfigs(): ProviderConfig[] {
    return this.configs;
  }
}

/** True when the server binds to the loopback interface only. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

/**
 * Start the Tariffia server. Fails closed if the registry cannot be loaded.
 * Returns a handle with the bound URL and a `close()` for tests.
 */
export async function startServeServer(config: ServeConfig): Promise<RunningServer> {
  // loadRegistry throws on missing/invalid registry. Apply the mode so the
  // server-owned enforcement (FREE_ONLY by default) is in place before serving.
  const base = await loadRegistry({ path: config.registryPath, env: process.env });
  // One memory-only usage meter for the process; records actual provider usage/cost.
  const usage = new UsageMeter();
  const mesh = createModeMesh({
    registry: base,
    mode: config.mode,
    usage,
    maxPricePerMTok: config.maxPricePerMTok,
  });
  const tokens = new Set([config.token]);
  // Key sync is offered only on loopback; a Router bound to 0.0.0.0 never exposes it.
  const keyStore = await MemoryKeyStore.create(config.registryPath, config.mode);
  const keySync = isLoopbackHost(config.host);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
        const url = `http://${config.host}:${config.port}${req.url ?? '/'}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers.set(k, v);
          else if (Array.isArray(v)) headers.set(k, v.join(', '));
        }
        const request = new Request(url, {
          method: req.method ?? 'GET',
          headers,
          // A Uint8Array view satisfies BodyInit; a raw Buffer does not under
          // the DOM typings.
          ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
        });
        const response = await handleRequest(request, { mesh, tokens, keyStore, keySync, usage });
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        const buf = Buffer.from(await response.arrayBuffer());
        res.end(buf);
      } catch (err) {
        // A transport-level failure, not a routing one; never echo secrets.
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'internal server error', code: 'internal_error' } }));
        void err;
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;

  return {
    server,
    url,
    config: { ...config, port },
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

/**
 * CLI entry: parse env, start the server, and print a minimal banner. The token
 * is only shown when stdout is a TTY, matching the core's own policy.
 */
export async function runServe(env: Record<string, string | undefined> = {}): Promise<RunningServer> {
  const config = serveConfigFromEnv(env);
  const running = await startServeServer(config);
  const isTty = Boolean((process.stdout as { isTTY?: boolean }).isTTY);
  process.stdout.write(`tariffia: listening on ${running.url} (mode ${config.mode})\n`);
  process.stdout.write(`tariffia: registry ${config.registryPath}\n`);
  if (config.generatedToken && isTty) {
    process.stdout.write(`tariffia: bearer token ${config.token}\n`);
  } else if (config.generatedToken) {
    process.stdout.write('tariffia: a random bearer token was generated (set TARIFFIA_TOKEN to choose one)\n');
  }
  return running;
}
