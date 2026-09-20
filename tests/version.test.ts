import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CREDITS_FOUNDATION_VERSION } from "../src/index.js";

describe("package invariants", () => {
  test("the user-agent version matches the manifest", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(CREDITS_FOUNDATION_VERSION).toBe(manifest.version);
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.exports)).toEqual([".", "./node", "./server", "./recovery", "./recovery/bun"]);
  });

  test("the root and its helpers import no Node builtins", async () => {
    for (const file of ["index.ts", "internal.ts", "transport.ts", "server.ts"]) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from "node:/u);
      expect(source).not.toMatch(/require\(/u);
    }
  });
});
