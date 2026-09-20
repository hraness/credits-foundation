import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  RECOVERY_MAX_BYTES, parseRecoveryState, prepareRecoveryState, transitionRecoveryState,
  recoveryAction, readRecoveryToken, type RecoveryState, type RecoveryDecision, type RecoveryAction,
} from "../src/recovery-state.js";
import { CREDITS_STATE_SCHEMA, CREDITS_CLAIM_STATUS_SCHEMA, CREDITS_CLAIM_SCHEMA } from "../src/index.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const databaseId = uuid(1), deviceId = uuid(5101), operationId = uuid(10), pickupId = uuid(5102);
const claimSecret = `cr_clm_${"s".repeat(43)}`, candidateToken = `cr_dev_${"c".repeat(43)}`, oldToken = `cr_dev_${"o".repeat(43)}`;
const origin = "http://localhost:3000", productId = "peopleblade", claimId = "00000000000000000000010003claims";
const prepared = () => prepareRecoveryState({ databaseId, productId, serviceOrigin: origin, deviceId })!;
function committed(result: RecoveryDecision): RecoveryState { expect(result.kind).toBe("commit"); if (result.kind !== "commit") throw new Error("Fixture transition failed."); expect(parseRecoveryState(result.next)).toEqual(result.next); return result.next; }
const apply = (state: RecoveryState, event: unknown) => committed(transitionRecoveryState(state, event));
const activeEmpty = () => apply(prepared(), { type: "activate" });
function registrationEvent(n = 10) { return { type: "prepare-registration", operationId: uuid(n), body: authority.created.request,
  claimSecret, pickupId, candidateToken }; }
const registration = () => apply(activeEmpty(), registrationEvent());
function observe(s: RecoveryState, type: string, action: RecoveryAction, response: unknown): RecoveryDecision {
  return transitionRecoveryState(s, { type, ticket: recoveryAction(s, action), response });
}
const created = () => committed(observe(registration(), "created-v2", "create-v2", authority.created.response));
const paid = () => committed(observe(created(), "status-v2", "status-v2", authority["status-paid"].response));
const pickupPending = () => apply(paid(), { type: "begin-pickup" });
const ackPending = () => committed(observe(pickupPending(), "pickup-v2", "pickup-v2", authority.pickup.response));
const established = () => committed(observe(ackPending(), "ack-v2", "ack-v2", authority.ack.response));

test("prepared bootstrap has no token/actions and cannot claim signout before the legacy fence", () => {
  const s = prepared(); expect(s).not.toBeNull(); expect(s.bootstrap).toBe("prepared");
  expect(readRecoveryToken(s)).toBeNull(); expect(recoveryAction(s, "create-v2")).toBeNull();
  expect(transitionRecoveryState(s, { type: "signout" })).toEqual({ kind: "reject", reason: "invalid-transition" });
  expect(transitionRecoveryState(s, registrationEvent())).toEqual({ kind: "reject", reason: "invalid-transition" });
  expect(transitionRecoveryState(s, { type: "activate", fenceLooksFine: true }).kind).toBe("reject");
});

test("new registration durably proposes one tuple, lost-reply replay keeps it, changed tuple conflicts", () => {
  const before = activeEmpty(), event = registrationEvent(), original = structuredClone(event);
  const decision = transitionRecoveryState(before, event), s = committed(decision); expect(decision.kind === "commit" && decision.afterCommitAction?.action).toBe("create-v2");
  expect(event).toEqual(original); expect(Object.isFrozen(event)).toBe(false);
  const ticket = recoveryAction(s, "create-v2"); expect(ticket).not.toBeNull();
  expect(transitionRecoveryState(s, { type: "uncertain", ticket })).toEqual({ kind: "unchanged", state: s });
  expect(transitionRecoveryState(s, event)).toEqual({ kind: "unchanged", state: s });
  for (const change of [
    (e: typeof event) => { e.operationId = uuid(11); }, (e: typeof event) => { e.pickupId = uuid(12); },
    (e: typeof event) => { e.candidateToken = oldToken; }, (e: typeof event) => { e.claimSecret = `cr_clm_${"x".repeat(43)}`; },
    (e: typeof event) => { e.body.packId = "p50"; }, (e: typeof event) => { e.body.creationId = uuid(13); },
  ]) { const changed = structuredClone(event); change(changed); expect(transitionRecoveryState(s, changed).kind).toBe("reject"); }
});

test("creation wire alone cannot change state without the current saved ticket", () => {
  const s = registration(); expect(transitionRecoveryState(s, { type: "created-v2", response: authority.created.response }).kind).toBe("reject");
  const ticket = recoveryAction(s, "create-v2")!;
  for (const wrong of [{ ...ticket, generation: 1 }, { ...ticket, operationId: uuid(999) }, { ...ticket, databaseId: uuid(999) }, { ...ticket, preparedRevision: ticket.preparedRevision + 1 }]) {
    expect(transitionRecoveryState(s, { type: "created-v2", ticket: wrong, response: authority.created.response })).toEqual({ kind: "reject", reason: "stale-ticket" });
  }
  const accepted = committed(observe(s, "created-v2", "create-v2", authority.created.response));
  expect(accepted.pending?.kind === "registration-v2" && accepted.pending.created?.payUrl).toBe(`${origin}/t/${claimId}`);
  expect(transitionRecoveryState(accepted, { type: "created-v2", ticket, response: authority.created.response }).kind).toBe("reject");
});

test("wrong origin, claim, product, device, pickup or operation cannot advance a saved registration", () => {
  const s = registration();
  for (const response of [{ ...authority.created.response, payUrl: `https://other.invalid/t/${claimId}` }, { ...authority.created.response, creationId: uuid(90) }, { ...authority.created.response, binding: { ...authority.created.response.binding, deviceId: uuid(90) } }]) expect(observe(s, "created-v2", "create-v2", response).kind).toBe("reject");
  const pending = pickupPending(), response = authority.pickup.response;
  for (const wrong of [{ ...response, operation: "ack" }, { ...response, pickupId: uuid(90) }, { ...response, binding: { ...response.binding, claimId: "another_claim" } }, { ...response, binding: { ...response.binding, productId: "other" } }, { ...response, claimSecret }]) expect(observe(pending, "pickup-v2", "pickup-v2", wrong).kind).toBe("reject");
});

test("paid status after original expiry survives; local error/timeout cannot invent terminal expiry", () => {
  const s = created(); expect(observe(s, "status-v2", "status-v2", authority["status-pending"].response)).toEqual({ kind: "unchanged", state: s });
  const result = committed(observe(s, "status-v2", "status-v2", authority["status-paid-after-expiry"].response)); expect(result.pending?.stage).toBe("paid");
  for (const response of [authority["status-pending"].response, { ...authority["status-pending"].response, payment: "expired" }, { error: "expired" }, { error: "unauthorized" }, { error: "unavailable" }]) expect(observe(result, "status-v2", "status-v2", response).kind).toBe("reject");
  expect(transitionRecoveryState(result, { type: "local-expiry", nowMs: Number.MAX_SAFE_INTEGER }).kind).toBe("reject");
});

test("pickup success remains ACK pending even if issuer allows use before ACK", () => {
  const s = pickupPending(); expect(readRecoveryToken(s)).toBeNull();
  for (const usable of [false, true]) { const pending = committed(observe(s, "pickup-v2", "pickup-v2", { ...authority.pickup.response, usable })); expect(pending.pending?.stage).toBe("ack-pending"); expect(readRecoveryToken(pending)).toBeNull();
    expect(observe(pending, "credential-v2", "credential-v2", { ...authority["credential-before-ack"].response, usable })).toEqual({ kind: "unchanged", state: pending }); }
});

test("lost ACK reply recovers the same candidate and deletes pending bearer material", () => {
  const s = ackPending(), ticket = recoveryAction(s, "ack-v2")!;
  expect(transitionRecoveryState(s, { type: "uncertain", ticket })).toEqual({ kind: "unchanged", state: s });
  const active = committed(observe(s, "credential-v2", "credential-v2", authority["credential-after-ack"].response));
  expect(active.active?.token).toBe(candidateToken); expect(active.pending).toBeNull(); expect(readRecoveryToken(active)).toBe(candidateToken);
  expect(JSON.stringify(active)).not.toContain(claimSecret); expect(recoveryAction(active, "status-v2")).toBeNull(); expect(recoveryAction(active, "ack-v2")).toBeNull();
  expect(transitionRecoveryState(active, { type: "ack-v2", ticket, response: authority.ack.response }).kind).toBe("reject");
});

test("authority-confirmed unpaid expiry clears only explicitly and fences every prior ticket", () => {
  const s = created(), old = recoveryAction(s, "status-v2")!;
  const expired = committed(observe(s, "status-v2", "status-v2", { ...authority["status-pending"].response, payment: "expired" }));
  expect(recoveryAction(expired, "status-v2")).toBeNull(); expect(expired.pending?.kind === "registration-v2" && expired.pending.claimSecret).toBe(claimSecret);
  const clear = apply(expired, { type: "clear-expired" }); expect(clear.pending).toBeNull(); expect(clear.generation).toBe(s.generation + 1);
  expect(transitionRecoveryState(clear, { type: "status-v2", ticket: old, response: authority["status-paid"].response }).kind).toBe("reject");
  expect(transitionRecoveryState(paid(), { type: "clear-expired" }).kind).toBe("reject");
});

test("pending revocation never becomes usable or clears as unpaid expiry", () => {
  const s = ackPending(), revoked = committed(observe(s, "status-v2", "status-v2", { ...authority["status-paid"].response, pickupState: "revoked", pickupId }));
  expect(revoked.pending?.stage).toBe("revoked"); expect(readRecoveryToken(revoked)).toBeNull();
  for (const action of ["status-v2", "pickup-v2", "ack-v2", "credential-v2"] as const) expect(recoveryAction(revoked, action)).toBeNull();
  expect(transitionRecoveryState(revoked, { type: "clear-expired" }).kind).toBe("reject"); expect(transitionRecoveryState(revoked, registrationEvent(55)).kind).toBe("reject");
  expect(apply(revoked, { type: "signout" }).pending).toBeNull();
});

test("full signout clears active/pending logical secrets and stale replies cannot resurrect them", () => {
  for (const s of [registration(), created(), paid(), pickupPending(), ackPending(), established()]) {
    const signedOut = apply(s, { type: "signout" }); expect(signedOut.active).toBeNull(); expect(signedOut.pending).toBeNull(); expect(signedOut.generation).toBe(s.generation + 1);
    expect(JSON.stringify(signedOut)).not.toContain(claimSecret); expect(JSON.stringify(signedOut)).not.toContain(candidateToken);
    for (const action of ["create-v2", "status-v2", "pickup-v2", "ack-v2"] as const) { const ticket = recoveryAction(s, action); if (ticket) expect(transitionRecoveryState(signedOut, { type: "uncertain", ticket }).kind).toBe("reject"); }
  }
});

const topupEvent = () => ({ type: "prepare-topup", operationId: uuid(60), body: { product: productId, device: { id: deviceId }, subjectToken: candidateToken, packId: "p25" } });
const v1Claim = () => ({ schemaVersion: CREDITS_CLAIM_SCHEMA, claimId: "topup_1", url: `${origin}/t/topup_1`, expiresAt: "2026-09-22T00:00:00Z", product: { id: productId, name: "Peopleblade" }, packs: [{ id: "p25", usd: 25, credits: 2500, bonusCredits: 0 }], suggestedPackId: "p25" });
function dispatchedTopup() { const before = apply(established(), topupEvent()), decision = transitionRecoveryState(before, { type: "dispatch-topup" }); const state = committed(decision); if (decision.kind !== "commit") throw new Error("Fixture dispatch failed."); return { state, ticket: decision.afterCommitAction! }; }
function pendingTopup() { const { state, ticket } = dispatchedTopup(); return apply(state, { type: "created-topup-v1", ticket, response: v1Claim() }); }
test("returning-device top-up preserves credential and is single-dispatch when creation reply is lost", () => {
  const { state, ticket } = dispatchedTopup(); expect(ticket.action).toBe("create-topup-v1"); expect(readRecoveryToken(state)).toBe(candidateToken);
  expect(transitionRecoveryState(state, { type: "uncertain", ticket })).toEqual({ kind: "unchanged", state });
  expect(recoveryAction(state, "create-topup-v1")).toBeNull(); expect(transitionRecoveryState(state, { type: "dispatch-topup" }).kind).toBe("reject");
  expect(transitionRecoveryState(state, registrationEvent()).kind).toBe("reject"); expect(transitionRecoveryState(state, topupEvent())).toEqual({ kind: "unchanged", state });
  expect(transitionRecoveryState(state, { ...topupEvent(), operationId: uuid(61) }).kind).toBe("reject");
  expect(transitionRecoveryState(activeEmpty(), topupEvent()).kind).toBe("reject");
});
test("v1 replies remain bound to saved credential/claim and cannot import a new token or claim secret", () => {
  const { state, ticket } = dispatchedTopup();
  for (const response of [{ ...v1Claim(), claimSecret }, { ...v1Claim(), token: oldToken }, { ...v1Claim(), url: "https://other.invalid/t/topup_1" }]) expect(transitionRecoveryState(state, { type: "created-topup-v1", ticket, response }).kind).toBe("reject");
  const pending = pendingTopup(), response = { schemaVersion: CREDITS_CLAIM_STATUS_SCHEMA, claimId: "topup_1", state: "paid", expiresAt: v1Claim().expiresAt };
  for (const wrong of [{ ...response, token: oldToken }, { ...response, token: candidateToken }, { ...response, claimId: "other" }]) expect(observe(pending, "status-topup-v1", "status-topup-v1", wrong).kind).toBe("reject");
  for (const state of ["paid", "consumed"]) { const completed = committed(observe(pending, "status-topup-v1", "status-topup-v1", { ...response, state })); expect(completed.pending).toBeNull(); expect(completed.active).toEqual(pending.active); }
  const expired = committed(observe(pending, "status-topup-v1", "status-topup-v1", { ...response, state: "expired" })); expect(apply(expired, { type: "clear-expired" }).active).toEqual(pending.active);
});

test("eligible legacy import preserves exact token/device and secretless claim without inventing its create body", () => {
  const input = { databaseId, productId, serviceOrigin: origin, deviceId, legacyOperationId: uuid(80), legacy: { schemaVersion: CREDITS_STATE_SCHEMA, product: productId, deviceId, token: oldToken, pendingClaim: { id: "old_claim", expiresAt: "2026-10-01T00:00:00Z" } } };
  const state = prepareRecoveryState(input)!; expect(state).not.toBeNull(); expect(state.active?.token).toBe(oldToken); expect(state.pending?.canonicalCreateBody).toBeNull();
  expect(readRecoveryToken(state)).toBeNull(); const active = apply(state, { type: "activate" }); expect(readRecoveryToken(active)).toBe(oldToken); expect(recoveryAction(active, "status-topup-v1")).not.toBeNull();
  expect(recoveryAction(active, "create-topup-v1")).toBeNull(); expect(transitionRecoveryState(active, { type: "dispatch-topup" }).kind).toBe("reject");
  for (const secret of [claimSecret, undefined, null, ""]) expect(prepareRecoveryState({ ...input, legacy: { ...input.legacy, pendingClaim: { ...input.legacy.pendingClaim, secret } } })).toBeNull();
  expect(prepareRecoveryState({ ...input, legacy: { ...input.legacy, token: undefined } })).toBeNull();
  expect(prepareRecoveryState({ ...input, legacy: { ...input.legacy, deviceId: uuid(90) } })).toBeNull();
  expect(transitionRecoveryState(state, { type: "signout" }).kind).toBe("reject");
});

test("imported states reject semantic contradictions, foreign keys and noncanonical persisted bodies", () => {
  const s = registration(), pending = s.pending!;
  for (const changed of [
    { ...s, active: established().active }, { ...s, bootstrap: "prepared" }, { ...s, generation: -1 }, { ...s, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...s, revision: 0 }, { ...s, generation: s.revision }, { ...s, generation: s.revision + 1 },
    { ...s, pending: { ...pending, canonicalCreateBody: ` ${pending.canonicalCreateBody}` } },
    { ...s, pending: { ...pending, stage: "paid", created: null } }, { ...s, pending: { ...pending, created: authority.created.response } },
    { ...s, pending: { ...pending, extra: "ignored?" } }, { ...established(), active: { ...established().active!, source: "legacy" } },
  ]) expect(parseRecoveryState(changed)).toBeNull();
});

test("v2 identities keep authority bounds while legacy imports retain their narrower v1 contract", () => {
  const v7 = "00000000-0000-7000-8000-000000005101", product = "film_tool";
  const p = prepareRecoveryState({ databaseId, productId: product, serviceOrigin: origin, deviceId: v7 })!;
  expect(p).not.toBeNull(); const s = apply(p, { type: "activate" });
  expect(apply(s, { ...registrationEvent(), body: { ...authority.created.request, product, device: { id: v7 } } }).pending?.stage).toBe("create-pending");
  expect(prepareRecoveryState({ databaseId, productId, serviceOrigin: origin, deviceId: v7,
    legacy: { schemaVersion: CREDITS_STATE_SCHEMA, product: productId, deviceId: v7, token: oldToken } })).toBeNull();
  expect(prepareRecoveryState({ databaseId, productId: product, serviceOrigin: origin, deviceId,
    legacy: { schemaVersion: CREDITS_STATE_SCHEMA, product, deviceId, token: oldToken } })).toBeNull();
});

test("bounded snapshots reject huge keys, surrogate bypasses, duplicate keys, accessors and prototypes without reading values", () => {
  const s = prepared(); let reads = 0;
  const getter = { ...s }; Object.defineProperty(getter, "databaseId", { enumerable: true, get() { reads++; return databaseId; } }); expect(parseRecoveryState(getter)).toBeNull(); expect(reads).toBe(0);
  const withToJson = { ...s, toJSON() { reads++; return s; } }; expect(parseRecoveryState(withToJson)).toBeNull(); expect(reads).toBe(0);
  const cases: unknown[] = [{ ...s, ["x".repeat(1_000_000)]: 1 }, { ...s, databaseId: "\ud800" }, { ...s, extra: "🙂".repeat(RECOVERY_MAX_BYTES / 2) }, Object.assign(Object.create({ inherited: true }), s), JSON.stringify(s).replace('"revision":0', '"revision":0,"revision":1'), `${JSON.stringify(s)}${" ".repeat(RECOVERY_MAX_BYTES)}`];
  const cyclic: Record<string, unknown> = { ...s }; cyclic.extra = cyclic; cases.push(cyclic);
  for (const input of cases) expect(parseRecoveryState(input)).toBeNull();
  expect(parseRecoveryState(JSON.stringify(s))).toEqual(s); expect(prepareRecoveryState({ databaseId, productId, serviceOrigin: origin, deviceId, unexpected: true })).toBeNull();
});

test("guards, proposed next state and imported nested snapshots are frozen without freezing caller inputs", () => {
  const s = structuredClone(created()), before = structuredClone(s), event = { type: "status-v2", ticket: recoveryAction(s, "status-v2"), response: structuredClone(authority["status-paid"].response) };
  const d = transitionRecoveryState(s, event); expect(d.kind).toBe("commit"); if (d.kind !== "commit") return;
  expect(Object.isFrozen(d.expected)).toBe(true); expect(Object.isFrozen(d.next.pending)).toBe(true); expect(Object.isFrozen(d.next.pending?.kind === "registration-v2" && d.next.pending.created?.binding)).toBe(true);
  expect(() => { (d.next as { revision: number }).revision = 999; }).toThrow(); expect(d.expected.revision).toBe(s.revision);
  expect(s).toEqual(before); expect(Object.isFrozen(s)).toBe(false); expect(Object.isFrozen(event.response)).toBe(false);
});

test("safe counter exhaustion rejects mutations; fixed failures do not contain secret-bearing input", () => {
  const s = activeEmpty(); for (const state of [{ ...s, revision: Number.MAX_SAFE_INTEGER }, { ...s, revision: Number.MAX_SAFE_INTEGER, generation: Number.MAX_SAFE_INTEGER - 1 }]) {
    expect(parseRecoveryState(state)).not.toBeNull(); expect(transitionRecoveryState(state, { type: "signout" })).toEqual({ kind: "reject", reason: "counter-exhausted" });
  }
  const failure = transitionRecoveryState(registration(), { type: "unknown", secret: claimSecret, token: candidateToken }); expect(failure.kind).toBe("reject"); expect(JSON.stringify(failure)).not.toContain(claimSecret); expect(JSON.stringify(failure)).not.toContain(candidateToken);
});

test("64 seeded lifecycle laws preserve a single candidate across replay/ACK loss and fence stale generation", () => {
  fc.assert(fc.property(fc.integer({ min: 100, max: 100000 }), fc.boolean(), fc.integer({ min: 0, max: 4 }), (id, afterRegister, losses) => {
    const event = registrationEvent(id); event.candidateToken = `cr_dev_${String(id).padStart(43, "0")}`;
    let s = apply(activeEmpty(), event);
    for (let n = 0; n < losses; n++) { const t = recoveryAction(s, "create-v2")!; expect(transitionRecoveryState(s, { type: "uncertain", ticket: t }).kind).toBe("unchanged"); expect(transitionRecoveryState(s, event).kind).toBe("unchanged"); }
    s = committed(observe(s, "created-v2", "create-v2", authority.created.response)); s = committed(observe(s, "status-v2", "status-v2", authority["status-paid-after-expiry"].response));
    s = apply(s, { type: "begin-pickup" }); s = committed(observe(s, "pickup-v2", "pickup-v2", { ...authority.pickup.response, usable: afterRegister }));
    expect(readRecoveryToken(s)).toBeNull(); const oldTicket = recoveryAction(s, "ack-v2")!;
    const confirmed = committed(observe(s, "credential-v2", "credential-v2", authority["credential-after-ack"].response)); expect(readRecoveryToken(confirmed)).toBe(event.candidateToken);
    const out = apply(confirmed, { type: "signout" }); expect(readRecoveryToken(out)).toBeNull(); expect(transitionRecoveryState(out, { type: "ack-v2", ticket: oldTicket, response: authority.ack.response }).kind).toBe("reject");
  }), { seed: 20260920, numRuns: 64 });
});

// The authority fixture constant below is copied byte-for-byte at the value level
// from a retained synthetic actual-handler capture (not a live service).
// Capture SHA256:4764469e7b49d95dea72f4afe97c13385b5a73b504d34511e4d4258c771a15d1.
// Model tokens above are local synthetic inputs; this does not authenticate them.

const authority = {
  "created": {
    "request": {
      "schemaVersion": "hraness-credits-claim-create-v2",
      "creationId": "00000000-0000-4000-8000-000000005100",
      "product": "peopleblade",
      "device": {
        "id": "00000000-0000-4000-8000-000000005101",
        "label": "Synthetic fixture device"
      },
      "email": "fixture@example.com",
      "packId": "p25"
    },
    "response": {
      "schemaVersion": "hraness-credits-claim-created-v2",
      "creationId": "00000000-0000-4000-8000-000000005100",
      "binding": {
        "claimId": "00000000000000000000010003claims",
        "productId": "peopleblade",
        "deviceId": "00000000-0000-4000-8000-000000005101"
      },
      "createdAt": "2026-09-16T12:00:00.000Z",
      "expiresAt": "2026-09-17T12:00:00.000Z",
      "payUrl": "http://localhost:3000/t/00000000000000000000010003claims"
    }
  },
  "status-pending": {
    "request": null,
    "response": {
      "schemaVersion": "hraness-credits-pickup-response-v2",
      "operation": "status",
      "binding": {
        "claimId": "00000000000000000000010003claims",
        "productId": "peopleblade",
        "deviceId": "00000000-0000-4000-8000-000000005101"
      },
      "payment": "pending",
      "pickupState": "unregistered",
      "pickupId": null,
      "usable": null
    }
  },
  "status-paid": {
    "request": null,
    "response": {
      "schemaVersion": "hraness-credits-pickup-response-v2",
      "operation": "status",
      "binding": {
        "claimId": "00000000000000000000010003claims",
        "productId": "peopleblade",
        "deviceId": "00000000-0000-4000-8000-000000005101"
      },
      "payment": "paid",
      "pickupState": "unregistered",
      "pickupId": null,
      "usable": null
    }
  },
  "pickup": {
    "request": {
      "schemaVersion": "hraness-credits-pickup-request-v2",
      "operation": "pickup",
      "claimId": "00000000000000000000010003claims",
      "pickupId": "00000000-0000-4000-8000-000000005102",
      "tokenSha256": "e11529975b3504a3d7831c269d34352a7a10eff8baa5bd870a95803c1ce0d780"
    },
    "response": {
      "schemaVersion": "hraness-credits-pickup-response-v2",
      "operation": "pickup",
      "binding": {
        "claimId": "00000000000000000000010003claims",
        "productId": "peopleblade",
        "deviceId": "00000000-0000-4000-8000-000000005101"
      },
      "payment": "paid",
      "pickupState": "registered",
      "pickupId": "00000000-0000-4000-8000-000000005102",
      "usable": false
    }
  },
  "credential-before-ack": {
    "request": null,
    "response": {
      "schemaVersion": "hraness-credits-pickup-response-v2",
      "operation": "credential",
      "binding": {
        "claimId": "00000000000000000000010003claims",
        "productId": "peopleblade",
        "deviceId": "00000000-0000-4000-8000-000000005101"
      },
      "payment": "paid",
      "pickupState": "registered",
      "pickupId": "00000000-0000-4000-8000-000000005102",
      "usable": false
    }
  },
  "ack": {
    "request": {
      "schemaVersion": "hraness-credits-pickup-request-v2",
      "operation": "ack",
      "claimId": "00000000000000000000010003claims",
      "pickupId": "00000000-0000-4000-8000-000000005102"
    },
    "response": {
      "schemaVersion": "hraness-credits-pickup-response-v2",
      "operation": "ack",
      "binding": {
        "claimId": "00000000000000000000010003claims",
        "productId": "peopleblade",
        "deviceId": "00000000-0000-4000-8000-000000005101"
      },
      "payment": "paid",
      "pickupState": "acknowledged",
      "pickupId": "00000000-0000-4000-8000-000000005102",
      "usable": true
    }
  },
  "credential-after-ack": {
    "request": null,
    "response": {
      "schemaVersion": "hraness-credits-pickup-response-v2",
      "operation": "credential",
      "binding": {
        "claimId": "00000000000000000000010003claims",
        "productId": "peopleblade",
        "deviceId": "00000000-0000-4000-8000-000000005101"
      },
      "payment": "paid",
      "pickupState": "acknowledged",
      "pickupId": "00000000-0000-4000-8000-000000005102",
      "usable": true
    }
  },
  "status-paid-after-expiry": {
    "request": null,
    "response": {
      "schemaVersion": "hraness-credits-pickup-response-v2",
      "operation": "status",
      "binding": {
        "claimId": "00000000000000000000010003claims",
        "productId": "peopleblade",
        "deviceId": "00000000-0000-4000-8000-000000005101"
      },
      "payment": "paid",
      "pickupState": "acknowledged",
      "pickupId": "00000000-0000-4000-8000-000000005102",
      "usable": null
    }
  }
};
