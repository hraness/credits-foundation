import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CREDITS_FOUNDATION_VERSION, parseCreditsStatus } from "../src/index.js";
import { runCreditsCommand, type CreditsCommandIo, type CreditsOutput } from "../src/node.js";
import {
  CLAIM_ID, CLAIM_SECRET, DEVICE_TOKEN, ORIGIN, OTHER_TOKEN, claimResponse, claimStatus, harness, profile, rateCard, reply,
  statusResponse, type Call, type Harness, type Reply, type Route,
} from "./helpers.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())); });

type Table = Record<string, Reply | ((call: Call, count: number) => Reply)>;
function table(entries: Table): Route {
  const counts = new Map<string, number>();
  return call => {
    const key = `${call.method} ${new URL(call.url).pathname}`;
    const entry = entries[key];
    if (entry === undefined) return reply(404, { error: "not_found", message: `No route ${key}` });
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return typeof entry === "function" ? entry(call, count) : entry;
  };
}

async function setup(entries: Table = {}, overrides: Partial<CreditsCommandIo> = {}): Promise<Harness> {
  const h = await harness(table(entries), overrides);
  disposers.push(h.dispose);
  return h;
}

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
async function seed(h: Harness, extra: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(h.stateFile), { recursive: true, mode: 0o700 });
  await writeFile(h.stateFile, JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: DEVICE_ID, ...extra }));
}
async function state(h: Harness): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(h.stateFile, "utf8"));
}
const run = (h: Harness, argv: string[]) => runCreditsCommand(profile, argv, h.io);
const PENDING = { id: CLAIM_ID, secret: CLAIM_SECRET, expiresAt: "2026-09-17T22:00:00Z" };
const PAID = claimStatus("paid", { paidAt: "2026-09-16T21:00:00Z", token: DEVICE_TOKEN, balance: { microUsd: 26500000, credits: 2650, usd: "26.50" } });

describe("protocol and usage", () => {
  test("protocol --json is pure", async () => {
    const h = await setup();
    const result = await run(h, ["protocol", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).schemaVersion).toBe("hraness-credits-protocol-v1");
    expect(result.stderr).toBe("");
    expect(h.calls).toHaveLength(0);
  });

  test("usage errors exit 2 and explain", async () => {
    const h = await setup();
    expect((await run(h, ["protocol"])).exitCode).toBe(2);
    const bare = await run(h, []);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toStartWith("Usage: peopleblade credits <command> [options]\n");
    const unknown = await run(h, ["stauts"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toBe('✗ Unknown credits command "stauts".\n→ peopleblade credits --help\n');
    const bogus = await run(h, ["bogus", "--json"]);
    expect(bogus.exitCode).toBe(2);
    expect(JSON.parse(bogus.stdout)).toMatchObject({ error: "usage_error" });
    expect((await run(h, ["status", "--nope"])).exitCode).toBe(2);
    expect((await run(h, ["status", "--json", "--json"])).exitCode).toBe(2);
    expect((await runCreditsCommand({ ...profile, command: [] }, ["protocol", "--json"], h.io)).exitCode).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});

describe("status", () => {
  test("signed out reports a way to top up without network", async () => {
    const h = await setup();
    const result = await run(h, ["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: "hraness-credits-status-v1",
      product: { id: "peopleblade", name: "PeopleBlade" },
      signedOut: true,
      topup: { command: ["peopleblade", "credits", "topup", "--json"] },
    });
    expect(result.stderr).toBe("");
    const human = await run(h, ["status"]);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe("○ No PeopleBlade credits on this device yet. Add some: peopleblade credits topup\n");
    expect(h.calls).toHaveLength(0);
  });

  test("signed in reads the balance with the device token", async () => {
    const h = await setup({ "GET /v1/balance": reply(200, statusResponse()) });
    await seed(h, { token: DEVICE_TOKEN });
    const result = await run(h, ["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(JSON.stringify(parseCreditsStatus(statusResponse()))));
    expect(h.calls[0]!.headers).toEqual({
      accept: "application/json",
      "user-agent": `hraness-credits-foundation/${CREDITS_FOUNDATION_VERSION} (peopleblade)`,
      authorization: `Bearer ${DEVICE_TOKEN}`,
    });
    expect(h.calls[0]!.url).toBe(`${ORIGIN}/v1/balance`);
    const human = await run(h, ["status"]);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe([
      "● PeopleBlade credits: $8.10, $0.50 held for work in progress.",
      "  Account: reader@example.com",
      "  Last operation cost $0.20.",
      `  Add credits: ${ORIGIN}/t/${CLAIM_ID} ($10 · $25 (suggested) · $50 · $100)`,
    ].join("\n") + "\n");
  });

  test("a rejected token is reported but kept", async () => {
    const h = await setup({ "GET /v1/balance": reply(401, { error: "unauthorized" }) });
    await seed(h, { token: DEVICE_TOKEN });
    const result = await run(h, ["status", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "unauthorized", service: { status: 401, code: "unauthorized" } });
    expect((await state(h)).token).toBe(DEVICE_TOKEN);
  });

  test("service failures map to exit 1", async () => {
    const cases: Array<[Reply, string, string]> = [
      [reply(0, undefined), "service_unreachable", "could not be reached"],
      [{ status: 200, raw: "<html>", contentType: "text/html" }, "service_error", "Unexpected content type"],
      [{ status: 200, raw: "{oops" }, "service_error", "not valid JSON"],
      [reply(200, { schemaVersion: "hraness-credits-status-v1" }), "service_error", "cannot read"],
      [reply(503, { error: "product_disabled" }), "product_disabled", "product disabled"],
      [reply(500, { error: "internal", message: "boom" }), "service_error", "boom"],
      [reply(429, { error: "rate_limited" }), "rate_limited", "rate limiting"],
    ];
    for (const [response, code, text] of cases) {
      const h = await setup({ "GET /v1/balance": response });
      await seed(h, { token: DEVICE_TOKEN });
      const result = await run(h, ["status", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toBe(code);
      expect(result.stderr).toContain(text);
    }
  });

  test("requests time out through the abort signal", async () => {
    const h = await harness(call => new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason))), { requestTimeoutMs: 20 });
    disposers.push(h.dispose);
    await seed(h, { token: DEVICE_TOKEN });
    const result = await run(h, ["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No response within");
  });
});

describe("topup", () => {
  test("creates a claim, stores it and never prints the secret", async () => {
    const h = await setup({ "POST /v1/claims": reply(201, claimResponse()) });
    const result = await run(h, ["topup", "--pack", "p25", "--json"]);
    expect(result.exitCode).toBe(0);
    const call = h.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(call.headers.authorization).toBeUndefined();
    const saved = await state(h);
    expect(call.body).toEqual({ product: "peopleblade", device: { id: saved.deviceId, label: "test-device" }, packId: "p25" });
    const printed = JSON.parse(result.stdout);
    expect(printed.claimSecret).toBeUndefined();
    expect(printed.claimId).toBe(CLAIM_ID);
    expect(result.stdout).not.toContain(CLAIM_SECRET);
    expect(saved.pendingClaim).toEqual({ id: CLAIM_ID, secret: CLAIM_SECRET, expiresAt: "2026-09-17T22:00:00Z" });
    expect(result.stderr).toBe("");
  });

  test("--usd resolves a pack through the cached rate card", async () => {
    const h = await setup({ "GET /v1/rate-cards/peopleblade": reply(200, rateCard), "POST /v1/claims": reply(201, claimResponse()) });
    const result = await run(h, ["topup", "--usd", "25", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(h.calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["GET /v1/rate-cards/peopleblade", "POST /v1/claims"]);
    expect((h.calls[1]!.body as { packId: string }).packId).toBe("p25");
    expect((await run(h, ["topup", "--usd", "50.00", "--json"])).exitCode).toBe(0);
    expect(h.calls).toHaveLength(3);
    const missing = await run(h, ["topup", "--usd", "7"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toBe("✗ No PeopleBlade pack costs $7. Packs: $10 · $25 (suggested) · $50 · $100.\n→ peopleblade credits --help\n");
    expect(h.calls).toHaveLength(3);
  });

  test("binds to the stored token and accepts a claim without a secret", async () => {
    const h = await setup({ "POST /v1/claims": reply(201, { ...claimResponse(), claimSecret: undefined, balance: { microUsd: 100000, credits: 10, usd: "0.10" } }) });
    await seed(h, { token: DEVICE_TOKEN });
    const result = await run(h, ["topup", "--email", "reader@example.com"]);
    expect(result.exitCode).toBe(0);
    expect(h.calls[0]!.body).toEqual({ product: "peopleblade", device: { id: DEVICE_ID, label: "test-device" }, subjectToken: DEVICE_TOKEN, email: "reader@example.com" });
    expect((await state(h)).pendingClaim).toEqual({ id: CLAIM_ID, expiresAt: "2026-09-17T22:00:00Z" });
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe([
      `→ Add PeopleBlade credits: ${ORIGIN}/t/${CLAIM_ID}`,
      "  Packs: $10 = 1000 credits; $25 = 2500 + 150 bonus credits (suggested); $50 = 5000 + 500 bonus credits; $100 = 10000 + 1500 bonus credits.",
      "  The link is valid for 23 hours, until 10:00 PM. After you pay, run peopleblade credits wait or rerun your command.",
      "  Not at this computer? Email yourself the link: peopleblade credits email --to <address>",
      "  Current balance: $0.10.",
    ].join("\n") + "\n");
  });

  test("device label can be suppressed", async () => {
    const h = await setup({ "POST /v1/claims": reply(201, claimResponse()) }, { deviceLabel: null });
    await run(h, ["topup", "--json"]);
    expect((h.calls[0]!.body as { device: object }).device).toEqual({ id: (await state(h)).deviceId });
  });

  test("usage and service errors", async () => {
    const h = await setup({ "POST /v1/claims": reply(400, { error: "invalid_request", message: "Unknown pack." }) });
    for (const argv of [["topup", "--usd", "1", "--pack", "p10"], ["topup", "--email", "nope"], ["topup", "--pack", "bad id"], ["topup", "extra"], ["topup", "--usd", "abc"]]) {
      expect((await run(h, argv)).exitCode).toBe(2);
    }
    expect(h.calls).toHaveLength(0);
    const refused = await run(h, ["topup", "--pack", "p9", "--json"]);
    expect(refused.exitCode).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ error: "invalid_request", message: expect.stringContaining("Unknown pack.") });
  });
});

describe("email", () => {
  test("sends the pending claim's link with the claim secret", async () => {
    const h = await setup({ "POST /v1/claims/clm_8f3k2q/email": reply(202, { sentTo: "reader@example.com" }) });
    await seed(h, { pendingClaim: PENDING });
    const result = await run(h, ["email", "--to", "reader@example.com"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"sentTo":"reader@example.com"}\n');
    expect(result.stderr).toBe("✓ Sent the PeopleBlade credits link to reader@example.com.\n");
    const person = await runCreditsCommand(profile, ["email", "--to", "reader@example.com"], { ...h.io, audience: "human" });
    expect(person.stdout).toBe("");
    expect(person.stderr).toBe("✓ Sent the PeopleBlade credits link to reader@example.com.\n");
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${CLAIM_SECRET}`);
    expect(h.calls[0]!.body).toEqual({ to: "reader@example.com" });
    const quiet = await run(h, ["email", "--to", "reader@example.com", "--json"]);
    expect(quiet.stderr).toBe("");
    expect(quiet.stdout).toBe('{"sentTo":"reader@example.com"}\n');
  });

  test("falls back to the device token for another claim and refuses without credentials", async () => {
    const h = await setup({ "POST /v1/claims/clm_other/email": reply(202, { sentTo: "reader@example.com" }) });
    await seed(h, { token: DEVICE_TOKEN, pendingClaim: PENDING });
    const result = await run(h, ["email", "--to", "reader@example.com", "--claim", "clm_other"]);
    expect(result.exitCode).toBe(0);
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
    const bare = await setup();
    await seed(bare, {});
    const none = await run(bare, ["email", "--to", "reader@example.com", "--claim", "clm_other"]);
    expect(none.exitCode).toBe(2);
    expect(none.stderr).toContain("no credentials");
    const nothing = await run(bare, ["email", "--to", "reader@example.com", "--json"]);
    expect(nothing.exitCode).toBe(2);
    expect(JSON.parse(nothing.stdout).error).toBe("no_pending_claim");
  });

  test("an expired claim exits 2 and is forgotten", async () => {
    const h = await setup({ "POST /v1/claims/clm_8f3k2q/email": reply(410, { error: "expired" }) });
    await seed(h, { pendingClaim: PENDING });
    const result = await run(h, ["email", "--to", "reader@example.com"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("expired");
    expect((await state(h)).pendingClaim).toBeUndefined();
  });

  test("usage and rate limits", async () => {
    const h = await setup({ "POST /v1/claims/clm_8f3k2q/email": reply(429, { error: "rate_limited" }) });
    await seed(h, { pendingClaim: PENDING });
    expect((await run(h, ["email"])).exitCode).toBe(2);
    expect((await run(h, ["email", "--to", "bad"])).exitCode).toBe(2);
    expect((await run(h, ["email", "--to", "a@b.co", "--claim", "bad/id"])).exitCode).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect((await run(h, ["email", "--to", "a@b.co"])).exitCode).toBe(1);
  });
});

describe("wait", () => {
  test("polls every five seconds, stores the token once paid and never prints it", async () => {
    const h = await setup({ "GET /v1/claims/clm_8f3k2q": (_call, count) => reply(200, count === 1 ? claimStatus("pending") : PAID) });
    await seed(h, { pendingClaim: PENDING });
    const start = h.now();
    const result = await run(h, ["wait", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${CLAIM_SECRET}`);
    expect(h.now() - start).toBe(5_000);
    const printed = JSON.parse(result.stdout);
    expect(printed.token).toBeUndefined();
    expect(printed).toMatchObject({ state: "paid", claimId: CLAIM_ID, balance: { usd: "26.50" } });
    expect(result.stdout).not.toContain(DEVICE_TOKEN);
    expect(result.stderr).toBe("");
    const saved = await state(h);
    expect(saved.token).toBe(DEVICE_TOKEN);
    expect(saved.pendingClaim).toBeUndefined();
    expect(saved.deviceId).toBe(DEVICE_ID);
  });

  test("human mode announces the wait and the result", async () => {
    const h = await setup({ "GET /v1/claims/clm_8f3k2q": reply(200, PAID) });
    await seed(h, { pendingClaim: PENDING });
    const result = await runCreditsCommand(profile, ["wait"], { ...h.io, audience: "human" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe([
      `↻ Waiting for payment at ${ORIGIN}/t/${CLAIM_ID}`,
      "  Checking every 5 seconds for up to 15m. Press Ctrl-C to stop; paying still works.",
      "✓ Payment received. PeopleBlade balance: $26.50.",
      "Next: rerun your command",
    ].join("\n") + "\n");
  });

  test("times out with exit 3 and the last status", async () => {
    const h = await setup({ "GET /v1/claims/clm_8f3k2q": reply(200, claimStatus("pending")) });
    await seed(h, { pendingClaim: PENDING });
    const result = await run(h, ["wait", "--timeout", "12s", "--json"]);
    expect(result.exitCode).toBe(3);
    expect(h.calls).toHaveLength(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "timeout", claim: { state: "pending", claimId: CLAIM_ID } });
    expect(result.stderr).toContain("Not paid yet after 12s");
    expect((await state(h)).pendingClaim).toEqual(PENDING);
  });

  test("expired, consumed and missing claims exit 2", async () => {
    const expired = await setup({ "GET /v1/claims/clm_8f3k2q": reply(200, claimStatus("expired")) });
    await seed(expired, { pendingClaim: PENDING });
    const result = await run(expired, ["wait", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "expired", claim: { state: "expired" } });
    expect((await state(expired)).pendingClaim).toBeUndefined();

    const consumed = await setup({ "GET /v1/claims/clm_8f3k2q": reply(200, claimStatus("consumed")) });
    await seed(consumed, { pendingClaim: PENDING });
    expect((await run(consumed, ["wait"])).exitCode).toBe(2);
    await seed(consumed, { token: DEVICE_TOKEN, pendingClaim: PENDING });
    expect((await run(consumed, ["wait"])).exitCode).toBe(0);

    const gone = await setup({ "GET /v1/claims/clm_8f3k2q": reply(410, { error: "expired" }) });
    await seed(gone, { pendingClaim: PENDING });
    expect((await run(gone, ["wait"])).exitCode).toBe(2);
    expect((await state(gone)).pendingClaim).toBeUndefined();

    const missing = await setup({ "GET /v1/claims/clm_8f3k2q": reply(404, { error: "not_found" }) });
    await seed(missing, { pendingClaim: PENDING });
    expect((await run(missing, ["wait"])).exitCode).toBe(2);

    const bare = await setup();
    expect((await run(bare, ["wait"])).exitCode).toBe(2);
    expect((await run(bare, ["wait"])).stderr).toContain("No pending PeopleBlade topup link");
  });

  test("keeps polling through outages and rate limits", async () => {
    const recovering = await setup({ "GET /v1/claims/clm_8f3k2q": (_call, count) => count === 1 ? reply(500, { error: "internal" }) : count === 2 ? reply(429, { error: "rate_limited" }) : count === 3 ? reply(0, undefined) : reply(200, PAID) });
    await seed(recovering, { pendingClaim: PENDING });
    expect((await run(recovering, ["wait", "--json"])).exitCode).toBe(0);
    expect(recovering.calls).toHaveLength(4);

    const down = await setup({ "GET /v1/claims/clm_8f3k2q": reply(0, undefined) });
    await seed(down, { pendingClaim: PENDING });
    const result = await run(down, ["wait", "--timeout", "6s", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toBe("service_unreachable");
    expect(down.calls).toHaveLength(3);
  });

  test("a claim bound to the wallet completes with the device token", async () => {
    const h = await setup({ "GET /v1/claims/clm_8f3k2q": reply(200, claimStatus("paid", { balance: { microUsd: 26500000, credits: 2650, usd: "26.50" } })) });
    await seed(h, { token: DEVICE_TOKEN, pendingClaim: { id: CLAIM_ID, expiresAt: "2026-09-17T22:00:00Z" } });
    const result = await run(h, ["wait"]);
    expect(result.exitCode).toBe(0);
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(result.stderr).toBe("✓ Payment received. PeopleBlade balance: $26.50.\n");
    expect(result.stderr).not.toContain("signed in");
    const saved = await state(h);
    expect(saved.token).toBe(DEVICE_TOKEN);
    expect(saved.pendingClaim).toBeUndefined();
  });

  test("validates --timeout and --claim", async () => {
    const h = await setup();
    await seed(h, { pendingClaim: PENDING });
    for (const value of ["0s", "5", "25h", "1d", ""]) expect((await run(h, ["wait", "--timeout", value])).exitCode).toBe(2);
    expect((await run(h, ["wait", "--claim", "bad/id"])).exitCode).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  test("a busy lock stops the wait before polling", async () => {
    const h = await setup({ "GET /v1/claims/clm_8f3k2q": reply(200, PAID) });
    await seed(h, { pendingClaim: PENDING });
    await writeFile(h.lockFile, "");
    const result = await run(h, ["wait", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toBe("busy");
    expect(h.calls).toHaveLength(0);
  });
});

describe("estimate", () => {
  test("prices unit operations from a rate card cached for five minutes", async () => {
    const h = await setup({ "GET /v1/rate-cards/peopleblade": reply(200, rateCard) });
    const result = await run(h, ["estimate", "enrich_contact", "--units", "3", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: "hraness-credits-estimate-v1",
      product: { id: "peopleblade", name: "PeopleBlade" },
      operation: "enrich_contact",
      label: "contact enrichment",
      units: 3,
      known: true,
      unitPrice: { microUsd: 200000, usd: "0.20" },
      total: { microUsd: 600000, credits: 60, usd: "0.60" },
    });
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
    expect((await state(h)).rateCard).toMatchObject({ fetchedAt: h.now() });
    const human = await run(h, ["estimate", "enrich_contact"]);
    expect(human.stderr).toBe("PeopleBlade contact enrichment: $0.20 per unit; 1 unit = $0.20 (20 credits).\n");
    expect(h.calls).toHaveLength(1);
    h.io.sleep!(5 * 60_000);
    await run(h, ["estimate", "enrich_contact", "--json"]);
    expect(h.calls).toHaveLength(2);
  });

  test("settlement-priced and unknown operations", async () => {
    const h = await setup({ "GET /v1/rate-cards/peopleblade": reply(200, rateCard) });
    const settlement = await run(h, ["estimate", "model_tokens", "--json"]);
    expect(settlement.exitCode).toBe(0);
    expect(JSON.parse(settlement.stdout)).toEqual({
      schemaVersion: "hraness-credits-estimate-v1", product: { id: "peopleblade", name: "PeopleBlade" }, operation: "model_tokens", label: "AI processing", units: 1, known: false,
    });
    expect((await run(h, ["estimate", "model_tokens"])).stderr).toContain("priced at settlement");
    const unknown = await run(h, ["estimate", "nothing", "--json"]);
    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ error: "unknown_operation", message: expect.stringContaining("enrich_contact, model_tokens") });
    for (const argv of [["estimate"], ["estimate", "a", "b"], ["estimate", "enrich_contact", "--units", "0"], ["estimate", "enrich_contact", "--units", "x"], ["estimate", "Bad"]]) {
      expect((await run(h, argv)).exitCode).toBe(2);
    }
    expect(h.calls).toHaveLength(1);
  });

  test("rate card failures", async () => {
    const missing = await setup({ "GET /v1/rate-cards/peopleblade": reply(404, { error: "not_found" }) });
    expect((await run(missing, ["estimate", "enrich_contact"])).exitCode).toBe(2);
    const down = await setup({ "GET /v1/rate-cards/peopleblade": reply(0, undefined) });
    expect((await run(down, ["estimate", "enrich_contact"])).exitCode).toBe(1);
    const odd = await setup({ "GET /v1/rate-cards/peopleblade": reply(200, { ...rateCard, operations: { a: { label: "x", takeRate: 0.5 } } }) });
    expect((await run(odd, ["estimate", "enrich_contact"])).exitCode).toBe(1);
  });
});

describe("signout", () => {
  test("forgets the token and keeps the device id", async () => {
    const h = await setup();
    await seed(h, { token: DEVICE_TOKEN, pendingClaim: PENDING });
    const result = await run(h, ["signout"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"signedOut":true}\n');
    expect(result.stderr).toBe("✓ Signed out of PeopleBlade credits on this device. Your balance stays with your account.\n");
    expect(await state(h)).toEqual({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: DEVICE_ID, pendingClaim: PENDING });
    const again = await run(h, ["signout", "--json"]);
    expect(again.exitCode).toBe(0);
    expect(again.stderr).toBe("");
    const fresh = await setup();
    expect((await run(fresh, ["signout"])).stderr).toBe("○ PeopleBlade credits weren't signed in on this device.\n");
    expect(h.calls).toHaveLength(0);
  });
});

describe("output", () => {
  function sink(writes: string[]): CreditsOutput {
    return { write(text) { writes.push(text); return true; } };
  }

  test("sinks receive the same text the result carries", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const h = await setup({ "GET /v1/rate-cards/peopleblade": reply(200, rateCard) }, { stdout: sink(out), stderr: sink(err) });
    const result = await run(h, ["estimate", "enrich_contact", "--json"]);
    expect(out.join("")).toBe(result.stdout);
    expect(err.join("")).toBe(result.stderr);
    expect(err).toEqual([]);
    const human = await run(h, ["estimate", "enrich_contact"]);
    expect(err.join("")).toBe(human.stderr);
  });

  test("a failing sink never changes the result", async () => {
    const h = await setup({}, { stdout: { write() { throw new Error("EPIPE"); } }, stderr: { write(_text, callback) { callback?.(new Error("EPIPE")); return false; }, on() {}, removeListener() {} } });
    const result = await run(h, ["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).signedOut).toBe(true);
    const human = await run(h, ["status"]);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toContain("peopleblade credits topup");
  });
});
