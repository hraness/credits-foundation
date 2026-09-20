import { describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import {
  CREDITS_CLAIM_CREATE_V2, CREDITS_CLAIM_CREATED_V2, CREDITS_PICKUP_REQUEST_V2, CREDITS_PICKUP_RESPONSE_V2,
  CREDITS_BALANCE_V2, CREDITS_V2_MAX_REQUEST_BYTES, CREDITS_V2_MAX_RESPONSE_BYTES,
  parseCreditsClaimCreateV2, parseCreditsClaimCreatedV2, parseCreditsPickupRequestV2, parseCreditsPickupResponseV2,
  parseCreditsBalanceV2, parseCreditsErrorV2, type CreditsPickupExpectationV2,
} from "../src/pickup-v2.js";

const creationId = "00000000-0000-4000-8000-000000001001";
const deviceId = "00000000-0000-4000-8000-000000000001";
const pickupId = "00000000-0000-4000-8000-000000002001";
const binding = { claimId: "synthetic_claim_1", productId: "product_1", deviceId };
const origin = "https://credits.example.test";
const create = { schemaVersion: CREDITS_CLAIM_CREATE_V2, creationId, product: binding.productId,
  device: { id: deviceId, label: "saved client" }, email: "original@example.com", packId: "p25" };
const created = { schemaVersion: CREDITS_CLAIM_CREATED_V2, creationId, binding,
  createdAt: "2026-09-16T12:00:00.000Z", expiresAt: "2026-09-17T12:00:00.000Z", payUrl: `${origin}/t/${binding.claimId}` };
const expectedCreation = { creationId, productId: binding.productId, deviceId, serviceOrigin: origin };
const response = { schemaVersion: CREDITS_PICKUP_RESPONSE_V2, operation: "pickup" as const, binding,
  payment: "paid" as const, pickupState: "registered" as const, pickupId, usable: false };
const expected: CreditsPickupExpectationV2 = { operation: "pickup", binding, pickupId };
const balance = { schemaVersion: CREDITS_BALANCE_V2, product: { id: binding.productId, name: "Product one" },
  balance: { microUsd: 25_000_000, credits: 2500, usd: "25.00" }, held: { microUsd: 0 }, lowBalance: false,
  packs: [{ id: "p25", label: "$25: 2,500 credits", usd: 25, credits: 2500, bonusCredits: 0 }], suggestedPackId: "p25" };
const clone = <T>(value: T): T => structuredClone(value);
const changed = <T>(value: T, mutation: (copy: T) => void): T => { const copy = clone(value); mutation(copy); return copy; };

describe("inactive credits v2 wire", () => {
  test("creation keeps optional distinctions and excludes bearer material", () => {
    expect<unknown>(parseCreditsClaimCreateV2(create)).toEqual(create);
    const bare = { schemaVersion: CREDITS_CLAIM_CREATE_V2, creationId, product: binding.productId, device: { id: deviceId } };
    expect<unknown>(parseCreditsClaimCreateV2(JSON.stringify(bare))).toEqual(bare);
    for (const key of ["claimSecret", "secretHash", "token", "subjectToken", "authorization", "unknown"]) {
      expect(parseCreditsClaimCreateV2({ ...create, [key]: "synthetic-private-value" })).toBeNull();
    }
    for (const value of [undefined, null, "", "x".repeat(65)]) {
      expect(parseCreditsClaimCreateV2({ ...create, device: { id: deviceId, label: value } })).toBeNull();
    }
    expect(parseCreditsClaimCreateV2({ ...bare, email: undefined })).toBeNull();
    expect(parseCreditsClaimCreateV2({ ...create, email: `${"x".repeat(314)}@a.co` })).not.toBeNull();
    expect(parseCreditsClaimCreateV2({ ...create, email: `${"x".repeat(316)}@a.co` })).toBeNull();
  });

  test("v2 identifiers do not inherit v1 product/claim/v4-only bounds", () => {
    const product = "9_under-score";
    expect(parseCreditsClaimCreateV2({ ...create, product })).not.toBeNull();
    expect(parseCreditsClaimCreateV2({ ...create, product: "x".repeat(32) })).not.toBeNull();
    expect(parseCreditsClaimCreateV2({ ...create, product: "x".repeat(33) })).toBeNull();
    for (const id of [deviceId.replace("-4000-", "-7000-"), "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
      expect(parseCreditsClaimCreateV2({ ...create, creationId: id, device: { id } })).not.toBeNull();
    }
    expect(parseCreditsClaimCreateV2({ ...create, creationId: creationId.replace("-4000-", "-9000-") })).toBeNull();
    const arbitraryGuid = "01234567-89ab-cdef-0123-456789abcdef";
    expect(parseCreditsPickupRequestV2({ schemaVersion: CREDITS_PICKUP_REQUEST_V2, operation: "ack", claimId: "x".repeat(128), pickupId: arbitraryGuid })).not.toBeNull();
    expect(parseCreditsPickupRequestV2({ schemaVersion: CREDITS_PICKUP_REQUEST_V2, operation: "status", claimId: "x".repeat(129) })).toBeNull();
    expect(parseCreditsPickupRequestV2({ schemaVersion: CREDITS_PICKUP_REQUEST_V2, operation: "ack", claimId: "x", pickupId: arbitraryGuid.toUpperCase() })).toBeNull();
  });

  test("created response binds creation/product/device and remembered claim", () => {
    expect<unknown>(parseCreditsClaimCreatedV2(created, expectedCreation)).toEqual(created);
    expect<unknown>(parseCreditsClaimCreatedV2(created, { ...expectedCreation, claimId: binding.claimId })).toEqual(created);
    for (const mutation of [
      (x: typeof created) => { x.creationId = pickupId; },
      (x: typeof created) => { x.binding.productId = "another"; },
      (x: typeof created) => { x.binding.deviceId = pickupId; },
    ]) expect(parseCreditsClaimCreatedV2(changed(created, mutation), expectedCreation)).toBeNull();
    expect(parseCreditsClaimCreatedV2(created, { ...expectedCreation, claimId: "another" })).toBeNull();
    expect(parseCreditsClaimCreatedV2({ ...created, payment: "paid" }, expectedCreation)).toBeNull();
    expect(parseCreditsClaimCreatedV2({ ...created, token: "cr_dev_" + "A".repeat(43) }, expectedCreation)).toBeNull();
  });

  test("pay URL must equal the configured origin and exact claim path byte-for-byte", () => {
    for (const url of [
      `https://other.test/t/${binding.claimId}`, `${created.payUrl}/`, `${created.payUrl}?x=1`, `${created.payUrl}#x`,
      `${origin}/t/another`, `${origin}/a/../t/${binding.claimId}`, `${origin}/t/%73ynthetic_claim_1`,
      `https://user@credits.example.test/t/${binding.claimId}`, `https://credits.example.test:443/t/${binding.claimId}`,
      `https://CREDITS.example.test/t/${binding.claimId}`, ` ${created.payUrl}`, `${origin}\\t\\${binding.claimId}`,
    ]) expect(parseCreditsClaimCreatedV2({ ...created, payUrl: url }, expectedCreation)).toBeNull();
    for (const serviceOrigin of [origin + "/", origin + "/path", origin + "?q=1", "http://remote.test", "file:///tmp", "https://user@credits.example.test"]) {
      expect(parseCreditsClaimCreatedV2(created, { ...expectedCreation, serviceOrigin })).toBeNull();
    }
    for (const serviceOrigin of ["http://localhost:3000", "http://127.0.0.1:8787", "http://[::1]:3000"]) {
      expect(parseCreditsClaimCreatedV2({ ...created, payUrl: `${serviceOrigin}/t/${binding.claimId}` }, { ...expectedCreation, serviceOrigin })).not.toBeNull();
    }
  });

  test("timestamp calendar and interval semantics are validated without a current clock", () => {
    expect(parseCreditsClaimCreatedV2({ ...created, createdAt: "2024-02-29T12:00+01:00", expiresAt: "2024-03-01T11:01Z" }, expectedCreation)).not.toBeNull();
    for (const expiresAt of [created.createdAt, "2020-01-01T00:00:00Z", "2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-09-17T24:00Z", "2026-09-17T12:00:60Z", "2026-09-17 12:00:00Z", "2026-09-17T12:00:00"]) {
      expect(parseCreditsClaimCreatedV2({ ...created, expiresAt }, expectedCreation)).toBeNull();
    }
  });

  test("request fields are exact for each operation", () => {
    for (const operation of ["status", "credential"] as const) {
      const request = { schemaVersion: CREDITS_PICKUP_REQUEST_V2, operation, claimId: binding.claimId };
      expect<unknown>(parseCreditsPickupRequestV2(request)).toEqual(request);
      expect(parseCreditsPickupRequestV2({ ...request, pickupId })).toBeNull();
    }
    const request = { schemaVersion: CREDITS_PICKUP_REQUEST_V2, operation: "pickup", claimId: binding.claimId, pickupId, tokenSha256: "a".repeat(64) };
    expect<unknown>(parseCreditsPickupRequestV2(request)).toEqual(request);
    for (const tokenSha256 of ["A".repeat(64), "a".repeat(63), "cr_dev_" + "A".repeat(43), null]) {
      expect(parseCreditsPickupRequestV2({ ...request, tokenSha256 })).toBeNull();
    }
    expect(parseCreditsPickupRequestV2({ ...request, operation: "ack" })).toBeNull();
    expect(parseCreditsPickupRequestV2({ ...request, schemaVersion: "hraness-credits-claim-v1" })).toBeNull();
  });

  test("pickup response binds operation and every persisted identity", () => {
    expect<unknown>(parseCreditsPickupResponseV2(response, expected)).toEqual(response);
    for (const operation of ["status", "credential", "ack"] as const) expect(parseCreditsPickupResponseV2(response, { ...expected, operation })).toBeNull();
    for (const key of ["claimId", "productId", "deviceId"] as const) {
      const other = { ...binding, [key]: key === "deviceId" ? pickupId : "another" };
      expect(parseCreditsPickupResponseV2(response, { ...expected, binding: other })).toBeNull();
    }
    expect(parseCreditsPickupResponseV2(response, { ...expected, pickupId: deviceId })).toBeNull();
    expect(parseCreditsPickupResponseV2(response, { ...expected, pickupId: null })).toBeNull();
    for (const key of ["token", "tokenSha256", "claimSecret", "secret", "issuerPolicyRevision", "accountId", "revision", "requirements"]) {
      expect(parseCreditsPickupResponseV2({ ...response, [key]: "synthetic-private-value" }, expected)).toBeNull();
    }
  });

  test("status observes payment/revocation without claiming credential usability", () => {
    const state = { ...response, operation: "status", pickupState: "unregistered", pickupId: null, usable: null };
    for (const payment of ["pending", "paid", "expired"]) {
      expect(parseCreditsPickupResponseV2({ ...state, payment }, { ...expected, operation: "status" })).not.toBeNull();
      expect(parseCreditsPickupResponseV2({ ...state, payment }, { ...expected, operation: "status", pickupId: null })).not.toBeNull();
    }
    expect(parseCreditsPickupResponseV2({ ...state, pickupState: "revoked", pickupId }, { ...expected, operation: "status" })).not.toBeNull();
    for (const usable of [true, false]) expect(parseCreditsPickupResponseV2({ ...state, usable }, { ...expected, operation: "status" })).toBeNull();
    expect(parseCreditsPickupResponseV2({ ...state, pickupState: "registered" }, { ...expected, operation: "status" })).toBeNull();
  });

  test("registered usability reflects either issuer policy; acknowledged requires true", () => {
    for (const operation of ["pickup", "credential"] as const) {
      for (const usable of [false, true]) expect(parseCreditsPickupResponseV2({ ...response, operation, usable }, { ...expected, operation })).not.toBeNull();
      for (const pickupState of ["unregistered", "revoked"]) expect(parseCreditsPickupResponseV2({ ...response, operation, pickupState }, { ...expected, operation })).toBeNull();
    }
    for (const operation of ["pickup", "credential", "ack"] as const) {
      const acked = { ...response, operation, pickupState: "acknowledged", usable: true };
      expect(parseCreditsPickupResponseV2(acked, { ...expected, operation })).not.toBeNull();
      expect(parseCreditsPickupResponseV2({ ...acked, usable: false }, { ...expected, operation })).toBeNull();
    }
    expect(parseCreditsPickupResponseV2({ ...response, operation: "ack" }, { ...expected, operation: "ack" })).toBeNull();
    for (const payment of ["pending", "expired"]) expect(parseCreditsPickupResponseV2({ ...response, payment }, expected)).toBeNull();
  });

  test("balance validates authoritative truncation including negative subcent amounts", () => {
    expect<unknown>(parseCreditsBalanceV2(balance, binding.productId)).toEqual(balance);
    expect(parseCreditsBalanceV2(balance, "another")).toBeNull();
    for (const money of [{ microUsd: -12345, credits: -1, usd: "-0.01" }, { microUsd: -1, credits: 0, usd: "-0.00" }]) {
      expect(parseCreditsBalanceV2({ ...balance, balance: money }, binding.productId)).not.toBeNull();
    }
    expect(parseCreditsBalanceV2({ ...balance, balance: { microUsd: -12345, credits: -2, usd: "-0.02" } }, binding.productId)).toBeNull();
    for (const money of [{ ...balance.balance, credits: 1.5 }, { ...balance.balance, usd: "25" }, { ...balance.balance, microUsd: 0.5 },
      { ...balance.balance, microUsd: Number.MAX_SAFE_INTEGER + 1 }, { ...balance.balance, microUsd: NaN }, { ...balance.balance, microUsd: Infinity }]) {
      expect(parseCreditsBalanceV2({ ...balance, balance: money }, binding.productId)).toBeNull();
    }
    expect(parseCreditsBalanceV2({ ...balance, held: { microUsd: -1 } }, binding.productId)).toBeNull();
    expect(parseCreditsBalanceV2({ ...balance, held: { microUsd: 99_000_000 } }, binding.productId)).not.toBeNull();
  });

  test("public packs keep semantic consistency without reconstructing private pricing", () => {
    for (const packs of [[], Array(9).fill(balance.packs[0]), [balance.packs[0], balance.packs[0]],
      [{ ...balance.packs[0], credits: 2501 }], [{ ...balance.packs[0], bonusCredits: 0.1 }], [{ ...balance.packs[0], usd: 1001 }]]) {
      expect(parseCreditsBalanceV2({ ...balance, packs }, binding.productId)).toBeNull();
    }
    expect(parseCreditsBalanceV2({ ...balance, suggestedPackId: "missing" }, binding.productId)).toBeNull();
    expect(parseCreditsBalanceV2({ ...balance, packs: [{ ...balance.packs[0], providerCost: 1 }] }, binding.productId)).toBeNull();
    expect(parseCreditsBalanceV2({ ...balance, token: "synthetic-private-value" }, binding.productId)).toBeNull();
  });

  test("fixed errors bind HTTP status and discard no unknown field silently", () => {
    for (const [error, status] of Object.entries({ unavailable: 503, unauthorized: 401, not_found: 404, invalid_request: 400,
      conflict: 409, expired: 410, rate_limited: 429, product_disabled: 503, too_large: 413 })) {
      expect<unknown>(parseCreditsErrorV2({ error }, status)).toEqual({ error });
      expect(parseCreditsErrorV2({ error }, 200)).toBeNull();
      expect(parseCreditsErrorV2({ error, message: "synthetic-secret" }, status)).toBeNull();
    }
    expect(parseCreditsErrorV2({ error: "unknown" }, 500)).toBeNull();
  });

  test("request and response byte bounds include UTF-8 and raw JSON whitespace", () => {
    const raw = JSON.stringify({ ...create, device: { id: deviceId, label: "é".repeat(64) } });
    const padded = raw + " ".repeat(CREDITS_V2_MAX_REQUEST_BYTES - new TextEncoder().encode(raw).length);
    expect(parseCreditsClaimCreateV2(padded)).not.toBeNull();
    expect(parseCreditsClaimCreateV2(padded + " ")).toBeNull();
    expect((padded + " ").length).toBeLessThan(CREDITS_V2_MAX_REQUEST_BYTES);
    const responseJson = JSON.stringify(response);
    const bounded = responseJson + " ".repeat(CREDITS_V2_MAX_RESPONSE_BYTES - responseJson.length);
    expect(parseCreditsPickupResponseV2(bounded, expected)).not.toBeNull();
    expect(parseCreditsPickupResponseV2(bounded + " ", expected)).toBeNull();
  });

  test("JSON duplicate keys, malformed input, Unicode and cycles fail closed", () => {
    const json = JSON.stringify(create);
    expect(parseCreditsClaimCreateV2('{"creationId":"other",' + json.slice(1))).toBeNull();
    expect(parseCreditsClaimCreateV2('{"creation\\u0049d":"other",' + json.slice(1))).toBeNull();
    for (const value of ["{", "null", "[]", "true", json + "x", { ...create, email: "\ud800@x.test" }, { ...create, device: { id: deviceId, label: "\udc00" } }]) {
      expect(parseCreditsClaimCreateV2(value)).toBeNull();
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(parseCreditsClaimCreateV2(cycle)).toBeNull();
    expect(parseCreditsClaimCreateV2(JSON.parse('{"__proto__":{"polluted":true}}'))).toBeNull();
    expect(parseCreditsClaimCreateV2({ ...create, product: 1n })).toBeNull();
  });

  test("data descriptors, prototypes and array shape are checked without invoking getters", () => {
    let calls = 0;
    const accessor = { ...create, get email() { calls++; return "private@example.test"; } };
    expect(parseCreditsClaimCreateV2(accessor)).toBeNull();
    expect(parseCreditsClaimCreateV2({ ...create, toJSON() { calls++; return create; } })).toBeNull();
    expect(calls).toBe(0);
    expect(parseCreditsClaimCreateV2(Object.create(create))).toBeNull();
    expect(parseCreditsClaimCreateV2(Object.assign(Object.create(null), create))).not.toBeNull();
    expect(parseCreditsClaimCreateV2(Object.defineProperty(clone(create), "hidden", { value: 1 }))).toBeNull();
    expect(parseCreditsClaimCreateV2({ ...create, [Symbol("hidden")]: 1 })).toBeNull();
    const hostile = new Proxy(create, { getPrototypeOf() { throw new Error("synthetic-secret"); } });
    expect(parseCreditsClaimCreateV2(hostile)).toBeNull();
    const packs = clone(balance.packs); Object.defineProperty(packs, "secret", { value: "private", enumerable: true });
    expect(parseCreditsBalanceV2({ ...balance, packs }, binding.productId)).toBeNull();
    expect(parseCreditsBalanceV2({ ...balance, packs: Array(1) }, binding.productId)).toBeNull();
    expect(parseCreditsPickupResponseV2(response, Object.create(expected))).toBeNull();
  });

  test("oversized object keys are rejected before reserialization", () => {
    const input = { ["x".repeat(1_000_000)]: 1 };
    const stringify = spyOn(JSON, "stringify");
    try {
      expect(parseCreditsClaimCreateV2(input)).toBeNull();
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
    let lengthReads = 0;
    const packs = new Proxy(clone(balance.packs), { get(target, key, receiver) {
      if (key === "length") lengthReads++;
      return Reflect.get(target, key, receiver);
    } });
    expect(parseCreditsBalanceV2({ ...balance, packs }, binding.productId)).not.toBeNull();
    expect(lengthReads).toBe(0);
  });

  test("client display admission rejects unsafe controls without normalizing public text", () => {
    for (const control of ["\u0007", "\u001b", "\n", "\t", "\u200b", "\u202e", "\u2028", "\u2029"]) {
      expect(parseCreditsClaimCreateV2({ ...create, device: { id: deviceId, label: `a${control}b` } })).toBeNull();
      expect(parseCreditsBalanceV2({ ...balance, product: { ...balance.product, name: `a${control}b` } }, binding.productId)).toBeNull();
      expect(parseCreditsBalanceV2({ ...balance, packs: [{ ...balance.packs[0], label: `a${control}b` }] }, binding.productId)).toBeNull();
    }
    expect(parseCreditsClaimCreateV2({ ...create, device: { id: deviceId, label: " Café 東京 " } })?.device.label).toBe(" Café 東京 ");
  });

  test("fresh deeply frozen results neither freeze nor alias caller data", () => {
    const source = clone(balance), result = parseCreditsBalanceV2(source, binding.productId)!;
    expect(result).not.toBe(source);
    for (const object of [result, result.product, result.balance, result.held, result.packs, result.packs[0]]) expect(Object.isFrozen(object)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(source.packs[0])).toBe(false);
    source.packs[0]!.label = "edited";
    expect(result.packs[0]!.label).not.toBe("edited");
    expect(() => { (result.packs[0] as { label: string }).label = "edited"; }).toThrow();
    const pickup = parseCreditsPickupResponseV2(response, expected)!;
    expect(Object.isFrozen(pickup.binding)).toBe(true);
    expect(Object.isFrozen(expected.binding)).toBe(false);
    expect(Object.isFrozen(parseCreditsClaimCreateV2(create)!.device)).toBe(true);
  });

  test("bounded property law matches authority money projections over safe integer range", () => {
    fc.assert(fc.property(fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }), microUsd => {
      const negative = microUsd < 0, magnitude = Math.abs(microUsd);
      const money = { microUsd, credits: Math.trunc(microUsd / 10000),
        usd: `${negative ? "-" : ""}${Math.trunc(magnitude / 1000000)}.${String(Math.trunc((magnitude % 1000000) / 10000)).padStart(2, "0")}` };
      // JSON is the authority wire; it canonically serializes negative zero to zero.
      expect<unknown>(parseCreditsBalanceV2(JSON.stringify({ ...balance, balance: money }), binding.productId)?.balance).toEqual(JSON.parse(JSON.stringify(money)));
    }), { numRuns: 128, seed: 20260920 });
  });
});

// Independently captured actual enabled HTTP router + Convex handlers, convex-test@0.0.54.
// Private source fixture SHA256 4764469e7b49d95dea72f4afe97c13385b5a73b504d34511e4d4258c771a15d1.
// Synthetic data only; no bearer material, sibling imports, network or durability claim.
const capturedAuthority = [
  {"name":"created","requestBody":{"schemaVersion":"hraness-credits-claim-create-v2","creationId":"00000000-0000-4000-8000-000000005100","product":"peopleblade","device":{"id":"00000000-0000-4000-8000-000000005101","label":"Synthetic fixture device"},"email":"fixture@example.com","packId":"p25"},"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-claim-created-v2\",\"creationId\":\"00000000-0000-4000-8000-000000005100\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"createdAt\":\"2026-09-16T12:00:00.000Z\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"payUrl\":\"http://localhost:3000/t/00000000000000000000010003claims\"}"},
  {"name":"creation-replay-pending","requestBody":{"schemaVersion":"hraness-credits-claim-create-v2","creationId":"00000000-0000-4000-8000-000000005100","product":"peopleblade","device":{"id":"00000000-0000-4000-8000-000000005101","label":"Synthetic fixture device"},"email":"fixture@example.com","packId":"p25"},"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-claim-created-v2\",\"creationId\":\"00000000-0000-4000-8000-000000005100\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"createdAt\":\"2026-09-16T12:00:00.000Z\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"payUrl\":\"http://localhost:3000/t/00000000000000000000010003claims\"}"},
  {"name":"status-pending","requestBody":null,"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"status\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"pending\",\"pickupState\":\"unregistered\",\"pickupId\":null,\"usable\":null}"},
  {"name":"status-paid","requestBody":null,"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"status\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"paid\",\"pickupState\":\"unregistered\",\"pickupId\":null,\"usable\":null}"},
  {"name":"pickup","requestBody":{"schemaVersion":"hraness-credits-pickup-request-v2","operation":"pickup","claimId":"00000000000000000000010003claims","pickupId":"00000000-0000-4000-8000-000000005102","tokenSha256":"e11529975b3504a3d7831c269d34352a7a10eff8baa5bd870a95803c1ce0d780"},"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"pickup\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"paid\",\"pickupState\":\"registered\",\"pickupId\":\"00000000-0000-4000-8000-000000005102\",\"usable\":false}"},
  {"name":"pickup-replay","requestBody":{"schemaVersion":"hraness-credits-pickup-request-v2","operation":"pickup","claimId":"00000000000000000000010003claims","pickupId":"00000000-0000-4000-8000-000000005102","tokenSha256":"e11529975b3504a3d7831c269d34352a7a10eff8baa5bd870a95803c1ce0d780"},"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"pickup\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"paid\",\"pickupState\":\"registered\",\"pickupId\":\"00000000-0000-4000-8000-000000005102\",\"usable\":false}"},
  {"name":"credential-before-ack","requestBody":null,"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"credential\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"paid\",\"pickupState\":\"registered\",\"pickupId\":\"00000000-0000-4000-8000-000000005102\",\"usable\":false}"},
  {"name":"ack","requestBody":{"schemaVersion":"hraness-credits-pickup-request-v2","operation":"ack","claimId":"00000000000000000000010003claims","pickupId":"00000000-0000-4000-8000-000000005102"},"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"ack\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"paid\",\"pickupState\":\"acknowledged\",\"pickupId\":\"00000000-0000-4000-8000-000000005102\",\"usable\":true}"},
  {"name":"ack-replay","requestBody":{"schemaVersion":"hraness-credits-pickup-request-v2","operation":"ack","claimId":"00000000000000000000010003claims","pickupId":"00000000-0000-4000-8000-000000005102"},"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"ack\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"paid\",\"pickupState\":\"acknowledged\",\"pickupId\":\"00000000-0000-4000-8000-000000005102\",\"usable\":true}"},
  {"name":"credential-after-ack","requestBody":null,"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"credential\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"paid\",\"pickupState\":\"acknowledged\",\"pickupId\":\"00000000-0000-4000-8000-000000005102\",\"usable\":true}"},
  {"name":"status-after-ack","requestBody":null,"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"status\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"paid\",\"pickupState\":\"acknowledged\",\"pickupId\":\"00000000-0000-4000-8000-000000005102\",\"usable\":null}"},
  {"name":"balance","requestBody":null,"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-balance-v2\",\"product\":{\"id\":\"peopleblade\",\"name\":\"PeopleBlade\"},\"balance\":{\"microUsd\":30000000,\"credits\":3000,\"usd\":\"30.00\"},\"held\":{\"microUsd\":0},\"lowBalance\":false,\"packs\":[{\"id\":\"p10\",\"label\":\"$10: 1,000 credits\",\"usd\":10,\"credits\":1000,\"bonusCredits\":0},{\"id\":\"p25\",\"label\":\"$25: 2,500 credits + 150 bonus\",\"usd\":25,\"credits\":2500,\"bonusCredits\":150},{\"id\":\"p50\",\"label\":\"$50: 5,000 credits + 500 bonus\",\"usd\":50,\"credits\":5000,\"bonusCredits\":500},{\"id\":\"p100\",\"label\":\"$100: 10,000 credits + 1,500 bonus\",\"usd\":100,\"credits\":10000,\"bonusCredits\":1500}],\"suggestedPackId\":\"p25\"}"},
  {"name":"creation-replay-paid-after-expiry","requestBody":{"schemaVersion":"hraness-credits-claim-create-v2","creationId":"00000000-0000-4000-8000-000000005100","product":"peopleblade","device":{"id":"00000000-0000-4000-8000-000000005101","label":"Synthetic fixture device"},"email":"fixture@example.com","packId":"p25"},"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-claim-created-v2\",\"creationId\":\"00000000-0000-4000-8000-000000005100\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"createdAt\":\"2026-09-16T12:00:00.000Z\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"payUrl\":\"http://localhost:3000/t/00000000000000000000010003claims\"}"},
  {"name":"status-paid-after-expiry","requestBody":null,"status":200,"rawBody":"{\"schemaVersion\":\"hraness-credits-pickup-response-v2\",\"operation\":\"status\",\"binding\":{\"claimId\":\"00000000000000000000010003claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000005101\"},\"payment\":\"paid\",\"pickupState\":\"acknowledged\",\"pickupId\":\"00000000-0000-4000-8000-000000005102\",\"usable\":null}"},
] as const;

test("all fourteen independently captured authority responses parse against the saved synthetic tuple", () => {
  const saved = { creationId: "00000000-0000-4000-8000-000000005100", productId: "peopleblade",
    deviceId: "00000000-0000-4000-8000-000000005101", claimId: "00000000000000000000010003claims",
    serviceOrigin: "http://localhost:3000" };
  const savedBinding = { claimId: saved.claimId, productId: saved.productId, deviceId: saved.deviceId };
  const savedPickup = "00000000-0000-4000-8000-000000005102";
  expect(capturedAuthority).toHaveLength(14);
  for (const fixture of capturedAuthority) {
    const body: unknown = JSON.parse(fixture.rawBody);
    expect(fixture.status).toBe(200);
    if (fixture.name === "created" || fixture.name.startsWith("creation-replay")) {
      expect<unknown>(parseCreditsClaimCreatedV2(fixture.rawBody, saved)).toEqual(body);
      expect<unknown>(parseCreditsClaimCreateV2(fixture.requestBody)).toEqual(fixture.requestBody);
      expect(parseCreditsClaimCreatedV2(fixture.rawBody, { ...saved, deviceId: savedPickup })).toBeNull();
    } else if (fixture.name === "balance") {
      expect<unknown>(parseCreditsBalanceV2(fixture.rawBody, saved.productId)).toEqual(body);
      expect(parseCreditsBalanceV2(fixture.rawBody, "another")).toBeNull();
    } else {
      const operation = fixture.name.startsWith("status") ? "status" : fixture.name.startsWith("credential") ? "credential"
        : fixture.name.startsWith("ack") ? "ack" : "pickup";
      const expected = { operation, binding: savedBinding, pickupId: savedPickup } as const;
      expect<unknown>(parseCreditsPickupResponseV2(fixture.rawBody, expected)).toEqual(body);
      expect(parseCreditsPickupResponseV2(fixture.rawBody, { ...expected, operation: operation === "status" ? "credential" : "status" })).toBeNull();
      if (fixture.requestBody !== null) expect<unknown>(parseCreditsPickupRequestV2(fixture.requestBody)).toEqual(fixture.requestBody);
    }
  }
});
