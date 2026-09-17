import { describe, expect, test } from "bun:test";
import { CREDITS_FOUNDATION_VERSION, parseCreditsRateCard } from "../src/index.js";
import { ceilingFor, createCreditsClient } from "../src/server.js";
import { CLAIM_ID, DEVICE_TOKEN, EXPIRES_AT, ORIGIN, PRODUCT_KEY, claimResponse, packs, rateCard, statusResponse, stubFetch, type Reply, type Route } from "./helpers.js";

const holdBody = { holdId: "hold_1", ceilingMicroUsd: 600000, balance: { microUsd: 8100000, availableMicroUsd: 7500000 }, expiresAt: EXPIRES_AT };
const shortfall = {
  error: "insufficient_credits",
  message: "Add credits to continue.",
  // The service renders money with a derived `credits` field; the client accepts it and keeps the contract shape.
  required: { microUsd: 12500000, credits: 1250, usd: "12.50" },
  balance: { microUsd: 0, credits: 0, usd: "0.00", availableMicroUsd: 0 },
  topup: { claimId: CLAIM_ID, url: `${ORIGIN}/t/${CLAIM_ID}`, expiresAt: EXPIRES_AT, packs, suggestedPackId: "p25" },
};

function client(route: Route) {
  const { fetch, calls } = stubFetch(route);
  return { client: createCreditsClient({ origin: ORIGIN, productKey: PRODUCT_KEY, fetch }), calls };
}
const always = (reply: Reply): Route => () => reply;

describe("server client", () => {
  test("rejects invalid options at creation", () => {
    expect(() => createCreditsClient({ origin: "https://credits.hraness.com/", productKey: PRODUCT_KEY })).toThrow(TypeError);
    expect(() => createCreditsClient({ origin: ORIGIN, productKey: DEVICE_TOKEN })).toThrow(TypeError);
  });

  test("hold posts with the product key and parses the hold", async () => {
    const { client: c, calls } = client(always({ status: 201, body: holdBody }));
    const result = await c.hold({ subjectToken: DEVICE_TOKEN, operation: "enrich_contact", units: 3, idempotencyKey: "job-1", context: { list: "founders" } });
    expect(result).toEqual({ ok: true, value: holdBody });
    expect(calls[0]!.url).toBe(`${ORIGIN}/v1/holds`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers).toEqual({
      accept: "application/json",
      "user-agent": `hraness-credits-foundation/${CREDITS_FOUNDATION_VERSION} (server)`,
      authorization: `Bearer ${PRODUCT_KEY}`,
      "content-type": "application/json; charset=utf-8",
    });
    expect(calls[0]!.body).toEqual({ subjectToken: DEVICE_TOKEN, operation: "enrich_contact", units: 3, idempotencyKey: "job-1", context: { list: "founders" } });
  });

  test("hold shortfall returns insufficient_credits with the topup", async () => {
    const { client: c } = client(always({ status: 402, body: shortfall }));
    const result = await c.hold({ subjectToken: DEVICE_TOKEN, operation: "enrich_contact", idempotencyKey: "job-2" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "insufficient_credits",
      status: 402,
      message: "Add credits to continue.",
      required: { microUsd: 12500000, usd: "12.50" },
      balance: { microUsd: 0, usd: "0.00", availableMicroUsd: 0 },
      topup: { claimId: CLAIM_ID, url: `${ORIGIN}/t/${CLAIM_ID}`, expiresAt: EXPIRES_AT, packs, suggestedPackId: "p25" },
    });
    const broken = client(always({ status: 402, body: { error: "insufficient_credits", required: { microUsd: 1 } } }));
    const malformed = await broken.client.hold({ subjectToken: DEVICE_TOKEN, operation: "enrich_contact", idempotencyKey: "job-3" });
    expect(malformed).toMatchObject({ ok: false, error: { code: "malformed_response", status: 402 } });
  });

  test("input validation never reaches the network", async () => {
    const { client: c, calls } = client(always({ status: 201, body: holdBody }));
    const cases = [
      c.hold({ subjectToken: "nope", operation: "enrich_contact", idempotencyKey: "k" }),
      c.hold({ subjectToken: DEVICE_TOKEN, operation: "Enrich", idempotencyKey: "k" }),
      c.hold({ subjectToken: DEVICE_TOKEN, operation: "enrich_contact", idempotencyKey: "k".repeat(129) }),
      c.hold({ subjectToken: DEVICE_TOKEN, operation: "enrich_contact", idempotencyKey: "k", units: 0 }),
      c.hold({ subjectToken: DEVICE_TOKEN, operation: "enrich_contact", idempotencyKey: "k", context: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "v"])) }),
      c.settle("bad/hold"),
      c.settle("hold_1", { costs: [{ provider: "openai", operation: "gpt", microUsd: 1.5, basis: "reported" }] }),
      c.release(""),
      c.balance("cr_dev_short"),
      c.claim({ product: "peopleblade", device: { id: "not-a-uuid" } }),
      c.claim({ product: "peopleblade", device: { id: "11111111-1111-4111-8111-111111111111" }, resume: { argv: [] } }),
    ];
    for (const result of await Promise.all(cases)) expect(result).toMatchObject({ ok: false, error: { code: "invalid_request", status: 0 } });
    expect(calls).toHaveLength(0);
  });

  test("settle and release", async () => {
    const settled = { holdId: "hold_1", state: "settled" as const, chargedMicroUsd: 140000, balance: { microUsd: 7960000, availableMicroUsd: 7960000 }, lowBalance: true, topup: { url: `${ORIGIN}/t/${CLAIM_ID}` } };
    const { client: c, calls } = client(call => call.url.endsWith("/settle") ? { status: 200, body: settled } : { status: 200, body: { holdId: "hold_1", state: "released", balance: { microUsd: 1, availableMicroUsd: 1 } } });
    const costs = [{ provider: "openai", operation: "gpt-5", microUsd: 100000, basis: "reported" as const }];
    expect(await c.settle("hold_1", { costs, units: 2 })).toEqual({ ok: true, value: settled });
    expect(calls[0]!.url).toBe(`${ORIGIN}/v1/holds/hold_1/settle`);
    expect(calls[0]!.body).toEqual({ units: 2, costs });
    expect(await c.release("hold_1")).toEqual({ ok: true, value: { holdId: "hold_1", state: "released", balance: { microUsd: 1, availableMicroUsd: 1 } } });
    expect(calls[1]!.url).toBe(`${ORIGIN}/v1/holds/hold_1/release`);
    expect(calls[1]!.body).toEqual({});
  });

  test("balance and claim", async () => {
    const { client: c, calls } = client(call => call.url.endsWith("/balance") ? { status: 200, body: statusResponse() } : { status: 201, body: claimResponse() });
    const balance = await c.balance(DEVICE_TOKEN);
    expect(balance.ok).toBe(true);
    if (balance.ok) expect(balance.value.balance.credits).toBe(810);
    expect(calls[0]!.url).toBe(`${ORIGIN}/v1/subjects/balance`);
    expect(calls[0]!.body).toEqual({ subjectToken: DEVICE_TOKEN });
    const claim = await c.claim({ product: "peopleblade", device: { id: "11111111-1111-4111-8111-111111111111", label: "server" }, email: "reader@example.com", packId: "p25", resume: { argv: ["peopleblade", "enrich"] } });
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.value.claimId).toBe(CLAIM_ID);
    expect(calls[1]!.url).toBe(`${ORIGIN}/v1/claims`);
    expect(calls[1]!.body).toEqual({ product: "peopleblade", device: { id: "11111111-1111-4111-8111-111111111111", label: "server" }, email: "reader@example.com", packId: "p25", resume: { argv: ["peopleblade", "enrich"] } });
  });

  test("errors never throw", async () => {
    const notFound = client(always({ status: 404, body: { error: "not_found", message: "No such hold.", holdId: "hold_9" } }));
    expect(await notFound.client.release("hold_9")).toEqual({ ok: false, error: { code: "not_found", status: 404, message: "No such hold.", holdId: "hold_9" } });
    const down = client(always({ status: 0 }));
    expect(await down.client.release("hold_9")).toEqual({ ok: false, error: { code: "unreachable", status: 0, message: "fetch failed" } });
    const html = client(always({ status: 502, raw: "<html>", contentType: "text/html" }));
    expect(await html.client.release("hold_9")).toMatchObject({ ok: false, error: { code: "malformed_response", status: 502 } });
    const bare = client(always({ status: 500, body: { message: "no code" } }));
    expect(await bare.client.release("hold_9")).toMatchObject({ ok: false, error: { code: "malformed_response", status: 500 } });
    const odd = client(always({ status: 200, body: { holdId: "hold_9", state: "released" } }));
    expect(await odd.client.release("hold_9")).toMatchObject({ ok: false, error: { code: "malformed_response", status: 200 } });
    const hijack = client(always({ status: 409, body: { error: "conflict", code: "spoofed", status: 200 } }));
    expect(await hijack.client.release("hold_9")).toEqual({ ok: false, error: { code: "conflict", status: 409 } });
  });

  test("ceilingFor mirrors public unit pricing", () => {
    const card = parseCreditsRateCard(rateCard)!;
    expect(ceilingFor(card, "enrich_contact", 3)).toBe(600000);
    expect(ceilingFor(card, "enrich_contact")).toBe(200000);
    expect(ceilingFor(card, "model_tokens")).toBeNull();
    expect(ceilingFor(card, "missing")).toBeNull();
    expect(ceilingFor(card, "toString")).toBeNull();
    expect(() => ceilingFor(card, "enrich_contact", 0)).toThrow(RangeError);
  });
});
