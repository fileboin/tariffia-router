/**
 * Memory-only usage and cost accounting.
 *
 * Records ACTUAL provider usage from successful calls, per provider/model, for two
 * bounded scopes: process lifetime and the current UTC day. No per-request history is
 * kept — the state is O(providers × models) per scope — and the snapshot aggregates
 * global/provider/model totals on demand.
 *
 * Metadata only: provider/model ids, request counts, token counts and cost. It never
 * holds keys, prompts, completions, Authorization headers or provider bodies.
 *
 * Tariffia addition (2026-10-06). See THIRD_PARTY_NOTICES.md.
 */

export interface UsageSample {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  costUsd: number;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageModelAggregate extends UsageTotals {
  /** `${provider}/${model}`. */
  model: string;
}

export interface UsageProviderAggregate extends UsageTotals {
  provider: string;
  models: UsageModelAggregate[];
}

export interface UsageScope {
  totals: UsageTotals;
  providers: UsageProviderAggregate[];
}

export interface UsageSnapshot {
  /** Process start, ISO-8601. */
  since: string;
  /** Current UTC day, 'YYYY-MM-DD'. */
  day: string;
  lifetime: UsageScope;
  today: UsageScope;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function emptyRecord(): UsageRecord {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costUsd: 0 };
}

function zeroTotals(): UsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

function addSample(target: UsageRecord, sample: UsageSample, costUsd: number): void {
  target.inputTokens += sample.inputTokens;
  target.outputTokens += sample.outputTokens;
  target.totalTokens += sample.totalTokens;
  target.requests += 1;
  target.costUsd += costUsd;
}

function addRecord(target: UsageTotals, rec: UsageRecord): void {
  target.requests += rec.requests;
  target.inputTokens += rec.inputTokens;
  target.outputTokens += rec.outputTokens;
  target.totalTokens += rec.totalTokens;
  target.costUsd += rec.costUsd;
}

/** Deterministic, locale-independent string order. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class UsageMeter {
  private readonly lifetime = new Map<string, UsageRecord>();
  private today = new Map<string, UsageRecord>();
  private day: string;
  readonly since: string;

  constructor(private readonly now: () => number = () => Date.now()) {
    const t = this.now();
    this.since = new Date(t).toISOString();
    this.day = utcDay(t);
  }

  /**
   * Record one successful call that actually reported usage. Cost is whatever the
   * caller already computed (from costOf); it is never recalculated here.
   */
  record(provider: string, model: string, usage: UsageSample, costUsd: number): void {
    this.rolloverIfNeeded();
    const key = `${provider}/${model}`;
    addSample(this.getOrCreate(this.lifetime, key), usage, costUsd);
    addSample(this.getOrCreate(this.today, key), usage, costUsd);
  }

  snapshot(): UsageSnapshot {
    this.rolloverIfNeeded();
    return {
      since: this.since,
      day: this.day,
      lifetime: this.scope(this.lifetime),
      today: this.scope(this.today),
    };
  }

  private getOrCreate(map: Map<string, UsageRecord>, key: string): UsageRecord {
    let rec = map.get(key);
    if (!rec) {
      rec = emptyRecord();
      map.set(key, rec);
    }
    return rec;
  }

  /** Reset only the `today` map when the UTC day changes; lifetime is untouched. */
  private rolloverIfNeeded(): void {
    const day = utcDay(this.now());
    if (day !== this.day) {
      this.day = day;
      this.today = new Map();
    }
  }

  private scope(map: Map<string, UsageRecord>): UsageScope {
    const totals = zeroTotals();
    const byProvider = new Map<string, UsageProviderAggregate>();
    for (const key of [...map.keys()].sort(compare)) {
      const rec = map.get(key) as UsageRecord;
      // The candidate key is `${provider}/${model}`; provider ids never contain '/'.
      const slash = key.indexOf('/');
      const provider = slash === -1 ? key : key.slice(0, slash);
      let agg = byProvider.get(provider);
      if (!agg) {
        agg = { provider, ...zeroTotals(), models: [] };
        byProvider.set(provider, agg);
      }
      agg.models.push({ model: key, ...rec });
      addRecord(agg, rec);
      addRecord(totals, rec);
    }
    const providers = [...byProvider.values()].sort((a, b) => compare(a.provider, b.provider));
    return { totals, providers };
  }
}
