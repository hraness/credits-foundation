import { afterEach, describe, expect, test } from "bun:test";
import { defineRegistry, runCli } from "@hraness/desktop-foundation/registry";
import { readFileSync } from "node:fs";
import { creditsProtocol } from "../src/index.js";
import { creditsVerbs, runCreditsCommand } from "../src/node.js";
import { harness, claimStatus, profile, reply, statusResponse, CLAIM_ID, DEVICE_TOKEN, type Harness } from "./helpers.js";

const errorCodes = JSON.parse(readFileSync(new URL("../node_modules/@hraness/desktop-foundation/contract/error-codes.json", import.meta.url), "utf8")) as {
  codes: { code: string; exit: number }[];
  productCodes: { pattern: string; exit: number };
};

/** Asserts a stdout line is a contract envelope and that the exit matches its error code. */
function envelope(out: string, exit: number): Record<string, unknown> {
  const value = JSON.parse(out) as Record<string, unknown>;
  expect(typeof value.generatedAt).toBe("string");
  expect(value.generatedAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  if (value.ok === true) {
    expect(Object.keys(value).sort()).toEqual(["data", "generatedAt", "ok", "schema"]);
    expect(exit).toBe(0);
    return value;
  }
  expect(value.ok).toBe(false);
  expect(value.schema).toBe("hraness.error/1");
  const code = (value.error as { code: string }).code;
  const known = errorCodes.codes.find(entry => entry.code === code);
  if (known !== undefined) expect(exit).toBe(known.exit);
  else {
    expect(code).toMatch(new RegExp(errorCodes.productCodes.pattern, "u"));
    expect(exit).toBe(errorCodes.productCodes.exit);
  }
  return value;
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())); });

async function setup(): Promise<Harness> {
  const h = await harness(call => new URL(call.url).pathname === "/v1/balance" ? reply(200, statusResponse()) : reply(404, {}));
  disposers.push(h.dispose);
  return h;
}

function cli(h: Harness) {
  const { stdout: _stdout, stderr: _stderr, audience: _audience, env, ...options } = h.io;
  const registry = defineRegistry("peopleblade", [...creditsVerbs("peopleblade", profile, options)]);
  let out = "";
  let err = "";
  const io = {
    stdout: { write: (text: string) => { out += text; } },
    stderr: { write: (text: string) => { err += text; } },
    env: { ...env, HRANESS_AUDIENCE: "quiet" },
  };
  return {
    run: async (argv: string[]) => { out = ""; err = ""; const code = await runCli(registry, argv, io); return { code, out, err }; },
  };
}

async function signIn(h: Harness): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(h.stateFile), { recursive: true, mode: 0o700 });
  await writeFile(h.stateFile, JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: "11111111-1111-4111-8111-111111111111", token: DEVICE_TOKEN }), { mode: 0o600 });
}

describe("creditsVerbs", () => {
  test("commands --json lists every credits command with its class", async () => {
    const h = await setup();
    const { code, out } = await cli(h).run(["commands", "--json"]);
    expect(code).toBe(0);
    const verbs = (JSON.parse(out) as { data: { verbs: { path: string[]; opClass: string; schema: string }[] } }).data.verbs;
    expect(verbs.map(verb => [verb.path.join(" "), verb.opClass, verb.schema])).toEqual([
      ["credits protocol", "read", "peopleblade.credits-protocol/1"],
      ["credits status", "read", "peopleblade.credits-status/1"],
      ["credits estimate", "read", "peopleblade.credits-estimate/1"],
      ["credits topup", "operate", "peopleblade.credits-topup/1"],
      ["credits wait", "operate", "peopleblade.credits-wait/1"],
      ["credits email", "operate", "peopleblade.credits-email/1"],
      ["credits signout", "operate", "peopleblade.credits-signout/1"],
    ]);
  });

  test("credits protocol, the entry point agents are told to run, is a verb", async () => {
    const h = await setup();
    const c = cli(h);
    for (const argv of [["credits", "protocol", "--json"], ["credits", "protocol"]]) {
      const { code, out } = await c.run(argv);
      const value = envelope(out, code);
      expect(value.schema).toBe("peopleblade.credits-protocol/1");
      const data = value.data as { commands: { protocol: string[] }; exitCodes: Record<string, string>; lifecycle: { wait: string } };
      // The protocol names `credits protocol --json`; the registry must route it.
      expect(data.commands.protocol).toEqual(["peopleblade", "credits", "protocol", "--json"]);
      // Exits in the verb's protocol are the contract's, not runCreditsCommand's.
      expect(Object.keys(data.exitCodes)).toEqual(["0", "1", "2"]);
      expect(data.lifecycle.wait).not.toContain("exit 3");
      const direct = JSON.parse(JSON.stringify(creditsProtocol(profile))) as Record<string, unknown>;
      expect({ ...(data as Record<string, unknown>), exitCodes: undefined, lifecycle: undefined }).toEqual({ ...direct, exitCodes: undefined, lifecycle: undefined });
    }
    expect(h.calls).toHaveLength(0);
  });

  test("a verb's --json success wraps runCreditsCommand's JSON in the contract envelope", async () => {
    const h = await setup();
    await signIn(h);
    const viaVerb = await cli(h).run(["credits", "status", "--json"]);
    const direct = await runCreditsCommand(profile, ["status", "--json"], { ...h.io, stdout: undefined, stderr: undefined, audience: "quiet" });
    const value = envelope(viaVerb.out, viaVerb.code);
    expect(value.schema).toBe("peopleblade.credits-status/1");
    expect(value.data).toEqual(JSON.parse(direct.stdout));
    expect((value.data as { balance: { usd: string } }).balance.usd).toBe("8.10");
    // runCreditsCommand itself keeps its own shape.
    expect(JSON.parse(direct.stdout).ok).toBeUndefined();
  });

  test("text output is runCreditsCommand's, unchanged", async () => {
    const h = await setup();
    await signIn(h);
    const viaVerb = await cli(h).run(["credits", "status"]);
    const direct = await runCreditsCommand(profile, ["status"], { ...h.io, stdout: undefined, stderr: undefined, audience: "quiet" });
    expect(viaVerb.code).toBe(0);
    expect(viaVerb.out).toBe(direct.stdout);
  });

  test("value flags reach the credits command in either spelling; a bad value is a usage envelope", async () => {
    const h = await setup();
    const c = cli(h);
    const spaced = await c.run(["credits", "topup", "--usd", "abc", "--json"]);
    const joined = await c.run(["credits", "topup", "--usd=abc", "--json"]);
    expect(spaced.code).toBe(2);
    expect(joined.code).toBe(2);
    const value = envelope(spaced.out, spaced.code) as { error: { code: string; message: string } };
    expect(value.error.code).toBe("usage");
    expect(value.error.message).toContain("--usd must be a dollar amount");
    expect(JSON.parse(joined.out).error).toEqual(value.error);
  });

  test("an undeclared flag is refused before anything runs, in the same envelope", async () => {
    const h = await setup();
    const { code, out } = await cli(h).run(["credits", "signout", "--force", "--json"]);
    expect(code).toBe(2);
    expect((envelope(out, code).error as { code: string }).code).toBe("usage");
    expect(h.calls).toHaveLength(0);
  });

  test("a missing credential is a product code with exit 1, not a usage error", async () => {
    const h = await setup();
    const { code, out } = await cli(h).run(["credits", "wait", "--claim", CLAIM_ID, "--json"]);
    expect(code).toBe(1);
    expect((envelope(out, code).error as { code: string }).code).toBe("peopleblade.credits-unauthorized");
  });

  test("wait running out with payment still needed exits 1 with a product code and the claim in detail", async () => {
    const h = await harness(call => new URL(call.url).pathname === `/v1/claims/${CLAIM_ID}` ? reply(200, claimStatus("pending")) : reply(404, {}));
    disposers.push(h.dispose);
    await signIn(h);
    const { code, out } = await cli(h).run(["credits", "wait", "--claim", CLAIM_ID, "--timeout", "12s", "--json"]);
    expect(code).toBe(1);
    const error = envelope(out, code).error as { code: string; detail: string };
    expect(error.code).toBe("peopleblade.credits-timeout");
    expect(JSON.parse(error.detail).claim).toMatchObject({ state: "pending", claimId: CLAIM_ID });
  });

  test("signout forgets the local sign-in", async () => {
    const h = await setup();
    await signIn(h);
    const { code, out } = await cli(h).run(["credits", "signout", "--json"]);
    expect(envelope(out, code).data).toEqual({ signedOut: true });
    const again = await cli(h).run(["credits", "status", "--json"]);
    expect((envelope(again.out, again.code).data as { signedOut: boolean }).signedOut).toBe(true);
  });

  test("invalid product names and profiles are refused", () => {
    expect(() => creditsVerbs("PeopleBlade", profile)).toThrow(TypeError);
    expect(() => creditsVerbs("peopleblade", { ...profile, serviceOrigin: "not a url" })).toThrow(TypeError);
  });
});
