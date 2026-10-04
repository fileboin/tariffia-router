/**
 * Free-provider seed importer (pure).
 *
 * Parses the CC0 `awesome-free-llm-apis` `data.json` into a small, validated
 * candidate structure. It is READ-ONLY candidate data: nothing here is activated,
 * nothing enters the active registry, and nothing touches routing or FREE_ONLY.
 *
 * It validates the shape and fails clearly, but it does not promote any field to
 * truth: a "permanent free tier" description stays a description, and no model
 * becomes free by virtue of appearing in this file. Free status is only ever the
 * active registry's explicit `price` of 0/0.
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md and seed/README.md.
 */

/** One model row from the seed list. Facts as published; not verified. */
export interface SeedModel {
  id: string;
  name: string;
  context: string;
  maxOutput: string;
  modality: string;
  rateLimit: string;
}

/**
 * A non-model summary row, e.g. `{ id: null, name: "+ 72 more models" }`. The
 * upstream list uses these to say a provider has more models than it lists. They
 * carry no id, so they are kept separately and never treated as a model.
 */
export interface SeedNote {
  name: string;
  context: string;
  maxOutput: string;
  modality: string;
  rateLimit: string;
}

/** One provider entry from the seed list. */
export interface SeedProvider {
  name: string;
  /** 'provider_api' (direct) or 'inference_provider' (aggregator/host). */
  category: string;
  country: string;
  flag: string;
  /** The provider's API-key / signup page. */
  url: string;
  /** Base URL of the API, when the list states one. */
  baseUrl?: string;
  /** Free-text description (often states the free tier and limits). */
  description: string;
  models: SeedModel[];
  /** Rows that describe "more models" and carry no id. Kept, never as a model. */
  notes: SeedNote[];
}

export interface SeedData {
  /** The upstream file's own timestamp, e.g. '2026-08-21'. */
  lastUpdated: string;
  providers: SeedProvider[];
}

/** Raised when the seed file is malformed. */
export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new SeedError(`seed: ${where} must be an object`);
  }
  return v as Record<string, unknown>;
}

function asString(v: unknown, where: string, required = true): string {
  if (typeof v === 'string') return v;
  if (!required && (v === undefined || v === null)) return '';
  throw new SeedError(`seed: ${where} must be a string`);
}

function stringsOf(m: Record<string, unknown>, where: string): Omit<SeedModel, 'id'> {
  return {
    name: asString(m['name'], `${where}.name`, false),
    context: asString(m['context'], `${where}.context`, false),
    maxOutput: asString(m['maxOutput'], `${where}.maxOutput`, false),
    modality: asString(m['modality'], `${where}.modality`, false),
    rateLimit: asString(m['rateLimit'], `${where}.rateLimit`, false),
  };
}

function parseModelRow(
  raw: unknown,
  providerName: string,
  i: number,
): { model?: SeedModel; note?: SeedNote } {
  const m = asObject(raw, `${providerName} model[${i}]`);
  const id = m['id'];
  // The list uses `id: null` for a "more models" summary row. It is not a model.
  if (id === null || id === undefined) {
    return { note: stringsOf(m, `${providerName} model[${i}]`) };
  }
  const idStr = asString(id, `${providerName} model[${i}].id`);
  if (idStr.length === 0) throw new SeedError(`seed: ${providerName} model[${i}].id is empty`);
  return { model: { id: idStr, ...stringsOf(m, `${providerName} model[${i}]`) } };
}

function parseProvider(raw: unknown, i: number): SeedProvider {
  const p = asObject(raw, `provider[${i}]`);
  const name = asString(p['name'], `provider[${i}].name`);
  if (name.length === 0) throw new SeedError(`seed: provider[${i}].name is empty`);
  const modelsRaw = p['models'];
  if (!Array.isArray(modelsRaw)) throw new SeedError(`seed: ${name}.models must be an array`);
  const baseUrl = p['baseUrl'];
  const models: SeedModel[] = [];
  const notes: SeedNote[] = [];
  modelsRaw.forEach((m, j) => {
    const parsed = parseModelRow(m, name, j);
    if (parsed.model) models.push(parsed.model);
    if (parsed.note) notes.push(parsed.note);
  });
  return {
    name,
    category: asString(p['category'], `${name}.category`, false),
    country: asString(p['country'], `${name}.country`, false),
    flag: asString(p['flag'], `${name}.flag`, false),
    url: asString(p['url'], `${name}.url`, false),
    ...(typeof baseUrl === 'string' && baseUrl.length > 0 ? { baseUrl } : {}),
    description: asString(p['description'], `${name}.description`, false),
    models,
    notes,
  };
}

/**
 * Parse and validate the seed JSON. Throws `SeedError` on a malformed document;
 * an empty `providers` list is valid.
 */
export function parseSeed(body: unknown): SeedData {
  const root = asObject(body, 'document');
  const providersRaw = root['providers'];
  if (!Array.isArray(providersRaw)) throw new SeedError("seed: document has no 'providers' array");
  return {
    lastUpdated: asString(root['lastUpdated'], 'lastUpdated', false),
    providers: providersRaw.map((p, i) => parseProvider(p, i)),
  };
}
