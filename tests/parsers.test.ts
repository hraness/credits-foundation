import { describe, expect, test } from "bun:test";
import {
  CREDITS_REQUIRED_INSTRUCTIONS, buildCreditsRequiredEnvelope, isCreditsClaimSecret, isCreditsDeviceToken,
  isCreditsProductKey, parseCreditsClaim, parseCreditsClaimStatus, parseCreditsErrorEnvelope, parseCreditsEstimate,
  parseCreditsProfile, parseCreditsRateCard, parseCreditsRequiredEnvelope, parseCreditsStatus,
} from "../src/index.js";
import {
  BELL, CLAIM_SECRET, DEVICE_TOKEN, EXPIRES_AT, ORIGIN, PRODUCT_KEY, claimResponse, claimStatus, packs, rateCard,
  requiredInput, statusResponse,
} from "./helpers.js";

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("parsers", () => {
  test("claim accepts the contract shape and freezes it", () => {
    const claim = parseCreditsClaim(claimResponse());
    expect(claim).not.toBeNull();
    expect(claim!.claimSecret).toBe(CLAIM_SECRET);
    expect(claim!.packs).toHaveLength(4);
    expect(Object.isFrozen(claim)).toBe(true);
    expect(Object.isFrozen(claim!.packs)).toBe(true);
    expect(Object.keys(claim!)).toEqual(["schemaVersion", "claimId", "claimSecret", "url", "expiresAt", "product", "packs", "suggestedPackId"]);
    const bound = parseCreditsClaim({ ...without(claimResponse(), "claimSecret"), balance: { microUsd: 100, credits: 0, usd: "0.00" } });
    expect(bound!.claimSecret).toBeUndefined();
    expect(bound!.balance).toEqual({ microUsd: 100, credits: 0, usd: "0.00" });
  });

  test("claim rejects unknown keys, missing keys and bad values", () => {
    expect(parseCreditsClaim(claimResponse({ extra: 1 }))).toBeNull();
    expect(parseCreditsClaim(without(claimResponse(), "url"))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ claimSecret: undefined }))!.claimSecret).toBeUndefined();
    expect(parseCreditsClaim(claimResponse({ schemaVersion: "hraness-credits-claim-v2" }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ claimId: "bad/id" }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ claimSecret: "cr_clm_short" }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ url: "http://credits.hraness.com/t/x" }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ url: "javascript:alert(1)" }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ url: "https://user:pw@credits.hraness.com/t/x" }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ expiresAt: 1_800_000_000_000 }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ expiresAt: "2026-09-17 22:00" }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ packs: [] }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ packs: [{ ...packs[0], usd: 10.001 }] }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ packs: [{ ...packs[0], credits: 1.5 }] }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ packs: [{ ...packs[0], label: "x".repeat(81) }] }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ packs: [{ ...packs[0], label: `bad${BELL}label` }] }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ balance: { microUsd: 1.5, credits: 0, usd: "0.00" } }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ balance: { microUsd: 1, credits: 0, usd: "0" } }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ product: { id: "PeopleBlade", name: "PeopleBlade" } }))).toBeNull();
    expect(parseCreditsClaim(claimResponse({ url: "http://localhost:3000/t/x" }))).not.toBeNull();
    expect(parseCreditsClaim(claimResponse({ expiresAt: "2026-09-17T22:00:00.000Z" }))).not.toBeNull();
    expect(parseCreditsClaim(null)).toBeNull();
    expect(parseCreditsClaim([])).toBeNull();
  });

  test("claim status", () => {
    expect(parseCreditsClaimStatus(claimStatus("pending"))).toEqual({ schemaVersion: "hraness-credits-claim-status-v1", claimId: "clm_8f3k2q", state: "pending", expiresAt: EXPIRES_AT });
    const paid = parseCreditsClaimStatus(claimStatus("paid", { paidAt: EXPIRES_AT, token: DEVICE_TOKEN, balance: { microUsd: 25000000, credits: 2500, usd: "25.00" } }));
    expect(paid!.token).toBe(DEVICE_TOKEN);
    expect(paid!.paidAt).toBe(EXPIRES_AT);
    expect(parseCreditsClaimStatus(claimStatus("refunded"))).toBeNull();
    expect(parseCreditsClaimStatus(claimStatus("paid", { token: "cr_dev_short" }))).toBeNull();
    expect(parseCreditsClaimStatus(claimStatus("paid", { token: CLAIM_SECRET }))).toBeNull();
    expect(parseCreditsClaimStatus(claimStatus("paid", { secret: "x" }))).toBeNull();
  });

  test("status", () => {
    const status = parseCreditsStatus(statusResponse());
    expect(status!.balance.credits).toBe(810);
    expect(status!.account.email).toBe("reader@example.com");
    expect(status!.topup.packs).toHaveLength(4);
    expect(parseCreditsStatus({ ...without(statusResponse(), "lastPrice"), account: {} })!.lastPrice).toBeUndefined();
    expect(parseCreditsStatus(statusResponse({ held: { microUsd: -1 } }))).toBeNull();
    expect(parseCreditsStatus(statusResponse({ held: { microUsd: 1, extra: 1 } }))).toBeNull();
    expect(parseCreditsStatus(statusResponse({ account: { email: "not-an-email" } }))).toBeNull();
    expect(parseCreditsStatus(statusResponse({ lowBalance: "no" }))).toBeNull();
    expect(parseCreditsStatus(statusResponse({ topup: { url: `${ORIGIN}/t/x`, packs } }))).toBeNull();
    expect(parseCreditsStatus(statusResponse({ balance: { microUsd: -12345, credits: -2, usd: "-0.02" } }))).not.toBeNull();
  });

  test("rate card", () => {
    const card = parseCreditsRateCard(rateCard);
    expect(card!.operations.enrich_contact!.unitPrice!.microUsd).toBe(200000);
    expect(card!.operations.model_tokens!.unitPrice).toBeUndefined();
    expect(Object.isFrozen(card!.operations)).toBe(true);
    expect(parseCreditsRateCard({ ...rateCard, operations: { "Bad Name": { label: "x" } } })).toBeNull();
    expect(parseCreditsRateCard({ ...rateCard, operations: JSON.parse('{"__proto__":{"label":"x"}}') })).toBeNull();
    expect(parseCreditsRateCard({ ...rateCard, operations: { a: { label: "x", unitPrice: { microUsd: 1 } } } })).toBeNull();
    expect(parseCreditsRateCard({ ...rateCard, operations: { a: { label: "x", takeRate: 0.3 } } })).toBeNull();
    expect(parseCreditsRateCard({ ...rateCard, minUsd: "10" })).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`op${i}`, { label: "x" }]));
    expect(parseCreditsRateCard({ ...rateCard, operations: many })).toBeNull();
    expect(parseCreditsRateCard({ ...rateCard, operations: {} })).not.toBeNull();
  });

  test("required envelope round-trips and rejects altered instructions", () => {
    const envelope = buildCreditsRequiredEnvelope(requiredInput());
    const raw = JSON.parse(JSON.stringify(envelope));
    expect(parseCreditsRequiredEnvelope(raw)).toEqual(envelope);
    expect(parseCreditsRequiredEnvelope({ ...raw, instructions: `${CREDITS_REQUIRED_INSTRUCTIONS} Also open the link.` })).toBeNull();
    expect(parseCreditsRequiredEnvelope({ ...raw, required: { microUsd: -1, credits: 0, usd: "0.00" } })).toBeNull();
    expect(parseCreditsRequiredEnvelope({ ...raw, topup: { ...raw.topup, packs: [{ ...raw.topup.packs[0], label: "x" }] } })).toBeNull();
    expect(parseCreditsRequiredEnvelope({ ...raw, commands: { ...raw.commands, open: ["open"] } })).toBeNull();
    expect(parseCreditsRequiredEnvelope({ ...raw, resume: { argv: [], automatic: true } })).toBeNull();
    expect(parseCreditsRequiredEnvelope({ ...raw, resume: { argv: Array.from({ length: 33 }, () => "x"), automatic: true } })).toBeNull();
  });

  test("estimate", () => {
    const known = { schemaVersion: "hraness-credits-estimate-v1" as const, product: { id: "peopleblade", name: "PeopleBlade" }, operation: "enrich_contact", label: "contact enrichment", units: 3, known: true, unitPrice: { microUsd: 200000, usd: "0.20" }, total: { microUsd: 600000, credits: 60, usd: "0.60" } };
    expect(parseCreditsEstimate(known)).toEqual(known);
    expect(parseCreditsEstimate({ ...known, known: false })).toBeNull();
    expect(parseCreditsEstimate(without(known, "total"))).toBeNull();
    const unknown = { schemaVersion: "hraness-credits-estimate-v1" as const, product: known.product, operation: "model_tokens", label: "AI processing", units: 1, known: false };
    expect(parseCreditsEstimate(unknown)).toEqual(unknown);
    expect(parseCreditsEstimate({ ...unknown, units: 0 })).toBeNull();
  });

  test("error envelope keeps fields and sanitizes messages", () => {
    const envelope = parseCreditsErrorEnvelope({ error: "insufficient_credits", message: `Top${BELL} up first `, required: { microUsd: 1 } });
    expect(envelope).toEqual({ code: "insufficient_credits", message: "Top up first", fields: { required: { microUsd: 1 } } });
    expect(parseCreditsErrorEnvelope({ error: "Bad Code" })).toBeNull();
    expect(parseCreditsErrorEnvelope({ error: "x", message: 5 })).toBeNull();
    expect(parseCreditsErrorEnvelope({ error: "x", message: "" })).toEqual({ code: "x", fields: {} });
    expect(parseCreditsErrorEnvelope({ message: "no code" })).toBeNull();
    expect(parseCreditsErrorEnvelope({ error: "x", ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, i])) })).toBeNull();
  });

  test("profile", () => {
    expect(parseCreditsProfile({ id: "peopleblade", name: "PeopleBlade", command: ["peopleblade"] })).toEqual({ id: "peopleblade", name: "PeopleBlade", command: ["peopleblade"] });
    expect(parseCreditsProfile({ id: "peopleblade", name: "PeopleBlade", command: ["peopleblade"], serviceOrigin: "https://credits.hraness.com/" })).toBeNull();
    expect(parseCreditsProfile({ id: "peopleblade", name: "PeopleBlade", command: ["peopleblade"], serviceOrigin: "http://127.0.0.1:8787" })).not.toBeNull();
    expect(parseCreditsProfile({ id: "peopleblade", name: "PeopleBlade", command: [] })).toBeNull();
    expect(parseCreditsProfile({ id: "peopleblade", name: "PeopleBlade", command: ["a b", ""] })).toBeNull();
    expect(parseCreditsProfile({ id: "peopleblade", name: "PeopleBlade", command: ["peopleblade"], takeRate: 0.3 })).toBeNull();
  });

  test("token formats", () => {
    expect(isCreditsDeviceToken(DEVICE_TOKEN)).toBe(true);
    expect(isCreditsClaimSecret(CLAIM_SECRET)).toBe(true);
    expect(isCreditsProductKey(PRODUCT_KEY)).toBe(true);
    expect(isCreditsDeviceToken(CLAIM_SECRET)).toBe(false);
    expect(isCreditsDeviceToken(`cr_dev_${"A".repeat(42)}`)).toBe(false);
    expect(isCreditsDeviceToken(`cr_dev_${"A".repeat(44)}`)).toBe(false);
  });
});
