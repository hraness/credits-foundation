/** Shared validation primitives. Pure, portable, and free of I/O. */

// Evaluate Unicode properties in the runtime. Some downstream Babel bundles
// omit the property tables needed to rewrite a regular-expression literal.
const UNSAFE_TEXT = new RegExp("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]", "u");
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const PRODUCT_ID = /^[a-z][a-z0-9-]{0,47}$/u;
export const CLAIM_ID = /^[A-Za-z0-9_-]{1,64}$/u;
export const HOLD_ID = /^[A-Za-z0-9_-]{1,64}$/u;
export const PACK_ID = /^[A-Za-z0-9_-]{1,32}$/u;
export const OPERATION = /^[a-z][a-z0-9_-]{0,63}$/u;
export const DEVICE_TOKEN = /^cr_dev_[A-Za-z0-9_-]{43}$/u;
export const CLAIM_SECRET = /^cr_clm_[A-Za-z0-9_-]{43}$/u;
export const PRODUCT_KEY = /^cr_prod_[A-Za-z0-9_-]{43}$/u;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const USD_STRING = /^-?\d{1,10}\.\d{2}$/u;
export const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
export const ERROR_CODE = /^[a-z][a-z_]{0,63}$/u;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact-key discipline: every required key present, no key outside required ∪ optional. */
export function shape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!record(value)) return false;
  // A key holding undefined counts as absent: optional product configuration
  // often spreads such keys, and JSON cannot carry them at all.
  const keys = Object.keys(value).filter(key => value[key] !== undefined);
  if (keys.length > required.length + optional.length) return false;
  for (const key of required) if (!keys.includes(key)) return false;
  for (const key of keys) if (!required.includes(key) && !optional.includes(key)) return false;
  return true;
}

export function plainText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim() === value && !UNSAFE_TEXT.test(value);
}

/** Strip control characters from text this package did not produce before it reaches a terminal or agent. */
export function sanitizeText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : String(value);
  const cleaned = Array.from(text).filter(character => !UNSAFE_TEXT.test(character)).join("").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function safeInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function stringArray(value: unknown, maxItems: number, maxLength: number, minItems = 1): value is string[] {
  return Array.isArray(value) && value.length >= minItems && value.length <= maxItems
    && value.every(item => plainText(item, maxLength));
}

export function safeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048
    || UNSAFE_TEXT.test(value) || /\s/u.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username !== "" || url.password !== "") return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

/** An origin is a safe URL with no path, query, or fragment, written exactly as `new URL(value).origin`. */
export function origin(value: unknown): value is string {
  return safeUrl(value) && new URL(value).origin === value;
}

export function email(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254 || UNSAFE_TEXT.test(value)) return false;
  const parts = value.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  return parts.length === 2 && local.length > 0 && local.length <= 64
    && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(local)
    && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(domain);
}

export function timestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

export function errorCode(error: unknown): string | undefined {
  return record(error) && typeof error.code === "string" ? error.code : undefined;
}
