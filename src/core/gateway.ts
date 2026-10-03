/**
 * Fetch-API gateway. One function, Request in / Response out, so the same
 * handler backs the Node server, a Cloudflare Worker, Deno, and Bun.
 *
 * Routes:
 *   POST /v1/chat/completions   OpenAI-compatible, streaming and not
 *   GET  /v1/models             the registry, as OpenAI model objects
 *   GET  /healthz               breakers, quota, and load-time warnings
 */

// Tariffia modification (2026-10-03): the upstream `/setup` page and `/v1/keys`
// routes were removed because they depend on the rejected `setup-ui.ts` and
// `validation-probe.ts` modules. No routing logic was changed. See
// THIRD_PARTY_NOTICES.md.
import { InferenceMesh } from './mesh.js';
import { blendedPrice, maxPrivacyOf } from './registry.js';
import { MeshError, NoCandidateError, type ChatRequest, type ProviderConfig } from './types.js';

/**
 * How the gateway persists a key it has just verified.
 *
 * Kept as an injected interface so this file never touches a filesystem and
 * still runs in a Worker — and so the only code that can read a stored key is
 * the code that wrote it. Note there is deliberately no `get`: nothing in the
 * HTTP surface can return a key back to a client, which is the one guarantee
 * the setup page makes to the person pasting it.
 */
export interface KeyStore {
  save(entries: Record<string, string>): Promise<void>;
  /** Rebuild a registry from config plus every key known so far. */
  reload(): Promise<Registry>;
  /** Raw provider config, including setup metadata the Registry drops. */
  providerConfigs(): ProviderConfig[];
}

export interface GatewayOptions {
  mesh: InferenceMesh;
  /**
   * Accepted bearer tokens. Fail-closed: an empty set rejects every request
   * rather than serving an open relay to whoever finds the port.
   */
  tokens: Set<string>;
  /** Allowed Origins for browser callers. Empty means no CORS headers at all. */
  allowedOrigins?: string[];
  /** Expose /healthz without a token. Off by default. */
  publicHealth?: boolean;
  /** Enables /setup and the key endpoints. Omit to disable setup entirely. */
  keyStore?: KeyStore;
  /**
   * Optional screenshots for the setup page's step-by-step guides.
   *
   * Injected rather than read from disk here, because this file has to keep
   * running in a Worker — a test walks the imports out of the entry point and
   * fails on anything from `node:`. The Node server supplies a reader over a
   * directory; a Worker could supply one over KV, or none at all, in which
   * case the page draws its own diagrams instead.
   */
  shots?: ShotStore;
}

export interface ShotStore {
  /** Provider id to the file names it has, in order. */
  list(): Promise<Record<string, string[]>>;
  /** Bytes for one file name, or null when there is no such file. */
  read(name: string): Promise<Uint8Array | null>;
}

function cors(origin: string | null, allowed: string[] | undefined): Record<string, string> {
  if (!allowed || allowed.length === 0 || !origin) return {};
  const ok = allowed.includes('*') || allowed.includes(origin);
  if (!ok) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    vary: 'Origin',
  };
}

function json(data: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}

function errorBody(message: string, code: string, detail?: unknown): unknown {
  return { error: { message, type: code, code, ...(detail === undefined ? {} : { detail }) } };
}

/**
 * Constant-time-ish token comparison.
 *
 * Set membership leaks length through timing in principle. It is used anyway
 * because these are long random tokens behind a tailnet, and the honest note is
 * worth more than a false sense of a hand-rolled compare.
 */
function authorized(req: Request, tokens: Set<string>): boolean {
  if (tokens.size === 0) return false;
  const header = req.headers.get('authorization');
  if (!header) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return tokens.has(m[1] as string);
}

/**
 * `created` for the model list.
 *
 * The OpenAI Model object carries a creation timestamp, and the official SDKs
 * type it as required — omitting it makes a strictly-deserialising client fail
 * on a listing that is otherwise fine. Nothing here knows when a model was
 * created, and inventing a plausible date would be a fact nobody has.
 *
 * So this is the time this process loaded, stated as what it is: a stable
 * placeholder that satisfies the shape without claiming to be a creation date.
 * Stable matters — a value recomputed per request would churn in any client
 * that diffs the listing.
 */
const LISTING_CREATED = Math.floor(Date.now() / 1000);

export async function handleRequest(req: Request, opts: GatewayOptions): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get('origin');
  const ch = cors(origin, opts.allowedOrigins);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });

  const isHealth = url.pathname === '/healthz';
  if (!(isHealth && opts.publicHealth) && !authorized(req, opts.tokens)) {
    return json(errorBody('missing or invalid bearer token', 'unauthorized'), 401, ch);
  }

  if (isHealth) {
    return json(
      {
        ok: true,
        providers: opts.mesh.registry.providers.map((p) => p.id),
        candidates: opts.mesh.registry.candidates.length,
        warnings: opts.mesh.registry.warnings,
        health: opts.mesh.health.snapshot(),
        quota: await opts.mesh.ledger.snapshot(),
      },
      200,
      ch,
    );
  }

  // Screenshots for the setup guides, behind the same token as everything
  // else the page calls. They are images of somebody's own provider console
  // and can carry an account name in the corner, so they are not served to an
  // unauthenticated caller the way the static page is.
  if (url.pathname === '/setup/shots.json' && req.method === 'GET') {
    return json(opts.shots ? await opts.shots.list() : {}, 200, ch);
  }

  if (url.pathname.startsWith('/setup/shot/') && req.method === 'GET') {
    const name = url.pathname.slice('/setup/shot/'.length);
    const bytes = opts.shots ? await opts.shots.read(name) : null;
    if (!bytes) return json(errorBody('no such screenshot', 'not_found'), 404, ch);
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        'content-type': name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
        'cache-control': 'no-store',
        // Belt and braces: an image endpoint that can be talked into serving
        // HTML is an XSS hole on the same origin as the key form.
        'x-content-type-options': 'nosniff',
        ...ch,
      },
    });
  }

  if (url.pathname === '/v1/providers' && req.method === 'GET' && opts.keyStore) {
    const loaded = new Set(opts.mesh.registry.providers.map((p) => p.id));
    const providers = opts.keyStore.providerConfigs().map((p) => ({
      id: p.id,
      summary: p.summary,
      freeTierNote: p.freeTierNote,
      signupUrl: p.signupUrl,
      signupSteps: p.signupSteps,
      keyPrefix: p.keyPrefix,
      accountIdEnv: p.accountIdEnv,
      keyless: Boolean(p.apiKeyOptional),
      // Whether a key is present — never the key itself.
      configured: loaded.has(p.id) && !p.apiKeyOptional,
      models: p.models.length,
    }));
    return json(
      {
        providers,
        candidates: opts.mesh.registry.candidates.length,
        usable: opts.mesh.registry.providers.map((p) => p.id),
      },
      200,
      ch,
    );
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const profiles = Object.keys(opts.mesh.registry.profiles).map((name) => ({
      id: `mesh/${name}`,
      object: 'model',
      created: LISTING_CREATED,
      owned_by: 'inferencemesh',
      mesh: { kind: 'profile' },
    }));
    const models = opts.mesh.registry.candidates.map((c) => ({
      id: c.key,
      object: 'model',
      created: LISTING_CREATED,
      owned_by: c.provider.id,
      mesh: {
        kind: 'model',
        capabilities: c.model.capabilities,
        context_window: c.model.contextWindow,
        price_per_mtok_blended: blendedPrice(c.model),
        max_privacy: maxPrivacyOf(c),
      },
    }));
    return json({ object: 'list', data: [...profiles, ...models] }, 200, ch);
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body: ChatRequest;
    try {
      body = (await req.json()) as ChatRequest;
    } catch {
      return json(errorBody('request body is not valid JSON', 'invalid_request'), 400, ch);
    }
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return json(errorBody('`model` (string) and `messages` (array) are required', 'invalid_request'), 400, ch);
    }

    try {
      if (body.stream) {
        const { stream, trace } = await opts.mesh.stream(body, req.signal);
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            // Which provider answered, without waiting for the body to finish.
            'x-mesh-served-by': trace.served_by,
            'x-mesh-profile': trace.profile,
            ...ch,
          },
        });
      }
      const res = await opts.mesh.chat(body, req.signal);
      return json(res, 200, {
        'x-mesh-served-by': res.mesh?.served_by ?? '',
        'x-mesh-profile': res.mesh?.profile ?? '',
        ...ch,
      });
    } catch (err) {
      if (err instanceof NoCandidateError) {
        return json(errorBody(err.message, err.code, err.rejected), err.status, ch);
      }
      if (err instanceof MeshError) {
        return json(errorBody(err.message, err.code, err.detail), err.status, ch);
      }
      const message = err instanceof Error ? err.message : String(err);
      return json(errorBody(message, 'internal_error'), 500, ch);
    }
  }

  return json(errorBody(`no route for ${req.method} ${url.pathname}`, 'not_found'), 404, ch);
}
