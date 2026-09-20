import { expect, test } from "bun:test";
import fc from "fast-check";
import { parseRecoveryState, prepareRecoveryState, transitionRecoveryState, recoveryAction, readRecoveryToken,
  type RecoveryState, type RecoveryDecision, type RecoveryAction } from "../src/recovery-state.js";
import { topupAuthorityRecords as records } from "./fixtures/topup-v2-authority.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const token = "cr_dev_" + "t".repeat(43), otherToken = "cr_dev_" + "o".repeat(43);
const request = records[0].request, created = JSON.parse(records[0].rawResponse);
const response = (name: string) => records.find(record => record.name === name)!.rawResponse;
function committed(d: RecoveryDecision): RecoveryState { expect(d.kind).toBe("commit"); if (d.kind !== "commit") throw new Error("Expected fixture commit."); expect(parseRecoveryState(d.next)).toEqual(d.next); return d.next; }
const apply = (s: RecoveryState, event: unknown) => committed(transitionRecoveryState(s, event));
function established(source: "legacy" | "pickup-v2" = "legacy") {
  const p = prepareRecoveryState({ databaseId: uuid(20), productId: request.product, serviceOrigin: "http://localhost:3000", deviceId: request.device.id,
    legacy: { schemaVersion: "hraness-credits-state-v1", product: request.product, deviceId: request.device.id, token } })!;
  const s = apply(p, { type: "activate" });
  return source === "legacy" ? s : parseRecoveryState({ ...s, active: { token, source, binding: { claimId: "registration_original", productId: s.productId, deviceId: s.deviceId } } })!;
}
const event = () => ({ type: "prepare-topup-v2", operationId: request.creationId, body: request });
const prepared = () => apply(established(), event());
function observe(s: RecoveryState, type: string, action: RecoveryAction, payload: unknown) {
  return transitionRecoveryState(s, { type, ticket: recoveryAction(s, action), response: payload });
}
const claimPending = () => committed(observe(prepared(), "created-topup-v2", "create-topup-v2", response("created")));

test("v2 top-up saves exact canonical intent and original established credential before replayable creation", () => {
  for (const source of ["legacy", "pickup-v2"] as const) {
    const active = established(source), decision = transitionRecoveryState(active, event()), s = committed(decision);
    expect(decision.kind === "commit" && decision.afterCommitAction?.action).toBe("create-topup-v2");
    expect(s.active).toEqual(active.active); expect(readRecoveryToken(s)).toBe(token);
    expect(s.pending?.kind).toBe("topup-v2"); if (s.pending?.kind !== "topup-v2") throw new Error("Expected fixture kind.");
    expect(s.pending.originalToken).toBe(token); expect(JSON.parse(s.pending.canonicalCreateBody)).toEqual(request);
    expect(s.pending.created).toBeNull(); expect(s.pending.operationId).toBe(request.creationId);
    const reopened = parseRecoveryState(JSON.stringify(s))!;
    expect(recoveryAction(reopened, "create-topup-v2")).toEqual(recoveryAction(s, "create-topup-v2"));
    expect(transitionRecoveryState(reopened, { type: "uncertain", ticket: recoveryAction(s, "create-topup-v2") })).toEqual({ kind: "unchanged", state: reopened });
    expect(transitionRecoveryState(reopened, { ...event(), body: { packId: request.packId, email: request.email, device: request.device, product: request.product, creationId: request.creationId, schemaVersion: request.schemaVersion } })).toEqual({ kind: "unchanged", state: reopened });
  }
});

test("changed intent, credential, stage or canonical body rejects without replacing saved state", () => {
  const s = prepared(), p = s.pending!;
  for (const e of [{ ...event(), operationId: uuid(90) }, { ...event(), body: { ...request, email: "other@example.com" } },
    { ...event(), body: { ...request, packId: undefined } }, { ...event(), originalToken: otherToken },
    { ...event(), body: { ...request, creationId: uuid(90) } }, { type: "prepare-registration" }]) expect(transitionRecoveryState(s, e).kind).toBe("reject");
  for (const invalid of [{ ...s, active: null }, { ...s, active: { ...s.active!, token: otherToken } },
    { ...s, pending: { ...p, originalToken: otherToken } }, { ...s, pending: { ...p, operationId: uuid(90) } },
    { ...s, pending: { ...p, canonicalCreateBody: " " + p.canonicalCreateBody } }, { ...s, pending: { ...p, canonicalCreateBody: null } },
    { ...s, pending: { ...p, stage: "claim-pending" } }, { ...s, pending: { ...p, claimSecret: "x" } },
    { ...s, bootstrap: "prepared", revision: 0 }, { ...s, pending: { ...p, kind: "topup-v3" } }, { ...s, schemaVersion: "future" }]) expect(parseRecoveryState(invalid)).toBeNull();
  const signed = apply(established(), { type: "signout" }); expect(transitionRecoveryState(signed, event()).kind).toBe("reject");
});

test("creation loss replays one tuple and only a committed bound response exposes the pay URL", () => {
  for (const name of ["created", "exact-replay", "expired-replay", "paid-past-expiry-replay"]) {
    const s = prepared(), ticket = recoveryAction(s, "create-topup-v2")!, result = apply(s, { type: "created-topup-v2", ticket, response: response(name) });
    expect(result.pending?.kind === "topup-v2" && result.pending.created).toEqual(created);
    expect(result.pending?.stage).toBe("claim-pending"); expect(recoveryAction(result, "create-topup-v2")).toBeNull();
    expect(recoveryAction(result, "status-topup-v2")).not.toBeNull(); expect(readRecoveryToken(result)).toBe(token);
    expect(transitionRecoveryState(result, { type: "created-topup-v2", ticket, response: response(name) }).kind).toBe("reject");
  }
  const s = prepared();
  for (const length of [64, 65, 128]) {
    const claimId = "a".repeat(length), wire = { ...created, binding: { ...created.binding, claimId }, payUrl: `http://localhost:3000/t/${claimId}` };
    expect(observe(s, "created-topup-v2", "create-topup-v2", wire).kind).toBe(length === 64 ? "commit" : "reject");
  }
});

test("paid after original expiry clears only pending and advances generation without rotating credentials", () => {
  const s = claimPending(), ticket = recoveryAction(s, "status-topup-v2")!;
  expect(observe(s, "status-topup-v2", "status-topup-v2", response("pending-status"))).toEqual({ kind: "unchanged", state: s });
  const paid = apply(s, { type: "status-topup-v2", ticket, response: { ...JSON.parse(response("paid-status")), paidAt: "2026-09-20T12:00:00.000Z" } });
  expect(paid.active).toEqual(s.active); expect(paid.pending).toBeNull(); expect(paid.generation).toBe(s.generation + 1);
  expect(paid.deviceId).toBe(s.deviceId); expect(paid.databaseId).toBe(s.databaseId); expect(paid.serviceOrigin).toBe(s.serviceOrigin);
  expect(transitionRecoveryState(paid, { type: "status-topup-v2", ticket, response: response("paid-status") }).kind).toBe("reject");
});

test("expiry, clearing and signout fence earlier replies and remove pending bearer copies", () => {
  const s = claimPending(), ticket = recoveryAction(s, "status-topup-v2")!;
  const expired = apply(s, { type: "status-topup-v2", ticket, response: response("expired-status") });
  expect(expired.pending?.stage).toBe("expired"); expect(expired.active).toEqual(s.active);
  expect(transitionRecoveryState(expired, { type: "status-topup-v2", ticket, response: response("paid-status") }).kind).toBe("reject");
  const cleared = apply(expired, { type: "clear-expired" }); expect(cleared.pending).toBeNull(); expect(cleared.active).toEqual(s.active); expect(cleared.generation).toBe(s.generation + 1);
  for (const state of [prepared(), s, expired]) {
    const signed = apply(state, { type: "signout" }); expect(signed.active).toBeNull(); expect(signed.pending).toBeNull(); expect(JSON.stringify(signed)).not.toContain(token);
    expect(transitionRecoveryState(signed, { type: "status-topup-v2", ticket, response: response("paid-status") }).kind).toBe("reject");
  }
});

test("observed expiry permits fresh status-only reconciliation of a later settled checkout", () => {
  const s = claimPending(), beforeExpiry = recoveryAction(s, "status-topup-v2")!;
  const expired = apply(s, { type: "status-topup-v2", ticket: beforeExpiry, response: response("expired-status") });
  const fresh = recoveryAction(expired, "status-topup-v2")!;
  expect(fresh).not.toBeNull(); expect(fresh.preparedRevision).toBe(expired.revision);
  expect(recoveryAction(expired, "create-topup-v2")).toBeNull();
  for (const name of ["pending-status", "expired-status"]) expect(transitionRecoveryState(expired, { type: "status-topup-v2", ticket: fresh, response: response(name) })).toEqual({ kind: "unchanged", state: expired });
  const paid = { ...JSON.parse(response("paid-status")), paidAt: "2026-09-20T12:00:00.000Z" };
  expect(transitionRecoveryState(expired, { type: "status-topup-v2", ticket: beforeExpiry, response: paid }).kind).toBe("reject");
  const completed = apply(expired, { type: "status-topup-v2", ticket: fresh, response: paid });
  expect(completed.pending).toBeNull(); expect(completed.active).toEqual(s.active); expect(completed.generation).toBe(expired.generation + 1);
  for (const type of ["clear-expired", "signout"]) {
    const closed = apply(expired, { type });
    expect(transitionRecoveryState(closed, { type: "status-topup-v2", ticket: fresh, response: paid }).kind).toBe("reject");
  }
});

test("mode and ticket mismatches cannot consume or replace a returning user's credential", () => {
  const s = prepared(), ticket = recoveryAction(s, "create-topup-v2")!;
  for (const wrong of [{ ...ticket, action: "create-v2" }, { ...ticket, action: "create-topup-v1" }, { ...ticket, generation: 1 },
    { ...ticket, preparedRevision: s.revision + 1 }, { ...ticket, databaseId: uuid(99) }, { ...ticket, operationId: uuid(99) }])
    expect(transitionRecoveryState(s, { type: "created-topup-v2", ticket: wrong, response: created }).kind).toBe("reject");
  for (const action of ["create-v2", "status-v2", "pickup-v2", "ack-v2", "credential-v2", "create-topup-v1", "status-topup-v1"] as const) {
    expect(recoveryAction(s, action)).toBeNull(); expect(recoveryAction(claimPending(), action)).toBeNull();
  }
  for (const type of ["created-v2", "created-topup-v1", "pickup-v2", "ack-v2"]) expect(transitionRecoveryState(s, { type, ticket, response: created }).kind).toBe("reject");
  const pending = claimPending();
  for (const wire of [{ error: "unauthorized" }, { error: "conflict" }, { error: "expired" }, { ...JSON.parse(response("paid-status")), token }, { ...JSON.parse(response("paid-status")), state: "consumed" }])
    expect(observe(pending, "status-topup-v2", "status-topup-v2", wire).kind).toBe("reject");
  expect(transitionRecoveryState(pending, { type: "local-expiry", nowMs: Number.MAX_SAFE_INTEGER }).kind).toBe("reject");
});

test("legacy lost-create and migrated known claims remain v1 and cannot be upgraded retrospectively", () => {
  const active = established(), old = apply(active, { type: "prepare-topup", operationId: uuid(70), body: { product: active.productId, device: { id: active.deviceId }, subjectToken: token } });
  const dispatched = apply(old, { type: "dispatch-topup" }); expect(recoveryAction(dispatched, "create-topup-v1")).toBeNull();
  expect(transitionRecoveryState(dispatched, event()).kind).toBe("reject"); expect(parseRecoveryState(JSON.stringify(dispatched))).toEqual(dispatched);
  const p = prepareRecoveryState({ databaseId: active.databaseId, productId: active.productId, serviceOrigin: active.serviceOrigin, deviceId: active.deviceId, legacyOperationId: uuid(71),
    legacy: { schemaVersion: "hraness-credits-state-v1", product: active.productId, deviceId: active.deviceId, token, pendingClaim: { id: "known_old", expiresAt: "2026-09-22T00:00:00Z" } } })!;
  const migrated = apply(p, { type: "activate" }); expect(migrated.pending?.canonicalCreateBody).toBeNull(); expect(recoveryAction(migrated, "status-topup-v1")).not.toBeNull();
  expect(recoveryAction(migrated, "create-topup-v2")).toBeNull(); expect(transitionRecoveryState(migrated, event()).kind).toBe("reject");
});

test("frozen decisions and finite counters retain state without leaking a mutable guard", () => {
  const s = structuredClone(established()), before = structuredClone(s), e = structuredClone(event());
  const decision = transitionRecoveryState(s, e); expect(decision.kind).toBe("commit"); if (decision.kind !== "commit") return;
  expect(Object.isFrozen(decision.expected)).toBe(true); expect(Object.isFrozen(decision.next.pending)).toBe(true);
  expect(() => { (decision.next.pending as { originalToken: string }).originalToken = otherToken; }).toThrow();
  expect(s).toEqual(before); expect(Object.isFrozen(e.body)).toBe(false);
  const exhausted = { ...claimPending(), revision: Number.MAX_SAFE_INTEGER, generation: Number.MAX_SAFE_INTEGER - 1 };
  expect(observe(exhausted, "status-topup-v2", "status-topup-v2", response("paid-status"))).toEqual({ kind: "reject", reason: "counter-exhausted" });
});

test("64 seeded intent lifecycles preserve exact original tokens and stale-response fences", () => {
  fc.assert(fc.property(fc.integer({ min: 2000, max: 900000 }), fc.boolean(), (id, signout) => {
    const start = established(), body = { ...request, creationId: uuid(id) }, prepare = { type: "prepare-topup-v2", operationId: body.creationId, body };
    const s = apply(start, prepare), ticket = recoveryAction(s, "create-topup-v2")!;
    expect(transitionRecoveryState(s, prepare)).toEqual({ kind: "unchanged", state: s });
    const pending = apply(s, { type: "created-topup-v2", ticket, response: { ...created, creationId: body.creationId } });
    const statusTicket = recoveryAction(pending, "status-topup-v2")!;
    const done = signout ? apply(pending, { type: "signout" }) : apply(pending, { type: "status-topup-v2", ticket: statusTicket, response: response("paid-status") });
    expect(done.pending).toBeNull(); expect(readRecoveryToken(done)).toBe(signout ? null : token);
    expect(transitionRecoveryState(done, { type: "status-topup-v2", ticket: statusTicket, response: response("paid-status") }).kind).toBe("reject");
  }), { seed: 20260921, numRuns: 64 });
});
