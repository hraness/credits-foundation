import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreditsFetch, CreditsProductProfile } from "../src/index.js";
import type { CreditsCommandIo } from "../src/node.js";

// Belt and braces: even a code path that consulted the process environment
// would land in a throwaway directory, never in real user state.
process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "credits-guard-"));

export const BELL = String.fromCharCode(7);
export const ORIGIN = "https://credits.hraness.com";
export const profile: CreditsProductProfile = Object.freeze({
  id: "peopleblade", name: "PeopleBlade", command: Object.freeze(["peopleblade"]), serviceOrigin: ORIGIN,
});
export const DEVICE_TOKEN = `cr_dev_${"A".repeat(43)}`;
export const OTHER_TOKEN = `cr_dev_${"Z".repeat(43)}`;
export const CLAIM_SECRET = `cr_clm_${"B".repeat(43)}`;
export const PRODUCT_KEY = `cr_prod_${"C".repeat(43)}`;
export const CLAIM_ID = "clm_8f3k2q";
export const EXPIRES_AT = "2026-09-17T22:00:00Z";
export const product = { id: "peopleblade", name: "PeopleBlade" };
export const packs = [
  { id: "p10", usd: 10, credits: 1000, bonusCredits: 0, label: "$10 pack" },
  { id: "p25", usd: 25, credits: 2500, bonusCredits: 150, label: "$25 pack" },
  { id: "p50", usd: 50, credits: 5000, bonusCredits: 500, label: "$50 pack" },
  { id: "p100", usd: 100, credits: 10000, bonusCredits: 1500, label: "$100 pack" },
];
export const rateCard = {
  product,
  packs,
  suggestedPackId: "p25",
  minUsd: 10,
  maxUsd: 500,
  operations: {
    enrich_contact: { label: "contact enrichment", unitPrice: { microUsd: 200000, usd: "0.20" } },
    model_tokens: { label: "AI processing" },
  },
};

export function claimResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "hraness-credits-claim-v1",
    claimId: CLAIM_ID,
    claimSecret: CLAIM_SECRET,
    url: `${ORIGIN}/t/${CLAIM_ID}`,
    expiresAt: EXPIRES_AT,
    product,
    packs,
    suggestedPackId: "p25",
    ...overrides,
  };
}

export function claimStatus(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: "hraness-credits-claim-status-v1", claimId: CLAIM_ID, state, expiresAt: EXPIRES_AT, ...overrides };
}

export function statusResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "hraness-credits-status-v1",
    product,
    balance: { microUsd: 8100000, credits: 810, usd: "8.10" },
    held: { microUsd: 500000 },
    lowBalance: false,
    lastPrice: { microUsd: 200000, usd: "0.20" },
    account: { email: "reader@example.com" },
    topup: { url: `${ORIGIN}/t/${CLAIM_ID}`, packs, suggestedPackId: "p25" },
    ...overrides,
  };
}

export function requiredInput() {
  return {
    product,
    command: ["peopleblade"],
    operation: "enrich_contact",
    requiredMicroUsd: 12500000,
    balanceMicroUsd: 0,
    topup: {
      url: `${ORIGIN}/t/${CLAIM_ID}`,
      expiresAt: EXPIRES_AT,
      packs: packs.slice(0, 2),
      suggestedPackId: "p25",
    },
    resume: { argv: ["peopleblade", "cloud", "enrich", "--list", "founders"], automatic: true },
  };
}

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal;
}
export interface Reply { status: number; body?: unknown; raw?: string; contentType?: string }
export type Route = (call: Call) => Reply | Promise<Reply>;

/** In-process transport: `status: 0` simulates an unreachable service. */
export function stubFetch(route: Route): { fetch: CreditsFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: CreditsFetch = async (url, init) => {
    const call: Call = {
      method: init.method,
      url,
      headers: { ...init.headers },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    };
    calls.push(call);
    const reply = await route(call);
    if (reply.status === 0) throw new TypeError("fetch failed");
    return new Response(reply.raw ?? JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": reply.contentType ?? "application/json; charset=utf-8" },
    });
  };
  return { fetch, calls };
}

export interface Harness {
  readonly io: CreditsCommandIo;
  readonly calls: Call[];
  readonly home: string;
  readonly stateFile: string;
  readonly lockFile: string;
  readonly now: () => number;
  readonly dispose: () => Promise<void>;
}

export async function harness(route: Route, overrides: Partial<CreditsCommandIo> = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "credits-test-"));
  const { fetch, calls } = stubFetch(route);
  let clock = 1_789_600_000_000;
  const io: CreditsCommandIo = {
    fetch,
    env: { XDG_STATE_HOME: home },
    now: () => clock,
    sleep: async ms => { clock += ms; },
    deviceLabel: "test-device",
    ...overrides,
  };
  const directory = join(home, "hraness", "credits");
  return {
    io,
    calls,
    home,
    stateFile: join(directory, "peopleblade.json"),
    lockFile: join(directory, "peopleblade.lock"),
    now: () => clock,
    dispose: () => rm(home, { recursive: true, force: true }),
  };
}

export function reply(status: number, body: unknown): Reply {
  return { status, body };
}
