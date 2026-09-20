// @bun
// src/recovery-sqlite.ts
import { Database, constants as sqlite } from "bun:sqlite";
import { constants as fsFlags, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statfsSync, unlinkSync, writeSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

// src/internal.ts
var UNSAFE_TEXT = new RegExp("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]", "u");
var LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
var PRODUCT_ID = /^[a-z][a-z0-9-]{0,47}$/u;
var CLAIM_ID = /^[A-Za-z0-9_-]{1,64}$/u;
var PACK_ID = /^[A-Za-z0-9_-]{1,32}$/u;
var OPERATION = /^[a-z][a-z0-9_-]{0,63}$/u;
var DEVICE_TOKEN = /^cr_dev_[A-Za-z0-9_-]{43}$/u;
var CLAIM_SECRET = /^cr_clm_[A-Za-z0-9_-]{43}$/u;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
var USD_STRING = /^-?\d{1,10}\.\d{2}$/u;
var TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shape(value, required, optional = []) {
  if (!record(value))
    return false;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  if (keys.length > required.length + optional.length)
    return false;
  for (const key of required)
    if (!keys.includes(key))
      return false;
  for (const key of keys)
    if (!required.includes(key) && !optional.includes(key))
      return false;
  return true;
}
function plainText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !UNSAFE_TEXT.test(value);
}
function safeInteger(value, min, max) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function safeUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || UNSAFE_TEXT.test(value) || /\s/u.test(value))
    return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "")
    return false;
  return url.protocol === "https:" || url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}
function origin(value) {
  return safeUrl(value) && new URL(value).origin === value;
}
function timestamp(value) {
  return typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

// src/pickup-v2.ts
var CREDITS_TOPUP_CREATE_V2 = "hraness-credits-topup-create-v2";
var CREDITS_TOPUP_CREATED_V2 = "hraness-credits-topup-created-v2";
var CREDITS_CLAIM_CREATE_V2 = "hraness-credits-claim-create-v2";
var CREDITS_CLAIM_CREATED_V2 = "hraness-credits-claim-created-v2";
var CREDITS_PICKUP_RESPONSE_V2 = "hraness-credits-pickup-response-v2";
var CREDITS_V2_MAX_REQUEST_BYTES = 4096;
var CREDITS_V2_MAX_RESPONSE_BYTES = 16384;
var ERROR_STATUS = Object.freeze({
  unavailable: 503,
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  expired: 410,
  rate_limited: 429,
  product_disabled: 503,
  too_large: 413
});
var PRODUCT = /^[a-z0-9_-]{1,32}$/u;
var CLAIM = /^[A-Za-z0-9_-]{1,128}$/u;
var GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
var UUID2 = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
var EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;
var UNSAFE_DISPLAY = new RegExp("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]", "u");
var operations = ["status", "credential", "pickup", "ack"];
var fail = () => {
  throw new Error("Invalid credits v2 wire value.");
};
var encoder = new TextEncoder;
function unicode(value) {
  for (let i = 0;i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 55296 && code <= 56319) {
      const next = value.charCodeAt(++i);
      if (!(next >= 56320 && next <= 57343))
        return false;
    } else if (code >= 56320 && code <= 57343)
      return false;
  }
  return true;
}
function uniqueJsonKeys(json) {
  const stack = [];
  for (let i = 0;i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      const start = i++;
      for (;i < json.length; i++) {
        if (json[i] === "\\")
          i++;
        else if (json[i] === '"')
          break;
      }
      const current = stack.at(-1);
      if (current?.key) {
        const key = JSON.parse(json.slice(start, i + 1));
        if (current.keys.has(key))
          fail();
        current.keys.add(key);
        current.key = false;
      }
    } else if (c === "{")
      stack.push({ keys: new Set, key: true });
    else if (c === "[")
      stack.push(null);
    else if (c === "}" || c === "]")
      stack.pop();
    else if (c === ",") {
      const current = stack.at(-1);
      if (current)
        current.key = true;
    }
    if (stack.length > 8)
      fail();
  }
}
function snapshot(input, maximumBytes) {
  if (typeof input === "string") {
    if (input.length > maximumBytes || !unicode(input) || encoder.encode(input).length > maximumBytes)
      fail();
    uniqueJsonKeys(input);
    input = JSON.parse(input);
  }
  let nodes = 0, characters = 0;
  const ancestors = new Set;
  function copy(value, depth) {
    if (++nodes > 256 || depth > 8)
      return fail();
    if (value === null || typeof value === "boolean")
      return value;
    if (typeof value === "number")
      return Number.isFinite(value) && !Object.is(value, -0) ? value : fail();
    if (typeof value === "string") {
      characters += value.length;
      if (characters > maximumBytes || !unicode(value))
        return fail();
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value))
      return fail();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      return fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64)
      return fail();
    const length = array ? Object.getOwnPropertyDescriptor(value, "length") : undefined;
    if (array && (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 63))
      return fail();
    ancestors.add(value);
    const result2 = array ? [] : Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (array && key === "length")
        continue;
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key) || !descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail();
      characters += key.length;
      if (characters > maximumBytes || !unicode(key))
        return fail();
      if (array && key !== String(result2.length))
        return fail();
      result2[key] = copy(descriptor.value, depth + 1);
    }
    if (array && result2.length !== length.value)
      return fail();
    ancestors.delete(value);
    return result2;
  }
  const result = copy(input, 0);
  if (encoder.encode(JSON.stringify(result)).length > maximumBytes)
    fail();
  return result;
}
function freeze(value) {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value))
      freeze(child);
    Object.freeze(value);
  }
  return value;
}
function parsed(input, maximumBytes, read) {
  try {
    return freeze(read(snapshot(input, maximumBytes)));
  } catch {
    return null;
  }
}
function shape2(value, required, optional = []) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail();
  const row = value, keys = Object.keys(row);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key)))
    return fail();
  return row;
}
function text(value, maximum, pattern) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || pattern && !pattern.test(value))
    return fail();
  return value;
}
function displayText(value, maximum) {
  const result = text(value, maximum);
  return UNSAFE_DISPLAY.test(result) ? fail() : result;
}
function integer(value, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    return fail();
  return value;
}
function choice(value, choices) {
  return typeof value === "string" && choices.includes(value) ? value : fail();
}
function binding(value, devicePattern = GUID) {
  const row = shape2(value, ["claimId", "productId", "deviceId"]);
  return { claimId: text(row.claimId, 128, CLAIM), productId: text(row.productId, 32, PRODUCT), deviceId: text(row.deviceId, 36, devicePattern) };
}
function sameBinding(a, b) {
  return a.claimId === b.claimId && a.productId === b.productId && a.deviceId === b.deviceId;
}
function origin2(value) {
  const raw = text(value, 2048), url = new URL(raw);
  if (url.origin !== raw || url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    return fail();
  return raw;
}
function timestamp2(value) {
  const raw = text(value, CREDITS_V2_MAX_RESPONSE_BYTES);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(raw);
  if (!match)
    return fail();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || !Number.isFinite(Date.parse(raw)))
    return fail();
  return raw;
}
function readCreation(input, schemaVersion) {
  const row = shape2(input, ["schemaVersion", "creationId", "product", "device"], ["email", "packId"]);
  if (row.schemaVersion !== schemaVersion)
    return fail();
  const device = shape2(row.device, ["id"], ["label"]);
  return {
    schemaVersion,
    creationId: text(row.creationId, 36, UUID2),
    product: text(row.product, 32, PRODUCT),
    device: { id: text(device.id, 36, UUID2), ..."label" in device ? { label: displayText(device.label, 64) } : {} },
    ..."email" in row ? { email: text(row.email, 320, EMAIL) } : {},
    ..."packId" in row ? { packId: text(row.packId, 32, PRODUCT) } : {}
  };
}
function parseCreditsClaimCreateV2(value) {
  return parsed(value, CREDITS_V2_MAX_REQUEST_BYTES, (input) => readCreation(input, CREDITS_CLAIM_CREATE_V2));
}
function parseCreditsTopupCreateV2(value) {
  return parsed(value, CREDITS_V2_MAX_REQUEST_BYTES, (input) => readCreation(input, CREDITS_TOPUP_CREATE_V2));
}
function readCreated(input, expected, schemaVersion) {
  const e = shape2(snapshot(expected, CREDITS_V2_MAX_REQUEST_BYTES), ["creationId", "productId", "deviceId", "serviceOrigin"], ["claimId"]);
  const creationId = text(e.creationId, 36, UUID2), productId = text(e.productId, 32, PRODUCT), deviceId = text(e.deviceId, 36, UUID2);
  const serviceOrigin = origin2(e.serviceOrigin), claimId = "claimId" in e ? text(e.claimId, 128, CLAIM) : undefined;
  const row = shape2(input, ["schemaVersion", "creationId", "binding", "createdAt", "expiresAt", "payUrl"]);
  const bound = binding(row.binding, UUID2), createdAt = timestamp2(row.createdAt), expiresAt = timestamp2(row.expiresAt);
  const payUrl = text(row.payUrl, 2048);
  if (row.schemaVersion !== schemaVersion || row.creationId !== creationId || bound.productId !== productId || bound.deviceId !== deviceId || claimId !== undefined && claimId !== bound.claimId || Date.parse(expiresAt) <= Date.parse(createdAt) || payUrl !== `${serviceOrigin}/t/${encodeURIComponent(bound.claimId)}`)
    return fail();
  return { schemaVersion, creationId, binding: bound, createdAt, expiresAt, payUrl };
}
function parseCreditsClaimCreatedV2(value, expected) {
  return parsed(value, CREDITS_V2_MAX_RESPONSE_BYTES, (input) => readCreated(input, expected, CREDITS_CLAIM_CREATED_V2));
}
function parseCreditsTopupCreatedV2(value, expected) {
  return parsed(value, CREDITS_V2_MAX_RESPONSE_BYTES, (input) => readCreated(input, expected, CREDITS_TOPUP_CREATED_V2));
}
function parseCreditsTopupStatusV2(value, expected) {
  return parsed(value, CREDITS_V2_MAX_RESPONSE_BYTES, (input) => {
    const e = shape2(snapshot(expected, CREDITS_V2_MAX_REQUEST_BYTES), ["claimId", "createdAt", "expiresAt"]);
    const claimId = text(e.claimId, 64, CLAIM), createdAt = timestamp2(e.createdAt), expiresAt = timestamp2(e.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(createdAt))
      return fail();
    const row = shape2(input, ["schemaVersion", "claimId", "state", "expiresAt"], ["paidAt", "balance"]);
    const state = choice(row.state, ["pending", "paid", "expired"]);
    if (row.schemaVersion !== "hraness-credits-claim-status-v1" || row.claimId !== claimId || row.expiresAt !== expiresAt || !timestamp(row.expiresAt) || state === "paid" !== "paidAt" in row)
      return fail();
    const paidAt = "paidAt" in row ? timestamp2(row.paidAt) : undefined;
    if (paidAt !== undefined && (!timestamp(paidAt) || Date.parse(paidAt) < Date.parse(createdAt)))
      return fail();
    let balance;
    if ("balance" in row) {
      const money = shape2(row.balance, ["microUsd", "credits", "usd"]);
      const microUsd = integer(money.microUsd, -1000000000000000, 1000000000000000), credits = integer(money.credits), usd = text(money.usd, 32);
      const amount = BigInt(microUsd), magnitude = amount < 0n ? -amount : amount;
      const projectedUsd = `${amount < 0n ? "-" : ""}${magnitude / 1000000n}.${String(magnitude % 1000000n / 10000n).padStart(2, "0")}`;
      if (credits !== Number(amount / 10000n) || usd !== projectedUsd)
        return fail();
      balance = { microUsd, credits, usd };
    }
    return {
      schemaVersion: "hraness-credits-claim-status-v1",
      claimId,
      state,
      expiresAt,
      ...paidAt === undefined ? {} : { paidAt },
      ...balance === undefined ? {} : { balance }
    };
  });
}
function parseCreditsPickupResponseV2(value, expected) {
  return parsed(value, CREDITS_V2_MAX_RESPONSE_BYTES, (input) => {
    const e = shape2(snapshot(expected, CREDITS_V2_MAX_REQUEST_BYTES), ["operation", "binding", "pickupId"]);
    const operation = choice(e.operation, operations), expectedBinding = binding(e.binding);
    const expectedPickup = e.pickupId === null ? null : text(e.pickupId, 36, GUID);
    if (expectedPickup === null && operation !== "status")
      return fail();
    const row = shape2(input, ["schemaVersion", "operation", "binding", "payment", "pickupState", "pickupId", "usable"]);
    const bound = binding(row.binding), payment = choice(row.payment, ["pending", "paid", "expired"]);
    const pickupState = choice(row.pickupState, ["unregistered", "registered", "acknowledged", "revoked"]);
    const pickupId = row.pickupId === null ? null : text(row.pickupId, 36, GUID);
    const usable = row.usable === null || typeof row.usable === "boolean" ? row.usable : fail();
    if (row.schemaVersion !== CREDITS_PICKUP_RESPONSE_V2 || row.operation !== operation || !sameBinding(bound, expectedBinding) || pickupId !== null && pickupId !== expectedPickup || pickupState === "unregistered" !== (pickupId === null) || pickupState !== "unregistered" && payment !== "paid" || operation === "status" !== (usable === null) || operation !== "status" && (pickupState === "unregistered" || pickupState === "revoked") || operation === "ack" && pickupState !== "acknowledged" || operation !== "status" && pickupState === "acknowledged" && usable !== true)
      return fail();
    return { schemaVersion: CREDITS_PICKUP_RESPONSE_V2, operation, binding: bound, payment, pickupState, pickupId, usable };
  });
}

// src/index.ts
var MICRO_USD_PER_CREDIT = 1e4;
var MAX_MICRO_USD = 1000000000000000;
var CREDITS_CLAIM_SCHEMA = "hraness-credits-claim-v1";
var CREDITS_CLAIM_STATUS_SCHEMA = "hraness-credits-claim-status-v1";
var CREDITS_STATE_SCHEMA = "hraness-credits-state-v1";
var CLAIM_STATES = ["pending", "paid", "consumed", "expired"];
var MAX_PACKS = 16;
var MAX_OPERATIONS = 64;
var isCreditsProductId = (value) => typeof value === "string" && PRODUCT_ID.test(value);
var isCreditsClaimId = (value) => typeof value === "string" && CLAIM_ID.test(value);
var isCreditsPackId = (value) => typeof value === "string" && PACK_ID.test(value);
var isCreditsOperation = (value) => typeof value === "string" && OPERATION.test(value);
var isCreditsDeviceToken = (value) => typeof value === "string" && DEVICE_TOKEN.test(value);
var isCreditsClaimSecret = (value) => typeof value === "string" && CLAIM_SECRET.test(value);
var isCreditsTimestamp = (value) => timestamp(value);
var isMicroUsd = (value) => safeInteger(value, -MAX_MICRO_USD, MAX_MICRO_USD);
var isCredits = (value) => safeInteger(value, -MAX_MICRO_USD / MICRO_USD_PER_CREDIT, MAX_MICRO_USD / MICRO_USD_PER_CREDIT);
var isUsdString = (value) => typeof value === "string" && USD_STRING.test(value);
var isUsdNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e6 && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
function parseProduct(value) {
  if (!shape(value, ["id", "name"]) || !isCreditsProductId(value.id) || !plainText(value.name, 80))
    return null;
  return Object.freeze({ id: value.id, name: value.name });
}
function parseMoney(value) {
  if (!shape(value, ["microUsd", "credits", "usd"]) || !isMicroUsd(value.microUsd) || !isCredits(value.credits) || !isUsdString(value.usd))
    return null;
  return Object.freeze({ microUsd: value.microUsd, credits: value.credits, usd: value.usd });
}
function parsePrice(value) {
  if (!shape(value, ["microUsd", "usd"]) || !isMicroUsd(value.microUsd) || !isUsdString(value.usd))
    return null;
  return Object.freeze({ microUsd: value.microUsd, usd: value.usd });
}
function parsePack(value) {
  if (!shape(value, ["id", "usd", "credits", "bonusCredits"], ["label"]) || !isCreditsPackId(value.id) || !isUsdNumber(value.usd) || !isCredits(value.credits) || value.credits < 0 || !isCredits(value.bonusCredits) || value.bonusCredits < 0 || value.label !== undefined && !plainText(value.label, 80))
    return null;
  return Object.freeze({
    id: value.id,
    usd: value.usd,
    credits: value.credits,
    bonusCredits: value.bonusCredits,
    ...value.label === undefined ? {} : { label: value.label }
  });
}
function parsePacks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PACKS)
    return null;
  const packs = [];
  for (const item of value) {
    const pack = parsePack(item);
    if (pack === null)
      return null;
    packs.push(pack);
  }
  return Object.freeze(packs);
}
function parseCreditsClaim(value) {
  if (!shape(value, ["schemaVersion", "claimId", "url", "expiresAt", "product", "packs", "suggestedPackId"], ["claimSecret", "balance"]) || value.schemaVersion !== CREDITS_CLAIM_SCHEMA || !isCreditsClaimId(value.claimId) || !safeUrl(value.url) || !timestamp(value.expiresAt) || !isCreditsPackId(value.suggestedPackId) || value.claimSecret !== undefined && !isCreditsClaimSecret(value.claimSecret))
    return null;
  const product = parseProduct(value.product);
  const packs = parsePacks(value.packs);
  const balance = value.balance === undefined ? undefined : parseMoney(value.balance);
  if (product === null || packs === null || balance === null)
    return null;
  return Object.freeze({
    schemaVersion: CREDITS_CLAIM_SCHEMA,
    claimId: value.claimId,
    ...value.claimSecret === undefined ? {} : { claimSecret: value.claimSecret },
    url: value.url,
    expiresAt: value.expiresAt,
    product,
    packs,
    suggestedPackId: value.suggestedPackId,
    ...balance === undefined ? {} : { balance }
  });
}
function parseCreditsClaimStatus(value) {
  if (!shape(value, ["schemaVersion", "claimId", "state", "expiresAt"], ["paidAt", "balance", "token"]) || value.schemaVersion !== CREDITS_CLAIM_STATUS_SCHEMA || !isCreditsClaimId(value.claimId) || !CLAIM_STATES.includes(value.state) || !timestamp(value.expiresAt) || value.paidAt !== undefined && !timestamp(value.paidAt) || value.token !== undefined && !isCreditsDeviceToken(value.token))
    return null;
  const balance = value.balance === undefined ? undefined : parseMoney(value.balance);
  if (balance === null)
    return null;
  return Object.freeze({
    schemaVersion: CREDITS_CLAIM_STATUS_SCHEMA,
    claimId: value.claimId,
    state: value.state,
    expiresAt: value.expiresAt,
    ...value.paidAt === undefined ? {} : { paidAt: value.paidAt },
    ...balance === undefined ? {} : { balance },
    ...value.token === undefined ? {} : { token: value.token }
  });
}
function parseCreditsRateCard(value) {
  if (!shape(value, ["product", "packs", "suggestedPackId", "minUsd", "maxUsd", "operations"]) || !isCreditsPackId(value.suggestedPackId) || !isUsdNumber(value.minUsd) || !isUsdNumber(value.maxUsd) || !record(value.operations))
    return null;
  const product = parseProduct(value.product);
  const packs = parsePacks(value.packs);
  if (product === null || packs === null)
    return null;
  const names = Object.keys(value.operations);
  if (names.length > MAX_OPERATIONS)
    return null;
  const operations2 = {};
  for (const name of names) {
    const operation = value.operations[name];
    if (!isCreditsOperation(name) || !shape(operation, ["label"], ["unitPrice"]) || !plainText(operation.label, 80))
      return null;
    const unitPrice = operation.unitPrice === undefined ? undefined : parsePrice(operation.unitPrice);
    if (unitPrice === null || unitPrice !== undefined && unitPrice.microUsd < 0)
      return null;
    operations2[name] = Object.freeze({ label: operation.label, ...unitPrice === undefined ? {} : { unitPrice } });
  }
  return Object.freeze({
    product,
    packs,
    suggestedPackId: value.suggestedPackId,
    minUsd: value.minUsd,
    maxUsd: value.maxUsd,
    operations: Object.freeze(operations2)
  });
}

// src/recovery-state.ts
var RECOVERY_STATE_SCHEMA = "hraness-credits-recovery-state-v2";
var RECOVERY_MAX_BYTES = 32768;
var PRODUCT2 = /^[a-z0-9_-]{1,32}$/u;
var UUID3 = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
var CLAIM2 = /^[A-Za-z0-9_-]{1,128}$/u;
var ACTIONS = ["create-v2", "status-v2", "pickup-v2", "credential-v2", "ack-v2", "create-topup-v1", "status-topup-v1", "create-topup-v2", "status-topup-v2"];
var encoder2 = new TextEncoder;

class Invalid extends Error {
  reason;
  constructor(reason = "invalid-event") {
    super("Invalid recovery value.");
    this.reason = reason;
  }
}
function fail2(reason) {
  throw new Invalid(reason);
}
function require2(value, reason) {
  if (!value)
    fail2(reason);
}
function unicode2(s) {
  for (let i = 0;i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 55296 && c <= 56319) {
      const n = s.charCodeAt(++i);
      if (!(n >= 56320 && n <= 57343))
        return false;
    } else if (c >= 56320 && c <= 57343)
      return false;
  }
  return true;
}
function uniqueKeys(json) {
  const stack = [];
  for (let i = 0;i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      const start = i++;
      for (;i < json.length; i++) {
        if (json[i] === "\\")
          i++;
        else if (json[i] === '"')
          break;
      }
      const top = stack.at(-1);
      if (top?.key) {
        const key = JSON.parse(json.slice(start, i + 1));
        require2(!top.keys.has(key));
        top.keys.add(key);
        top.key = false;
      }
    } else if (c === "{")
      stack.push({ keys: new Set, key: true });
    else if (c === "[")
      stack.push(null);
    else if (c === "}" || c === "]")
      stack.pop();
    else if (c === ",") {
      const top = stack.at(-1);
      if (top)
        top.key = true;
    }
    require2(stack.length <= 12);
  }
}
function snapshot2(input) {
  if (typeof input === "string") {
    require2(input.length <= RECOVERY_MAX_BYTES && unicode2(input) && encoder2.encode(input).length <= RECOVERY_MAX_BYTES);
    uniqueKeys(input);
    input = JSON.parse(input);
  }
  const ancestors = new Set;
  let nodes = 0, characters = 0;
  function copy(v, depth) {
    require2(++nodes <= 2048 && depth <= 12);
    if (v === null || typeof v === "boolean")
      return v;
    if (typeof v === "number") {
      require2(Number.isFinite(v) && !Object.is(v, -0));
      return v;
    }
    if (typeof v === "string") {
      characters += v.length;
      require2(characters <= RECOVERY_MAX_BYTES && unicode2(v));
      return v;
    }
    require2(typeof v === "object" && v !== null && !ancestors.has(v));
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    require2(array ? proto === Array.prototype : proto === null || proto === Object.prototype);
    const keys = Reflect.ownKeys(v);
    require2(keys.length <= 128);
    const length = array ? Object.getOwnPropertyDescriptor(v, "length") : undefined;
    if (array)
      require2(length && "value" in length && Number.isSafeInteger(length.value) && length.value >= 0 && length.value <= 127);
    const out2 = array ? [] : Object.create(null);
    ancestors.add(v);
    for (const key of keys) {
      if (array && key === "length")
        continue;
      require2(typeof key === "string" && !["__proto__", "constructor", "prototype"].includes(key));
      characters += key.length;
      require2(characters <= RECOVERY_MAX_BYTES && unicode2(key));
      const d = Object.getOwnPropertyDescriptor(v, key);
      require2(d && "value" in d && d.enumerable);
      if (array)
        require2(key === String(out2.length));
      out2[key] = copy(d.value, depth + 1);
    }
    if (array)
      require2(out2.length === length.value);
    ancestors.delete(v);
    return out2;
  }
  const out = copy(input, 0);
  require2(encoder2.encode(JSON.stringify(out)).length <= RECOVERY_MAX_BYTES);
  return out;
}
function frozen(v) {
  if (v !== null && typeof v === "object") {
    for (const child of Object.values(v))
      frozen(child);
    Object.freeze(v);
  }
  return v;
}
function object(v, required, optional = []) {
  require2(v !== null && typeof v === "object" && !Array.isArray(v));
  const row = v, keys = Object.keys(row);
  require2(required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k)));
  return row;
}
function text2(v, max, pattern) {
  require2(typeof v === "string" && v.length > 0 && v.length <= max && (!pattern || pattern.test(v)));
  return v;
}
function counter(v) {
  require2(typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  return v;
}
function choice2(v, choices) {
  require2(typeof v === "string" && choices.includes(v));
  return v;
}
function canonical(v) {
  if (v === null || typeof v !== "object")
    return JSON.stringify(v);
  if (Array.isArray(v))
    return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
function bound(v, product, device) {
  const r = object(v, ["claimId", "productId", "deviceId"]);
  require2(r.productId === product && r.deviceId === device);
  return { claimId: text2(r.claimId, 128, CLAIM2), productId: product, deviceId: device };
}
function creation(body, s) {
  const parsed2 = parseCreditsClaimCreateV2(body);
  require2(parsed2 && parsed2.product === s.productId && parsed2.device.id === s.deviceId);
  return parsed2;
}
function topupBody(body, s, operationId) {
  const r = object(body, ["product", "device", "subjectToken"], ["email", "packId"]);
  require2(s.active && r.subjectToken === s.active.token);
  const { subjectToken: _token, ...fields } = r;
  creation({ ...fields, schemaVersion: CREDITS_CLAIM_CREATE_V2, creationId: operationId }, s);
  const out = canonical(r);
  require2(encoder2.encode(out).length <= 4096);
  return out;
}
function topupV2Body(body, s, operationId) {
  const parsed2 = parseCreditsTopupCreateV2(body);
  require2(parsed2 && parsed2.product === s.productId && parsed2.device.id === s.deviceId && parsed2.creationId === operationId);
  return parsed2;
}
function readState(v) {
  const r = object(v, ["schemaVersion", "databaseId", "productId", "serviceOrigin", "deviceId", "revision", "generation", "bootstrap", "active", "pending"]);
  require2(r.schemaVersion === RECOVERY_STATE_SCHEMA && origin(r.serviceOrigin));
  const state = {
    schemaVersion: RECOVERY_STATE_SCHEMA,
    databaseId: text2(r.databaseId, 36, UUID3),
    productId: text2(r.productId, 32, PRODUCT2),
    serviceOrigin: r.serviceOrigin,
    deviceId: text2(r.deviceId, 36, UUID3),
    revision: counter(r.revision),
    generation: counter(r.generation),
    bootstrap: choice2(r.bootstrap, ["prepared", "active"]),
    active: null,
    pending: null
  };
  if (r.active !== null) {
    const a = object(r.active, ["token", "source", "binding"]);
    require2(isCreditsDeviceToken(a.token));
    const source = choice2(a.source, ["legacy", "pickup-v2"]);
    require2(source === "legacy" === (a.binding === null));
    if (source === "legacy")
      require2(UUID.test(state.deviceId) && isCreditsProductId(state.productId));
    state.active = { token: a.token, source, binding: a.binding === null ? null : bound(a.binding, state.productId, state.deviceId) };
  }
  if (r.pending !== null) {
    const kind = object(r.pending, ["kind", "operationId", "canonicalCreateBody", "stage"], ["claimSecret", "pickupId", "candidateToken", "created", "claim", "originalToken"]).kind;
    if (kind === "registration-v2") {
      require2(state.active === null && state.bootstrap === "active");
      const p = object(r.pending, ["kind", "operationId", "canonicalCreateBody", "stage", "claimSecret", "pickupId", "candidateToken", "created"]);
      const bodyText = text2(p.canonicalCreateBody, 4096), body = creation(bodyText, state);
      require2(canonical(body) === bodyText && isCreditsClaimSecret(p.claimSecret) && isCreditsDeviceToken(p.candidateToken));
      const stage = choice2(p.stage, ["create-pending", "payment-pending", "paid", "pickup-pending", "ack-pending", "expired", "revoked"]);
      const created = p.created === null ? null : parseCreditsClaimCreatedV2(p.created, { creationId: body.creationId, productId: state.productId, deviceId: state.deviceId, serviceOrigin: state.serviceOrigin });
      require2(stage === "create-pending" === (p.created === null) && (p.created === null || created !== null));
      state.pending = { kind, operationId: text2(p.operationId, 36, UUID3), canonicalCreateBody: bodyText, stage, created, claimSecret: p.claimSecret, pickupId: text2(p.pickupId, 36, UUID3), candidateToken: p.candidateToken };
    } else if (kind === "topup-v2") {
      require2(state.active !== null && state.bootstrap === "active");
      const p = object(r.pending, ["kind", "operationId", "canonicalCreateBody", "stage", "originalToken", "created"]);
      const operationId = text2(p.operationId, 36, UUID3), bodyText = text2(p.canonicalCreateBody, 4096);
      const body = topupV2Body(bodyText, state, operationId);
      require2(canonical(body) === bodyText && p.originalToken === state.active.token);
      const stage = choice2(p.stage, ["create-pending", "claim-pending", "expired"]);
      const created = p.created === null ? null : parseCreditsTopupCreatedV2(p.created, {
        creationId: operationId,
        productId: state.productId,
        deviceId: state.deviceId,
        serviceOrigin: state.serviceOrigin
      });
      require2(stage === "create-pending" === (p.created === null) && (p.created === null || created && isCreditsClaimId(created.binding.claimId)));
      state.pending = { kind, operationId, canonicalCreateBody: bodyText, originalToken: state.active.token, stage, created };
    } else {
      require2(kind === "topup-v1" && state.active !== null);
      const p = object(r.pending, ["kind", "operationId", "canonicalCreateBody", "stage", "claim"]), operationId = text2(p.operationId, 36, UUID3);
      const stage = choice2(p.stage, ["prepared", "create-dispatched", "claim-pending", "expired"]);
      let body = null;
      if (p.canonicalCreateBody !== null) {
        body = text2(p.canonicalCreateBody, 4096);
        require2(topupBody(snapshot2(body), state, operationId) === body);
      }
      require2(body !== null || ["claim-pending", "expired"].includes(stage));
      let claim = null;
      if (p.claim !== null) {
        const c = object(p.claim, ["claimId", "expiresAt", "payUrl"]);
        require2(isCreditsClaimId(c.claimId) && isCreditsTimestamp(c.expiresAt));
        require2(c.payUrl === null || c.payUrl === `${state.serviceOrigin}/t/${encodeURIComponent(c.claimId)}`);
        claim = { claimId: c.claimId, expiresAt: c.expiresAt, payUrl: c.payUrl };
      }
      require2(["prepared", "create-dispatched"].includes(stage) === (claim === null));
      require2(state.bootstrap === "active" || body === null && stage === "claim-pending");
      state.pending = { kind, operationId, canonicalCreateBody: body, stage, claim };
    }
  }
  if (state.bootstrap === "prepared")
    require2((state.active === null || state.active.source === "legacy") && state.revision === 0 && state.generation === 0);
  else
    require2(state.revision >= 1 && state.generation < state.revision);
  return state;
}
function parseRecoveryState(input) {
  try {
    return frozen(readState(snapshot2(input)));
  } catch {
    return null;
  }
}
function prepareRecoveryState(input) {
  try {
    const r = object(snapshot2(input), ["databaseId", "productId", "serviceOrigin", "deviceId"], ["legacy", "legacyOperationId"]);
    const state = readState({
      schemaVersion: RECOVERY_STATE_SCHEMA,
      databaseId: r.databaseId,
      productId: r.productId,
      serviceOrigin: r.serviceOrigin,
      deviceId: r.deviceId,
      revision: 0,
      generation: 0,
      bootstrap: "prepared",
      active: null,
      pending: null
    });
    if (!("legacy" in r)) {
      require2(!("legacyOperationId" in r));
      return frozen(state);
    }
    const legacy = object(r.legacy, ["schemaVersion", "product", "deviceId"], ["token", "pendingClaim", "rateCard"]);
    require2(legacy.schemaVersion === CREDITS_STATE_SCHEMA && legacy.product === state.productId && isCreditsProductId(legacy.product) && legacy.deviceId === state.deviceId && UUID.test(state.deviceId));
    if ("rateCard" in legacy) {
      const cache = object(legacy.rateCard, ["fetchedAt", "body"]);
      counter(cache.fetchedAt);
      require2(parseCreditsRateCard(cache.body));
    }
    let active = null, pending = null;
    if ("token" in legacy) {
      require2(isCreditsDeviceToken(legacy.token));
      active = { token: legacy.token, source: "legacy", binding: null };
    }
    if ("pendingClaim" in legacy) {
      const claim = object(legacy.pendingClaim, ["id", "expiresAt"]);
      require2(active && isCreditsClaimId(claim.id) && isCreditsTimestamp(claim.expiresAt));
      pending = {
        kind: "topup-v1",
        operationId: text2(r.legacyOperationId, 36, UUID3),
        canonicalCreateBody: null,
        stage: "claim-pending",
        claim: { claimId: claim.id, expiresAt: claim.expiresAt, payUrl: null }
      };
    } else
      require2(!("legacyOperationId" in r));
    return frozen(readState({ ...state, active, pending }));
  } catch {
    return null;
  }
}
function allowed(s, action, dispatchReply = false) {
  if (s.bootstrap !== "active" || !s.pending)
    return false;
  const p = s.pending;
  if (p.kind === "topup-v1")
    return action === "status-topup-v1" ? p.stage === "claim-pending" : action === "create-topup-v1" && dispatchReply && p.stage === "create-dispatched";
  if (p.kind === "topup-v2")
    return action === "create-topup-v2" ? p.stage === "create-pending" : action === "status-topup-v2" && ["claim-pending", "expired"].includes(p.stage);
  return action === "create-v2" ? p.stage === "create-pending" : action === "status-v2" ? !["create-pending", "expired", "revoked"].includes(p.stage) : action === "pickup-v2" ? p.stage === "pickup-pending" : (action === "ack-v2" || action === "credential-v2") && p.stage === "ack-pending";
}
function ticket(s, action) {
  require2(s.pending);
  return { databaseId: s.databaseId, generation: s.generation, operationId: s.pending.operationId, preparedRevision: s.revision, action };
}
function checkTicket(s, value, action) {
  const r = object(value, ["databaseId", "generation", "operationId", "preparedRevision", "action"]), a = choice2(r.action, ACTIONS);
  require2((action === undefined || a === action) && allowed(s, a, true), "stale-ticket");
  const expected = ticket(s, a);
  require2(canonical(r) === canonical(expected), "stale-ticket");
  return expected;
}
function commit(s, updates, action = null) {
  require2(s.revision < Number.MAX_SAFE_INTEGER, "counter-exhausted");
  const next = parseRecoveryState({ ...s, ...updates, revision: s.revision + 1 });
  require2(next, "invalid-transition");
  require2(action === null || allowed(next, action, true), "invalid-transition");
  return frozen({ kind: "commit", expected: { databaseId: s.databaseId, revision: s.revision, generation: s.generation }, next, afterCommitAction: action === null ? null : ticket(next, action) });
}
var unchanged = (s) => frozen({ kind: "unchanged", state: s });
function nextGeneration(s) {
  require2(s.generation < Number.MAX_SAFE_INTEGER, "counter-exhausted");
  return s.generation + 1;
}
function transitionRecoveryState(stateInput, eventInput) {
  const s = parseRecoveryState(stateInput);
  if (!s)
    return frozen({ kind: "reject", reason: "invalid-state" });
  try {
    const event = snapshot2(eventInput), head = event;
    require2(head && typeof head === "object" && !Array.isArray(head));
    const type = text2(head.type, 64), p = s.pending;
    if (type === "activate") {
      object(event, ["type"]);
      require2(s.bootstrap === "prepared", "invalid-transition");
      return commit(s, { bootstrap: "active" });
    }
    require2(s.bootstrap === "active", "invalid-transition");
    if (type === "signout") {
      object(event, ["type"]);
      return commit(s, { active: null, pending: null, generation: nextGeneration(s) });
    }
    if (type === "clear-expired") {
      object(event, ["type"]);
      require2(p?.stage === "expired", "invalid-transition");
      return commit(s, { pending: null, generation: nextGeneration(s) });
    }
    if (type === "prepare-registration") {
      const e2 = object(event, ["type", "operationId", "body", "claimSecret", "pickupId", "candidateToken"]);
      require2(s.active === null, "invalid-transition");
      const body = creation(e2.body, s);
      require2(isCreditsClaimSecret(e2.claimSecret) && isCreditsDeviceToken(e2.candidateToken));
      const identity = { kind: "registration-v2", operationId: text2(e2.operationId, 36, UUID3), canonicalCreateBody: canonical(body), claimSecret: e2.claimSecret, pickupId: text2(e2.pickupId, 36, UUID3), candidateToken: e2.candidateToken };
      if (p) {
        require2(p.kind === "registration-v2" && canonical({ ...p, stage: null, created: null }) === canonical({ ...identity, stage: null, created: null }), "invalid-transition");
        return unchanged(s);
      }
      return commit(s, { pending: { ...identity, stage: "create-pending", created: null } }, "create-v2");
    }
    if (type === "prepare-topup") {
      const e2 = object(event, ["type", "operationId", "body"]);
      require2(s.active, "invalid-transition");
      const operationId = text2(e2.operationId, 36, UUID3), body = topupBody(e2.body, s, operationId);
      if (p) {
        require2(p.kind === "topup-v1" && p.operationId === operationId && p.canonicalCreateBody === body, "invalid-transition");
        return unchanged(s);
      }
      return commit(s, { pending: { kind: "topup-v1", operationId, canonicalCreateBody: body, stage: "prepared", claim: null } });
    }
    if (type === "prepare-topup-v2") {
      const e2 = object(event, ["type", "operationId", "body"]);
      require2(s.active, "invalid-transition");
      const operationId = text2(e2.operationId, 36, UUID3), body = canonical(topupV2Body(e2.body, s, operationId));
      if (p) {
        require2(p.kind === "topup-v2" && p.operationId === operationId && p.canonicalCreateBody === body && p.originalToken === s.active.token, "invalid-transition");
        return unchanged(s);
      }
      return commit(s, { pending: { kind: "topup-v2", operationId, canonicalCreateBody: body, originalToken: s.active.token, stage: "create-pending", created: null } }, "create-topup-v2");
    }
    if (type === "dispatch-topup") {
      object(event, ["type"]);
      require2(p?.kind === "topup-v1" && p.stage === "prepared", "invalid-transition");
      return commit(s, { pending: { ...p, stage: "create-dispatched" } }, "create-topup-v1");
    }
    if (type === "begin-pickup") {
      object(event, ["type"]);
      require2(p?.kind === "registration-v2" && ["paid", "pickup-pending"].includes(p.stage), "invalid-transition");
      return p.stage === "pickup-pending" ? unchanged(s) : commit(s, { pending: { ...p, stage: "pickup-pending" } }, "pickup-v2");
    }
    if (type === "uncertain") {
      const e2 = object(event, ["type", "ticket"]);
      checkTicket(s, e2.ticket);
      return unchanged(s);
    }
    const e = object(event, ["type", "ticket", "response"]);
    if (type === "created-topup-v2") {
      checkTicket(s, e.ticket, "create-topup-v2");
      require2(p?.kind === "topup-v2");
      const created = parseCreditsTopupCreatedV2(e.response, { creationId: p.operationId, productId: s.productId, deviceId: s.deviceId, serviceOrigin: s.serviceOrigin });
      require2(created && isCreditsClaimId(created.binding.claimId));
      return commit(s, { pending: { ...p, created, stage: "claim-pending" } });
    }
    if (type === "status-topup-v2") {
      checkTicket(s, e.ticket, "status-topup-v2");
      require2(p?.kind === "topup-v2" && p.created);
      const response = parseCreditsTopupStatusV2(e.response, { claimId: p.created.binding.claimId, createdAt: p.created.createdAt, expiresAt: p.created.expiresAt });
      require2(response);
      if (response.state === "pending" || response.state === "expired" && p.stage === "expired")
        return unchanged(s);
      return response.state === "expired" ? commit(s, { pending: { ...p, stage: "expired" } }) : commit(s, { pending: null, generation: nextGeneration(s) });
    }
    if (type === "created-v2") {
      checkTicket(s, e.ticket, "create-v2");
      require2(p?.kind === "registration-v2");
      const body = creation(p.canonicalCreateBody, s);
      const created = parseCreditsClaimCreatedV2(e.response, { creationId: body.creationId, productId: s.productId, deviceId: s.deviceId, serviceOrigin: s.serviceOrigin });
      require2(created);
      return commit(s, { pending: { ...p, created, stage: "payment-pending" } });
    }
    if (type === "status-v2" || type === "pickup-v2" || type === "ack-v2" || type === "credential-v2") {
      checkTicket(s, e.ticket, type);
      require2(p?.kind === "registration-v2" && p.created);
      const operation = type.slice(0, -3);
      const response = parseCreditsPickupResponseV2(e.response, { operation, binding: p.created.binding, pickupId: p.pickupId });
      require2(response);
      if (type === "status-v2") {
        if (response.pickupState === "revoked")
          return commit(s, { pending: { ...p, stage: "revoked" } });
        if (response.payment === "expired") {
          require2(p.stage === "payment-pending", "invalid-transition");
          return commit(s, { pending: { ...p, stage: "expired" } });
        }
        if (response.payment === "pending") {
          require2(p.stage === "payment-pending", "invalid-transition");
          return unchanged(s);
        }
        return p.stage === "payment-pending" ? commit(s, { pending: { ...p, stage: "paid" } }) : unchanged(s);
      }
      if (type === "pickup-v2")
        return commit(s, { pending: { ...p, stage: "ack-pending" } }, "ack-v2");
      if (response.pickupState !== "acknowledged" || response.usable !== true)
        return unchanged(s);
      return commit(s, { active: { token: p.candidateToken, source: "pickup-v2", binding: p.created.binding }, pending: null });
    }
    if (type === "created-topup-v1") {
      checkTicket(s, e.ticket, "create-topup-v1");
      require2(p?.kind === "topup-v1");
      const response = parseCreditsClaim(e.response);
      require2(response && response.claimSecret === undefined && response.product.id === s.productId && response.url === `${s.serviceOrigin}/t/${encodeURIComponent(response.claimId)}`);
      return commit(s, { pending: { ...p, stage: "claim-pending", claim: { claimId: response.claimId, expiresAt: response.expiresAt, payUrl: response.url } } });
    }
    if (type === "status-topup-v1") {
      checkTicket(s, e.ticket, "status-topup-v1");
      require2(p?.kind === "topup-v1" && p.claim);
      const response = parseCreditsClaimStatus(e.response);
      require2(response && response.token === undefined && response.claimId === p.claim.claimId && response.expiresAt === p.claim.expiresAt && (!(response.state === "pending" || response.state === "expired") || response.paidAt === undefined));
      if (response.state === "pending")
        return unchanged(s);
      return commit(s, { pending: response.state === "expired" ? { ...p, stage: "expired" } : null });
    }
    return fail2();
  } catch (error) {
    return frozen({ kind: "reject", reason: error instanceof Invalid ? error.reason : "invalid-event" });
  }
}

// src/recovery-sqlite.ts
var UUID4 = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
var PRODUCT3 = /^[a-z0-9_-]{1,32}$/u;
var encoder3 = new TextEncoder;

class StoreFailure extends Error {
  reason;
  constructor(reason) {
    super("Recovery store unavailable.");
    this.reason = reason;
  }
}
function need(value, reason = "invalid-input") {
  if (!value)
    throw new StoreFailure(reason);
}
function validUnicode(value) {
  for (let i = 0;i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 55296 && c <= 56319) {
      const n = value.charCodeAt(++i);
      if (!(n >= 56320 && n <= 57343))
        return false;
    } else if (c >= 56320 && c <= 57343)
      return false;
  }
  return true;
}
function boundedText(value, bytes) {
  need(typeof value === "string" && value.length > 0 && value.length <= bytes && validUnicode(value) && encoder3.encode(value).length <= bytes);
  return value;
}
function fields(value, names, optional = []) {
  need(value !== null && typeof value === "object" && !Array.isArray(value));
  const proto = Object.getPrototypeOf(value);
  need(proto === null || proto === Object.prototype);
  const keys = Reflect.ownKeys(value);
  need(keys.length >= names.length && keys.length <= names.length + optional.length);
  const result = Object.create(null);
  for (const key of keys) {
    need(typeof key === "string" && key.length <= 64 && (names.includes(key) || optional.includes(key)));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor && "value" in descriptor && descriptor.enumerable);
    result[key] = descriptor.value;
  }
  need(names.every((key) => Object.hasOwn(result, key)));
  return result;
}
function directoryParts(value) {
  need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  const length = Object.getOwnPropertyDescriptor(value, "length");
  need(length && "value" in length && Number.isInteger(length.value) && length.value >= 0 && length.value <= 8);
  need(Reflect.ownKeys(value).length === length.value + 1);
  const parts = [];
  for (let i = 0;i < length.value; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    need(descriptor && "value" in descriptor && descriptor.enumerable);
    const part = boundedText(descriptor.value, 128);
    need(part !== "." && part !== ".." && !/[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(part));
    parts.push(part);
  }
  return Object.freeze(parts);
}
function locationInput(value) {
  const row = fields(value, ["trustedBase", "directory", "productId", "serviceOrigin"]);
  const trustedBase = boundedText(row.trustedBase, 4096), productId = boundedText(row.productId, 32);
  need(trustedBase.startsWith("/") && !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trustedBase));
  need(trustedBase === "/" || !trustedBase.endsWith("/") && trustedBase.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== ".."));
  need(PRODUCT3.test(productId) && origin(row.serviceOrigin));
  const directory = directoryParts(row.directory);
  need(encoder3.encode([trustedBase, ...directory, `${productId}.v2.sqlite-journal`].join("/")).length <= 4096);
  return Object.freeze({ trustedBase, directory, productId, serviceOrigin: row.serviceOrigin });
}
function expectedInput(value) {
  const row = fields(value, ["databaseId", "revision", "generation"]), databaseId = boundedText(row.databaseId, 36);
  need(UUID4.test(databaseId));
  for (const key of ["revision", "generation"])
    need(typeof row[key] === "number" && Number.isSafeInteger(row[key]) && !Object.is(row[key], -0) && row[key] >= 0);
  return Object.freeze({ databaseId, revision: row.revision, generation: row.generation });
}
var RECOVERY_SQLITE_PROFILE = Object.freeze({
  bun: "1.3.14",
  platform: "darwin",
  arch: "arm64",
  filesystem: 26,
  sqlite: "3.51.0",
  sourceId: "2025-06-12 13:14:41 f0ca7bba1c5e232e5d279fad6338121ab55af0c8c68c84cdfb18ba5114dcaapl"
});
var DB_LIMIT = 1048576;
var LEGACY_LIMIT = 16384;
var JOURNAL_LIMIT = 2097152;
var APP_ID = 1129469490;
var MARKER = "hraness-credits-state-v2-sqlite";
var NOFOLLOW = fsFlags.O_NOFOLLOW;
var NONBLOCK = fsFlags.O_NONBLOCK;
var SQL_SCHEMA = "CREATE TABLE recovery (singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_id TEXT NOT NULL, product_id TEXT NOT NULL, service_origin TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), generation INTEGER NOT NULL CHECK(generation>=0), bootstrap TEXT NOT NULL CHECK(bootstrap IN ('prepared','active')), state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB))<=32768), legacy_sha256 TEXT, legacy_bytes BLOB CHECK(legacy_bytes IS NULL OR length(legacy_bytes)<=16384)) STRICT";
var SELECT_ROW = "SELECT singleton,database_id,product_id,service_origin,CAST(revision AS TEXT) AS revision,CAST(generation AS TEXT) AS generation,bootstrap,state_json,legacy_sha256,legacy_bytes FROM recovery LIMIT 2";
var INSERT_ROW = "INSERT INTO recovery(singleton,database_id,product_id,service_origin,revision,generation,bootstrap,state_json,legacy_sha256,legacy_bytes) VALUES (1,?,?,?,?,?,?,?,?,?)";
var UPDATE_ROW = "UPDATE recovery SET revision=?,generation=?,bootstrap=?,state_json=?,legacy_sha256=?,legacy_bytes=? WHERE singleton=1 AND database_id=? AND revision=? AND generation=?";
var occupied = new Set;
var poisoned = new Set;
var decoder = new TextDecoder("utf-8", { fatal: true });
function errorCode(error) {
  return error !== null && typeof error === "object" ? error.code : undefined;
}
function failure(reason) {
  return Object.freeze({ ok: false, reason });
}
function attempt(run) {
  try {
    return Object.freeze({ ok: true, value: run() });
  } catch (error) {
    return failure(error instanceof StoreFailure ? error.reason : "storage-uncertain");
  }
}
function one(db, sql) {
  const row = db.query(sql).get();
  need(row && Object.keys(row).length === 1, "invalid-store");
  return Object.values(row)[0];
}
function runtime() {
  need(typeof Bun !== "undefined" && Bun.version === RECOVERY_SQLITE_PROFILE.bun && process.platform === "darwin" && process.arch === "arm64" && typeof process.getuid === "function" && Number.isSafeInteger(process.getuid()) && typeof NOFOLLOW === "number" && typeof NONBLOCK === "number", "unsupported-runtime");
  const db = new Database(":memory:", sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_CREATE | sqlite.SQLITE_OPEN_NOFOLLOW);
  try {
    need(one(db, "SELECT sqlite_version()") === RECOVERY_SQLITE_PROFILE.sqlite && one(db, "SELECT sqlite_source_id()") === RECOVERY_SQLITE_PROFILE.sourceId, "unsupported-runtime");
    const options = db.query("PRAGMA compile_options").all();
    need(["THREADSAFE=2", "ENABLE_LOCKING_STYLE=1", "DEFAULT_SYNCHRONOUS=2"].every((option) => options.some((row) => row.compile_options === option)), "unsupported-runtime");
  } finally {
    db.close();
  }
}
function metadata(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return null;
    throw error;
  }
}
function identity(path, stat) {
  return { path, dev: stat.dev, ino: stat.ino };
}
function same(a, b) {
  return b !== null && a.dev === b.dev && a.ino === b.ino;
}
function filesystem(path) {
  need(statfsSync(path, { bigint: true }).type === 26n, "unsupported-filesystem");
}
function privateDirectory(stat, uid) {
  need(stat.isDirectory() && stat.uid === uid && (stat.mode & 0o7777n) === 0o700n, "unsafe-path");
}
function privateFile(ctx, path, max, optional = false) {
  const stat = metadata(path);
  if (stat === null) {
    need(optional, "missing-store");
    return null;
  }
  need(stat.isFile() && stat.uid === ctx.uid && (stat.mode & 0o7777n) === 0o600n && stat.nlink === 1n && stat.dev === ctx.dirs[0].dev, "unsafe-path");
  need(stat.size <= BigInt(max), "invalid-store");
  return stat;
}
function syncDirectory(path) {
  const fd = openSync(path, fsFlags.O_RDONLY | fsFlags.O_DIRECTORY | NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function context(location, create) {
  runtime();
  const uid = BigInt(process.getuid()), base = metadata(location.trustedBase);
  need(base && base.isDirectory() && (base.uid === uid || base.uid === 0n) && (base.mode & 0o022n) === 0n && realpathSync(location.trustedBase) === location.trustedBase, "unsafe-path");
  filesystem(location.trustedBase);
  const dirs = [identity(location.trustedBase, base)];
  let directory = location.trustedBase;
  if (location.directory.length === 0)
    privateDirectory(base, uid);
  for (const part of location.directory) {
    const parent = directory;
    directory = join(directory, part);
    let stat = metadata(directory);
    if (stat === null) {
      need(create, "missing-store");
      mkdirSync(directory, { mode: 448 });
      stat = metadata(directory);
      need(stat, "unsafe-path");
      privateDirectory(stat, uid);
      need(stat.dev === base.dev, "unsafe-path");
      filesystem(directory);
      syncDirectory(directory);
      syncDirectory(parent);
    }
    privateDirectory(stat, uid);
    need(stat.dev === base.dev, "unsafe-path");
    filesystem(directory);
    dirs.push(identity(directory, stat));
  }
  const name = location.productId;
  return { location, directory, db: join(directory, `${name}.v2.sqlite`), marker: join(directory, `${name}.json`), lock: join(directory, `${name}.lock`), uid, dirs };
}
function checkPaths(ctx) {
  for (const [i, expected] of ctx.dirs.entries()) {
    const current = metadata(expected.path);
    need(same(expected, current), "unsafe-path");
    if (i > 0 || ctx.location.directory.length === 0)
      privateDirectory(current, ctx.uid);
    else
      need(current.isDirectory() && (current.uid === ctx.uid || current.uid === 0n) && (current.mode & 0o022n) === 0n, "unsafe-path");
    filesystem(expected.path);
  }
  if (ctx.dbIdentity)
    need(same(ctx.dbIdentity, privateFile(ctx, ctx.db, DB_LIMIT)), "unsafe-path");
}
function sidecars(ctx) {
  need(metadata(`${ctx.db}-wal`) === null && metadata(`${ctx.db}-shm`) === null, "invalid-store");
  privateFile(ctx, `${ctx.db}-journal`, JOURNAL_LIMIT, true);
}
function readBytes(ctx, path, max, optional = false, sync = false) {
  const stat = privateFile(ctx, path, max, optional);
  if (!stat)
    return null;
  const expected = identity(path, stat), fd = openSync(path, fsFlags.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    need(same(expected, fstatSync(fd, { bigint: true })), "unsafe-path");
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n)
        break;
      length += n;
    }
    need(length <= max && fstatSync(fd, { bigint: true }).size === BigInt(length), "invalid-store");
    if (sync)
      fsyncSync(fd);
    need(same(expected, metadata(path)), "unsafe-path");
    return Uint8Array.from(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function sameBytes(a, b) {
  return a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]);
}
function markerText(ctx, id) {
  return `${JSON.stringify({ schemaVersion: MARKER, product: ctx.location.productId, databaseId: id })}
`;
}
function markerMatches(ctx, id, sync = false) {
  const bytes = readBytes(ctx, ctx.marker, 1024, false, sync);
  need(bytes && decoder.decode(bytes) === markerText(ctx, id), "migration-conflict");
}
function markerId(ctx, bytes) {
  if (!bytes)
    return null;
  let raw;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || !Object.hasOwn(raw, "schemaVersion") || raw.schemaVersion !== MARKER)
    return null;
  const row = fields(raw, ["schemaVersion", "product", "databaseId"]);
  need(typeof row.databaseId === "string" && UUID4.test(row.databaseId) && row.product === ctx.location.productId && decoder.decode(bytes) === markerText(ctx, row.databaseId), "migration-conflict");
  return row.databaseId;
}
function configure(db, fresh) {
  db.exec("PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA locking_mode=NORMAL;");
  if (fresh)
    db.exec("PRAGMA page_size=4096; PRAGMA journal_mode=DELETE;");
  need(one(db, "PRAGMA journal_mode") === "delete", "invalid-store");
  need(one(db, "PRAGMA page_size") === 4096, "invalid-store");
  need(one(db, "PRAGMA max_page_count=256") === 256, "invalid-store");
  for (const [pragma, value] of [["synchronous", 3], ["fullfsync", 1], ["busy_timeout", 0], ["trusted_schema", 0], ["secure_delete", 1], ["temp_store", 2], ["locking_mode", "normal"]]) {
    need(one(db, `PRAGMA ${pragma}`) === value, "unsupported-runtime");
  }
}
function database(ctx, fresh, action) {
  checkPaths(ctx);
  sidecars(ctx);
  const stat = privateFile(ctx, ctx.db, DB_LIMIT);
  if (ctx.dbIdentity)
    need(same(ctx.dbIdentity, stat), "unsafe-path");
  else
    ctx.dbIdentity = identity(ctx.db, stat);
  need(!poisoned.has(ctx.db), "storage-uncertain");
  const db = new Database(ctx.db, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW);
  let result;
  try {
    try {
      configure(db, fresh);
    } catch (error) {
      if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(errorCode(error))))
        throw new StoreFailure("busy");
      throw error;
    }
    checkPaths(ctx);
    result = action(db);
  } finally {
    try {
      db.close();
    } catch {
      poisoned.add(ctx.db);
      throw new StoreFailure("storage-uncertain");
    }
  }
  try {
    checkPaths(ctx);
    sidecars(ctx);
  } catch {
    throw new StoreFailure("storage-uncertain");
  }
  return result;
}
function transaction(db, action) {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(errorCode(error))))
      throw new StoreFailure("busy");
    throw error;
  }
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      if (db.inTransaction)
        db.exec("ROLLBACK");
    } catch {
      throw new StoreFailure("storage-uncertain");
    }
    throw error;
  }
}
function decimalCounter(value) {
  need(typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})$/u.test(value), "invalid-store");
  const n = BigInt(value);
  need(n <= BigInt(Number.MAX_SAFE_INTEGER), "invalid-store");
  return Number(n);
}
function prepared(ctx, s, legacy) {
  let raw;
  try {
    raw = legacy === null ? "" : decoder.decode(legacy);
  } catch {
    throw new StoreFailure("invalid-store");
  }
  const inputs = {
    databaseId: s.databaseId,
    deviceId: s.deviceId,
    productId: ctx.location.productId,
    serviceOrigin: ctx.location.serviceOrigin,
    ...s.pending ? { legacyOperationId: s.pending.operationId } : {}
  };
  const json = JSON.stringify(inputs);
  const state = prepareRecoveryState(legacy === null ? inputs : `${json.slice(0, -1)},"legacy":${raw}}`);
  need(state, "invalid-store");
  return state;
}
function readRow(ctx, db) {
  need(one(db, "PRAGMA application_id") === APP_ID && one(db, "PRAGMA user_version") === 1, "invalid-store");
  const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all();
  need(schema.length === 1 && JSON.stringify(schema[0]) === JSON.stringify({ type: "table", name: "recovery", tbl_name: "recovery", sql: SQL_SCHEMA }), "invalid-store");
  const rows = db.query(SELECT_ROW).all();
  need(rows.length === 1, "invalid-store");
  const row = rows[0];
  need(row.singleton === 1 && typeof row.state_json === "string" && encoder3.encode(row.state_json).length <= 32768, "invalid-store");
  const state = parseRecoveryState(row.state_json);
  need(state && state.databaseId === row.database_id && state.productId === row.product_id && state.serviceOrigin === row.service_origin && state.productId === ctx.location.productId && state.serviceOrigin === ctx.location.serviceOrigin && state.bootstrap === row.bootstrap && state.revision === decimalCounter(row.revision) && state.generation === decimalCounter(row.generation), "invalid-store");
  need(row.legacy_bytes === null || row.legacy_bytes instanceof Uint8Array && row.legacy_bytes.byteLength <= LEGACY_LIMIT, "invalid-store");
  const legacy = row.legacy_bytes;
  need(legacy === null && row.legacy_sha256 === null || legacy !== null && row.legacy_sha256 === digest(legacy), "invalid-store");
  if (state.bootstrap === "active")
    need(legacy === null && row.legacy_sha256 === null, "invalid-store");
  else
    need(JSON.stringify(prepared(ctx, state, legacy)) === JSON.stringify(state), "invalid-store");
  return { state, legacy, digest: row.legacy_sha256 };
}
function compareExpected(state, expected) {
  need(state.databaseId === expected.databaseId && state.revision === expected.revision && state.generation === expected.generation, "stale-state");
}
function update(db, before, after) {
  const result = db.query(UPDATE_ROW).run(BigInt(after.revision), BigInt(after.generation), after.bootstrap, JSON.stringify(after), null, null, before.databaseId, BigInt(before.revision), BigInt(before.generation));
  need(result.changes === 1, "stale-state");
}
function guarded(input, create, action) {
  return attempt(() => {
    const location = locationInput(input), key = join(location.trustedBase, ...location.directory, `${location.productId}.v2.sqlite`);
    need(!occupied.has(key), "busy");
    need(!poisoned.has(key), "storage-uncertain");
    occupied.add(key);
    try {
      return action(context(location, create));
    } finally {
      occupied.delete(key);
    }
  });
}
function existing(ctx, action) {
  privateFile(ctx, ctx.db, DB_LIMIT);
  const id = markerId(ctx, readBytes(ctx, ctx.marker, 1024));
  need(id, "migration-conflict");
  const result = database(ctx, false, (db) => transaction(db, () => {
    const { state } = readRow(ctx, db);
    need(state.databaseId === id, "migration-conflict");
    need(state.bootstrap === "active", "bootstrap-required");
    markerMatches(ctx, id);
    return action(db, state);
  }));
  try {
    markerMatches(ctx, id);
    checkPaths(ctx);
  } catch {
    throw new StoreFailure("storage-uncertain");
  }
  return result;
}
function readRecoveryStore(location) {
  return guarded(location, false, (ctx) => existing(ctx, (_db, state) => state));
}
function checkRecoveryFence(location, expected) {
  let parsed2;
  try {
    parsed2 = expectedInput(expected);
  } catch {
    return failure("invalid-input");
  }
  return guarded(location, false, (ctx) => existing(ctx, (_db, state) => {
    compareExpected(state, parsed2);
    return state;
  }));
}
function commitRecoveryEvent(location, expected, event) {
  let parsed2;
  try {
    parsed2 = expectedInput(expected);
  } catch {
    return failure("invalid-input");
  }
  return guarded(location, false, (ctx) => existing(ctx, (db, state) => {
    compareExpected(state, parsed2);
    const decision = transitionRecoveryState(state, event);
    need(decision.kind !== "reject", decision.kind === "reject" && decision.reason === "counter-exhausted" ? "counter-exhausted" : "invalid-transition");
    if (decision.kind === "commit")
      update(db, state, decision.next);
    return decision;
  }));
}
function freshInput(value) {
  if (value === null)
    return null;
  const row = fields(value, ["databaseId", "deviceId"], ["legacyOperationId"]);
  for (const key of Object.keys(row))
    need(typeof row[key] === "string" && UUID4.test(row[key]));
  return Object.freeze(row);
}
function freshState(ctx, fresh, legacy) {
  const inputs = { ...fresh, productId: ctx.location.productId, serviceOrigin: ctx.location.serviceOrigin }, json = JSON.stringify(inputs);
  let state = null;
  try {
    state = prepareRecoveryState(legacy === null ? inputs : `${json.slice(0, -1)},"legacy":${decoder.decode(legacy)}}`);
  } catch {}
  need(state, "migration-conflict");
  return state;
}
function createDb(ctx, stored) {
  checkPaths(ctx);
  sidecars(ctx);
  const fd = openSync(ctx.db, fsFlags.O_RDWR | fsFlags.O_CREAT | fsFlags.O_EXCL | NOFOLLOW, 384);
  try {
    const stat = fstatSync(fd, { bigint: true });
    ctx.dbIdentity = identity(ctx.db, stat);
    privateFile(ctx, ctx.db, DB_LIMIT);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(ctx.directory);
  database(ctx, true, (db) => transaction(db, () => {
    need(db.query("SELECT name FROM sqlite_schema").all().length === 0, "invalid-store");
    db.exec(SQL_SCHEMA);
    db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;`);
    const s = stored.state;
    db.query(INSERT_ROW).run(s.databaseId, s.productId, s.serviceOrigin, BigInt(s.revision), BigInt(s.generation), s.bootstrap, JSON.stringify(s), stored.digest, stored.legacy);
    readRow(ctx, db);
  }));
}
function finalize(ctx, databaseId) {
  markerMatches(ctx, databaseId, true);
  syncDirectory(ctx.directory);
  checkPaths(ctx);
  const result = database(ctx, false, (db) => transaction(db, () => {
    const { state } = readRow(ctx, db);
    need(state.databaseId === databaseId, "migration-conflict");
    markerMatches(ctx, databaseId);
    if (state.bootstrap === "active")
      return state;
    const decision = transitionRecoveryState(state, { type: "activate" });
    need(decision.kind === "commit", "invalid-transition");
    update(db, state, decision.next);
    return decision.next;
  }));
  try {
    markerMatches(ctx, databaseId);
    checkPaths(ctx);
  } catch {
    throw new StoreFailure("storage-uncertain");
  }
  return result;
}
function publishMarker(ctx, stored) {
  checkPaths(ctx);
  need(sameBytes(readBytes(ctx, ctx.marker, LEGACY_LIMIT, true), stored.legacy), "migration-conflict");
  const path = join(ctx.directory, `${ctx.location.productId}.${stored.state.databaseId}.v2-marker.tmp`);
  need(metadata(path) === null, "migration-conflict");
  const fd = openSync(path, fsFlags.O_WRONLY | fsFlags.O_CREAT | fsFlags.O_EXCL | NOFOLLOW, 384);
  let own, renamed = false;
  try {
    try {
      own = identity(path, fstatSync(fd, { bigint: true }));
      privateFile(ctx, path, 1024);
      const bytes = encoder3.encode(markerText(ctx, stored.state.databaseId));
      let offset = 0;
      while (offset < bytes.length) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset);
        need(n > 0, "storage-uncertain");
        offset += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    checkPaths(ctx);
    need(sameBytes(readBytes(ctx, ctx.marker, LEGACY_LIMIT, true), stored.legacy), "migration-conflict");
    need(same(own, privateFile(ctx, path, 1024)), "unsafe-path");
    renameSync(path, ctx.marker);
    renamed = true;
    syncDirectory(ctx.directory);
  } finally {
    if (!renamed && own && same(own, metadata(path)))
      unlinkSync(path);
  }
}
function bootstrapRecoveryStore(location, fresh) {
  let parsed2;
  try {
    parsed2 = freshInput(fresh);
  } catch {
    return failure("invalid-input");
  }
  return guarded(location, true, (ctx) => {
    const hasDb = privateFile(ctx, ctx.db, DB_LIMIT, true) !== null, bytes = readBytes(ctx, ctx.marker, LEGACY_LIMIT, true), id = markerId(ctx, bytes);
    if (hasDb)
      need(parsed2 === null, "invalid-input");
    if (id) {
      need(hasDb, "missing-store");
      return finalize(ctx, id);
    }
    let lockFd;
    try {
      lockFd = openSync(ctx.lock, fsFlags.O_WRONLY | fsFlags.O_CREAT | fsFlags.O_EXCL | NOFOLLOW, 384);
    } catch (error) {
      if (errorCode(error) === "EEXIST")
        throw new StoreFailure("busy");
      throw error;
    }
    let own;
    try {
      own = identity(ctx.lock, fstatSync(lockFd, { bigint: true }));
      privateFile(ctx, ctx.lock, 1024);
      checkPaths(ctx);
      const legacy = readBytes(ctx, ctx.marker, LEGACY_LIMIT, true);
      need(markerId(ctx, legacy) === null, "migration-conflict");
      let stored;
      if (hasDb) {
        stored = database(ctx, false, (db) => transaction(db, () => readRow(ctx, db)));
        need(stored.state.bootstrap === "prepared" && sameBytes(legacy, stored.legacy), "migration-conflict");
      } else {
        need(parsed2, "missing-store");
        const state = freshState(ctx, parsed2, legacy);
        stored = { state, legacy, digest: legacy === null ? null : digest(legacy) };
        createDb(ctx, stored);
      }
      publishMarker(ctx, stored);
      return finalize(ctx, stored.state.databaseId);
    } finally {
      try {
        closeSync(lockFd);
      } finally {
        need(own && same(own, metadata(ctx.lock)), "storage-uncertain");
        unlinkSync(ctx.lock);
      }
    }
  });
}

// src/recovery-bun.ts
var bootstrapRecoveryStore2 = bootstrapRecoveryStore;
var checkRecoveryFence2 = checkRecoveryFence;
var commitRecoveryEvent2 = commitRecoveryEvent;
var readRecoveryStore2 = readRecoveryStore;
export {
  readRecoveryStore2 as readRecoveryStore,
  commitRecoveryEvent2 as commitRecoveryEvent,
  checkRecoveryFence2 as checkRecoveryFence,
  bootstrapRecoveryStore2 as bootstrapRecoveryStore
};
