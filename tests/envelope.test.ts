import { describe, expect, test } from "bun:test";
import {
  CREDITS_REQUIRED_INSTRUCTIONS, buildCreditsRequiredEnvelope, claimUrl, formatArgv, renderCreditsRequiredForHuman,
} from "../src/index.js";
import { requiredInput } from "./helpers.js";

const specExample = {
  schemaVersion: "hraness-credits-required-v1",
  product: { id: "peopleblade", name: "PeopleBlade" },
  operation: "enrich_contact",
  required: { microUsd: 12500000, credits: 1250, usd: "12.50" },
  balance: { microUsd: 0, credits: 0, usd: "0.00" },
  topup: {
    url: "https://credits.hraness.com/t/clm_8f3k2q",
    expiresAt: "2026-09-17T22:00:00Z",
    packs: [{ id: "p10", usd: 10, credits: 1000, bonusCredits: 0 }, { id: "p25", usd: 25, credits: 2500, bonusCredits: 150 }],
    suggestedPackId: "p25",
  },
  commands: {
    status: ["peopleblade", "credits", "status", "--json"],
    wait: ["peopleblade", "credits", "wait", "--json"],
    email: ["peopleblade", "credits", "email", "--to", "{address}"],
  },
  resume: { argv: ["peopleblade", "cloud", "enrich", "--list", "founders"], automatic: true },
  instructions: "Show the person the link and the price in plain words. Offer to email the link with the email command if they are not at this terminal. After payment, run the wait command or rerun the original command; the work resumes. Do not retry before payment, never enter card details, and never open the link yourself.",
};

describe("required envelope", () => {
  test("matches the contract example exactly, including key order", () => {
    const envelope = buildCreditsRequiredEnvelope(requiredInput());
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(specExample);
    expect(JSON.stringify(envelope)).toBe(JSON.stringify(specExample));
    expect(envelope.instructions).toBe(CREDITS_REQUIRED_INSTRUCTIONS);
    expect(Object.isFrozen(envelope.commands.status)).toBe(true);
  });

  test("uses the product's command prefix", () => {
    const envelope = buildCreditsRequiredEnvelope({ ...requiredInput(), command: ["npx", "-y", "peopleblade"] });
    expect(envelope.commands.email).toEqual(["npx", "-y", "peopleblade", "credits", "email", "--to", "{address}"]);
  });

  test("rejects invalid input", () => {
    const input = requiredInput();
    expect(() => buildCreditsRequiredEnvelope({ ...input, requiredMicroUsd: -1 })).toThrow(TypeError);
    expect(() => buildCreditsRequiredEnvelope({ ...input, requiredMicroUsd: 1.5 })).toThrow(TypeError);
    expect(() => buildCreditsRequiredEnvelope({ ...input, operation: "Enrich" })).toThrow(TypeError);
    expect(() => buildCreditsRequiredEnvelope({ ...input, topup: { ...input.topup, url: "http://credits.hraness.com/t/x" } })).toThrow(TypeError);
    expect(() => buildCreditsRequiredEnvelope({ ...input, resume: { argv: [], automatic: true } })).toThrow(TypeError);
    expect(() => buildCreditsRequiredEnvelope({ ...input, command: [] })).toThrow(TypeError);
  });

  test("human rendering is five lines with cost, link, packs, resume and email", () => {
    const now = Date.parse("2026-09-16T22:00:00Z");
    const text = renderCreditsRequiredForHuman(buildCreditsRequiredEnvelope(requiredInput()), { now, timeZone: "UTC" });
    expect(text).toBe([
      "PeopleBlade needs $12.50 in credits for enrich contact. This device has $0.00.",
      "Add credits: https://credits.hraness.com/t/clm_8f3k2q",
      "Packs: $10 · $25 (suggested). The link is valid for 24 hours, until 10:00 PM.",
      "After you pay, rerun peopleblade cloud enrich --list founders and the work picks up where it stopped.",
      "Not at this computer? Email yourself the link: peopleblade credits email --to <address>",
    ].join("\n") + "\n");
    expect(renderCreditsRequiredForHuman(buildCreditsRequiredEnvelope(requiredInput()), { now, timeZone: "UTC", operationLabel: "Contact enrichment" }))
      .toStartWith("PeopleBlade needs $12.50 in credits for Contact enrichment. ");
    const lines = text.trimEnd().split("\n");
    expect(lines.length >= 3 && lines.length <= 5).toBe(true);
  });

  test("human rendering without automatic resume", () => {
    const input = requiredInput();
    const text = renderCreditsRequiredForHuman(buildCreditsRequiredEnvelope({ ...input, resume: { argv: ["peopleblade", "enrich", "a b"], automatic: false } }));
    expect(text).toContain("After you pay, run peopleblade credits wait, then rerun peopleblade enrich 'a b'.");
    expect(() => renderCreditsRequiredForHuman({ ...buildCreditsRequiredEnvelope(input), instructions: "open it" } as never)).toThrow(TypeError);
  });

  test("formatArgv quotes only what needs quoting", () => {
    expect(formatArgv(["peopleblade", "credits", "email", "--to", "a@b.co"])).toBe("peopleblade credits email --to a@b.co");
    expect(formatArgv(["x", "it's", "two words"])).toBe("x 'it'\\''s' 'two words'");
  });

  test("claimUrl", () => {
    expect(claimUrl("https://credits.hraness.com", "clm_8f3k2q")).toBe("https://credits.hraness.com/t/clm_8f3k2q");
    expect(() => claimUrl("https://credits.hraness.com/", "clm_8f3k2q")).toThrow(TypeError);
    expect(() => claimUrl("https://credits.hraness.com", "../x")).toThrow(TypeError);
  });
});
