import { afterEach, describe, expect, test } from "bun:test";
import { defineRegistry, runCli } from "@hraness/desktop-foundation/registry";
import { creditsVerbs, runCreditsCommand } from "../src/node.js";
import { harness, profile, reply, statusResponse, DEVICE_TOKEN, type Harness } from "./helpers.js";

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
      ["credits status", "read", "peopleblade.credits-status/1"],
      ["credits estimate", "read", "peopleblade.credits-estimate/1"],
      ["credits topup", "operate", "peopleblade.credits-topup/1"],
      ["credits wait", "operate", "peopleblade.credits-wait/1"],
      ["credits email", "operate", "peopleblade.credits-email/1"],
      ["credits signout", "operate", "peopleblade.credits-signout/1"],
    ]);
  });

  test("a verb prints exactly what runCreditsCommand prints, with the same exit code", async () => {
    const h = await setup();
    await signIn(h);
    const viaVerb = await cli(h).run(["credits", "status", "--json"]);
    const direct = await runCreditsCommand(profile, ["status", "--json"], { ...h.io, stdout: undefined, stderr: undefined, audience: "quiet" });
    expect(viaVerb.code).toBe(direct.exitCode);
    expect(viaVerb.code).toBe(0);
    expect(viaVerb.out).toBe(direct.stdout);
    expect(JSON.parse(viaVerb.out).balance.usd).toBe("8.10");
  });

  test("value flags reach the credits command in either spelling", async () => {
    const h = await setup();
    const c = cli(h);
    const spaced = await c.run(["credits", "topup", "--usd", "abc", "--json"]);
    const joined = await c.run(["credits", "topup", "--usd=abc", "--json"]);
    expect(spaced.code).toBe(2);
    expect(joined.code).toBe(2);
    expect(JSON.parse(spaced.out).message).toContain("--usd must be a dollar amount");
    expect(spaced.out).toBe(joined.out);
  });

  test("an undeclared flag is refused before anything runs", async () => {
    const h = await setup();
    const { code, out } = await cli(h).run(["credits", "signout", "--force", "--json"]);
    expect(code).toBe(2);
    expect(JSON.parse(out).error.code).toBe("usage");
    expect(h.calls).toHaveLength(0);
  });

  test("signout forgets the local sign-in", async () => {
    const h = await setup();
    await signIn(h);
    const { code, out } = await cli(h).run(["credits", "signout", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ signedOut: true });
    const again = await cli(h).run(["credits", "status", "--json"]);
    expect(JSON.parse(again.out).signedOut).toBe(true);
  });

  test("invalid product names and profiles are refused", () => {
    expect(() => creditsVerbs("PeopleBlade", profile)).toThrow(TypeError);
    expect(() => creditsVerbs("peopleblade", { ...profile, serviceOrigin: "not a url" })).toThrow(TypeError);
  });
});
