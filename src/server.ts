/** Product backend client for the credits service. Fetch only; never throws on HTTP errors. */
import {
  CREDITS_STATUS_SCHEMA, CREDITS_FOUNDATION_VERSION, isCreditsClaimId, isCreditsDeviceToken, isCreditsEmail,
  isCreditsOperation, isCreditsOrigin, isCreditsPackId, isCreditsProductId, isCreditsProductKey, isMicroUsd,
  parseCreditsClaim, parseCreditsErrorEnvelope, parseCreditsPack, parseCreditsStatus, priceUnit,
  type CreditsClaim, type CreditsCostBasis, type CreditsFetch, type CreditsPack, type CreditsPrice, type CreditsRateCard,
  type CreditsStatus,
} from "./index.js";
import { HOLD_ID, UUID, plainText, record, safeInteger, safeUrl, shape, stringArray, timestamp } from "./internal.js";
import { DEFAULT_TIMEOUT_MS, requestJson, type ServiceResponse } from "./transport.js";

const COST_BASES: readonly CreditsCostBasis[] = ["reported", "contractual", "estimated", "unknown"];
const MAX_UNITS = 1_000_000_000;

export interface CreditsClientOptions {
  readonly origin: string;
  readonly productKey: string;
  readonly fetch?: CreditsFetch;
  readonly timeoutMs?: number;
}
export interface CreditsHoldInput {
  readonly subjectToken: string;
  readonly operation: string;
  readonly units?: number;
  readonly ceilingMicroUsd?: number;
  readonly idempotencyKey: string;
  readonly context?: Readonly<Record<string, string>>;
}
export type CreditsLedgerBalance = Readonly<{ microUsd: number; availableMicroUsd: number }>;
export type CreditsHold = Readonly<{ holdId: string; ceilingMicroUsd: number; balance: CreditsLedgerBalance; expiresAt: string }>;
export interface CreditsCost {
  readonly provider: string;
  readonly operation: string;
  readonly microUsd: number;
  readonly basis: CreditsCostBasis;
}
export interface CreditsSettleInput {
  readonly units?: number;
  readonly costs?: readonly CreditsCost[];
}
export type CreditsSettlement = Readonly<{
  holdId: string;
  state: "settled";
  chargedMicroUsd: number;
  balance: CreditsLedgerBalance;
  lowBalance: boolean;
  topup?: Readonly<{ url: string }>;
}>;
export type CreditsRelease = Readonly<{ holdId: string; state: "released"; balance: CreditsLedgerBalance }>;
export interface CreditsClaimInput {
  readonly product: string;
  readonly device: Readonly<{ id: string; label?: string }>;
  readonly subjectToken?: string;
  readonly email?: string;
  readonly packId?: string;
  readonly resume?: Readonly<{ argv: readonly string[] }>;
}
export type CreditsInsufficientError = Readonly<{
  code: "insufficient_credits";
  status: 402;
  message?: string;
  required: CreditsPrice;
  balance: Readonly<{ microUsd: number; usd: string; availableMicroUsd: number }>;
  topup: Readonly<{ claimId: string; url: string; expiresAt: string; packs: readonly CreditsPack[]; suggestedPackId: string }>;
}>;
export type CreditsClientError =
  | CreditsInsufficientError
  /** No HTTP exchange completed: invalid input (status 0), or the service was unreachable (status 0). */
  | Readonly<{ code: "invalid_request" | "unreachable"; status: 0; message: string }>
  | Readonly<{ code: "malformed_response"; status: number; message: string }>
  | Readonly<{ code: string; status: number; message?: string; readonly [field: string]: unknown }>;
export type CreditsClientResult<T> = { ok: true; value: T } | { ok: false; error: CreditsClientError };

function parseLedgerBalance(value: unknown): CreditsLedgerBalance | null {
  if (!shape(value, ["microUsd", "availableMicroUsd"]) || !isMicroUsd(value.microUsd) || !isMicroUsd(value.availableMicroUsd)) return null;
  return Object.freeze({ microUsd: value.microUsd, availableMicroUsd: value.availableMicroUsd });
}

function parseHold(value: unknown): CreditsHold | null {
  if (!shape(value, ["holdId", "ceilingMicroUsd", "balance", "expiresAt"]) || typeof value.holdId !== "string"
    || !HOLD_ID.test(value.holdId) || !isMicroUsd(value.ceilingMicroUsd) || value.ceilingMicroUsd < 0
    || !timestamp(value.expiresAt)) return null;
  const balance = parseLedgerBalance(value.balance);
  return balance === null ? null : Object.freeze({ holdId: value.holdId, ceilingMicroUsd: value.ceilingMicroUsd, balance, expiresAt: value.expiresAt });
}

function parseSettlement(value: unknown): CreditsSettlement | null {
  if (!shape(value, ["holdId", "state", "chargedMicroUsd", "balance", "lowBalance"], ["topup"]) || typeof value.holdId !== "string"
    || !HOLD_ID.test(value.holdId) || value.state !== "settled" || !isMicroUsd(value.chargedMicroUsd) || value.chargedMicroUsd < 0
    || typeof value.lowBalance !== "boolean"
    || (value.topup !== undefined && (!shape(value.topup, ["url"]) || !safeUrl(value.topup.url)))) return null;
  const balance = parseLedgerBalance(value.balance);
  if (balance === null) return null;
  const topup = value.topup;
  return Object.freeze({
    holdId: value.holdId, state: "settled", chargedMicroUsd: value.chargedMicroUsd, balance, lowBalance: value.lowBalance,
    ...(shape(topup, ["url"]) && typeof topup.url === "string" ? { topup: Object.freeze({ url: topup.url }) } : {}),
  });
}

function parseRelease(value: unknown): CreditsRelease | null {
  if (!shape(value, ["holdId", "state", "balance"]) || typeof value.holdId !== "string" || !HOLD_ID.test(value.holdId)
    || value.state !== "released") return null;
  const balance = parseLedgerBalance(value.balance);
  return balance === null ? null : Object.freeze({ holdId: value.holdId, state: "released", balance });
}

function parseInsufficient(fields: Readonly<Record<string, unknown>>, message: string | undefined): CreditsInsufficientError | null {
  // The service renders money as `{ microUsd, credits, usd }`; `credits` is derived display data and optional here.
  if (!shape(fields, ["required", "balance", "topup"]) || !shape(fields.required, ["microUsd", "usd"], ["credits"])
    || !isMicroUsd(fields.required.microUsd) || fields.required.microUsd < 0 || typeof fields.required.usd !== "string"
    || !/^-?\d{1,10}\.\d{2}$/u.test(fields.required.usd)
    || (fields.required.credits !== undefined && !Number.isSafeInteger(fields.required.credits))
    || !shape(fields.balance, ["microUsd", "usd", "availableMicroUsd"], ["credits"]) || !isMicroUsd(fields.balance.microUsd)
    || typeof fields.balance.usd !== "string" || !/^-?\d{1,10}\.\d{2}$/u.test(fields.balance.usd)
    || (fields.balance.credits !== undefined && !Number.isSafeInteger(fields.balance.credits))
    || !isMicroUsd(fields.balance.availableMicroUsd)
    || !shape(fields.topup, ["claimId", "url", "expiresAt", "packs", "suggestedPackId"]) || !isCreditsClaimId(fields.topup.claimId)
    || !safeUrl(fields.topup.url) || !timestamp(fields.topup.expiresAt) || !isCreditsPackId(fields.topup.suggestedPackId)
    || !Array.isArray(fields.topup.packs) || fields.topup.packs.length < 1 || fields.topup.packs.length > 16) return null;
  const packs: CreditsPack[] = [];
  for (const item of fields.topup.packs) {
    const pack = parseCreditsPack(item);
    if (pack === null) return null;
    packs.push(pack);
  }
  return Object.freeze({
    code: "insufficient_credits",
    status: 402,
    ...(message === undefined ? {} : { message }),
    required: Object.freeze({ microUsd: fields.required.microUsd, usd: fields.required.usd }),
    balance: Object.freeze({ microUsd: fields.balance.microUsd, usd: fields.balance.usd, availableMicroUsd: fields.balance.availableMicroUsd }),
    topup: Object.freeze({
      claimId: fields.topup.claimId, url: fields.topup.url, expiresAt: fields.topup.expiresAt,
      packs: Object.freeze(packs), suggestedPackId: fields.topup.suggestedPackId,
    }),
  });
}

function invalid(message: string): CreditsClientResult<never> {
  return { ok: false, error: { code: "invalid_request", status: 0, message } };
}

function outcome<T>(response: ServiceResponse, expectedStatus: number, parse: (body: unknown) => T | null): CreditsClientResult<T> {
  if (response.kind === "unreachable") return { ok: false, error: { code: "unreachable", status: 0, message: response.message } };
  if (response.kind === "malformed") return { ok: false, error: { code: "malformed_response", status: response.status, message: response.message } };
  if (response.status === expectedStatus) {
    const value = parse(response.body);
    return value === null
      ? { ok: false, error: { code: "malformed_response", status: response.status, message: "The response did not match the contract." } }
      : { ok: true, value };
  }
  const envelope = parseCreditsErrorEnvelope(response.body);
  if (envelope === null) {
    return { ok: false, error: { code: "malformed_response", status: response.status, message: `HTTP ${response.status} without an error envelope.` } };
  }
  if (response.status === 402 && envelope.code === "insufficient_credits") {
    const insufficient = parseInsufficient(envelope.fields, envelope.message);
    return insufficient === null
      ? { ok: false, error: { code: "malformed_response", status: 402, message: "The insufficient_credits envelope did not match the contract." } }
      : { ok: false, error: insufficient };
  }
  return {
    ok: false,
    error: { ...envelope.fields, code: envelope.code, status: response.status, ...(envelope.message === undefined ? {} : { message: envelope.message }) },
  };
}

function validContext(value: unknown): value is Readonly<Record<string, string>> {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= 8 && keys.every(key => plainText(key, 64) && plainText(value[key], 256));
}

/** Local mirror of the service's public unit pricing: `unitPrice × units`, or null when the operation has no public unit price. */
export function ceilingFor(rateCard: CreditsRateCard, operation: string, units = 1): number | null {
  if (!isCreditsOperation(operation) || !Object.prototype.hasOwnProperty.call(rateCard.operations, operation)) return null;
  const unitPrice = rateCard.operations[operation]?.unitPrice;
  return unitPrice === undefined ? null : priceUnit(unitPrice.microUsd, units);
}

export function createCreditsClient(options: CreditsClientOptions) {
  if (!isCreditsOrigin(options.origin)) throw new TypeError("origin must be an https origin such as https://credits.hraness.com.");
  if (!isCreditsProductKey(options.productKey)) throw new TypeError("productKey must be a cr_prod_ key.");
  const fetch: CreditsFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = `hraness-credits-foundation/${CREDITS_FOUNDATION_VERSION} (server)`;
  const post = (path: string, body: unknown) => requestJson({
    fetch, method: "POST", url: `${options.origin}${path}`, userAgent, timeoutMs, bearer: options.productKey, body,
  });
  return Object.freeze({
    /** Reserve a ceiling for one operation; 402 returns `insufficient_credits` with a topup link bound to the subject's wallet. */
    async hold(input: CreditsHoldInput): Promise<CreditsClientResult<CreditsHold>> {
      if (!record(input) || !isCreditsDeviceToken(input.subjectToken)) return invalid("subjectToken must be a cr_dev_ token.");
      if (!isCreditsOperation(input.operation)) return invalid("operation must be an operation name.");
      if (input.units !== undefined && !safeInteger(input.units, 1, MAX_UNITS)) return invalid("units must be a whole number of at least 1.");
      if (input.ceilingMicroUsd !== undefined && (!isMicroUsd(input.ceilingMicroUsd) || input.ceilingMicroUsd < 0)) return invalid("ceilingMicroUsd must be a non-negative integer.");
      if (!plainText(input.idempotencyKey, 128)) return invalid("idempotencyKey must be plain text of at most 128 characters.");
      if (input.context !== undefined && !validContext(input.context)) return invalid("context allows at most 8 plain-text string entries.");
      const response = await post("/v1/holds", {
        subjectToken: input.subjectToken,
        operation: input.operation,
        ...(input.units === undefined ? {} : { units: input.units }),
        ...(input.ceilingMicroUsd === undefined ? {} : { ceilingMicroUsd: input.ceilingMicroUsd }),
        idempotencyKey: input.idempotencyKey,
        ...(input.context === undefined ? {} : { context: input.context }),
      });
      return outcome(response, 201, parseHold);
    },
    /** Charge `min(price, ceiling)` from reported costs or units; retrying a settled hold returns the recorded result. */
    async settle(holdId: string, input: CreditsSettleInput = {}): Promise<CreditsClientResult<CreditsSettlement>> {
      if (typeof holdId !== "string" || !HOLD_ID.test(holdId)) return invalid("holdId must be a hold id.");
      if (!record(input)) return invalid("settle input must be an object.");
      if (input.units !== undefined && !safeInteger(input.units, 1, MAX_UNITS)) return invalid("units must be a whole number of at least 1.");
      if (input.costs !== undefined && (!Array.isArray(input.costs) || input.costs.length > 32 || !input.costs.every(cost =>
        record(cost) && plainText(cost.provider, 64) && plainText(cost.operation, 64) && isMicroUsd(cost.microUsd) && cost.microUsd >= 0
        && COST_BASES.includes(cost.basis as CreditsCostBasis)))) return invalid("costs must list at most 32 entries with provider, operation, microUsd and basis.");
      const response = await post(`/v1/holds/${holdId}/settle`, {
        ...(input.units === undefined ? {} : { units: input.units }),
        ...(input.costs === undefined ? {} : { costs: input.costs.map(cost => ({ provider: cost.provider, operation: cost.operation, microUsd: cost.microUsd, basis: cost.basis })) }),
      });
      return outcome(response, 200, parseSettlement);
    },
    /** Release a hold without charging. */
    async release(holdId: string): Promise<CreditsClientResult<CreditsRelease>> {
      if (typeof holdId !== "string" || !HOLD_ID.test(holdId)) return invalid("holdId must be a hold id.");
      return outcome(await post(`/v1/holds/${holdId}/release`, {}), 200, parseRelease);
    },
    /** Balance for a subject token, in the same shape as the CLI status. */
    async balance(subjectToken: string): Promise<CreditsClientResult<CreditsStatus>> {
      if (!isCreditsDeviceToken(subjectToken)) return invalid("subjectToken must be a cr_dev_ token.");
      const response = await post("/v1/subjects/balance", { subjectToken });
      return outcome(response, 200, body => {
        const status = parseCreditsStatus(body);
        return status !== null && status.schemaVersion === CREDITS_STATUS_SCHEMA ? status : null;
      });
    },
    /** Create a claim on behalf of a subject, for products that hand out topup links from their own backend. */
    async claim(input: CreditsClaimInput): Promise<CreditsClientResult<CreditsClaim>> {
      if (!record(input) || !isCreditsProductId(input.product)) return invalid("product must be a product id.");
      if (!shape(input.device, ["id"], ["label"]) || typeof input.device.id !== "string" || !UUID.test(input.device.id)
        || (input.device.label !== undefined && !plainText(input.device.label, 64))) return invalid("device needs a UUID id and an optional label of at most 64 characters.");
      if (input.subjectToken !== undefined && !isCreditsDeviceToken(input.subjectToken)) return invalid("subjectToken must be a cr_dev_ token.");
      if (input.email !== undefined && !isCreditsEmail(input.email)) return invalid("email must be a valid address.");
      if (input.packId !== undefined && !isCreditsPackId(input.packId)) return invalid("packId must be a pack id.");
      if (input.resume !== undefined && (!shape(input.resume, ["argv"]) || !stringArray(input.resume.argv, 32, 256))) return invalid("resume.argv allows at most 32 plain-text items of 256 characters.");
      const response = await post("/v1/claims", {
        product: input.product,
        device: { id: input.device.id, ...(input.device.label === undefined ? {} : { label: input.device.label }) },
        ...(input.subjectToken === undefined ? {} : { subjectToken: input.subjectToken }),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.packId === undefined ? {} : { packId: input.packId }),
        ...(input.resume === undefined ? {} : { resume: { argv: [...input.resume.argv] } }),
      });
      return outcome(response, 201, parseCreditsClaim);
    },
  });
}

export type CreditsClient = ReturnType<typeof createCreditsClient>;
