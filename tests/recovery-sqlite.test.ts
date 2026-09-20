import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { constants as fsConstants, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapRecoveryStore, checkRecoveryFence, commitRecoveryEvent, readRecoveryStore, RECOVERY_SQLITE_PROFILE, type RecoveryStoreResult, type RecoveryLocation } from "../src/recovery-sqlite.js";
import { recoveryAction, type RecoveryState } from "../src/recovery-state.js";
import { readStoredDeviceToken, runCreditsCommand } from "../src/node.js";
import { CLAIM_ID, CLAIM_SECRET, EXPIRES_AT, claimStatus, profile, reply, stubFetch } from "./helpers.js";

const location = { trustedBase: "/private/tmp/credits-fixture", directory: ["credits"], productId: "peopleblade", serviceOrigin: "https://credits.example" };
const expected = { databaseId: "00000000-0000-4000-8000-000000000001", revision: 1, generation: 0 };

describe("recovery SQLite bounded input admission", () => {
  test("rejects hostile property shapes without running getters", () => {
    let getters = 0;
    for (const bad of [null, [], Object.create(location), { ...location, extra: 1 }, { ...location, [Symbol("x")]: 1 },
      Object.defineProperty({ ...location }, "productId", { get() { getters++; return "peopleblade"; } }),
      { ...location, ["x".repeat(100_000)]: 1 }, { ...location, productId: "\ud800" }]) {
      expect(readRecoveryStore(bad)).toEqual({ ok: false, reason: "invalid-input" });
    }
    expect(getters).toBe(0);
  });
  test("rejects path traversal, aliases, control characters and UTF-8 overflow before effects", () => {
    for (const trustedBase of ["relative", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\\b", "/a\n", "/a\u202e", `/${"界".repeat(2000)}`]) {
      expect(readRecoveryStore({ ...location, trustedBase })).toEqual({ ok: false, reason: "invalid-input" });
    }
    for (const directory of [[".."], ["."], [""], ["a/b"], ["a\\b"], ["a\n"], ["a\u2028"], ["\udfff"], ["界".repeat(43)], Array(9).fill("a"), Array(1)]) {
      expect(readRecoveryStore({ ...location, directory })).toEqual({ ok: false, reason: "invalid-input" });
    }
    const poisoned = ["a"]; let getters = 0;
    Object.defineProperty(poisoned, "0", { get() { getters++; return "a"; }, enumerable: true });
    expect(readRecoveryStore({ ...location, directory: poisoned })).toEqual({ ok: false, reason: "invalid-input" }); expect(getters).toBe(0);
  });
  test("requires exact product, origin and safe expected counters", () => {
    for (const productId of ["A", "a/b", "x".repeat(33), "../", ""]) expect(readRecoveryStore({ ...location, productId })).toEqual({ ok: false, reason: "invalid-input" });
    for (const serviceOrigin of ["https://x.test/path", "https://x.test/", "https://u:p@x.test", "http://example.com", "https://x.test?q=x"]) expect(readRecoveryStore({ ...location, serviceOrigin })).toEqual({ ok: false, reason: "invalid-input" });
    for (const change of [{ databaseId: "bad" }, { revision: -0 }, { generation: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { generation: Infinity }, { extra: "x" }]) {
      expect(checkRecoveryFence(location, { ...expected, ...change })).toEqual({ ok: false, reason: "invalid-input" });
    }
  });
});

function qualificationRefusal(): "unsupported-runtime" | "unsupported-filesystem" | null {
  if (process.platform !== "darwin" || process.arch !== "arm64" || Bun.version !== RECOVERY_SQLITE_PROFILE.bun
    || typeof process.getuid !== "function" || !Number.isSafeInteger(process.getuid())
    || typeof fsConstants.O_NOFOLLOW !== "number" || typeof fsConstants.O_NONBLOCK !== "number") return "unsupported-runtime";
  const db = new Database(":memory:");
  try {
    const identity = db.query("SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId").get() as { version: string; sourceId: string };
    const options = db.query("PRAGMA compile_options").all() as { compile_options: string }[];
    if (identity.version !== RECOVERY_SQLITE_PROFILE.sqlite || identity.sourceId !== RECOVERY_SQLITE_PROFILE.sourceId
      || !["THREADSAFE=2", "ENABLE_LOCKING_STYLE=1", "DEFAULT_SYNCHRONOUS=2"].every(option => options.some(row => row.compile_options === option))) return "unsupported-runtime";
  } finally { db.close(); }
  return statfsSync(realpathSync(tmpdir()), { bigint: true }).type === 26n ? null : "unsupported-filesystem";
}
const refusedProfile = qualificationRefusal();
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true }); });
const ids = { databaseId: expected.databaseId, deviceId: "00000000-0000-4000-8000-000000000002" };
const token = `cr_dev_${"t".repeat(43)}`;
const legacy = (extra: Record<string, unknown> = {}) => ({ schemaVersion: "hraness-credits-state-v1", product: "peopleblade", deviceId: ids.deviceId, ...extra });
function setup(): RecoveryLocation {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "credits-sqlite-test-")); chmodSync(base, 0o700); scratch.push(base);
  return { ...location, trustedBase: base };
}
function paths(loc: RecoveryLocation) { const dir = join(loc.trustedBase, ...loc.directory); return { dir, db: join(dir, "peopleblade.v2.sqlite"), marker: join(dir, "peopleblade.json"), lock: join(dir, "peopleblade.lock") }; }
function value<T>(result: RecoveryStoreResult<T>): T { expect(result.ok).toBe(true); if (!result.ok) throw new Error(`Fixture failed: ${result.reason}`); return result.value; }
function counters(s: RecoveryState) { return { databaseId: s.databaseId, revision: s.revision, generation: s.generation }; }
function seed(loc: RecoveryLocation, raw: unknown) { const p = paths(loc); mkdirSync(p.dir, { mode: 0o700 }); writeFileSync(p.marker, typeof raw === "string" ? raw : JSON.stringify(raw), { mode: 0o600 }); }
function sql(loc: RecoveryLocation, run: (db: Database) => void) { const db = new Database(paths(loc).db, { readwrite: true, create: false }); try { run(db); } finally { db.close(); } }
function registration(s: RecoveryState) {
  return { type: "prepare-registration", operationId: "00000000-0000-4000-8000-000000000003", pickupId: "00000000-0000-4000-8000-000000000004", claimSecret: `cr_clm_${"s".repeat(43)}`, candidateToken: `cr_dev_${"c".repeat(43)}`,
    body: { schemaVersion: "hraness-credits-claim-create-v2", creationId: "00000000-0000-4000-8000-000000000005", product: s.productId, device: { id: s.deviceId } } };
}
async function child(loc: RecoveryLocation, mode: string) {
  const process = Bun.spawn([Bun.argv[0]!, join(import.meta.dir, "fixtures/recovery-sqlite-child.ts"), mode, loc.trustedBase], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { TZ: "UTC" } });
  const errors = new Response(process.stderr).text(), reader = process.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const message = await Promise.race([
      (async () => {
        let text = "";
        for (;;) { const chunk = await reader.read(); if (chunk.done) throw new Error("Qualification child stopped before receipt."); text += new TextDecoder().decode(chunk.value); if (text.length > 4096) throw new Error("Oversized child receipt."); if (text.includes("\n")) return JSON.parse(text.slice(0, text.indexOf("\n"))) as Record<string, unknown>; }
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Qualification child deadline.")), 5000); }),
    ]);
    return { message, async collect(kill = false) {
      if (kill) process.kill("SIGKILL");
      const code = await process.exited; await reader.cancel(); expect(await errors).toBe(""); expect(code).toBe(kill ? 137 : 0);
    } };
  } catch (error) { process.kill("SIGKILL"); await process.exited; await reader.cancel(); const detail = await errors; throw new Error(`${String(error)} ${detail.slice(0, 2048)}`); }
  finally { if (timer) clearTimeout(timer); }
}

test.skipIf(refusedProfile === null)("unqualified host rejects all storage operations with the exact profile reason", () => {
  if (refusedProfile === null) throw new Error("Qualified hosts must run the positive qualification suite.");
  const loc = setup();
  for (const result of [bootstrapRecoveryStore(loc, ids), readRecoveryStore(loc), checkRecoveryFence(loc, expected), commitRecoveryEvent(loc, expected, { type: "signout" })]) {
    expect(result).toEqual({ ok: false, reason: refusedProfile });
  }
  expect(existsSync(paths(loc).dir)).toBe(false);
});

describe.skipIf(refusedProfile !== null)("recovery SQLite exact-host file qualification", () => {
  test("returning topup-v2 persists intent, reconciles late paid status and fences old writers", async () => {
    const loc = setup(); seed(loc, legacy({ token })); const start = value(bootstrapRecoveryStore(loc, ids));
    const marker = readFileSync(paths(loc).marker, "utf8"), operationId = "00000000-0000-4000-8000-000000000008";
    const body = { schemaVersion: "hraness-credits-topup-create-v2", creationId: operationId, product: loc.productId, device: { id: ids.deviceId }, packId: "p25" };
    const prepared = value(commitRecoveryEvent(loc, counters(start), { type: "prepare-topup-v2", operationId, body }));
    expect(prepared.kind).toBe("commit"); if (prepared.kind !== "commit") throw new Error("Fixture commit failed.");
    const pending = value(readRecoveryStore(loc)); expect(pending).toEqual(prepared.next); expect(pending.active?.token).toBe(token);
    expect(pending.pending?.kind === "topup-v2" && pending.pending.originalToken).toBe(token);
    expect(recoveryAction(pending, "create-topup-v2")).toEqual(prepared.afterCommitAction);
    expect(commitRecoveryEvent(loc, counters(start), { type: "prepare-topup-v2", operationId, body })).toEqual({ ok: false, reason: "stale-state" });
    const createdAt = "2026-09-16T12:00:00.000Z", expiresAt = "2026-09-17T12:00:00.000Z", claimId = "topup_store";
    value(commitRecoveryEvent(loc, counters(pending), { type: "created-topup-v2", ticket: prepared.afterCommitAction,
      response: { schemaVersion: "hraness-credits-topup-created-v2", creationId: operationId, binding: { claimId, productId: loc.productId, deviceId: ids.deviceId }, createdAt, expiresAt, payUrl: `${loc.serviceOrigin}/t/${claimId}` } }));
    const known = value(readRecoveryStore(loc)), ticket = recoveryAction(known, "status-topup-v2")!;
    const status = { schemaVersion: "hraness-credits-claim-status-v1", claimId, state: "expired", expiresAt };
    value(commitRecoveryEvent(loc, counters(known), { type: "status-topup-v2", ticket, response: status }));
    const expired = value(readRecoveryStore(loc)), fresh = recoveryAction(expired, "status-topup-v2")!;
    expect(expired.pending?.stage).toBe("expired"); expect(fresh.preparedRevision).toBe(expired.revision);
    expect(commitRecoveryEvent(loc, counters(known), { type: "status-topup-v2", ticket, response: { ...status, state: "paid", paidAt: "2026-09-20T12:00:00.000Z" } })).toEqual({ ok: false, reason: "stale-state" });
    const oldWriter = await runCreditsCommand(profile, ["signout", "--json"], { stateDirectory: paths(loc).dir, fetch: async () => { throw new Error("No old-writer network."); } });
    expect(oldWriter.exitCode).toBe(1); expect(value(readRecoveryStore(loc))).toEqual(expired);
    value(commitRecoveryEvent(loc, counters(expired), { type: "status-topup-v2", ticket: fresh, response: { ...status, state: "paid", paidAt: "2026-09-20T12:00:00.000Z" } }));
    const paid = value(readRecoveryStore(loc)); expect(paid.pending).toBeNull(); expect(paid.active).toEqual(start.active); expect(paid.generation).toBe(start.generation + 1);
    value(commitRecoveryEvent(loc, counters(paid), { type: "signout" }));
    const signed = value(readRecoveryStore(loc)); expect(signed.active).toBeNull(); expect(signed.pending).toBeNull(); expect(JSON.stringify(signed)).not.toContain(token);
    expect(readFileSync(paths(loc).marker, "utf8")).toBe(marker);
  });
  test("returning topup-v2 crash and lost commit result recover only the saved intent", async () => {
    for (const mode of ["topup-before-commit", "topup-after-commit", "topup-commit-after-failure"]) {
      const loc = setup(); seed(loc, legacy({ token })); const start = value(bootstrapRecoveryStore(loc, ids));
      const operation = await child(loc, mode);
      await operation.collect(mode !== "topup-commit-after-failure");
      if (mode === "topup-commit-after-failure") expect(operation.message).toEqual({ ok: false, reason: "storage-uncertain" });
      else expect(operation.message).toEqual({ phase: mode });
      const saved = value(readRecoveryStore(loc)); expect(saved.active).toEqual(start.active);
      if (mode === "topup-before-commit") expect(saved).toEqual(start);
      else {
        expect(saved.pending?.kind).toBe("topup-v2"); expect(saved.pending?.stage).toBe("create-pending");
        expect(saved.pending?.kind === "topup-v2" && saved.pending.originalToken).toBe(token);
        expect(JSON.parse(saved.pending!.canonicalCreateBody!)).toEqual({ schemaVersion: "hraness-credits-topup-create-v2", creationId: "00000000-0000-4000-8000-000000000003", product: loc.productId, device: { id: ids.deviceId } });
        expect(recoveryAction(saved, "create-topup-v2")?.preparedRevision).toBe(saved.revision);
      }
    }
  });
  test("fresh adoption is fenced, private, bounded, immutable and idempotent only with null fresh", async () => {
    const loc = setup(), p = paths(loc), state = value(bootstrapRecoveryStore(loc, ids));
    expect(state).toMatchObject({ bootstrap: "active", revision: 1, generation: 0, ...ids, active: null, pending: null });
    expect(Object.isFrozen(state)).toBe(true);
    expect(value(readRecoveryStore(loc))).toEqual(state);
    expect(value(bootstrapRecoveryStore(loc, null))).toEqual(state);
    expect(bootstrapRecoveryStore(loc, ids)).toEqual({ ok: false, reason: "invalid-input" });
    expect(lstatSync(p.dir).mode & 0o777).toBe(0o700); expect(lstatSync(p.db).mode & 0o777).toBe(0o600); expect(lstatSync(p.marker).mode & 0o777).toBe(0o600);
    expect(lstatSync(p.db).size).toBeLessThanOrEqual(1_048_576);
    expect(readdirSync(p.dir).sort()).toEqual(["peopleblade.json", "peopleblade.v2.sqlite"]);
    expect(await readStoredDeviceToken(profile, { stateDirectory: p.dir })).toEqual({ ok: false, reason: "state-unavailable" });
    const old = await runCreditsCommand(profile, ["signout", "--json"], { stateDirectory: p.dir, fetch: async () => { throw new Error("No old-writer network expected."); } });
    expect(old.exitCode).toBe(1); expect(value(readRecoveryStore(loc))).toEqual(state);
  });
  test("migrates eligible original legacy state and removes redundant legacy bearer blobs", () => {
    for (const pending of [false, true]) {
      const loc = setup(), claim = { id: "claim_existing", expiresAt: "2026-09-21T12:00:00Z" };
      seed(loc, legacy({ token, ...(pending ? { pendingClaim: claim } : {}) }));
      const state = value(bootstrapRecoveryStore(loc, { ...ids, ...(pending ? { legacyOperationId: "00000000-0000-4000-8000-000000000009" } : {}) }));
      expect(state.active?.token).toBe(token); expect(state.deviceId).toBe(ids.deviceId);
      expect(state.pending?.canonicalCreateBody ?? null).toBeNull();
      if (pending) expect(state.pending).toMatchObject({ kind: "topup-v1", stage: "claim-pending", claim: { claimId: claim.id, payUrl: null } });
      sql(loc, db => expect(db.query("SELECT legacy_bytes,legacy_sha256 FROM recovery").get()).toEqual({ legacy_bytes: null, legacy_sha256: null }));
      const signed = value(commitRecoveryEvent(loc, counters(state), { type: "signout" })); expect(signed.kind).toBe("commit");
      expect(value(readRecoveryStore(loc))).toMatchObject({ active: null, pending: null, revision: 2, generation: 1 });
    }
  });
  test("refuses secret-bearing, duplicate-key, foreign or malformed legacy unchanged", () => {
    for (const original of [JSON.stringify(legacy({ token, pendingClaim: { id: "claim_a", secret: `cr_clm_${"x".repeat(43)}`, expiresAt: "2026-09-21T12:00:00Z" } })),
      JSON.stringify(legacy({ token, pendingClaim: { id: "claim_a", secret: null, expiresAt: "2026-09-21T12:00:00Z" } })),
      JSON.stringify(legacy()).replace('"product":"peopleblade"', '"product":"wrong","product":"peopleblade"'),
      JSON.stringify({ ...legacy(), product: "wrong" }), "{broken", JSON.stringify(legacy({ extra: 1 }))]) {
      const loc = setup(); seed(loc, original); const p = paths(loc);
      expect(bootstrapRecoveryStore(loc, ids).ok).toBe(false); expect(readFileSync(p.marker, "utf8")).toBe(original);
      expect(existsSync(p.db)).toBe(false); expect(existsSync(p.lock)).toBe(false);
    }
  });
  test("CAS executes the model, withholds pending tokens, fences signout and rejects forged state events", () => {
    const loc = setup(), initial = value(bootstrapRecoveryStore(loc, ids)), result = value(commitRecoveryEvent(loc, counters(initial), registration(initial)));
    expect(result.kind).toBe("commit"); if (result.kind !== "commit") throw new Error("Expected committed fixture.");
    expect(result.afterCommitAction?.action).toBe("create-v2"); expect(result.next.active).toBeNull();
    expect(Object.isFrozen(result.next.pending)).toBe(true); expect(Object.isFrozen(result.expected)).toBe(true);
    expect(commitRecoveryEvent(loc, counters(initial), { type: "signout" })).toEqual({ ok: false, reason: "stale-state" });
    expect(checkRecoveryFence(loc, counters(initial))).toEqual({ ok: false, reason: "stale-state" });
    expect(value(checkRecoveryFence(loc, counters(result.next)))).toEqual(result.next);
    expect(commitRecoveryEvent(loc, counters(result.next), { type: "activate" })).toEqual({ ok: false, reason: "invalid-transition" });
    expect(commitRecoveryEvent(loc, counters(result.next), { next: { ...result.next, active: { token } } }).ok).toBe(false);
    const signed = value(commitRecoveryEvent(loc, counters(result.next), { type: "signout" })); expect(signed.kind).toBe("commit");
    expect(commitRecoveryEvent(loc, counters(result.next), { type: "uncertain", ticket: result.afterCommitAction })).toEqual({ ok: false, reason: "stale-state" });
    expect(value(readRecoveryStore(loc))).toMatchObject({ generation: 1, pending: null, active: null });
  });
  test("existing opens never create missing DB/marker and preserve mismatched artifacts", () => {
    const empty = setup(); expect(readRecoveryStore(empty)).toEqual({ ok: false, reason: "missing-store" }); expect(existsSync(paths(empty).dir)).toBe(false);
    for (const change of ["db", "marker", "uuid"] as const) {
      const loc = setup(); value(bootstrapRecoveryStore(loc, ids)); const p = paths(loc);
      if (change === "uuid") writeFileSync(p.marker, readFileSync(p.marker, "utf8").replace(ids.databaseId, ids.deviceId)); else unlinkSync(p[change]);
      expect(readRecoveryStore(loc).ok).toBe(false); expect(checkRecoveryFence(loc, expected).ok).toBe(false);
      expect(existsSync(p.db)).toBe(change !== "db"); expect(existsSync(p.marker)).toBe(change !== "marker");
    }
  });
  test("rejects unsafe private paths, symlinks, hardlinks and sidecars without repair", () => {
    for (const change of ["dir-mode", "db-mode", "db-readonly", "marker-mode", "db-hardlink", "db-symlink", "wal", "shm", "unsafe-journal"] as const) {
      const loc = setup(); value(bootstrapRecoveryStore(loc, ids)); const p = paths(loc);
      if (change === "dir-mode") chmodSync(p.dir, 0o755);
      if (change === "db-mode") chmodSync(p.db, 0o644);
      if (change === "db-readonly") chmodSync(p.db, 0o400);
      if (change === "marker-mode") chmodSync(p.marker, 0o644);
      if (change === "db-hardlink") linkSync(p.db, join(loc.trustedBase, "db-copy"));
      if (change === "db-symlink") { const bytes = readFileSync(p.db); unlinkSync(p.db); const other = join(loc.trustedBase, "other.sqlite"); writeFileSync(other, bytes, { mode: 0o600 }); symlinkSync(other, p.db); }
      if (change === "wal" || change === "shm") writeFileSync(`${p.db}-${change}`, "", { mode: 0o600 });
      if (change === "unsafe-journal") writeFileSync(`${p.db}-journal`, "", { mode: 0o644 });
      expect(readRecoveryStore(loc).ok).toBe(false); expect(existsSync(p.db)).toBe(true);
    }
  });
  test("rejects corrupt, unknown-schema, missing-row and unreachable imported counters", () => {
    for (const change of ["corrupt", "empty", "trigger", "row", "counter", "raw-legacy", "mode"] as const) {
      const loc = setup(); value(bootstrapRecoveryStore(loc, ids)); const p = paths(loc);
      if (change === "corrupt") writeFileSync(p.db, "broken database");
      else if (change === "empty") writeFileSync(p.db, "");
      else sql(loc, db => {
        if (change === "trigger") db.exec("CREATE TRIGGER other AFTER UPDATE ON recovery BEGIN SELECT 1; END;");
        if (change === "row") db.exec("DELETE FROM recovery");
        if (change === "counter") db.exec("UPDATE recovery SET generation=revision");
        if (change === "raw-legacy") db.query("UPDATE recovery SET legacy_bytes=?,legacy_sha256=?").run(new Uint8Array([1]), "bad");
        if (change === "mode") db.exec("PRAGMA journal_mode=WAL");
      });
      expect(readRecoveryStore(loc).ok).toBe(false); expect(existsSync(p.db)).toBe(true);
    }
  });
  test("existing legacy lock is busy and is never stolen", () => {
    const loc = setup(); seed(loc, legacy({ token })); const p = paths(loc); writeFileSync(p.lock, "", { mode: 0o600 });
    const before = readFileSync(p.marker); expect(bootstrapRecoveryStore(loc, ids)).toEqual({ ok: false, reason: "busy" });
    expect(readFileSync(p.marker)).toEqual(before); expect(existsSync(p.db)).toBe(false); expect(existsSync(p.lock)).toBe(true);
  });

  test("a real legacy wait paused at its consuming response remains writable after migration refusal", async () => {
    const loc = setup(); seed(loc, legacy({ pendingClaim: { id: CLAIM_ID, secret: CLAIM_SECRET, expiresAt: EXPIRES_AT } }));
    const p = paths(loc); let admit!: () => void, release!: () => void;
    const requested = new Promise<void>(resolve => { admit = resolve; }), response = new Promise<void>(resolve => { release = resolve; });
    const transport = stubFetch(async call => { expect(call.method).toBe("GET"); admit(); await response; return reply(200, claimStatus("paid", { paidAt: "2026-09-16T21:00:00Z", token, balance: { microUsd: 1000000, credits: 100, usd: "1.00" } })); });
    const pending = runCreditsCommand(profile, ["wait", "--json"], { stateDirectory: p.dir, fetch: transport.fetch, now: () => 1_789_600_000_000, requestTimeoutMs: 2000 });
    let completed: Awaited<typeof pending> | undefined;
    try {
      await requested; expect(existsSync(p.lock)).toBe(false); const before = readFileSync(p.marker);
      expect(bootstrapRecoveryStore(loc, ids)).toEqual({ ok: false, reason: "migration-conflict" });
      expect(readFileSync(p.marker)).toEqual(before); expect(existsSync(p.db)).toBe(false); expect(transport.calls).toHaveLength(1);
    } finally { release(); completed = await pending; }
    expect(completed!.exitCode).toBe(0);
    expect(await readStoredDeviceToken(profile, { stateDirectory: p.dir })).toEqual({ ok: true, value: token });
    expect(JSON.stringify(JSON.parse(readFileSync(p.marker, "utf8")))).not.toContain(CLAIM_SECRET);
  });

  test("two processes contend and normal API recovers a real hot rollback journal under pinned settings", async () => {
    for (const mode of ["hot", "umask"]) {
      const loc = setup(), before = value(bootstrapRecoveryStore(loc, ids)), held = await child(loc, mode);
      try {
        expect(held.message).toMatchObject({ phase: "journal-held", mode: 0o600, hotHeader: "d9d505f920a163d7", sqlite: { value: RECOVERY_SQLITE_PROFILE.sqlite }, sync: { synchronous: 3 }, fullfsync: { fullfsync: 1 } });
        expect(held.message.bytes as number).toBeLessThanOrEqual(2_097_152);
        expect(readRecoveryStore(loc)).toEqual({ ok: false, reason: "busy" });
      } finally { await held.collect(true); }
      expect(existsSync(`${paths(loc).db}-journal`)).toBe(true);
      expect(value(readRecoveryStore(loc))).toEqual(before);
      expect(existsSync(`${paths(loc).db}-journal`)).toBe(false);
      expect(value(checkRecoveryFence(loc, counters(before)))).toEqual(before);
    }
  });
  test("actual API process death before/after COMMIT preserves exact old/new tuple", async () => {
    for (const mode of ["before-commit", "after-commit"]) {
      const loc = setup(), before = value(bootstrapRecoveryStore(loc, ids)), held = await child(loc, mode);
      try { expect(held.message).toEqual({ phase: mode }); } finally { await held.collect(true); }
      const recovered = value(readRecoveryStore(loc));
      if (mode === "before-commit") expect(recovered).toEqual(before);
      else {
        const event = registration(before);
        expect(recovered).toMatchObject({ databaseId: ids.databaseId, generation: 0, revision: 2, pending: { kind: "registration-v2", operationId: event.operationId, pickupId: event.pickupId, candidateToken: event.candidateToken, claimSecret: event.claimSecret, stage: "create-pending" } });
      }
    }
  });
  test("unsafe real hot journal is refused unchanged before normal recovery", async () => {
    const loc = setup(), before = value(bootstrapRecoveryStore(loc, ids)), held = await child(loc, "hot");
    try { expect(held.message.hotHeader).toBe("d9d505f920a163d7"); } finally { await held.collect(true); }
    const path = `${paths(loc).db}-journal`, journal = readFileSync(path); chmodSync(path, 0o644);
    expect(readRecoveryStore(loc)).toEqual({ ok: false, reason: "unsafe-path" }); expect(readFileSync(path)).toEqual(journal);
    // Test-only restoration of this owned fixture's mode, never a product repair.
    chmodSync(path, 0o600); expect(value(readRecoveryStore(loc))).toEqual(before);
  });
  test("commit, close and final fence uncertainty never return afterCommitAction", async () => {
    for (const mode of ["close-failure", "fence-failure", "commit-before-failure", "commit-after-failure"]) {
      const loc = setup(), before = value(bootstrapRecoveryStore(loc, ids)), p = paths(loc), marker = readFileSync(p.marker);
      const outcome = await child(loc, mode); await outcome.collect();
      expect(outcome.message).toEqual({ ok: false, reason: "storage-uncertain" }); expect("value" in outcome.message).toBe(false);
      if (mode === "fence-failure") {
        expect(readRecoveryStore(loc).ok).toBe(false);
        // Fixture-only restoration of the marker deliberately damaged by this child.
        writeFileSync(p.marker, marker);
      }
      const after = value(readRecoveryStore(loc)); expect(after.databaseId).toBe(before.databaseId);
      expect(after.revision).toBe(mode === "commit-before-failure" ? 1 : 2);
      if (mode !== "commit-before-failure") expect(after.pending).toMatchObject({ candidateToken: `cr_dev_${"c".repeat(43)}`, pickupId: "00000000-0000-4000-8000-000000000004", operationId: "00000000-0000-4000-8000-000000000003" });
    }
  });
  test("bootstrap crashes follow prepared/marker/active restart cases without stealing old lock", async () => {
    for (const mode of ["prepared-commit", "marker-temp", "marker-rename", "marker-dir-sync", "active-commit"]) {
      const loc = setup(); seed(loc, legacy({ token })); const p = paths(loc), original = readFileSync(p.marker), held = await child(loc, mode);
      try { expect(held.message).toEqual({ phase: mode }); } finally { await held.collect(true); }
      expect(existsSync(p.lock)).toBe(true);
      if (mode === "prepared-commit" || mode === "marker-temp") {
        expect(readFileSync(p.marker)).toEqual(original); expect(bootstrapRecoveryStore(loc, null)).toEqual({ ok: false, reason: "busy" });
        expect(readRecoveryStore(loc).ok).toBe(false); expect(existsSync(p.lock)).toBe(true);
      } else {
        if (mode !== "active-commit") expect(readRecoveryStore(loc)).toEqual({ ok: false, reason: "bootstrap-required" });
        const recovered = value(bootstrapRecoveryStore(loc, null)); expect(recovered).toMatchObject({ revision: 1, generation: 0, active: { token }, pending: null });
        expect(existsSync(p.lock)).toBe(true);
        sql(loc, db => expect(db.query("SELECT legacy_bytes,legacy_sha256 FROM recovery").get()).toEqual({ legacy_bytes: null, legacy_sha256: null }));
      }
    }
  });
  test("marker fsync/rename failures retain exact prepared intent; uncertain directory sync is retried safely", async () => {
    for (const mode of ["marker-sync-failure", "marker-rename-failure", "marker-dir-failure"]) {
      const loc = setup(); seed(loc, legacy({ token })); const p = paths(loc), original = readFileSync(p.marker), outcome = await child(loc, mode);
      await outcome.collect(); expect(outcome.message).toEqual({ ok: false, reason: "storage-uncertain" }); expect(existsSync(p.lock)).toBe(false);
      if (mode !== "marker-dir-failure") expect(readFileSync(p.marker)).toEqual(original);
      expect(value(bootstrapRecoveryStore(loc, null))).toMatchObject({ ...ids, revision: 1, generation: 0, active: { token } });
    }
  });
  test("changed legacy, orphan marker temp and pre-row empty DB fail closed", async () => {
    for (const change of ["changed", "orphan", "empty"] as const) {
      const loc = setup(); seed(loc, legacy({ token })); const p = paths(loc);
      if (change === "empty") writeFileSync(p.db, "", { mode: 0o600 });
      else {
        const held = await child(loc, change === "orphan" ? "marker-temp" : "prepared-commit"); await held.collect(true);
        // The test owns this dead child's exact scratch lock. Production never does this.
        unlinkSync(p.lock);
        if (change === "changed") writeFileSync(p.marker, JSON.stringify(legacy({ token: `cr_dev_${"z".repeat(43)}` })));
      }
      const before = readFileSync(p.marker); expect(bootstrapRecoveryStore(loc, null).ok).toBe(false); expect(readFileSync(p.marker)).toEqual(before); expect(existsSync(p.db)).toBe(true);
    }
  });
  test("bounded SQLITE_FULL preserves original bytes and refuses to recreate an incomplete DB", async () => {
    const loc = setup(), original = `${JSON.stringify(legacy({ token }))}${" ".repeat(15_000)}`; seed(loc, original);
    const outcome = await child(loc, "full"); await outcome.collect(); expect(outcome.message).toEqual({ ok: false, reason: "storage-uncertain" });
    expect(readFileSync(paths(loc).marker, "utf8")).toBe(original); expect(existsSync(paths(loc).db)).toBe(true);
    expect(bootstrapRecoveryStore(loc, null)).toEqual({ ok: false, reason: "invalid-store" });
  });
  test("unknown filesystem/runtime reject before creating state", async () => {
    for (const mode of ["unknown-fs", "unknown-runtime"]) {
      const loc = setup(), outcome = await child(loc, mode); await outcome.collect();
      expect(outcome.message).toEqual({ ok: false, reason: mode === "unknown-fs" ? "unsupported-filesystem" : "unsupported-runtime" }); expect(existsSync(paths(loc).dir)).toBe(false);
    }
  });
  test("fstat failure after opening bootstrap files still closes owned descriptors", async () => {
    for (const mode of ["lock-fstat-failure", "temp-fstat-failure"]) {
      const loc = setup(); seed(loc, legacy({ token })); const p = paths(loc), before = readFileSync(p.marker), outcome = await child(loc, mode);
      await outcome.collect(); expect(outcome.message).toEqual({ ok: false, reason: "storage-uncertain", remainingOwnedDescriptors: 0 });
      expect(readFileSync(p.marker)).toEqual(before);
      if (mode === "lock-fstat-failure") { expect(existsSync(p.lock)).toBe(true); expect(existsSync(p.db)).toBe(false); }
      else { expect(existsSync(p.lock)).toBe(false); expect(readdirSync(p.dir).some(path => path.endsWith(".v2-marker.tmp"))).toBe(true); }
    }
  });
});
