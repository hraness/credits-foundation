import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { creditsStateDirectory, readStoredDeviceToken, runCreditsCommand } from "../src/node.js";
import { CLAIM_ID, CLAIM_SECRET, DEVICE_TOKEN, claimResponse, harness, profile, reply, type Harness, type Route } from "./helpers.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())); });

async function setup(route: Route = () => reply(404, { error: "not_found" })): Promise<Harness> {
  const h = await harness(route);
  disposers.push(h.dispose);
  return h;
}

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
async function seed(h: Harness, extra: Record<string, unknown>, raw?: string): Promise<void> {
  await mkdir(dirname(h.stateFile), { recursive: true, mode: 0o700 });
  await writeFile(h.stateFile, raw ?? JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: DEVICE_ID, ...extra }));
}

describe("state store", () => {
  test("resolves the XDG state directory", () => {
    expect(creditsStateDirectory({ env: { XDG_STATE_HOME: "/tmp/x" } })).toBe(join("/tmp/x", "hraness", "credits"));
    expect(creditsStateDirectory({ env: { XDG_STATE_HOME: "relative" } })).toEndWith(join(".local", "state", "hraness", "credits"));
    expect(creditsStateDirectory({ stateDirectory: "/custom" })).toBe("/custom");
  });

  test("a read-only command creates the private directory but no state file", async () => {
    const h = await setup();
    const result = await runCreditsCommand(profile, ["status", "--json"], h.io);
    expect(result.exitCode).toBe(0);
    const directory = dirname(h.stateFile);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual([]);
  });

  test("topup writes the state file atomically with a private mode", async () => {
    const h = await setup(() => reply(201, claimResponse()));
    const result = await runCreditsCommand(profile, ["topup", "--json"], h.io);
    expect(result.exitCode).toBe(0);
    expect(await readdir(dirname(h.stateFile))).toEqual(["peopleblade.json"]);
    expect((await stat(h.stateFile)).mode & 0o777).toBe(0o600);
    const text = await readFile(h.stateFile, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const state = JSON.parse(text);
    expect(Object.keys(state)).toEqual(["schemaVersion", "product", "deviceId", "pendingClaim"]);
    expect(state.schemaVersion).toBe("hraness-credits-state-v1");
    expect(state.product).toBe("peopleblade");
    expect(state.deviceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(state.pendingClaim).toEqual({ id: CLAIM_ID, secret: CLAIM_SECRET, expiresAt: "2026-09-17T22:00:00Z" });
    const again = await runCreditsCommand(profile, ["topup", "--json"], h.io);
    expect(JSON.parse(again.stdout).claimId).toBe(CLAIM_ID);
    expect(JSON.parse(await readFile(h.stateFile, "utf8")).deviceId).toBe(state.deviceId);
  });

  test("a held lock reports busy and changes nothing", async () => {
    const h = await setup();
    await seed(h, { token: DEVICE_TOKEN });
    await writeFile(h.lockFile, "");
    const before = await readFile(h.stateFile, "utf8");
    const result = await runCreditsCommand(profile, ["signout", "--json"], h.io);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("holds the state lock");
    expect(result.stderr).toContain(h.lockFile);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "busy" });
    expect(await readFile(h.stateFile, "utf8")).toBe(before);
    expect(h.calls).toHaveLength(0);
  });

  test("malformed state is preserved and reported as unavailable", async () => {
    for (const raw of [
      "{not json",
      JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "other", deviceId: DEVICE_ID }),
      JSON.stringify({ schemaVersion: "hraness-credits-state-v2", product: "peopleblade", deviceId: DEVICE_ID }),
      JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: DEVICE_ID, token: "cr_dev_short" }),
      JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: DEVICE_ID, pendingClaim: { id: CLAIM_ID } }),
      JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: DEVICE_ID, rateCard: { fetchedAt: 1, body: {} } }),
      JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: DEVICE_ID, extra: true }),
      "[]",
    ]) {
      const h = await setup();
      await seed(h, {}, raw);
      const result = await runCreditsCommand(profile, ["status"], h.io);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unavailable or malformed");
      expect(await readFile(h.stateFile, "utf8")).toBe(raw);
      expect(await readdir(dirname(h.stateFile))).toEqual(["peopleblade.json"]);
      expect(await readStoredDeviceToken(profile, h.io)).toEqual({ ok: false, reason: "state-unavailable" });
    }
  });

  test("oversized state is unavailable", async () => {
    const h = await setup();
    await seed(h, {}, `${JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: DEVICE_ID })}${" ".repeat(17_000)}`);
    const result = await runCreditsCommand(profile, ["status", "--json"], h.io);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toBe("state_unavailable");
  });

  test("a symlinked state file is refused", async () => {
    const h = await setup();
    await mkdir(dirname(h.stateFile), { recursive: true, mode: 0o700 });
    const target = join(h.home, "elsewhere.json");
    await writeFile(target, JSON.stringify({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: DEVICE_ID, token: DEVICE_TOKEN }));
    await symlink(target, h.stateFile);
    const result = await runCreditsCommand(profile, ["status", "--json"], h.io);
    expect(result.exitCode).toBe(1);
    expect(await readStoredDeviceToken(profile, h.io)).toEqual({ ok: false, reason: "state-unavailable" });
  });

  test("readStoredDeviceToken reads without taking the lock", async () => {
    const h = await setup();
    expect(await readStoredDeviceToken(profile, h.io)).toEqual({ ok: true, value: null });
    await seed(h, { token: DEVICE_TOKEN });
    await writeFile(h.lockFile, "");
    expect(await readStoredDeviceToken(profile, h.io)).toEqual({ ok: true, value: DEVICE_TOKEN });
    expect(await readStoredDeviceToken({ ...profile, id: "Bad Id" }, h.io)).toEqual({ ok: false, reason: "state-unavailable" });
  });

  test("no temporary files survive a write", async () => {
    const h = await setup(() => reply(201, claimResponse()));
    for (let i = 0; i < 3; i += 1) await runCreditsCommand(profile, ["topup", "--json"], h.io);
    expect(await readdir(dirname(h.stateFile))).toEqual(["peopleblade.json"]);
  });
});
