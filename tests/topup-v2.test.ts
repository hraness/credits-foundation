import { expect, test } from "bun:test";
import {
  CREDITS_TOPUP_CREATE_V2, CREDITS_TOPUP_CREATED_V2, parseCreditsTopupCreateV2,
  parseCreditsTopupCreatedV2, parseCreditsTopupStatusV2, parseCreditsClaimCreateV2,
  parseCreditsClaimCreatedV2, parseCreditsPickupResponseV2, parseCreditsErrorV2,
} from "../src/pickup-v2.js";
import { topupAuthorityRecords as records } from "./fixtures/topup-v2-authority.js";

export const request = records[0].request;
export const created = JSON.parse(records[0].rawResponse);
export const expectation = { creationId: request.creationId, productId: request.product,
  deviceId: request.device.id, serviceOrigin: "http://localhost:3000" };
const statusExpected = { claimId: created.binding.claimId, createdAt: created.createdAt, expiresAt: created.expiresAt };
const status = (name: string) => JSON.parse(records.find(record => record.name === name)!.rawResponse);

test("all nine actual-handler fixtures retain creation replay, payment status and fixed errors", () => {
  expect(records.length).toBe(9);
  for (const record of records) {
    if (record.status !== 200) expect(parseCreditsErrorV2(record.rawResponse, record.status)).toEqual(JSON.parse(record.rawResponse));
    else if (record.method === "POST") {
      expect(parseCreditsTopupCreateV2(record.request)).toEqual(request);
      expect(parseCreditsTopupCreatedV2(record.rawResponse, expectation)).toEqual(created);
    } else expect(parseCreditsTopupStatusV2(record.rawResponse, statusExpected)).toEqual(JSON.parse(record.rawResponse));
  }
});

test("top-up and registration creation schemas are disjoint in both directions", () => {
  expect(parseCreditsClaimCreateV2(request)).toBeNull();
  expect(parseCreditsTopupCreateV2({ ...request, schemaVersion: "hraness-credits-claim-create-v2" })).toBeNull();
  expect(parseCreditsClaimCreatedV2(created, expectation)).toBeNull();
  expect(parseCreditsTopupCreatedV2({ ...created, schemaVersion: "hraness-credits-claim-created-v2" }, expectation)).toBeNull();
  expect(parseCreditsPickupResponseV2(created, { operation: "status", binding: created.binding, pickupId: null })).toBeNull();
  expect(CREDITS_TOPUP_CREATE_V2).toBe(request.schemaVersion); expect(CREDITS_TOPUP_CREATED_V2).toBe(created.schemaVersion);
});

test("creation bounds preserve absent optionals and reject secrets and unsafe display values", () => {
  const minimal = { schemaVersion: request.schemaVersion, creationId: request.creationId, product: request.product, device: { id: request.device.id } };
  expect(parseCreditsTopupCreateV2(minimal)).toEqual(minimal);
  for (const change of [{ subjectToken: "cr_dev_x" }, { claimSecret: "x" }, { candidateToken: "x" }, { price: 25 }, { resume: true },
    { email: undefined }, { email: null }, { email: "x".repeat(321) }, { email: "bad" }, { packId: "x".repeat(33) }, { product: "UPPER" },
    { creationId: request.creationId.toUpperCase().replace("00000000", "AAAAAAAA") }, { creationId: "bad" },
    { device: { id: request.device.id, label: "" } }, { device: { id: request.device.id, label: "x".repeat(65) } },
    { device: { id: request.device.id, label: "a\n" } }, { device: { id: request.device.id, label: "a\u202e" } },
    { device: { id: request.device.id, label: "a\u2028" } }, { device: { id: request.device.id, label: "\ud800" } }]) {
    expect(parseCreditsTopupCreateV2({ ...request, ...change })).toBeNull();
  }
  for (const id of ["00000000-0000-7000-8000-000000000001", "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"])
    expect(parseCreditsTopupCreateV2({ ...minimal, creationId: id, device: { id } })).not.toBeNull();
});

test("raw wire and expectation snapshots reject duplicates, excessive bytes and hostile objects", () => {
  const json = JSON.stringify(request);
  for (const raw of [json.replace('"product":"peopleblade"', '"product":"other","pr\\u006fduct":"peopleblade"'),
    json + " ".repeat(4096), json.replace('"original"', '"\udfff"'), "[".repeat(10) + json + "]".repeat(10)]) expect(parseCreditsTopupCreateV2(raw)).toBeNull();
  let reads = 0;
  const getter = { ...request }; Object.defineProperty(getter, "creationId", { enumerable: true, get() { reads++; return request.creationId; } });
  for (const value of [getter, { ...request, toJSON() { reads++; return request; } }, Object.assign(Object.create({}), request),
    { ...request, [Symbol("x")]: 1 }, { ...request, ["x".repeat(100000)]: 1 }]) expect(parseCreditsTopupCreateV2(value)).toBeNull();
  expect(reads).toBe(0);
  const badExpected = { ...expectation }; Object.defineProperty(badExpected, "creationId", { enumerable: true, get() { reads++; return request.creationId; } });
  expect(parseCreditsTopupCreatedV2(created, badExpected)).toBeNull(); expect(reads).toBe(0);
  expect(parseCreditsTopupCreatedV2(JSON.stringify(created) + " ".repeat(16384), expectation)).toBeNull();
});

test("creation replies bind the saved tuple and exact configured payment URL", () => {
  for (const change of [{ creationId: "00000000-0000-4000-8000-000000000002" }, { binding: { ...created.binding, productId: "other" } },
    { binding: { ...created.binding, deviceId: "00000000-0000-4000-8000-000000000002" } }, { expiresAt: created.createdAt },
    { createdAt: "2026-02-30T00:00:00Z" }, { token: "x" }, { claimSecret: "x" }, { pickupId: "x" }, { state: "paid" }]) {
    expect(parseCreditsTopupCreatedV2({ ...created, ...change }, expectation)).toBeNull();
  }
  for (const payUrl of [created.payUrl + "?x=1", created.payUrl + "#x", created.payUrl.replace("localhost", "elsewhere.invalid"),
    created.payUrl.replace("http://", "http://user:pass@"), created.payUrl + "/", created.payUrl.replace("/t/", "/t/../t/")])
    expect(parseCreditsTopupCreatedV2({ ...created, payUrl }, expectation)).toBeNull();
  expect(parseCreditsTopupCreatedV2(created, { ...expectation, claimId: "different" })).toBeNull();
  expect(parseCreditsTopupCreatedV2(created, { ...expectation, serviceOrigin: "http://localhost:3000/" })).toBeNull();
});

test("pure creation admits authority128 IDs but payment status retains the actual64 route bound", () => {
  for (const length of [64, 65, 128, 129]) {
    const claimId = "a".repeat(length), response = { ...created, binding: { ...created.binding, claimId }, payUrl: `${expectation.serviceOrigin}/t/${claimId}` };
    expect(parseCreditsTopupCreatedV2(response, expectation) !== null).toBe(length <= 128);
    expect(parseCreditsTopupStatusV2({ ...status("pending-status"), claimId }, { ...statusExpected, claimId }) !== null).toBe(length <= 64);
  }
});

test("payment-only status cannot mint credentials or confuse unpaid and paid evidence", () => {
  const pending = status("pending-status"), paid = status("paid-status");
  for (const response of [{ ...pending, token: undefined }, { ...paid, token: "cr_dev_" + "x".repeat(43) },
    { ...paid, state: "consumed" }, { ...paid, claimId: "other" }, { ...paid, expiresAt: "2026-09-18T12:00:00.000Z" },
    { ...paid, paidAt: "2026-09-15T12:00:00.000Z" }, { ...paid, paidAt: undefined },
    { ...pending, paidAt: paid.paidAt }, { ...pending, state: "expired", paidAt: paid.paidAt },
    { ...paid, pickupState: "acknowledged" }, { ...paid, schemaVersion: "hraness-credits-pickup-response-v2" }])
    expect(parseCreditsTopupStatusV2(response, statusExpected)).toBeNull();
  const { paidAt: _paidAt, ...missingPaid } = paid; expect(parseCreditsTopupStatusV2(missingPaid, statusExpected)).toBeNull();
  expect(parseCreditsTopupStatusV2({ ...paid, paidAt: "2026-09-20T12:00:00.000Z" }, statusExpected)).not.toBeNull();
  for (const balance of [{ ...paid.balance, credits: 1 }, { ...paid.balance, usd: "0.00" }, { ...paid.balance, extra: 1 },
    { microUsd: Number.MAX_SAFE_INTEGER + 1, credits: 0, usd: "0.00" }, undefined])
    expect(parseCreditsTopupStatusV2({ ...paid, balance }, statusExpected)).toBeNull();
});

test("outputs and nested bindings are frozen without changing caller input", () => {
  const input = structuredClone(created), result = parseCreditsTopupCreatedV2(input, expectation)!;
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.binding)).toBe(true); expect(Object.isFrozen(input)).toBe(false);
  expect(() => { (result.binding as { claimId: string }).claimId = "changed"; }).toThrow();
  expect(parseCreditsTopupCreateV2(JSON.stringify(request))).toEqual(request);
});
