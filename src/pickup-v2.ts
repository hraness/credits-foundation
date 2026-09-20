/** Inactive, portable v2 wire parsing only. No transport, credential issuance or state writes. */
export const CREDITS_CLAIM_CREATE_V2 = "hraness-credits-claim-create-v2";
export const CREDITS_CLAIM_CREATED_V2 = "hraness-credits-claim-created-v2";
export const CREDITS_PICKUP_REQUEST_V2 = "hraness-credits-pickup-request-v2";
export const CREDITS_PICKUP_RESPONSE_V2 = "hraness-credits-pickup-response-v2";
export const CREDITS_BALANCE_V2 = "hraness-credits-balance-v2";
export const CREDITS_V2_MAX_REQUEST_BYTES = 4_096;
export const CREDITS_V2_MAX_RESPONSE_BYTES = 16_384;

export type CreditsBindingV2 = Readonly<{ claimId: string; productId: string; deviceId: string }>;
export type CreditsClaimCreateV2 = Readonly<{
  schemaVersion: typeof CREDITS_CLAIM_CREATE_V2; creationId: string; product: string;
  device: Readonly<{ id: string; label?: string }>; email?: string; packId?: string;
}>;
export type CreditsClaimCreatedV2 = Readonly<{
  schemaVersion: typeof CREDITS_CLAIM_CREATED_V2; creationId: string; binding: CreditsBindingV2;
  createdAt: string; expiresAt: string; payUrl: string;
}>;
export type CreditsCreationExpectationV2 = Readonly<{
  creationId: string; productId: string; deviceId: string; serviceOrigin: string;
  /** Set after the first accepted creation response to bind subsequent replays. */
  claimId?: string;
}>;
export type CreditsPickupOperationV2 = "status" | "credential" | "pickup" | "ack";
type RequestBase = Readonly<{ schemaVersion: typeof CREDITS_PICKUP_REQUEST_V2; claimId: string }>;
export type CreditsPickupRequestV2 = RequestBase & (
  | Readonly<{ operation: "status" | "credential" }>
  | Readonly<{ operation: "pickup"; pickupId: string; tokenSha256: string }>
  | Readonly<{ operation: "ack"; pickupId: string }>
);
export type CreditsPickupResponseV2 = Readonly<{
  schemaVersion: typeof CREDITS_PICKUP_RESPONSE_V2; operation: CreditsPickupOperationV2;
  binding: CreditsBindingV2; payment: "pending" | "paid" | "expired";
  pickupState: "unregistered" | "registered" | "acknowledged" | "revoked";
  pickupId: string | null; usable: boolean | null;
}>;
export type CreditsPickupExpectationV2 = Readonly<{
  operation: CreditsPickupOperationV2; binding: CreditsBindingV2;
  /** Persisted candidate ID. Null is allowed only for unregistered status. */
  pickupId: string | null;
}>;
export type CreditsBalanceV2 = Readonly<{
  schemaVersion: typeof CREDITS_BALANCE_V2;
  product: Readonly<{ id: string; name: string }>;
  balance: Readonly<{ microUsd: number; credits: number; usd: string }>;
  held: Readonly<{ microUsd: number }>; lowBalance: boolean;
  packs: readonly Readonly<{ id: string; label: string; usd: number; credits: number; bonusCredits: number }>[];
  suggestedPackId: string;
}>;
const ERROR_STATUS = Object.freeze({ unavailable: 503, unauthorized: 401, not_found: 404,
  invalid_request: 400, conflict: 409, expired: 410, rate_limited: 429, product_disabled: 503, too_large: 413 });
export type CreditsErrorV2 = Readonly<{ error: keyof typeof ERROR_STATUS }>;

// These are v2 authority contracts, deliberately independent of the v1 validators.
const PRODUCT = /^[a-z0-9_-]{1,32}$/u;
const CLAIM = /^[A-Za-z0-9_-]{1,128}$/u;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const UUID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
const HASH = /^[a-f0-9]{64}$/u;
const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;
const UNSAFE_DISPLAY = new RegExp("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]", "u");
const operations = ["status", "credential", "pickup", "ack"] as const;
const fail = (): never => { throw new Error("Invalid credits v2 wire value."); };
const encoder = new TextEncoder();

function unicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** JSON.parse validates grammar; this bounded lexical pass also rejects duplicate object keys. */
function uniqueJsonKeys(json: string): void {
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      const start = i++;
      for (; i < json.length; i++) { if (json[i] === "\\") i++; else if (json[i] === '"') break; }
      const current = stack.at(-1);
      if (current?.key) {
        const key = JSON.parse(json.slice(start, i + 1)) as string;
        if (current.keys.has(key)) fail();
        current.keys.add(key); current.key = false;
      }
    } else if (c === "{") stack.push({ keys: new Set(), key: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") { const current = stack.at(-1); if (current) current.key = true; }
    if (stack.length > 8) fail();
  }
}

/** Copy data properties only, before inspecting fields; never invoke accessors or toJSON. */
function snapshot(input: unknown, maximumBytes: number): unknown {
  if (typeof input === "string") {
    if (input.length > maximumBytes || !unicode(input) || encoder.encode(input).length > maximumBytes) fail();
    uniqueJsonKeys(input); input = JSON.parse(input) as unknown;
  }
  let nodes = 0, characters = 0;
  const ancestors = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 256 || depth > 8) return fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? value : fail();
    if (typeof value === "string") {
      characters += value.length;
      if (characters > maximumBytes || !unicode(value)) return fail();
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) return fail();
    const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64) return fail();
    const length = array ? Object.getOwnPropertyDescriptor(value, "length") : undefined;
    if (array && (!length || !("value" in length) || !Number.isSafeInteger(length.value)
      || length.value < 0 || length.value > 63)) return fail();
    ancestors.add(value);
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (array && key === "length") continue;
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
        || !descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
      characters += key.length;
      if (characters > maximumBytes || !unicode(key)) return fail();
      if (array && key !== String((result as unknown[]).length)) return fail();
      (result as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
    }
    if (array && (result as unknown[]).length !== length!.value) return fail();
    ancestors.delete(value); return result;
  }
  const result = copy(input, 0);
  if (encoder.encode(JSON.stringify(result)).length > maximumBytes) fail();
  return result;
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function parsed<T>(input: unknown, maximumBytes: number, read: (value: unknown) => T): T | null {
  try { return freeze(read(snapshot(input, maximumBytes))); } catch { return null; }
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>, keys = Object.keys(row);
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) return fail();
  return row;
}
function text(value: unknown, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || (pattern && !pattern.test(value))) return fail();
  return value;
}
function displayText(value: unknown, maximum: number): string {
  const result = text(value, maximum);
  return UNSAFE_DISPLAY.test(result) ? fail() : result;
}
function integer(value: unknown, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return fail();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : fail();
}
function binding(value: unknown, devicePattern = GUID): CreditsBindingV2 {
  const row = shape(value, ["claimId", "productId", "deviceId"]);
  return { claimId: text(row.claimId, 128, CLAIM), productId: text(row.productId, 32, PRODUCT), deviceId: text(row.deviceId, 36, devicePattern) };
}
function sameBinding(a: CreditsBindingV2, b: CreditsBindingV2): boolean {
  return a.claimId === b.claimId && a.productId === b.productId && a.deviceId === b.deviceId;
}
function origin(value: unknown): string {
  const raw = text(value, 2_048), url = new URL(raw);
  if (url.origin !== raw || url.username || url.password || (url.protocol !== "https:"
    && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return fail();
  return raw;
}
function timestamp(value: unknown): string {
  const raw = text(value, CREDITS_V2_MAX_RESPONSE_BYTES);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(raw);
  if (!match) return fail();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || !Number.isFinite(Date.parse(raw))) return fail();
  return raw;
}

/** Accept an object or bounded JSON text. The claim bearer is deliberately absent from the body. */
export function parseCreditsClaimCreateV2(value: unknown): CreditsClaimCreateV2 | null {
  return parsed(value, CREDITS_V2_MAX_REQUEST_BYTES, input => {
    const row = shape(input, ["schemaVersion", "creationId", "product", "device"], ["email", "packId"]);
    if (row.schemaVersion !== CREDITS_CLAIM_CREATE_V2) return fail();
    const device = shape(row.device, ["id"], ["label"]);
    return { schemaVersion: CREDITS_CLAIM_CREATE_V2, creationId: text(row.creationId, 36, UUID), product: text(row.product, 32, PRODUCT),
      device: { id: text(device.id, 36, UUID), ...("label" in device ? { label: displayText(device.label, 64) } : {}) },
      ...("email" in row ? { email: text(row.email, 320, EMAIL) } : {}), ...("packId" in row ? { packId: text(row.packId, 32, PRODUCT) } : {}) };
  });
}

/** Bind the original creation tuple; provide claimId on a replay after its first accepted response. */
export function parseCreditsClaimCreatedV2(value: unknown, expected: CreditsCreationExpectationV2): CreditsClaimCreatedV2 | null {
  return parsed(value, CREDITS_V2_MAX_RESPONSE_BYTES, input => {
    const e = shape(snapshot(expected, CREDITS_V2_MAX_REQUEST_BYTES), ["creationId", "productId", "deviceId", "serviceOrigin"], ["claimId"]);
    const creationId = text(e.creationId, 36, UUID), productId = text(e.productId, 32, PRODUCT), deviceId = text(e.deviceId, 36, UUID);
    const serviceOrigin = origin(e.serviceOrigin), claimId = "claimId" in e ? text(e.claimId, 128, CLAIM) : undefined;
    const row = shape(input, ["schemaVersion", "creationId", "binding", "createdAt", "expiresAt", "payUrl"]);
    const bound = binding(row.binding, UUID), createdAt = timestamp(row.createdAt), expiresAt = timestamp(row.expiresAt);
    const payUrl = text(row.payUrl, 2_048);
    if (row.schemaVersion !== CREDITS_CLAIM_CREATED_V2 || row.creationId !== creationId || bound.productId !== productId || bound.deviceId !== deviceId
      || (claimId !== undefined && claimId !== bound.claimId) || Date.parse(expiresAt) <= Date.parse(createdAt)
      || payUrl !== `${serviceOrigin}/t/${encodeURIComponent(bound.claimId)}`) return fail();
    return { schemaVersion: CREDITS_CLAIM_CREATED_V2, creationId, binding: bound, createdAt, expiresAt, payUrl };
  });
}

export function parseCreditsPickupRequestV2(value: unknown): CreditsPickupRequestV2 | null {
  return parsed(value, CREDITS_V2_MAX_REQUEST_BYTES, input => {
    const base = shape(input, ["schemaVersion", "claimId", "operation"], ["pickupId", "tokenSha256"]);
    const operation = choice(base.operation, operations);
    const row = shape(base, ["schemaVersion", "claimId", "operation", ...(operation === "pickup" ? ["pickupId", "tokenSha256"] : operation === "ack" ? ["pickupId"] : [])]);
    if (row.schemaVersion !== CREDITS_PICKUP_REQUEST_V2) return fail();
    const common = { schemaVersion: CREDITS_PICKUP_REQUEST_V2, claimId: text(row.claimId, 128, CLAIM) } as const;
    if (operation === "pickup") return { ...common, operation, pickupId: text(row.pickupId, 36, GUID), tokenSha256: text(row.tokenSha256, 64, HASH) };
    if (operation === "ack") return { ...common, operation, pickupId: text(row.pickupId, 36, GUID) };
    return { ...common, operation };
  });
}

/** A status response may say unregistered despite an already persisted local candidate. */
export function parseCreditsPickupResponseV2(value: unknown, expected: CreditsPickupExpectationV2): CreditsPickupResponseV2 | null {
  return parsed(value, CREDITS_V2_MAX_RESPONSE_BYTES, input => {
    const e = shape(snapshot(expected, CREDITS_V2_MAX_REQUEST_BYTES), ["operation", "binding", "pickupId"]);
    const operation = choice(e.operation, operations), expectedBinding = binding(e.binding);
    const expectedPickup = e.pickupId === null ? null : text(e.pickupId, 36, GUID);
    if (expectedPickup === null && operation !== "status") return fail();
    const row = shape(input, ["schemaVersion", "operation", "binding", "payment", "pickupState", "pickupId", "usable"]);
    const bound = binding(row.binding), payment = choice(row.payment, ["pending", "paid", "expired"]);
    const pickupState = choice(row.pickupState, ["unregistered", "registered", "acknowledged", "revoked"]);
    const pickupId = row.pickupId === null ? null : text(row.pickupId, 36, GUID);
    const usable = row.usable === null || typeof row.usable === "boolean" ? row.usable : fail();
    if (row.schemaVersion !== CREDITS_PICKUP_RESPONSE_V2 || row.operation !== operation || !sameBinding(bound, expectedBinding)
      || (pickupId !== null && pickupId !== expectedPickup) || ((pickupState === "unregistered") !== (pickupId === null))
      || (pickupState !== "unregistered" && payment !== "paid") || ((operation === "status") !== (usable === null))
      || (operation !== "status" && (pickupState === "unregistered" || pickupState === "revoked"))
      || (operation === "ack" && pickupState !== "acknowledged")
      || (operation !== "status" && pickupState === "acknowledged" && usable !== true)) return fail();
    return { schemaVersion: CREDITS_PICKUP_RESPONSE_V2, operation, binding: bound, payment, pickupState, pickupId, usable };
  });
}

/** This response carries product identity only, not a claim/device proof or an activation decision. */
export function parseCreditsBalanceV2(value: unknown, expectedProductId: string): CreditsBalanceV2 | null {
  return parsed(value, CREDITS_V2_MAX_RESPONSE_BYTES, input => {
    const expected = text(expectedProductId, 32, PRODUCT);
    const row = shape(input, ["schemaVersion", "product", "balance", "held", "lowBalance", "packs", "suggestedPackId"]);
    const product = shape(row.product, ["id", "name"]), money = shape(row.balance, ["microUsd", "credits", "usd"]), held = shape(row.held, ["microUsd"]);
    const microUsd = integer(money.microUsd), credits = integer(money.credits), usd = text(money.usd, 32);
    const amount = BigInt(microUsd), magnitude = amount < 0n ? -amount : amount;
    const projectedUsd = `${amount < 0n ? "-" : ""}${magnitude / 1_000_000n}.${String(magnitude % 1_000_000n / 10_000n).padStart(2, "0")}`;
    if (row.schemaVersion !== CREDITS_BALANCE_V2 || product.id !== expected || credits !== Number(amount / 10_000n)
      || usd !== projectedUsd || typeof row.lowBalance !== "boolean" || !Array.isArray(row.packs) || row.packs.length < 1 || row.packs.length > 8) return fail();
    const packs = row.packs.map(value => {
      const pack = shape(value, ["id", "label", "usd", "credits", "bonusCredits"]);
      const dollars = integer(pack.usd, 1, 1_000), packCredits = integer(pack.credits, 0), bonusCredits = integer(pack.bonusCredits, 0);
      if (packCredits !== dollars * 100) return fail();
      return { id: text(pack.id, 32, PRODUCT), label: displayText(pack.label, 128), usd: dollars, credits: packCredits, bonusCredits };
    });
    const suggestedPackId = text(row.suggestedPackId, 32, PRODUCT);
    if (new Set(packs.map(pack => pack.id)).size !== packs.length || !packs.some(pack => pack.id === suggestedPackId)) return fail();
    return { schemaVersion: CREDITS_BALANCE_V2, product: { id: expected, name: displayText(product.name, 64) },
      balance: { microUsd, credits, usd }, held: { microUsd: integer(held.microUsd, 0) }, lowBalance: row.lowBalance, packs, suggestedPackId };
  });
}

/** Only the fixed v2 error body and its matching HTTP status are accepted; no echoed diagnostics. */
export function parseCreditsErrorV2(value: unknown, httpStatus: number): CreditsErrorV2 | null {
  return parsed(value, CREDITS_V2_MAX_RESPONSE_BYTES, input => {
    const row = shape(input, ["error"]), error = choice(row.error, Object.keys(ERROR_STATUS) as (keyof typeof ERROR_STATUS)[]);
    if (ERROR_STATUS[error] !== httpStatus) return fail();
    return { error };
  });
}
