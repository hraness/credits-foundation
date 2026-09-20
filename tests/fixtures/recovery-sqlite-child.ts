/** Finite offline qualification child. Never imported by a product entry. */
import { mock } from "bun:test";
import { Database, constants as sqlite } from "bun:sqlite";
import * as fs from "node:fs";
import { join } from "node:path";

const [mode, base] = process.argv.slice(2);
const modes = ["topup-before-commit", "topup-after-commit", "topup-commit-after-failure","hot", "umask", "before-commit", "after-commit", "prepared-commit", "marker-temp", "marker-rename", "marker-dir-sync", "active-commit", "close-failure", "fence-failure", "commit-before-failure", "commit-after-failure", "marker-sync-failure", "marker-rename-failure", "marker-dir-failure", "lock-fstat-failure", "temp-fstat-failure", "full", "unknown-fs", "unknown-runtime", "read"];
if (!mode || !modes.includes(mode) || !base || !base.startsWith("/") || !base.split("/").at(-1)?.startsWith("credits-sqlite-test-") || fs.realpathSync(base) !== base || (fs.lstatSync(base).mode & 0o777) !== 0o700) throw new Error("Invalid fixture invocation.");
const loc = { trustedBase: base, directory: ["credits"], productId: "peopleblade", serviceOrigin: "https://credits.example" };
const dir = join(base, "credits"), dbPath = join(dir, "peopleblade.v2.sqlite"), markerPath = join(dir, "peopleblade.json");
const ids = { databaseId: "00000000-0000-4000-8000-000000000001", deviceId: "00000000-0000-4000-8000-000000000002" };
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
function stop(phase: string): never { emit({ phase }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000); process.exit(3); }
const fdPaths = new Map<number, string>(); let renamed = false;
const originalFs = { ...fs };
if (["marker-temp", "marker-rename", "marker-dir-sync", "marker-sync-failure", "marker-rename-failure", "marker-dir-failure", "lock-fstat-failure", "temp-fstat-failure", "unknown-fs"].includes(mode)) {
  mock.module("node:fs", () => ({
    ...originalFs,
    openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = originalFs.openSync(...args); fdPaths.set(fd, String(args[0])); return fd; },
    closeSync: (fd: number) => { fdPaths.delete(fd); return originalFs.closeSync(fd); },
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      const path = fdPaths.get(args[0]);
      if ((mode === "lock-fstat-failure" && path?.endsWith(".lock")) || (mode === "temp-fstat-failure" && path?.endsWith(".v2-marker.tmp"))) throw new Error("Synthetic fstat failure.");
      return originalFs.fstatSync(...args);
    },
    fsyncSync: (fd: number) => {
      const path = fdPaths.get(fd);
      if (path?.endsWith(".v2-marker.tmp") && mode === "marker-sync-failure") throw new Error("Synthetic secret must not escape.");
      if (path === dir && renamed && mode === "marker-dir-failure") throw new Error("Synthetic secret must not escape.");
      originalFs.fsyncSync(fd);
      if (path?.endsWith(".v2-marker.tmp") && mode === "marker-temp") stop(mode);
      if (path === dir && renamed && mode === "marker-dir-sync") stop(mode);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === markerPath && mode === "marker-rename-failure") throw new Error("Synthetic secret must not escape.");
      originalFs.renameSync(from, to);
      if (String(to) === markerPath) { renamed = true; if (mode === "marker-rename") stop(mode); }
    },
    statfsSync: (...args: Parameters<typeof fs.statfsSync>) => mode === "unknown-fs" ? { type: 999n } : originalFs.statfsSync(...args),
  }));
}
if (mode === "unknown-runtime") Object.defineProperty(process, "platform", { value: "linux" });
const commitMode = mode.startsWith("topup-") ? mode.slice(6) : mode;
const originalExec = Database.prototype.exec, originalClose = Database.prototype.close;
let commits = 0;
Database.prototype.exec = function (...args: Parameters<typeof originalExec>) {
  const isTarget = this.filename === dbPath, sql = args[0];
  if (isTarget && sql === "COMMIT") {
    commits++;
    if (commitMode === "before-commit") stop(mode);
    if (mode === "commit-before-failure") throw new Error("Synthetic secret must not escape.");
  }
  const result = originalExec.apply(this, args);
  if (isTarget && mode === "full" && typeof sql === "string" && sql.startsWith("CREATE TABLE recovery")) originalExec.call(this, "PRAGMA max_page_count=2");
  if (isTarget && sql === "COMMIT") {
    if (commitMode === "after-commit" || (mode === "prepared-commit" && commits === 1) || (mode === "active-commit" && commits === 2)) stop(mode);
    if (commitMode === "commit-after-failure") throw new Error("Synthetic secret must not escape.");
  }
  return result;
};
Database.prototype.close = function (...args: Parameters<typeof originalClose>) {
  const isTarget = this.filename === dbPath, result = originalClose.apply(this, args);
  if (isTarget && commits > 0 && mode === "close-failure") throw new Error("Synthetic secret must not escape.");
  if (isTarget && commits > 0 && mode === "fence-failure") originalFs.writeFileSync(markerPath, "damaged marker\n");
  return result;
};
const store = await import("../../src/recovery-sqlite.js");
if (mode === "hot" || mode === "umask") {
  if (mode === "umask") process.umask(0);
  const db = new Database(dbPath, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW);
  db.exec("PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0; PRAGMA locking_mode=NORMAL; PRAGMA max_page_count=256; PRAGMA cache_size=1; PRAGMA cache_spill=1;");
  db.exec("BEGIN IMMEDIATE");
  // Force real dirty-page spill, preserving the last committed valid row in the journal.
  db.query("UPDATE recovery SET state_json=? WHERE singleton=1").run(" ".repeat(32768));
  // SQLite keeps a minimum cache even with cache_size=1. A bounded, uncommitted
  // fixture table forces spill beyond that floor; rollback must remove it too.
  db.exec("CREATE TABLE fault_spill(payload BLOB); INSERT INTO fault_spill VALUES (zeroblob(131072));");
  const journal = `${dbPath}-journal`, st = fs.lstatSync(journal);
  const header = new Uint8Array(8), fd = fs.openSync(journal, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
  emit({ phase: "journal-held", mode: st.mode & 0o777, bytes: st.size, hotHeader: Buffer.from(header).toString("hex"), sqlite: db.query("SELECT sqlite_version() AS value").get(), sync: db.query("PRAGMA synchronous").get(), fullfsync: db.query("PRAGMA fullfsync").get() });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000); process.exit(3);
} else if (["before-commit", "after-commit", "close-failure", "fence-failure", "commit-before-failure", "commit-after-failure"].includes(commitMode)) {
  const event = mode.startsWith("topup-") ? { type: "prepare-topup-v2", operationId: "00000000-0000-4000-8000-000000000003",
    body: { schemaVersion: "hraness-credits-topup-create-v2", creationId: "00000000-0000-4000-8000-000000000003", product: loc.productId, device: { id: ids.deviceId } } } : { type: "prepare-registration", operationId: "00000000-0000-4000-8000-000000000003", pickupId: "00000000-0000-4000-8000-000000000004", claimSecret: `cr_clm_${"s".repeat(43)}`, candidateToken: `cr_dev_${"c".repeat(43)}`,
    body: { schemaVersion: "hraness-credits-claim-create-v2", creationId: "00000000-0000-4000-8000-000000000005", product: loc.productId, device: { id: ids.deviceId } } };
  const result = store.commitRecoveryEvent(loc, { databaseId: ids.databaseId, revision: 1, generation: 0 }, event);
  if (result.ok) emit({ ok: true, kind: result.value.kind }); else emit(result);
} else if (mode === "read") {
  const result = store.readRecoveryStore(loc); emit(result.ok ? { ok: true, revision: result.value.revision, generation: result.value.generation } : result);
} else {
  const result = store.bootstrapRecoveryStore(loc, ids);
  emit(result.ok ? { ok: true, revision: result.value.revision, generation: result.value.generation }
    : mode === "lock-fstat-failure" || mode === "temp-fstat-failure" ? { ...result, remainingOwnedDescriptors: fdPaths.size } : result);
}
