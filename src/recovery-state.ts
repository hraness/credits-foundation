/** Inactive, internal pure recovery model. No persistence, transport or credential generation. */
import {
  CREDITS_CLAIM_CREATE_V2, parseCreditsClaimCreateV2, parseCreditsClaimCreatedV2,
  parseCreditsPickupResponseV2, type CreditsBindingV2, type CreditsClaimCreatedV2,
} from "./pickup-v2.js";
import {
  CREDITS_STATE_SCHEMA, isCreditsClaimId, isCreditsClaimSecret, isCreditsDeviceToken,
  isCreditsTimestamp, isCreditsProductId, parseCreditsClaim, parseCreditsClaimStatus, parseCreditsRateCard,
} from "./index.js";
import { origin, UUID as LEGACY_UUID } from "./internal.js";

export const RECOVERY_STATE_SCHEMA = "hraness-credits-recovery-state-v2";
export const RECOVERY_MAX_BYTES = 32_768;
type RegistrationStage = "create-pending" | "payment-pending" | "paid" | "pickup-pending" | "ack-pending" | "expired" | "revoked";
export type RecoveryRegistration = Readonly<{
  kind: "registration-v2"; operationId: string; canonicalCreateBody: string;
  claimSecret: string; pickupId: string; candidateToken: string;
  stage: RegistrationStage; created: CreditsClaimCreatedV2 | null;
}>;
export type RecoveryTopup = Readonly<{
  kind: "topup-v1"; operationId: string; canonicalCreateBody: string | null;
  stage: "prepared" | "create-dispatched" | "claim-pending" | "expired";
  claim: Readonly<{ claimId: string; expiresAt: string; payUrl: string | null }> | null;
}>;
export type RecoveryState = Readonly<{
  schemaVersion: typeof RECOVERY_STATE_SCHEMA;
  databaseId: string; productId: string; serviceOrigin: string; deviceId: string;
  revision: number; generation: number; bootstrap: "prepared" | "active";
  active: Readonly<{ token: string; source: "legacy" | "pickup-v2"; binding: CreditsBindingV2 | null }> | null;
  pending: RecoveryRegistration | RecoveryTopup | null;
}>;
export type RecoveryAction = "create-v2" | "status-v2" | "pickup-v2" | "credential-v2" | "ack-v2" | "create-topup-v1" | "status-topup-v1";
export type RecoveryActionTicket = Readonly<{
  databaseId: string; generation: number; operationId: string; preparedRevision: number; action: RecoveryAction;
}>;
/** Observation variants are adapter trust inputs, not an authentication mechanism. */
export type RecoveryEvent =
  | Readonly<{ type: "activate" | "signout" | "clear-expired" | "dispatch-topup" | "begin-pickup" }>
  | Readonly<{ type: "prepare-registration"; operationId: string; body: unknown; claimSecret: string; pickupId: string; candidateToken: string }>
  | Readonly<{ type: "prepare-topup"; operationId: string; body: unknown }>
  | Readonly<{ type: "uncertain"; ticket: RecoveryActionTicket }>
  | Readonly<{ type: "created-v2" | "status-v2" | "pickup-v2" | "ack-v2" | "credential-v2" | "created-topup-v1" | "status-topup-v1";
      ticket: RecoveryActionTicket; response: unknown }>;
export type RecoveryFailure = "invalid-state" | "invalid-event" | "invalid-transition" | "stale-ticket" | "counter-exhausted";
export type RecoveryDecision =
  | Readonly<{ kind: "reject"; reason: RecoveryFailure }>
  | Readonly<{ kind: "unchanged"; state: RecoveryState }>
  | Readonly<{ kind: "commit"; expected: Readonly<{ databaseId: string; revision: number; generation: number }>;
      next: RecoveryState; afterCommitAction: RecoveryActionTicket | null }>;

const PRODUCT = /^[a-z0-9_-]{1,32}$/u;
const UUID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
const CLAIM = /^[A-Za-z0-9_-]{1,128}$/u;
const ACTIONS: readonly RecoveryAction[] = ["create-v2", "status-v2", "pickup-v2", "credential-v2", "ack-v2", "create-topup-v1", "status-topup-v1"];
const encoder = new TextEncoder();
class Invalid extends Error { constructor(readonly reason: RecoveryFailure = "invalid-event") { super("Invalid recovery value."); } }
function fail(reason?: RecoveryFailure): never { throw new Invalid(reason); }
function require(value: unknown, reason?: RecoveryFailure): asserts value { if (!value) fail(reason); }
function unicode(s: string): boolean {
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) { const n = s.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) return false; } else if (c >= 0xdc00 && c <= 0xdfff) return false; } return true;
}
function uniqueKeys(json: string): void {
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') { const start = i++; for (; i < json.length; i++) { if (json[i] === "\\") i++; else if (json[i] === '"') break; } const top = stack.at(-1); if (top?.key) { const key = JSON.parse(json.slice(start, i + 1)) as string; require(!top.keys.has(key)); top.keys.add(key); top.key = false; } }
    else if (c === "{") stack.push({ keys: new Set(), key: true }); else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop(); else if (c === ",") { const top = stack.at(-1); if (top) top.key = true; }
    require(stack.length <= 12);
  }
}
/** Ordinary accessors/toJSON are never invoked. Proxies remain outside that claim. */
function snapshot(input: unknown): unknown {
  if (typeof input === "string") { require(input.length <= RECOVERY_MAX_BYTES && unicode(input) && encoder.encode(input).length <= RECOVERY_MAX_BYTES); uniqueKeys(input); input = JSON.parse(input) as unknown; }
  const ancestors = new Set<object>(); let nodes = 0, characters = 0;
  function copy(v: unknown, depth: number): unknown {
    require(++nodes <= 2048 && depth <= 12);
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { require(Number.isFinite(v) && !Object.is(v, -0)); return v; }
    if (typeof v === "string") { characters += v.length; require(characters <= RECOVERY_MAX_BYTES && unicode(v)); return v; }
    require(typeof v === "object" && v !== null && !ancestors.has(v));
    const array = Array.isArray(v), proto: unknown = Object.getPrototypeOf(v); require(array ? proto === Array.prototype : proto === null || proto === Object.prototype);
    const keys = Reflect.ownKeys(v); require(keys.length <= 128);
    const length = array ? Object.getOwnPropertyDescriptor(v, "length") : undefined;
    if (array) require(length && "value" in length && Number.isSafeInteger(length.value) && length.value >= 0 && length.value <= 127);
    const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
    ancestors.add(v);
    for (const key of keys) {
      if (array && key === "length") continue;
      require(typeof key === "string" && !["__proto__", "constructor", "prototype"].includes(key));
      characters += key.length; require(characters <= RECOVERY_MAX_BYTES && unicode(key));
      const d = Object.getOwnPropertyDescriptor(v, key); require(d && "value" in d && d.enumerable);
      if (array) require(key === String((out as unknown[]).length));
      (out as Record<string, unknown>)[key] = copy(d.value, depth + 1);
    }
    if (array) require((out as unknown[]).length === length!.value);
    ancestors.delete(v); return out;
  }
  const out = copy(input, 0); require(encoder.encode(JSON.stringify(out)).length <= RECOVERY_MAX_BYTES); return out;
}
function frozen<T>(v: T): T { if (v !== null && typeof v === "object") { for (const child of Object.values(v)) frozen(child); Object.freeze(v); } return v; }
function object(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  require(v !== null && typeof v === "object" && !Array.isArray(v)); const row = v as Record<string, unknown>, keys = Object.keys(row);
  require(required.every(k => keys.includes(k)) && keys.every(k => required.includes(k) || optional.includes(k))); return row;
}
function text(v: unknown, max: number, pattern?: RegExp): string { require(typeof v === "string" && v.length > 0 && v.length <= max && (!pattern || pattern.test(v))); return v; }
function counter(v: unknown): number { require(typeof v === "number" && Number.isSafeInteger(v) && v >= 0); return v; }
function choice<T extends string>(v: unknown, choices: readonly T[]): T { require(typeof v === "string" && choices.includes(v as T)); return v as T; }
function canonical(v: unknown): string { if (v === null || typeof v !== "object") return JSON.stringify(v); if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`; }
function bound(v: unknown, product: string, device: string): CreditsBindingV2 {
  const r = object(v, ["claimId", "productId", "deviceId"]); require(r.productId === product && r.deviceId === device); return { claimId: text(r.claimId, 128, CLAIM), productId: product, deviceId: device };
}
function creation(body: unknown, s: Pick<RecoveryState, "productId" | "deviceId">) {
  const parsed = parseCreditsClaimCreateV2(body); require(parsed && parsed.product === s.productId && parsed.device.id === s.deviceId); return parsed;
}
function topupBody(body: unknown, s: Pick<RecoveryState, "productId" | "deviceId" | "active">, operationId: string): string {
  const r = object(body, ["product", "device", "subjectToken"], ["email", "packId"]); require(s.active && r.subjectToken === s.active.token);
  // The shipped CLI's subset of the v1 authority body shares these exact v2 bounds.
  const { subjectToken: _token, ...fields } = r;
  creation({ ...fields, schemaVersion: CREDITS_CLAIM_CREATE_V2, creationId: operationId }, s);
  const out = canonical(r); require(encoder.encode(out).length <= 4096); return out;
}
function readState(v: unknown): RecoveryState {
  const r = object(v, ["schemaVersion", "databaseId", "productId", "serviceOrigin", "deviceId", "revision", "generation", "bootstrap", "active", "pending"]);
  require(r.schemaVersion === RECOVERY_STATE_SCHEMA && origin(r.serviceOrigin));
  const state: { -readonly [K in keyof RecoveryState]: RecoveryState[K] } = {
    schemaVersion: RECOVERY_STATE_SCHEMA, databaseId: text(r.databaseId, 36, UUID), productId: text(r.productId, 32, PRODUCT), serviceOrigin: r.serviceOrigin,
    deviceId: text(r.deviceId, 36, UUID), revision: counter(r.revision), generation: counter(r.generation), bootstrap: choice(r.bootstrap, ["prepared", "active"]), active: null, pending: null,
  };
  if (r.active !== null) {
    const a = object(r.active, ["token", "source", "binding"]); require(isCreditsDeviceToken(a.token)); const source = choice(a.source, ["legacy", "pickup-v2"]);
    require((source === "legacy") === (a.binding === null));
    if (source === "legacy") require(LEGACY_UUID.test(state.deviceId) && isCreditsProductId(state.productId));
    state.active = { token: a.token, source, binding: a.binding === null ? null : bound(a.binding, state.productId, state.deviceId) };
  }
  if (r.pending !== null) {
    const kind = object(r.pending, ["kind", "operationId", "canonicalCreateBody", "stage"], ["claimSecret", "pickupId", "candidateToken", "created", "claim"]).kind;
    if (kind === "registration-v2") {
      require(state.active === null && state.bootstrap === "active");
      const p = object(r.pending, ["kind", "operationId", "canonicalCreateBody", "stage", "claimSecret", "pickupId", "candidateToken", "created"]);
      const bodyText = text(p.canonicalCreateBody, 4096), body = creation(bodyText, state); require(canonical(body) === bodyText && isCreditsClaimSecret(p.claimSecret) && isCreditsDeviceToken(p.candidateToken));
      const stage = choice(p.stage, ["create-pending", "payment-pending", "paid", "pickup-pending", "ack-pending", "expired", "revoked"]);
      const created = p.created === null ? null : parseCreditsClaimCreatedV2(p.created, { creationId: body.creationId, productId: state.productId, deviceId: state.deviceId, serviceOrigin: state.serviceOrigin });
      require((stage === "create-pending") === (p.created === null) && (p.created === null || created !== null));
      state.pending = { kind, operationId: text(p.operationId, 36, UUID), canonicalCreateBody: bodyText, stage, created, claimSecret: p.claimSecret, pickupId: text(p.pickupId, 36, UUID), candidateToken: p.candidateToken };
    } else {
      require(kind === "topup-v1" && state.active !== null);
      const p = object(r.pending, ["kind", "operationId", "canonicalCreateBody", "stage", "claim"]), operationId = text(p.operationId, 36, UUID);
      const stage = choice(p.stage, ["prepared", "create-dispatched", "claim-pending", "expired"]);
      let body: string | null = null;
      if (p.canonicalCreateBody !== null) { body = text(p.canonicalCreateBody, 4096); require(topupBody(snapshot(body), state, operationId) === body); }
      require(body !== null || ["claim-pending", "expired"].includes(stage));
      let claim: RecoveryTopup["claim"] = null;
      if (p.claim !== null) { const c = object(p.claim, ["claimId", "expiresAt", "payUrl"]); require(isCreditsClaimId(c.claimId) && isCreditsTimestamp(c.expiresAt)); require(c.payUrl === null || c.payUrl === `${state.serviceOrigin}/t/${encodeURIComponent(c.claimId)}`); claim = { claimId: c.claimId, expiresAt: c.expiresAt, payUrl: c.payUrl }; }
      require((["prepared", "create-dispatched"].includes(stage)) === (claim === null));
      require(state.bootstrap === "active" || (body === null && stage === "claim-pending"));
      state.pending = { kind, operationId, canonicalCreateBody: body, stage, claim };
    }
  }
  if (state.bootstrap === "prepared") require((state.active === null || state.active.source === "legacy") && state.revision === 0 && state.generation === 0);
  else require(state.revision >= 1 && state.generation < state.revision);
  return state;
}
export function parseRecoveryState(input: unknown): RecoveryState | null { try { return frozen(readState(snapshot(input))); } catch { return null; } }

/** Adapter must retain the original legacy bytes/fingerprint until the reviewed fence is durable. */
export function prepareRecoveryState(input: unknown): RecoveryState | null {
  try {
    const r = object(snapshot(input), ["databaseId", "productId", "serviceOrigin", "deviceId"], ["legacy", "legacyOperationId"]);
    const state = readState({ schemaVersion: RECOVERY_STATE_SCHEMA, databaseId: r.databaseId, productId: r.productId,
      serviceOrigin: r.serviceOrigin, deviceId: r.deviceId, revision: 0, generation: 0, bootstrap: "prepared", active: null, pending: null });
    if (!("legacy" in r)) { require(!("legacyOperationId" in r)); return frozen(state); }
    const legacy = object(r.legacy, ["schemaVersion", "product", "deviceId"], ["token", "pendingClaim", "rateCard"]);
    require(legacy.schemaVersion === CREDITS_STATE_SCHEMA && legacy.product === state.productId && isCreditsProductId(legacy.product)
      && legacy.deviceId === state.deviceId && LEGACY_UUID.test(state.deviceId));
    if ("rateCard" in legacy) { const cache = object(legacy.rateCard, ["fetchedAt", "body"]); counter(cache.fetchedAt); require(parseCreditsRateCard(cache.body)); }
    let active: RecoveryState["active"] = null, pending: RecoveryState["pending"] = null;
    if ("token" in legacy) { require(isCreditsDeviceToken(legacy.token)); active = { token: legacy.token, source: "legacy", binding: null }; }
    if ("pendingClaim" in legacy) {
      // Deliberately no optional secret key, even if malformed or undefined.
      const claim = object(legacy.pendingClaim, ["id", "expiresAt"]); require(active && isCreditsClaimId(claim.id) && isCreditsTimestamp(claim.expiresAt));
      pending = { kind: "topup-v1", operationId: text(r.legacyOperationId, 36, UUID), canonicalCreateBody: null, stage: "claim-pending",
        claim: { claimId: claim.id, expiresAt: claim.expiresAt, payUrl: null } };
    } else require(!("legacyOperationId" in r));
    return frozen(readState({ ...state, active, pending }));
  } catch { return null; }
}

function allowed(s: RecoveryState, action: RecoveryAction, dispatchReply = false): boolean {
  if (s.bootstrap !== "active" || !s.pending) return false;
  const p = s.pending;
  if (p.kind === "topup-v1") return action === "status-topup-v1" ? p.stage === "claim-pending" : action === "create-topup-v1" && dispatchReply && p.stage === "create-dispatched";
  return action === "create-v2" ? p.stage === "create-pending" : action === "status-v2" ? !["create-pending", "expired", "revoked"].includes(p.stage)
    : action === "pickup-v2" ? p.stage === "pickup-pending" : (action === "ack-v2" || action === "credential-v2") && p.stage === "ack-pending";
}
function ticket(s: RecoveryState, action: RecoveryAction): RecoveryActionTicket {
  require(s.pending); return { databaseId: s.databaseId, generation: s.generation, operationId: s.pending.operationId, preparedRevision: s.revision, action };
}
export function recoveryAction(input: unknown, action: RecoveryAction): RecoveryActionTicket | null {
  const s = parseRecoveryState(input); return s && ACTIONS.includes(action) && allowed(s, action) ? frozen(ticket(s, action)) : null;
}
/** Returns a locally established credential; the authority still decides current spending validity. */
export function readRecoveryToken(input: unknown): string | null { const s = parseRecoveryState(input); return s?.bootstrap === "active" ? s.active?.token ?? null : null; }
function checkTicket(s: RecoveryState, value: unknown, action?: RecoveryAction): RecoveryActionTicket {
  const r = object(value, ["databaseId", "generation", "operationId", "preparedRevision", "action"]), a = choice(r.action, ACTIONS);
  require((action === undefined || a === action) && allowed(s, a, true), "stale-ticket");
  const expected = ticket(s, a); require(canonical(r) === canonical(expected), "stale-ticket"); return expected;
}
function commit(s: RecoveryState, updates: Partial<Pick<RecoveryState, "bootstrap" | "active" | "pending" | "generation">>, action: RecoveryAction | null = null): RecoveryDecision {
  require(s.revision < Number.MAX_SAFE_INTEGER, "counter-exhausted");
  const next = parseRecoveryState({ ...s, ...updates, revision: s.revision + 1 }); require(next, "invalid-transition");
  require(action === null || allowed(next, action, true), "invalid-transition");
  return frozen({ kind: "commit", expected: { databaseId: s.databaseId, revision: s.revision, generation: s.generation }, next, afterCommitAction: action === null ? null : ticket(next, action) });
}
const unchanged = (s: RecoveryState): RecoveryDecision => frozen({ kind: "unchanged", state: s });
function nextGeneration(s: RecoveryState): number { require(s.generation < Number.MAX_SAFE_INTEGER, "counter-exhausted"); return s.generation + 1; }

/**
 * Observation events MUST come from the adapter's authenticated pinned transport,
 * after the saved ticket was committed. Valid wire JSON alone is not authentication.
 * This function checks semantics/tickets; it neither authenticates nor persists.
 */
export function transitionRecoveryState(stateInput: unknown, eventInput: unknown): RecoveryDecision {
  const s = parseRecoveryState(stateInput); if (!s) return frozen({ kind: "reject", reason: "invalid-state" });
  try {
    const event = snapshot(eventInput), head = event as Record<string, unknown>; require(head && typeof head === "object" && !Array.isArray(head));
    const type = text(head.type, 64), p = s.pending;
    if (type === "activate") { object(event, ["type"]); require(s.bootstrap === "prepared", "invalid-transition"); return commit(s, { bootstrap: "active" }); }
    require(s.bootstrap === "active", "invalid-transition");
    if (type === "signout") { object(event, ["type"]); return commit(s, { active: null, pending: null, generation: nextGeneration(s) }); }
    if (type === "clear-expired") { object(event, ["type"]); require(p?.stage === "expired", "invalid-transition"); return commit(s, { pending: null, generation: nextGeneration(s) }); }
    if (type === "prepare-registration") {
      const e = object(event, ["type", "operationId", "body", "claimSecret", "pickupId", "candidateToken"]); require(s.active === null, "invalid-transition");
      const body = creation(e.body, s); require(isCreditsClaimSecret(e.claimSecret) && isCreditsDeviceToken(e.candidateToken));
      const identity = { kind: "registration-v2" as const, operationId: text(e.operationId, 36, UUID), canonicalCreateBody: canonical(body), claimSecret: e.claimSecret, pickupId: text(e.pickupId, 36, UUID), candidateToken: e.candidateToken };
      if (p) { require(p.kind === "registration-v2" && canonical({ ...p, stage: null, created: null }) === canonical({ ...identity, stage: null, created: null }), "invalid-transition"); return unchanged(s); }
      return commit(s, { pending: { ...identity, stage: "create-pending", created: null } }, "create-v2");
    }
    if (type === "prepare-topup") {
      const e = object(event, ["type", "operationId", "body"]); require(s.active, "invalid-transition"); const operationId = text(e.operationId, 36, UUID), body = topupBody(e.body, s, operationId);
      if (p) { require(p.kind === "topup-v1" && p.operationId === operationId && p.canonicalCreateBody === body, "invalid-transition"); return unchanged(s); }
      return commit(s, { pending: { kind: "topup-v1", operationId, canonicalCreateBody: body, stage: "prepared", claim: null } });
    }
    if (type === "dispatch-topup") { object(event, ["type"]); require(p?.kind === "topup-v1" && p.stage === "prepared", "invalid-transition"); return commit(s, { pending: { ...p, stage: "create-dispatched" } }, "create-topup-v1"); }
    if (type === "begin-pickup") { object(event, ["type"]); require(p?.kind === "registration-v2" && ["paid", "pickup-pending"].includes(p.stage), "invalid-transition"); return p.stage === "pickup-pending" ? unchanged(s) : commit(s, { pending: { ...p, stage: "pickup-pending" } }, "pickup-v2"); }
    if (type === "uncertain") { const e = object(event, ["type", "ticket"]); checkTicket(s, e.ticket); return unchanged(s); }
    const e = object(event, ["type", "ticket", "response"]);
    if (type === "created-v2") {
      checkTicket(s, e.ticket, "create-v2"); require(p?.kind === "registration-v2"); const body = creation(p.canonicalCreateBody, s);
      const created = parseCreditsClaimCreatedV2(e.response, { creationId: body.creationId, productId: s.productId, deviceId: s.deviceId, serviceOrigin: s.serviceOrigin }); require(created);
      return commit(s, { pending: { ...p, created, stage: "payment-pending" } });
    }
    if (type === "status-v2" || type === "pickup-v2" || type === "ack-v2" || type === "credential-v2") {
      checkTicket(s, e.ticket, type); require(p?.kind === "registration-v2" && p.created);
      const operation = type.slice(0, -3) as "status" | "pickup" | "ack" | "credential";
      const response = parseCreditsPickupResponseV2(e.response, { operation, binding: p.created.binding, pickupId: p.pickupId }); require(response);
      if (type === "status-v2") {
        if (response.pickupState === "revoked") return commit(s, { pending: { ...p, stage: "revoked" } });
        if (response.payment === "expired") { require(p.stage === "payment-pending", "invalid-transition"); return commit(s, { pending: { ...p, stage: "expired" } }); }
        if (response.payment === "pending") { require(p.stage === "payment-pending", "invalid-transition"); return unchanged(s); }
        return p.stage === "payment-pending" ? commit(s, { pending: { ...p, stage: "paid" } }) : unchanged(s);
      }
      if (type === "pickup-v2") return commit(s, { pending: { ...p, stage: "ack-pending" } }, "ack-v2");
      if (response.pickupState !== "acknowledged" || response.usable !== true) return unchanged(s);
      return commit(s, { active: { token: p.candidateToken, source: "pickup-v2", binding: p.created.binding }, pending: null });
    }
    if (type === "created-topup-v1") {
      checkTicket(s, e.ticket, "create-topup-v1"); require(p?.kind === "topup-v1"); const response = parseCreditsClaim(e.response); require(response && response.claimSecret === undefined && response.product.id === s.productId && response.url === `${s.serviceOrigin}/t/${encodeURIComponent(response.claimId)}`);
      return commit(s, { pending: { ...p, stage: "claim-pending", claim: { claimId: response.claimId, expiresAt: response.expiresAt, payUrl: response.url } } });
    }
    if (type === "status-topup-v1") {
      checkTicket(s, e.ticket, "status-topup-v1"); require(p?.kind === "topup-v1" && p.claim); const response = parseCreditsClaimStatus(e.response);
      require(response && response.token === undefined && response.claimId === p.claim.claimId && response.expiresAt === p.claim.expiresAt && (!(response.state === "pending" || response.state === "expired") || response.paidAt === undefined));
      if (response.state === "pending") return unchanged(s);
      return commit(s, { pending: response.state === "expired" ? { ...p, stage: "expired" } : null });
    }
    return fail();
  } catch (error) { return frozen({ kind: "reject", reason: error instanceof Invalid ? error.reason : "invalid-event" }); }
}
