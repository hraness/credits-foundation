import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildCreditsRequiredEnvelope, creditsMenuItems, formatValidity, humanizeOperation, parseCreditsStatus,
  type CreditsSignedOutStatus,
} from "../src/index.js";
import { detectCreditsAudience, emitCreditsRequired, runCreditsCommand, type CreditsCommandIo } from "../src/node.js";
import { DEVICE_TOKEN, harness, profile, reply, requiredInput, statusResponse, type Harness } from "./helpers.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())); });

async function setup(overrides: Partial<CreditsCommandIo> = {}): Promise<Harness> {
  const h = await harness(call => new URL(call.url).pathname === "/v1/balance" ? reply(200, statusResponse()) : reply(404, {}), overrides);
  disposers.push(h.dispose);
  return h;
}

async function signIn(h: Harness): Promise<void> {
  await mkdir(dirname(h.stateFile), { recursive: true, mode: 0o700 });
  await writeFile(h.stateFile, JSON.stringify({
    schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: "11111111-1111-4111-8111-111111111111", token: DEVICE_TOKEN,
  }));
}

describe("detectCreditsAudience", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  test("follows the shared Hraness rule", () => {
    expect(detectCreditsAudience({ env: {}, stderr: tty })).toBe("human");
    expect(detectCreditsAudience({ env: {}, stderr: pipe })).toBe("quiet");
    for (const marker of ["AI_AGENT", "CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CURSOR_AGENT", "GEMINI_CLI"]) {
      expect(detectCreditsAudience({ env: { [marker]: "1" }, stderr: tty })).toBe("agent");
      expect(detectCreditsAudience({ env: { [marker]: "" }, stderr: tty })).toBe("human");
    }
    // Prefixes are human configuration, not agent markers.
    expect(detectCreditsAudience({ env: { CODEX_HOME: "/x", DEVIN_API_KEY: "k", CLAUDE_CODE_ENTRYPOINT: "cli" }, stderr: tty })).toBe("human");
    expect(detectCreditsAudience({ env: { CLAUDECODE: "1", HRANESS_AUDIENCE: "human" }, stderr: pipe })).toBe("human");
    expect(detectCreditsAudience({ env: { HRANESS_AUDIENCE: "agent" }, stderr: tty })).toBe("agent");
    expect(detectCreditsAudience({ env: { HRANESS_AUDIENCE: "off" }, stderr: tty })).toBe("quiet");
    expect(detectCreditsAudience({ env: { HRANESS_AUDIENCE: "robot" }, stderr: tty })).toBe("human");
  });
});

describe("credits help", () => {
  test("--help, -h, help and a bare call print grouped help to stdout and exit 0", async () => {
    const h = await setup();
    const outputs = await Promise.all([["--help"], ["-h"], ["help"], []].map(argv => runCreditsCommand(profile, argv, h.io)));
    for (const result of outputs) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(outputs[0]!.stdout);
    }
    const help = outputs[0]!.stdout;
    expect(help).toBe([
      "Usage: peopleblade credits <command> [options]",
      "",
      "Check and add credits for PeopleBlade on this device.",
      "",
      "Commands",
      "  status               Show your balance",
      "  topup                Get a link to add credits",
      "  wait                 Wait for a payment to finish",
      "  email --to <address> Email the link to yourself",
      "  estimate <operation> Show what an operation costs",
      "  signout              Forget the credits sign-in on this device",
      "",
      "Options",
      "  --json               Print machine-readable output",
      "  -h, --help           Show this help",
      "",
      "Example",
      "  peopleblade credits topup --usd 25",
    ].join("\n") + "\n");
    expect(help.split("\n").every(line => line.length <= 80)).toBe(true);
    expect(help).not.toMatch(/protocol|claim|micro/iu);
    expect(h.calls).toHaveLength(0);
  });
});

describe("audience and terminals", () => {
  test("a detected agent gets JSON without --json; a person gets text", async () => {
    const h = await setup();
    await signIn(h);
    const agent = await runCreditsCommand(profile, ["status"], { ...h.io, audience: undefined, env: { ...h.io.env, CLAUDECODE: "1" }, stderr: undefined });
    expect(JSON.parse(agent.stdout)).toEqual(JSON.parse(JSON.stringify(parseCreditsStatus(statusResponse()))));
    expect(agent.stderr).toBe("");
    const person = await runCreditsCommand(profile, ["status"], { ...h.io, audience: "human" });
    expect(person.stdout).toBe("");
    expect(person.stderr).toStartWith("● PeopleBlade credits: $8.10");
    const failure = await runCreditsCommand(profile, ["bogus"], { ...h.io, audience: "agent" });
    expect(failure.exitCode).toBe(2);
    expect(JSON.parse(failure.stdout)).toMatchObject({ error: "usage_error" });
  });

  test("signout and email keep JSON for scripts but never show it to a person", async () => {
    const h = await setup();
    await signIn(h);
    const person = await runCreditsCommand(profile, ["signout"], { ...h.io, audience: "human" });
    expect(person.stdout).toBe("");
    const pipe = await runCreditsCommand(profile, ["signout"], h.io);
    expect(pipe.stdout).toBe('{"signedOut":true}\n');
  });

  test("NO_COLOR changes nothing because the output has no color; plain terminals get ASCII", async () => {
    const h = await setup();
    const run = (env: Record<string, string>) => runCreditsCommand(profile, ["status"], { ...h.io, env: { XDG_STATE_HOME: h.home, ...env } });
    const expected = "○ No PeopleBlade credits on this device yet. Add some: peopleblade credits topup\n";
    expect((await run({ LANG: "en_US.UTF-8", NO_COLOR: "1" })).stderr).toBe(expected);
    expect((await run({ LANG: "en_US.UTF-8", TERM: "dumb" })).stderr).toBe(expected.replace("○", "o"));
    expect((await run({ LC_ALL: "C", LANG: "en_US.UTF-8" })).stderr).toBe(expected.replace("○", "o"));
    expect((await run({ LANG: "en_US.UTF-8", HRANESS_ASCII: "1" })).stderr).toBe(expected.replace("○", "o"));
    const unknown = await runCreditsCommand(profile, ["nope"], { ...h.io, env: { XDG_STATE_HOME: h.home } });
    expect(unknown.stderr).toBe('FAIL Unknown credits command "nope".\n-> peopleblade credits --help\n');
    expect(unknown.stderr).not.toMatch(/\u001b\[/u);
  });

  test("a low balance says so and uses the warning symbol", async () => {
    const low = await harness(() => reply(200, statusResponse({ lowBalance: true, held: { microUsd: 0 } })), {});
    disposers.push(low.dispose);
    await signIn(low);
    const result = await runCreditsCommand(profile, ["status"], low.io);
    expect(result.stderr.split("\n")[0]).toBe("⚠ PeopleBlade credits: $8.10. Your balance is low.");
  });
});

describe("emitCreditsRequired audience default", () => {
  const envelope = buildCreditsRequiredEnvelope(requiredInput());
  const capture = (isTTY: boolean) => {
    const writes: string[] = [];
    return { writes, stderr: { isTTY, write(text: string) { writes.push(text); return true; } } };
  };
  test("text at a terminal and in a pipe, JSON only for a detected agent", async () => {
    const tty = capture(true);
    expect(await emitCreditsRequired(envelope, { stderr: tty.stderr, env: {} }, undefined, { now: Date.parse("2026-09-16T22:00:00Z"), timeZone: "UTC" })).toBe(true);
    expect(tty.writes.join("")).toStartWith("PeopleBlade needs $12.50 in credits for enrich contact. This device has $0.00.\n");
    const pipe = capture(false);
    expect(await emitCreditsRequired(envelope, { stderr: pipe.stderr, env: {} })).toBe(true);
    expect(pipe.writes.join("")).toStartWith("PeopleBlade needs");
    const agent = capture(true);
    expect(await emitCreditsRequired(envelope, { stderr: agent.stderr, env: { CODEX_SANDBOX: "seatbelt" } })).toBe(true);
    expect(JSON.parse(agent.writes[0]!).schemaVersion).toBe("hraness-credits-required-v1");
  });
});

describe("formatValidity and humanizeOperation", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  test("relative time with a clock time, never a raw timestamp", () => {
    expect(formatValidity("2026-09-17T12:00:00Z", { now, timeZone: "UTC" })).toBe("valid for 24 hours, until 12:00 PM");
    expect(formatValidity("2026-09-16T13:00:00Z", { now, timeZone: "UTC" })).toBe("valid for 1 hour, until 1:00 PM");
    expect(formatValidity("2026-09-16T12:45:00Z", { now, timeZone: "UTC" })).toBe("valid for 45 minutes, until 12:45 PM");
    expect(formatValidity("2026-09-16T12:00:20Z", { now, timeZone: "UTC" })).toBe("valid for 1 minute, until 12:00 PM");
    expect(formatValidity("2026-09-30T15:40:00Z", { now, timeZone: "UTC" })).toBe("valid until Sep 30, 3:40 PM");
    expect(formatValidity("2026-09-16T11:00:00Z", { now, timeZone: "UTC" })).toBe("expired");
  });
  test("operation IDs read as words", () => {
    expect(humanizeOperation("enrich_contact")).toBe("enrich contact");
    expect(humanizeOperation("model-tokens.v2")).toBe("model tokens v2");
  });
});

describe("creditsMenuItems", () => {
  const status = parseCreditsStatus(statusResponse())!;
  test("a balance status row and an Add credits action (menu kit v2)", () => {
    expect(creditsMenuItems(status)).toEqual([
      { kind: "status", symbol: "status.running", label: "$8.10 in credits" },
      { kind: "action", id: "credits.add", label: "Add credits", symbol: "action.add", opens: "browser" },
    ]);
  });
  test("a low balance needs attention", () => {
    const low = parseCreditsStatus(statusResponse({ lowBalance: true }))!;
    expect(creditsMenuItems(low, { id: "credits.topup" })).toEqual([
      { kind: "status", symbol: "status.attention", label: "$8.10 in credits", detail: "Balance is low" },
      { kind: "action", id: "credits.topup", label: "Add credits", symbol: "action.add", opens: "browser" },
    ]);
  });
  test("signed out", () => {
    const signedOut: CreditsSignedOutStatus = { schemaVersion: "hraness-credits-status-v1", product: { id: "peopleblade", name: "PeopleBlade" }, signedOut: true, topup: { command: ["peopleblade", "credits", "topup", "--json"] } };
    expect(creditsMenuItems(signedOut)[0]).toEqual({ kind: "status", symbol: "status.signedOut", label: "No credits on this device" });
  });
  test("rejects reserved or malformed IDs", () => {
    for (const id of ["foundation.login", "", "has space", "-x"]) expect(() => creditsMenuItems(status, { id })).toThrow(TypeError);
  });
  test("labels pass the menu lint basics: sentence case, ≤48 characters, no glyphs or paths", () => {
    for (const row of creditsMenuItems(status)) {
      expect(row.label.length).toBeLessThanOrEqual(48);
      expect(row.label).not.toMatch(/[↗…/]|\.\.\./u);
    }
  });
});
