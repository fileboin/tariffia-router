/**
 * The mesh: route, attempt, fall back, book.
 *
 * This is the only object that sees the whole picture, and therefore the only
 * one allowed to retry. Adapters fail once and say why; the mesh decides
 * whether "why" is worth trying somebody else for.
 */

import { analyzeRequest, type AnalyzeOptions, type TaskRequirements } from './analyzer.js';
import { resolveClaudeRouting, type ClaudeFamilyPolicy } from './claude-family.js';
import { ConcurrencyLimiter, type Slot } from './concurrency.js';
import { HealthTracker } from './health.js';
import { QuotaLedger } from './ledger.js';
import { priceCapRejectionReason, Router } from './router.js';
import { UsageMeter } from './usage.js';
import { costOf, hasCapabilities, isFree, maxPrivacyOf, quotaPoolKey, servesPrivacy, type Registry } from './registry.js';
import { ProviderError, type Adapter, type FetchLike } from './providers/base.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { GeminiAdapter } from './providers/gemini.js';
import { OpenAICompatAdapter } from './providers/openai-compat.js';
import { redact, restore } from './redact.js';
import {
  MeshError,
  NoCandidateError,
  type Capability,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type PrivacyLevel,
  type MeshTrace,
  type Quota,
  type RouteDecision,
  type RouteRequest,
  type ScoredCandidate,
  type Usage,
} from './types.js';

/**
 * The profile a server-authoritative FREE_ONLY mesh forces every request
 * through. InferenceMesh's built-in `free` profile is `freeOnly`, so routing
 * to it rejects paid candidates before scoring. This name is a server constant,
 * never something a request can influence.
 */
const FREE_ONLY_PROFILE = 'free';

/**
 * Merge the analyzer's required capabilities into the request's own, without
 * duplicates. A candidate must satisfy every capability in the union; a
 * capability the request itself declared is kept, because that is a filter the
 * caller already asked for.
 */
function withRequiredCapabilities(req: RouteRequest, required: Capability[]): RouteRequest {
  if (required.length === 0) return req;
  const merged: Capability[] = [...(req.capabilities ?? [])];
  for (const cap of required) if (!merged.includes(cap)) merged.push(cap);
  return { ...req, capabilities: merged };
}

export interface MeshEvent {
  type: 'route' | 'attempt' | 'success' | 'failure' | 'exhausted';
  key?: string;
  profile?: string;
  status?: number;
  error?: string;
  ms?: number;
  costUsd?: number;
  usage?: Usage;
  /** Deterministic task analysis for this request. Present on the 'route' event. */
  analysis?: TaskRequirements;
}

/*
 * Execution-boundary guards (see InferenceMesh.guardReason). They repeat, at the
 * last moment before an adapter, the hard filters the routing layer already
 * applied, and fail closed: a candidate that cannot be proven eligible is
 * skipped, never executed. The guard returns a `code: reason` string, or null
 * when the candidate is eligible.
 */

export interface MeshOptions {
  registry: Registry;
  ledger?: QuotaLedger;
  health?: HealthTracker;
  limiter?: ConcurrencyLimiter;
  /**
   * Optional usage/cost meter. When absent, no usage is recorded and behavior is
   * unchanged. The meter is metadata-only (tokens, requests, cost per provider/model).
   */
  usage?: UsageMeter;
  fetchImpl?: FetchLike;
  adapters?: Record<string, Adapter>;
  /** Per-attempt timeout. The whole chain can take up to attempts × this. */
  timeoutMs?: number;
  /** Cap on how far down the ranked chain to walk. */
  maxAttempts?: number;
  /**
   * How long to queue behind a saturated provider, but only once every
   * candidate is saturated. Zero disables queueing: the request fails rather
   * than waits.
   */
  concurrencyWaitMs?: number;
  onEvent?: (e: MeshEvent) => void;
  /**
   * Server-owned maximum USD rate per 1M input AND output tokens. Missing or
   * invalid means only explicitly free 0/0 candidates are eligible. This is
   * not a per-request spending budget.
   */
  maxPricePerMTok?: number;
  /**
   * Server-authoritative FREE_ONLY mode. Set by the server from its own
   * configuration; never derived from a request. When true, no request — pin or
   * `mesh` routing extension included — can cause a non-free model to be
   * executed. Defaults to false, so non-FREE_ONLY behavior is unchanged.
   */
  enforceFreeOnly?: boolean;
  /**
   * Server-authoritative FREE_FIRST ordering. When true, the ranked chain is
   * split so every free candidate is tried before any paid candidate: free
   * candidates keep their relative score order, then paid candidates follow in
   * theirs. Paid is reached only when no free candidate can serve. Defaults to
   * false, so other modes are unchanged.
   *
   * Never derived from a request. FREE_ONLY takes precedence: with both set, a
   * paid candidate is still never executed.
   */
  freeFirst?: boolean;
  /**
   * Server-side opt-in to route providers marked `risk: 'avoid'`. Defaults to
   * false, so avoided providers are never candidates unless the operator
   * explicitly allows them. Set by the server from its own configuration; never
   * read from a request.
   */
  allowAvoidRiskProviders?: boolean;
  /**
   * Optional Claude-family routing policy.
   *
   * Claude Code sends normal Claude model ids (`claude-sonnet-*`, ...). This map
   * decides how such an id routes WITHOUT becoming a pin. A value is either:
   *   - a profile name to route through (e.g. 'balanced', 'free'), or
   *   - the sentinel 'auto' meaning "no profile, no pin — use the active
   *     profile/default" (the safe default for every family), or
   *   - a `provider/model` pin to route to a specific backend.
   *
   * The requested Claude id is preserved for the client-visible response; only
   * the internal routing target changes. Server-owned; never read from a request.
   * When omitted, every family is 'auto' (behaviour is unchanged for non-Claude
   * ids and Claude ids alike, except that a Claude id no longer pins to nothing).
   */
  claudeFamilyPolicy?: ClaudeFamilyPolicy;
}

/**
 * Cheap token estimate for quota admission only.
 *
 * Four characters per token is an English rule. Japanese and Chinese run closer
 * to one token per character, so counting every character the same way
 * under-estimated a Japanese prompt roughly fourfold — and the error runs in
 * the dangerous direction: a daily token cap admits four times what it should
 * and the over-spend shows up as the provider cutting you off, which is the one
 * thing this ledger exists to avoid. (The comment here used to claim the
 * opposite, that being off cost an early cutoff. For English it would have.)
 *
 * So ASCII is counted at 4 characters per token and everything else at 1. That
 * over-estimates Cyrillic and Greek by roughly 2x, which is the harmless
 * direction: it reserves a little too much of a daily allowance rather than
 * spending one that is already gone. Real usage is booked from the provider's
 * own count once the call returns, so this only ever gates admission.
 */
export function estimateTokens(req: ChatRequest): number {
  let tokens = 0;
  const count = (text: string) => {
    let ascii = 0;
    for (const ch of text) {
      if ((ch.codePointAt(0) ?? 0) < 128) ascii++;
      else tokens += 1;
    }
    tokens += Math.ceil(ascii / 4);
  };
  for (const m of req.messages) {
    if (typeof m.content === 'string') count(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === 'text') count(p.text);
    }
  }
  return tokens + (req.max_tokens ?? 512);
}

/**
 * Split an addressed model into a routing request.
 *
 *   'mesh/free'                   -> profile 'free'
 *   'groq/llama-3.3-70b'          -> pinned candidate
 *   'openrouter/deepseek/chat-v4' -> pinned candidate (model ids may contain /)
 */
export function parseModel(model: string): RouteRequest {  const slash = model.indexOf('/');
  if (slash === -1) return { pin: model };
  const head = model.slice(0, slash);
  if (head === 'mesh') return { mesh: model.slice(slash + 1) };
  return { pin: model };
}

/**
 * Alias the masked terms out of every message before anything is attempted.
 *
 * One table for the whole request, so the same term becomes the same alias
 * in the system prompt and in every user turn — a model that cannot tell two
 * mentions apart cannot follow the question. The table is built here, in the
 * mesh, and handed to no provider: adapters receive the redacted request and
 * `stripMeshFields` drops the `mesh` extension (with the term list) before
 * the body is serialised. Fallback reuses the same redacted request, so a
 * retry never re-sends the original.
 *
 * A prompt that already contains an alias token is the caller's mistake, and
 * `redact` throws for it. That throw is re-raised as a 400 here: it is a bad
 * request, not an internal failure, and the gateway maps it accordingly.
 */
function maskRequest(req: ChatRequest): { req: ChatRequest; entities: string[] } {
  const terms = req.mesh?.mask ?? [];
  if (terms.length === 0) return { req, entities: [] };
  try {
    // One table for the whole request, built from the messages joined: the
    // same term becomes the same alias in the system prompt and in every
    // user turn. Matching is deterministic longest-first, so redacting each
    // message separately against that table replays the same aliases.
    const texts: string[] = [];
    for (const m of req.messages) {
      if (typeof m.content === 'string') texts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === 'text') texts.push(p.text);
      }
    }
    const { entities } = redact(texts.join('\n'), terms);
    if (entities.length === 0) return { req, entities };
    const maskText = (text: string): string => redact(text, entities).redacted;
    const messages: ChatMessage[] = req.messages.map((m) => {
      if (typeof m.content === 'string') return { ...m, content: maskText(m.content) };
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((p) => (p.type === 'text' ? { ...p, text: maskText(p.text) } : p)),
        };
      }
      return m;
    });
    return { req: { ...req, messages }, entities };
  } catch (err) {
    throw new MeshError(err instanceof Error ? err.message : String(err), 400, 'invalid_request');
  }
}

/** Put the aliases in a finished reply back the way the caller wrote them. */
function restoreResponse(res: ChatResponse, entities: string[]): ChatResponse {
  return {
    ...res,
    choices: res.choices.map((c) => {
      const content = c.message.content;
      if (typeof content === 'string') {
        return { ...c, message: { ...c.message, content: restore(content, entities) } };
      }
      if (Array.isArray(content)) {
        return {
          ...c,
          message: {
            ...c.message,
            content: content.map((p) => (p.type === 'text' ? { ...p, text: restore(p.text, entities) } : p)),
          },
        };
      }
      return c;
    }),
  };
}

interface AttemptSignal {
  signal: AbortSignal;
  /**
   * Stop the timeout while leaving caller-abort wired up.
   *
   * A streaming response must call this the moment headers arrive: the timeout
   * bounds how long a provider may take to *start* answering, and leaving it
   * armed would cut a legitimately long completion off mid-sentence.
   */
  clearTimer: () => void;
  /** Release everything. Safe to call twice. */
  detach: () => void;
}

function combineSignals(timeoutMs: number, caller?: AbortSignal): AttemptSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`attempt timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ctrl.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) ctrl.abort(caller.reason);
    else caller.addEventListener('abort', onAbort, { once: true });
  }
  const clearTimer = () => clearTimeout(timer);
  return {
    signal: ctrl.signal,
    clearTimer,
    detach: () => {
      clearTimer();
      caller?.removeEventListener('abort', onAbort);
    },
  };
}

export interface StreamResult {
  stream: ReadableStream<Uint8Array>;
  /** Known as soon as a provider accepts the request; cost fills in at the end. */
  trace: MeshTrace;
}

/** Everything one attempt needs, threaded through the chain unchanged. */
interface AttemptContext {
  req: ChatRequest;
  signal: AbortSignal | undefined;
  streaming: boolean;
  decision: RouteDecision;
  /** Hard filters repeated at the execution boundary, from the routing request. */
  requiredCapabilities: Capability[];
  privacy: PrivacyLevel;
  estimated: number;
  attempts: MeshTrace['attempts'];
  started: number;
  /**
   * True once any candidate has actually been handed to a provider.
   *
   * Distinguishes "everything was busy" from "something was tried and failed",
   * which is the difference between queueing being the only way forward and
   * queueing being added latency on a request that already had its shot.
   */
  reached: boolean;
}

export class InferenceMesh {
  private _registry: Registry;
  /** Process-local tunnel readiness. Ollama fails closed until explicitly enabled. */
  private ollamaAvailable = false;
  readonly ledger: QuotaLedger;
  readonly health: HealthTracker;
  readonly limits: ConcurrencyLimiter;
  private readonly usage: UsageMeter | undefined;
  private _router: Router;
  private readonly adapters: Record<string, Adapter>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly concurrencyWaitMs: number;
  private readonly maxPricePerMTok: number | undefined;
  private readonly onEvent: (e: MeshEvent) => void;
  private readonly enforceFreeOnly: boolean;
  private readonly freeFirst: boolean;
  private readonly allowAvoidRiskProviders: boolean;
  private readonly claudeFamilyPolicy: ClaudeFamilyPolicy;
  /**
   * Synchronous snapshot of remaining quota headroom (0..1) per ledger key,
   * refreshed after each adm admission/record from the ledger's utilization.
   * Kept synchronous so the Router's scoring stays pure; absent entries mean
   * "unknown" (headroom 1, no effect).
   */
  private readonly headroom = new Map<string, number>();

  constructor(opts: MeshOptions) {
    // Apply the risk filter first, at construction, so an `avoid` provider is
    // never a candidate for any request. The opt-in is server-owned.
    this._registry = opts.registry.withoutAvoidRisk(opts.allowAvoidRiskProviders ?? false);
    this.ledger = opts.ledger ?? new QuotaLedger();
    this.health = opts.health ?? new HealthTracker();
    this.limits = opts.limiter ?? new ConcurrencyLimiter();
    this.usage = opts.usage;
    this.maxPricePerMTok = opts.maxPricePerMTok;
    this._router = new Router(this._registry, {
      health: this.health,
      headroom: (key) => this.headroom.get(key),
      maxPricePerMTok: this.maxPricePerMTok,
    });
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.concurrencyWaitMs = opts.concurrencyWaitMs ?? 30_000;
    this.onEvent = opts.onEvent ?? (() => {});
    this.enforceFreeOnly = opts.enforceFreeOnly ?? false;
    this.freeFirst = opts.freeFirst ?? false;
    this.allowAvoidRiskProviders = opts.allowAvoidRiskProviders ?? false;
    this.claudeFamilyPolicy = opts.claudeFamilyPolicy ?? {};
    this.adapters = opts.adapters ?? {
      'openai-compat': new OpenAICompatAdapter(),
      'workers-ai': new OpenAICompatAdapter(),
      anthropic: new AnthropicAdapter(),
      gemini: new GeminiAdapter(),
    };
  }

  get registry(): Registry {
    return this._registry;
  }

  private get router(): Router {
    return this._router;
  }

  /**
   * Expose the deterministic task analysis to callers of the routing pipeline.
   * Pure and side-effect free; it does not influence model selection.
   */
  analyze(req: ChatRequest, opts: AnalyzeOptions = {}): TaskRequirements {
    return analyzeRequest(req, opts);
  }

  /**
   * Swap in a freshly loaded registry without restarting.
   *
   * Needed because keys arrive *after* the process starts — someone adds one
   * through the setup UI and expects it to work now, not after they figure out
   * how to restart a container. Health and quota carry over deliberately: a
   * provider that was rate limited a second ago is still rate limited, and
   * forgetting that on every key addition would walk straight into a 429.
   */
  reload(registry: Registry): void {
    // Re-apply the risk filter so a reloaded registry cannot reintroduce an
    // `avoid` provider that construction-time filtering removed.
    const filtered = registry.withoutAvoidRisk(this.allowAvoidRiskProviders);
    this._registry = filtered;
    this._router = new Router(filtered, {
      health: this.health,
      headroom: (key) => this.headroom.get(key),
      maxPricePerMTok: this.maxPricePerMTok,
    });
  }

  /** Set the process-local availability of the Ollama provider (not persisted). */
  setOllamaAvailable(available: boolean): void {
    this.ollamaAvailable = available;
  }

  private routeFor(req: ChatRequest): RouteRequest {
    // Claude-family routing, applied BEFORE parseModel would pin a normal Claude
    // id to a non-existent `provider/model`. This only changes the internal
    // routing target; `req.model` (the client-visible id) is left untouched so the
    // Anthropic response keeps the requested Claude identity.
    const claude = resolveClaudeRouting(req.model, this.claudeFamilyPolicy);
    const routingModel = claude
      ? claude.pin
        ? claude.pin
        : claude.mesh
          ? `mesh/${claude.mesh}`
          : req.model // auto: no profile, no pin -> parse as the model/index
      : req.model;

    const parsed = parseModel(routingModel);
    const merged: RouteRequest = {
      ...parsed,
      ...(req.mesh ?? {}),
      ...(parsed.mesh ? { mesh: parsed.mesh } : {}),
    };
    // An auto Claude id has no slash and no mesh; parseModel would turn it into a
    // pin. Clear that pin so the active profile/scorer decides.
    if (claude && !claude.pin && !claude.mesh) delete merged.pin;
    // The requested output budget is a scoring signal; take it from the request
    // itself so a client-supplied value in `mesh` cannot influence scoring.
    if (typeof req.max_tokens === 'number') merged.maxOutputTokens = req.max_tokens;
    else delete merged.maxOutputTokens;
    if (this.enforceFreeOnly) return this.enforceFreeOnlyRoute(merged);
    if (this.freeFirst) return this.enforceFreeFirstRoute(merged);
    return merged;
  }

  /**
   * FREE_FIRST pin sanitisation.
   *
   * A client pin must not turn FREE_FIRST into a paid-first route. A pin to a
   * *paid* model is dropped so the ordered free-first chain serves; a pin to a
   * free model is kept (it is already free-first). An unknown pin is left as-is;
   * the router will report it as no candidate. This does not enforce free-only:
   * paid candidates remain eligible as a later fallback.
   */
  private enforceFreeFirstRoute(req: RouteRequest): RouteRequest {
    if (req.pin) {
      const candidate = this.registry.find(req.pin);
      if (candidate && !isFree(candidate.model)) {
        const next: RouteRequest = { ...req };
        delete next.pin;
        return next;
      }
    }
    return req;
  }

  /**
   * Server-authoritative FREE_ONLY enforcement for one request.
   *
   * The mode belongs to this mesh instance and is set by the server from its
   * own configuration, so a request cannot opt out of it. A client cannot
   * reach a paid model by pinning one or by sending routing overrides in
   * `body.mesh`:
   *
   *   - a pin that names a paid or unknown model is dropped, so the request is
   *     routed to an eligible free candidate instead of being rejected or
   *     executed against the pinned one; and
   *   - the profile is forced to the free-only profile, so a client-supplied
   *     profile (for example `mesh/best`) cannot select a paid candidate.
   *
   * A pin that names a *free* model is kept: it is still subject to the
   * router's privacy/capability/context filters and cannot select anything
   * ineligible.
   */
  private enforceFreeOnlyRoute(req: RouteRequest): RouteRequest {
    const next: RouteRequest = { ...req, mesh: FREE_ONLY_PROFILE };
    if (next.pin) {
      const candidate = this.registry.find(next.pin);
      if (!candidate || !isFree(candidate.model)) delete next.pin;
    }
    return next;
  }

  /**
   * Last line before execution: drop any non-free candidate from the ranked
   * chain even if some other path produced it. Keeps the fallback walk from
   * ever handing a paid candidate to an adapter while FREE_ONLY is active.
   */
  private enforceFreeOnlyDecision(decision: RouteDecision): RouteDecision {
    const rejected = [...decision.rejected];
    const ranked: ScoredCandidate[] = [];
    for (const scored of decision.ranked) {
      if (isFree(scored.candidate.model)) ranked.push(scored);
      else rejected.push({ key: scored.candidate.key, reason: 'free_only: candidate is not free' });
    }
    return { ranked, rejected, profile: decision.profile };
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const masked = maskRequest(req);
    const res = (await this.run(masked.req, signal, false)) as ChatResponse;
    return masked.entities.length ? restoreResponse(res, masked.entities) : res;
  }

  async stream(req: ChatRequest, signal?: AbortSignal): Promise<StreamResult> {
    if ((req.mesh?.mask?.length ?? 0) > 0) {
      // Restoring aliases split across SSE chunks needs a buffering replacer
      // that does not exist yet. Sending masked and returning aliases would
      // corrupt the caller's text silently; refusing loudly instead.
      throw new MeshError(
        'mask with stream is not supported yet: call without stream, or without mask',
        400,
        'invalid_request',
      );
    }
    return this.run(req, signal, true) as Promise<StreamResult>;
  }

  /**
   * FREE_FIRST ordering: stable-partition the ranked chain so free candidates
   * are attempted before any paid candidate. Free candidates first (in score
   * order), then paid (in score order). Where FREE_ONLY is also on, the chain is
   * free-only and this leaves it unchanged.
   */
  private freeFirstDecision(decision: RouteDecision): RouteDecision {
    const free: ScoredCandidate[] = [];
    const paid: ScoredCandidate[] = [];
    for (const scored of decision.ranked) {
      (isFree(scored.candidate.model) ? free : paid).push(scored);
    }
    return { ranked: [...free, ...paid], rejected: decision.rejected, profile: decision.profile };
  }

  /** Exclude only Ollama while its Android-to-VPS SSH tunnel is unavailable. */
  private enforceOllamaAvailability(decision: RouteDecision): RouteDecision {
    if (this.ollamaAvailable) return decision;

    const rejected = [...decision.rejected];
    const ranked = decision.ranked.filter((scored) => {
      if (scored.candidate.provider.id !== 'ollama') return true;
      rejected.push({ key: scored.candidate.key, reason: 'runtime: Ollama tunnel unavailable' });
      return false;
    });
    return { ...decision, ranked, rejected };
  }

  private async run(
    req: ChatRequest,
    signal: AbortSignal | undefined,
    streaming: boolean,
  ): Promise<ChatResponse | StreamResult> {
    const routeReq = this.routeFor(req);
    const analysis = analyzeRequest(req);
    // Capability-aware filtering runs before scoring: a candidate that cannot
    // satisfy a capability the request needs is not a worse choice, it is not a
    // choice. This never downgrades a requirement — the union is a hard filter.
    const capabilityReq = withRequiredCapabilities(routeReq, analysis.requiredCapabilities);
    let decision = this.router.route(capabilityReq);
    decision = this.enforceOllamaAvailability(decision);
    if (this.enforceFreeOnly) decision = this.enforceFreeOnlyDecision(decision);
    // FREE_FIRST ordering, applied after the FREE_ONLY filter (which, under
    // FREE_ONLY, leaves only free candidates, so this is a no-op there). The
    // chain is stable-partitioned by free status; free candidates keep their
    // relative score order, then paid candidates in theirs.
    if (this.freeFirst) decision = this.freeFirstDecision(decision);
    this.onEvent({ type: 'route', profile: decision.profile.name, analysis });

    if (decision.ranked.length === 0) {
      const required = analysis.requiredCapabilities;
      const capNote = required.length > 1 ? ` Required capabilities: ${required.join(', ')}.` : '';
      throw new NoCandidateError(
        `no provider satisfies this request (profile '${decision.profile.name}').${capNote} ` +
          `${this.registry.candidates.length} candidates in registry, all rejected.`,
        decision.rejected,
      );
    }

    const ctx: AttemptContext = {
      req,
      signal,
      streaming,
      decision,
      requiredCapabilities: capabilityReq.capabilities ?? [],
      privacy: routeReq.privacy ?? 'public',
      estimated: routeReq.estimatedTokens ?? estimateTokens(req),
      attempts: [],
      started: Date.now(),
      reached: false,
    };
    const saturated: ScoredCandidate[] = [];
    // One shot per candidate per request. The ranked chain is already unique by
    // construction, but this keeps "never retry the same candidate" true even
    // if a future ranking change ever repeats one.
    const tried = new Set<string>();

    for (const scored of decision.ranked.slice(0, this.maxAttempts)) {
      if (tried.has(scored.candidate.key)) {
        const reason = 'already attempted this request';
        ctx.attempts.push({ key: scored.candidate.key, error: reason, ms: 0 });
        this.onEvent({ type: 'attempt', key: scored.candidate.key, error: reason });
        continue;
      }
      tried.add(scored.candidate.key);

      const { provider, key } = scored.candidate;
      // A busy provider is a reason to try somebody else, not a reason to wait.
      // Queueing here would spend the fallback chain's whole point on patience.
      const slot = this.limits.tryAcquire(provider.id, provider.maxConcurrent);
      if (!slot) {
        saturated.push(scored);
        const reason = `concurrency: ${this.limits.inFlight(provider.id)}/${provider.maxConcurrent} in flight`;
        ctx.attempts.push({ key, error: reason, ms: 0 });
        this.onEvent({ type: 'attempt', key, error: reason });
        continue;
      }
      const answer = await this.attemptOne(scored, slot, ctx);
      if (answer) return answer;
    }

    // Nothing in the chain was ever handed to a provider, and concurrency is
    // why. There is no faster answer to fall over to, so queue for the
    // best-ranked busy one instead of returning a 503 that a moment's patience
    // would have avoided. This is the single-provider case the semaphore is
    // for; with two providers the loop above has already taken the free one.
    const head = saturated[0];
    if (head && !ctx.reached && this.concurrencyWaitMs > 0) {
      const { provider, key } = head.candidate;
      try {
        const slot = await this.limits.acquire(provider.id, provider.maxConcurrent, {
          timeoutMs: this.concurrencyWaitMs,
          ...(signal ? { signal } : {}),
        });
        const answer = await this.attemptOne(head, slot, ctx);
        if (answer) return answer;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.attempts.push({ key, error: `concurrency: ${message}`, ms: 0 });
        this.onEvent({ type: 'failure', key, error: message });
      }
    }

    await this.ledger.flush();
    this.onEvent({ type: 'exhausted', profile: decision.profile.name });
    throw new MeshError(
      `all ${ctx.attempts.length} attempt(s) failed: ` +
        ctx.attempts.map((a) => `${a.key} (${a.status ?? '-'}: ${a.error})`).join('; '),
      503,
      'all_providers_failed',
      { attempts: ctx.attempts, rejected: decision.rejected },
    );
  }

  /**
   * The execution-boundary guard.
   *
   * Routing already applied the capability, privacy and FREE_ONLY hard filters,
   * so on a correct chain this returns null for every candidate. It exists so
   * those guarantees do not depend on the routing layer staying correct: even if
   * a future ranking or filter change accidentally returns a candidate that
   * violates one of them, it is skipped here rather than handed to an adapter.
   *
   * Returns a `code: reason` string when the candidate must not be executed, or
   * null when it is eligible. There is no other kind of answer: unknown kinds
   * and unprovable eligibility both fail closed.
   */
  /**
   * Refresh the synchronous headroom snapshot for a ledger key from its quota.
   * Headroom = 1 - max(minute, day) utilization. Unknown quota leaves it at 1.
   * Best-effort and non-blocking; scoring reads only the map.
   */
  private async refreshHeadroom(key: string, quota: Quota | undefined): Promise<void> {
    if (!quota) {
      this.headroom.set(key, 1);
      return;
    }
    try {
      const u = await this.ledger.utilization(key, quota);
      const maxUse = Math.max(u.minute ?? 0, u.day ?? 0);
      this.headroom.set(key, maxUse >= 1 ? 0 : 1 - maxUse);
    } catch {
      // A snapshot failure must never affect routing; leave the last value.
    }
  }

  private guardReason(scored: ScoredCandidate, ctx: AttemptContext): string | null {
    const { candidate } = scored;

    // Repeat the server-owned rate cap at the execution boundary so a pin or a
    // future routing-path change cannot hand an over-cap model to an adapter.
    const priceRejection = priceCapRejectionReason(candidate.model, this.maxPricePerMTok);
    if (priceRejection) return priceRejection;

    // FREE_ONLY: a non-free model must never reach an adapter. Checked first
    // because it is the hard safety guarantee.
    if (this.enforceFreeOnly && !isFree(candidate.model)) {
      return 'free_only: candidate is not free';
    }

    // Privacy: the model must serve at least the request's sensitivity.
    if (!servesPrivacy(candidate, ctx.privacy)) {
      return `privacy: needs ${ctx.privacy}, serves up to ${maxPrivacyOf(candidate)}`;
    }

    // Capability: every required capability must be present.
    if (!hasCapabilities(candidate.model, ctx.requiredCapabilities)) {
      const missing = ctx.requiredCapabilities.filter((c) => !candidate.model.capabilities.includes(c));
      return `capability: missing ${missing.join(',')}`;
    }

    // Adapter: an unknown provider kind cannot be executed.
    if (!this.adapters[candidate.provider.kind]) {
      return `unknown_adapter: no adapter for kind '${candidate.provider.kind}'`;
    }

    return null;
  }

  /**
   * One candidate, one slot, one shot.
   *
   * Returns the answer, or undefined to mean "keep walking the chain". Throws
   * only for a failure that would repeat identically everywhere.
   *
   * `slot` is owned by this method: it is released on every exit except the
   * streaming one, where the stream is still occupying the provider and the
   * release rides along to the last byte.
   */
  private async attemptOne(
    scored: ScoredCandidate,
    slot: Slot,
    ctx: AttemptContext,
  ): Promise<ChatResponse | StreamResult | undefined> {
    const { candidate } = scored;
    const key = candidate.key;
    const { attempts } = ctx;
    let handedOff = false;

    // Execution-boundary guards. See guardReason() — they repeat the hard
    // filters and always fail closed.
    const guard = this.guardReason(scored, ctx);
    if (guard) {
      attempts.push({ key, error: guard, ms: 0 });
      this.onEvent({ type: 'attempt', key, error: guard });
      return undefined;
    }

    // Two layers of window budget, reserved outermost first: the credential's
    // own, then this model's. Everything reserved is tracked so a rejection at
    // the inner layer gives the outer one back — a provider budget that is
    // spent by a request the model layer refused would drift down all day
    // without a single error to show for it.
    const reserved: string[] = [];
    const giveBack = async (): Promise<void> => {
      while (reserved.length > 0) await this.ledger.refund(reserved.pop() as string);
    };

    try {
      const providerQuota = candidate.provider.quota;
      // The account-wide layer is keyed by the shared quota pool, so models
      // behind one credential/account draw on the same budget.
      const poolKey = quotaPoolKey(candidate.provider);
      if (providerQuota) {
        const admittedProvider = await this.ledger.admit(
          poolKey,
          providerQuota,
          ctx.estimated,
        );
        if (!admittedProvider.ok) {
          const reason = `account ${admittedProvider.reason}`;
          attempts.push({ key, error: `quota: ${reason}`, ms: 0 });
          this.onEvent({ type: 'attempt', key, error: reason });
          return undefined;
        }
        reserved.push(poolKey);
        void this.refreshHeadroom(poolKey, providerQuota);
      }

      const admitted = await this.ledger.admit(key, candidate.model.quota, ctx.estimated);
      if (!admitted.ok) {
        await giveBack();
        attempts.push({ key, error: `quota: ${admitted.reason}`, ms: 0 });
        this.onEvent({ type: 'attempt', key, error: admitted.reason ?? 'quota' });
        return undefined;
      }
      reserved.push(key);
      void this.refreshHeadroom(key, candidate.model.quota);

      if (!this.adapters[candidate.provider.kind]) {
        // Already reported by the guard; kept as a backstop only.
        await giveBack();
        const reason = `unknown_adapter: no adapter for kind '${candidate.provider.kind}'`;
        attempts.push({ key, error: reason, ms: 0 });
        this.onEvent({ type: 'attempt', key, error: reason });
        return undefined;
      }
      const adapter = this.adapters[candidate.provider.kind] as Adapter;

      const attempt = combineSignals(this.timeoutMs, ctx.signal);
      const t0 = Date.now();
      ctx.reached = true;
      this.onEvent({ type: 'attempt', key, profile: ctx.decision.profile.name });

      try {
        const adapterCtx = {
          candidate,
          apiKey: this.registry.apiKey(candidate.provider.id),
          ...(this.registry.accountId(candidate.provider.id)
            ? { accountId: this.registry.accountId(candidate.provider.id) as string }
            : {}),
          request: ctx.req,
          signal: attempt.signal,
          fetchImpl: this.fetchImpl,
        };

        if (ctx.streaming) {
          const raw = await adapter.stream(adapterCtx);
          const ms = Date.now() - t0;
          // Headers are in. From here the timeout must not apply.
          attempt.clearTimer();
          this.health.success(key, ms);
          const trace: MeshTrace = {
            served_by: key,
            profile: ctx.decision.profile.name,
            attempts,
            latency_ms: ms,
            cost_usd: 0,
          };
          this.onEvent({ type: 'success', key, ms });
          handedOff = true;
          // Full teardown is deferred to stream end so the caller can still
          // abort a completion that is already flowing.
          return {
            stream: this.meter(raw, candidate, trace, () => {
              attempt.detach();
              slot.release();
            }),
            trace,
          };
        }

        const res = await adapter.chat(adapterCtx);
        const ms = Date.now() - t0;
        attempt.detach();
        this.health.success(key, ms);
        const usage = res.usage;
        const cost = usage
          ? costOf(candidate.model, usage.prompt_tokens, usage.completion_tokens)
          : 0;
        if (usage) {
          await this.ledger.record(key, usage.total_tokens);
          // The account's daily token cap counts the same tokens the model's
          // does; booking only one of them lets a tokensPerDay on the provider
          // sit at zero forever.
          if (candidate.provider.quota) {
            await this.ledger.record(poolKey, usage.total_tokens);
          }
          // Usage/cost accounting (metadata only); cost is the one already computed.
          this.usage?.record(
            candidate.provider.id,
            candidate.model.id,
            {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            },
            cost,
          );
        }
        await this.ledger.flush();
        this.onEvent({ type: 'success', key, ms, costUsd: cost, ...(usage ? { usage } : {}) });
        return {
          ...res,
          mesh: {
            served_by: key,
            profile: ctx.decision.profile.name,
            attempts,
            latency_ms: Date.now() - ctx.started,
            cost_usd: cost,
          },
        };
      } catch (err) {
        attempt.detach();
        const ms = Date.now() - t0;
        await giveBack();
        const pe = err instanceof ProviderError ? err : undefined;
        this.health.failure(key, pe?.retryAfterMs);
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({ key, ...(pe ? { status: pe.status } : {}), error: message, ms });
        this.onEvent({ type: 'failure', key, ...(pe ? { status: pe.status } : {}), error: message, ms });

        // A malformed request fails identically everywhere. Walking the chain
        // would turn one clear 400 into four confusing ones.
        if (pe && !pe.failoverable) {
          await this.ledger.flush();
          throw new MeshError(message, pe.status, 'provider_error', { attempts });
        }
        return undefined;
      }
    } finally {
      if (!handedOff) slot.release();
    }
  }

  /**
   * Wrap a provider stream so usage lands in the ledger.
   *
   * Fallback is impossible past this point: bytes are already on their way to
   * the client. An error here ends the stream, it does not retry.
   */
  private meter(
    stream: ReadableStream<Uint8Array>,
    candidate: {
      key: string;
      model: { id: string; price: { inPerMTok: number; outPerMTok: number } };
      provider: { id: string; quota?: Quota; quotaPool?: string };
    },
    trace: MeshTrace,
    done: () => void,
  ): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const ledger = this.ledger;
    const poolKey = quotaPoolKey(candidate.provider as { id: string; quotaPool?: string } as never);
    const onEvent = this.onEvent;
    const usageMeter = this.usage;
    const model = candidate.model as unknown as Parameters<typeof costOf>[0];
    let tail = '';
    let usage: Usage | undefined;

    const meter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        // Only the last few KB can hold the usage chunk; keep the window small
        // so a long completion does not accumulate in memory.
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-8192);
      },
      async flush() {
        for (const line of tail.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as { usage?: Usage };
            if (parsed.usage) usage = parsed.usage;
          } catch {
            /* partial JSON in the tail window; the next line may still parse */
          }
        }
        if (usage) {
          trace.cost_usd = costOf(model, usage.prompt_tokens, usage.completion_tokens);
          await ledger.record(candidate.key, usage.total_tokens);
          // Same two layers as the non-streaming path; a stream's tokens count
          // against the account's daily cap too.
          if (candidate.provider.quota) {
            await ledger.record(poolKey, usage.total_tokens);
          }
          // Usage/cost accounting (metadata only), only when the provider reported usage.
          usageMeter?.record(
            candidate.provider.id,
            candidate.model.id,
            {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            },
            trace.cost_usd,
          );
        }
        await ledger.flush();
        onEvent({
          type: 'success',
          key: candidate.key,
          costUsd: trace.cost_usd,
          ...(usage ? { usage } : {}),
        });
      },
    });

    /**
     * Piped by hand rather than with `pipeThrough`, so teardown has one home.
     *
     * `flush` runs only when the stream ends normally. A client that hangs up
     * mid-answer cancels the readable, which errors the writable and rejects
     * this pipe — and if teardown lived in `flush` the provider's concurrency
     * slot would then be held for the life of the process, which is the exact
     * leak the limiter exists to prevent. A transformer `cancel` would read
     * better but is not in every runtime this ships to; a settled `pipeTo` is.
     */
    stream
      .pipeTo(meter.writable)
      .catch(() => {
        /* the consumer walked away, or the provider cut the stream */
      })
      .finally(done);
    return meter.readable;
  }
}
