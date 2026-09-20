/** Inactive internal Bun storage candidate. No root export or command binding. */
import { Database, constants as sqlite } from "bun:sqlite";
import { constants as fsFlags, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statfsSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseRecoveryState, prepareRecoveryState, transitionRecoveryState, type RecoveryDecision, type RecoveryState } from "./recovery-state.js";
import { origin } from "./internal.js";

export type RecoveryLocation = Readonly<{
  trustedBase: string;
  directory: readonly string[];
  productId: string;
  serviceOrigin: string;
}>;
export type RecoveryStoreExpected = Readonly<{ databaseId: string; revision: number; generation: number }>;
export type RecoveryStoreFailure =
  | "invalid-input" | "unsupported-runtime" | "unsupported-filesystem"
  | "unsafe-path" | "missing-store" | "invalid-store" | "busy"
  | "bootstrap-required" | "migration-conflict" | "stale-state"
  | "invalid-transition" | "counter-exhausted" | "storage-uncertain";
export type RecoveryStoreResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reason: RecoveryStoreFailure }>;

const UUID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
const PRODUCT = /^[a-z0-9_-]{1,32}$/u;
const encoder = new TextEncoder();
class StoreFailure extends Error {
  constructor(readonly reason: RecoveryStoreFailure) { super("Recovery store unavailable."); }
}
function need(value: unknown, reason: RecoveryStoreFailure = "invalid-input"): asserts value {
  if (!value) throw new StoreFailure(reason);
}
function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const n = value.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function boundedText(value: unknown, bytes: number): string {
  need(typeof value === "string" && value.length > 0 && value.length <= bytes && validUnicode(value) && encoder.encode(value).length <= bytes);
  return value;
}
/** Copies only expected own enumerable data properties; no ordinary accessor is invoked. */
function fields(value: unknown, names: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  need(value !== null && typeof value === "object" && !Array.isArray(value));
  const proto: unknown = Object.getPrototypeOf(value); need(proto === null || proto === Object.prototype);
  const keys = Reflect.ownKeys(value); need(keys.length >= names.length && keys.length <= names.length + optional.length);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    need(typeof key === "string" && key.length <= 64 && (names.includes(key) || optional.includes(key)));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor && "value" in descriptor && descriptor.enumerable);
    result[key] = descriptor.value;
  }
  need(names.every(key => Object.hasOwn(result, key)));
  return result;
}
function directoryParts(value: unknown): readonly string[] {
  need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  const length = Object.getOwnPropertyDescriptor(value, "length");
  need(length && "value" in length && Number.isInteger(length.value) && length.value >= 0 && length.value <= 8);
  need(Reflect.ownKeys(value).length === length.value + 1);
  const parts: string[] = [];
  for (let i = 0; i < length.value; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i)); need(descriptor && "value" in descriptor && descriptor.enumerable);
    const part = boundedText(descriptor.value, 128);
    need(part !== "." && part !== ".." && !/[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(part)); parts.push(part);
  }
  return Object.freeze(parts);
}
function locationInput(value: unknown): RecoveryLocation {
  const row = fields(value, ["trustedBase", "directory", "productId", "serviceOrigin"]);
  const trustedBase = boundedText(row.trustedBase, 4096), productId = boundedText(row.productId, 32);
  need(trustedBase.startsWith("/") && !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trustedBase));
  need(trustedBase === "/" || (!trustedBase.endsWith("/") && trustedBase.split("/").slice(1).every(part => part !== "" && part !== "." && part !== "..")));
  need(PRODUCT.test(productId) && origin(row.serviceOrigin));
  const directory = directoryParts(row.directory);
  need(encoder.encode([trustedBase, ...directory, `${productId}.v2.sqlite-journal`].join("/")).length <= 4096);
  return Object.freeze({ trustedBase, directory, productId, serviceOrigin: row.serviceOrigin });
}
function expectedInput(value: unknown): RecoveryStoreExpected {
  const row = fields(value, ["databaseId", "revision", "generation"]), databaseId = boundedText(row.databaseId, 36);
  need(UUID.test(databaseId));
  for (const key of ["revision", "generation"] as const) need(typeof row[key] === "number" && Number.isSafeInteger(row[key]) && !Object.is(row[key], -0) && row[key] >= 0);
  return Object.freeze({ databaseId, revision: row.revision as number, generation: row.generation as number });
}

/** This candidate profile is a runtime admission pin, not a claim of live activation. */
export const RECOVERY_SQLITE_PROFILE = Object.freeze({
  bun: "1.3.14", platform: "darwin", arch: "arm64", filesystem: 26,
  sqlite: "3.51.0", sourceId: "2025-06-12 13:14:41 f0ca7bba1c5e232e5d279fad6338121ab55af0c8c68c84cdfb18ba5114dcaapl",
});
const DB_LIMIT = 1_048_576, LEGACY_LIMIT = 16_384, JOURNAL_LIMIT = 2_097_152;
const APP_ID = 0x43525632, MARKER = "hraness-credits-state-v2-sqlite";
const NOFOLLOW = fsFlags.O_NOFOLLOW, NONBLOCK = fsFlags.O_NONBLOCK;
const SQL_SCHEMA = "CREATE TABLE recovery (singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_id TEXT NOT NULL, product_id TEXT NOT NULL, service_origin TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), generation INTEGER NOT NULL CHECK(generation>=0), bootstrap TEXT NOT NULL CHECK(bootstrap IN ('prepared','active')), state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB))<=32768), legacy_sha256 TEXT, legacy_bytes BLOB CHECK(legacy_bytes IS NULL OR length(legacy_bytes)<=16384)) STRICT";
const SELECT_ROW = "SELECT singleton,database_id,product_id,service_origin,CAST(revision AS TEXT) AS revision,CAST(generation AS TEXT) AS generation,bootstrap,state_json,legacy_sha256,legacy_bytes FROM recovery LIMIT 2";
const INSERT_ROW = "INSERT INTO recovery(singleton,database_id,product_id,service_origin,revision,generation,bootstrap,state_json,legacy_sha256,legacy_bytes) VALUES (1,?,?,?,?,?,?,?,?,?)";
const UPDATE_ROW = "UPDATE recovery SET revision=?,generation=?,bootstrap=?,state_json=?,legacy_sha256=?,legacy_bytes=? WHERE singleton=1 AND database_id=? AND revision=? AND generation=?";
const occupied = new Set<string>(), poisoned = new Set<string>();
const decoder = new TextDecoder("utf-8", { fatal: true });
type Identity = Readonly<{ path: string; dev: bigint; ino: bigint }>;
type Context = { location: RecoveryLocation; directory: string; db: string; marker: string; lock: string; uid: bigint; dirs: Identity[]; dbIdentity?: Identity };
type Stored = { state: RecoveryState; legacy: Uint8Array | null; digest: string | null };
function errorCode(error: unknown): unknown { return error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined; }
function failure<T>(reason: RecoveryStoreFailure): RecoveryStoreResult<T> { return Object.freeze({ ok: false, reason }); }
function attempt<T>(run: () => T): RecoveryStoreResult<T> {
  try { return Object.freeze({ ok: true, value: run() }); }
  catch (error) { return failure(error instanceof StoreFailure ? error.reason : "storage-uncertain"); }
}
function one(db: Database, sql: string): unknown {
  const row = db.query(sql).get() as Record<string, unknown> | null;
  need(row && Object.keys(row).length === 1, "invalid-store"); return Object.values(row)[0];
}
function runtime(): void {
  need(typeof Bun !== "undefined" && Bun.version === RECOVERY_SQLITE_PROFILE.bun && process.platform === "darwin" && process.arch === "arm64"
    && typeof process.getuid === "function" && Number.isSafeInteger(process.getuid()) && typeof NOFOLLOW === "number" && typeof NONBLOCK === "number", "unsupported-runtime");
  const db = new Database(":memory:", sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_CREATE | sqlite.SQLITE_OPEN_NOFOLLOW);
  try {
    need(one(db, "SELECT sqlite_version()") === RECOVERY_SQLITE_PROFILE.sqlite && one(db, "SELECT sqlite_source_id()") === RECOVERY_SQLITE_PROFILE.sourceId, "unsupported-runtime");
    const options = db.query("PRAGMA compile_options").all() as { compile_options: string }[];
    need(["THREADSAFE=2", "ENABLE_LOCKING_STYLE=1", "DEFAULT_SYNCHRONOUS=2"].every(option => options.some(row => row.compile_options === option)), "unsupported-runtime");
  } finally { db.close(); }
}
function metadata(path: string): BigIntStats | null {
  try { return lstatSync(path, { bigint: true }); } catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
}
function identity(path: string, stat: BigIntStats): Identity { return { path, dev: stat.dev, ino: stat.ino }; }
function same(a: Identity, b: BigIntStats | null): boolean { return b !== null && a.dev === b.dev && a.ino === b.ino; }
function filesystem(path: string): void { need(statfsSync(path, { bigint: true }).type === 26n, "unsupported-filesystem"); }
function privateDirectory(stat: BigIntStats, uid: bigint): void { need(stat.isDirectory() && stat.uid === uid && (stat.mode & 0o7777n) === 0o700n, "unsafe-path"); }
function privateFile(ctx: Context, path: string, max: number, optional = false): BigIntStats | null {
  const stat = metadata(path); if (stat === null) { need(optional, "missing-store"); return null; }
  need(stat.isFile() && stat.uid === ctx.uid && (stat.mode & 0o7777n) === 0o600n && stat.nlink === 1n && stat.dev === ctx.dirs[0]!.dev, "unsafe-path");
  need(stat.size <= BigInt(max), "invalid-store"); return stat;
}
function syncDirectory(path: string): void {
  const fd = openSync(path, fsFlags.O_RDONLY | fsFlags.O_DIRECTORY | NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function context(location: RecoveryLocation, create: boolean): Context {
  runtime(); const uid = BigInt(process.getuid!()), base = metadata(location.trustedBase);
  need(base && base.isDirectory() && (base.uid === uid || base.uid === 0n) && (base.mode & 0o022n) === 0n && realpathSync(location.trustedBase) === location.trustedBase, "unsafe-path");
  filesystem(location.trustedBase); const dirs: Identity[] = [identity(location.trustedBase, base)]; let directory = location.trustedBase;
  if (location.directory.length === 0) privateDirectory(base, uid);
  for (const part of location.directory) {
    const parent = directory; directory = join(directory, part); let stat = metadata(directory);
    if (stat === null) {
      need(create, "missing-store"); mkdirSync(directory, { mode: 0o700 }); stat = metadata(directory); need(stat, "unsafe-path");
      privateDirectory(stat, uid); need(stat.dev === base.dev, "unsafe-path"); filesystem(directory); syncDirectory(directory); syncDirectory(parent);
    }
    privateDirectory(stat, uid); need(stat.dev === base.dev, "unsafe-path"); filesystem(directory); dirs.push(identity(directory, stat));
  }
  const name = location.productId;
  return { location, directory, db: join(directory, `${name}.v2.sqlite`), marker: join(directory, `${name}.json`), lock: join(directory, `${name}.lock`), uid, dirs };
}
function checkPaths(ctx: Context): void {
  for (const [i, expected] of ctx.dirs.entries()) {
    const current = metadata(expected.path); need(same(expected, current), "unsafe-path");
    if (i > 0 || ctx.location.directory.length === 0) privateDirectory(current!, ctx.uid);
    else need(current!.isDirectory() && (current!.uid === ctx.uid || current!.uid === 0n) && (current!.mode & 0o022n) === 0n, "unsafe-path");
    filesystem(expected.path);
  }
  if (ctx.dbIdentity) need(same(ctx.dbIdentity, privateFile(ctx, ctx.db, DB_LIMIT)), "unsafe-path");
}
function sidecars(ctx: Context): void {
  need(metadata(`${ctx.db}-wal`) === null && metadata(`${ctx.db}-shm`) === null, "invalid-store");
  privateFile(ctx, `${ctx.db}-journal`, JOURNAL_LIMIT, true);
}
function readBytes(ctx: Context, path: string, max: number, optional = false, sync = false): Uint8Array | null {
  const stat = privateFile(ctx, path, max, optional); if (!stat) return null;
  const expected = identity(path, stat), fd = openSync(path, fsFlags.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    need(same(expected, fstatSync(fd, { bigint: true })), "unsafe-path");
    const buffer = Buffer.alloc(max + 1); let length = 0;
    while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n; }
    need(length <= max && fstatSync(fd, { bigint: true }).size === BigInt(length), "invalid-store");
    if (sync) fsyncSync(fd);
    need(same(expected, metadata(path)), "unsafe-path"); return Uint8Array.from(buffer.subarray(0, length));
  } finally { closeSync(fd); }
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean { return a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]); }
function markerText(ctx: Context, id: string): string { return `${JSON.stringify({ schemaVersion: MARKER, product: ctx.location.productId, databaseId: id })}\n`; }
function markerMatches(ctx: Context, id: string, sync = false): void {
  const bytes = readBytes(ctx, ctx.marker, 1024, false, sync); need(bytes && decoder.decode(bytes) === markerText(ctx, id), "migration-conflict");
}
function markerId(ctx: Context, bytes: Uint8Array | null): string | null {
  if (!bytes) return null;
  let raw: unknown; try { raw = JSON.parse(decoder.decode(bytes)); } catch { return null; }
  if (raw === null || typeof raw !== "object" || !Object.hasOwn(raw, "schemaVersion") || (raw as { schemaVersion: unknown }).schemaVersion !== MARKER) return null;
  const row = fields(raw, ["schemaVersion", "product", "databaseId"]);
  need(typeof row.databaseId === "string" && UUID.test(row.databaseId) && row.product === ctx.location.productId && decoder.decode(bytes) === markerText(ctx, row.databaseId), "migration-conflict");
  return row.databaseId;
}
function configure(db: Database, fresh: boolean): void {
  // Connection-local safety settings precede ordinary schema/state reads.
  db.exec("PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA locking_mode=NORMAL;");
  if (fresh) db.exec("PRAGMA page_size=4096; PRAGMA journal_mode=DELETE;");
  need(one(db, "PRAGMA journal_mode") === "delete", "invalid-store");
  need(one(db, "PRAGMA page_size") === 4096, "invalid-store");
  need(one(db, "PRAGMA max_page_count=256") === 256, "invalid-store");
  for (const [pragma, value] of [["synchronous", 3], ["fullfsync", 1], ["busy_timeout", 0], ["trusted_schema", 0], ["secure_delete", 1], ["temp_store", 2], ["locking_mode", "normal"]] as const) {
    need(one(db, `PRAGMA ${pragma}`) === value, "unsupported-runtime");
  }
}
function database<T>(ctx: Context, fresh: boolean, action: (db: Database) => T): T {
  checkPaths(ctx); sidecars(ctx); const stat = privateFile(ctx, ctx.db, DB_LIMIT)!;
  if (ctx.dbIdentity) need(same(ctx.dbIdentity, stat), "unsafe-path"); else ctx.dbIdentity = identity(ctx.db, stat);
  need(!poisoned.has(ctx.db), "storage-uncertain");
  const db = new Database(ctx.db, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW);
  let result: T;
  try {
    try { configure(db, fresh); } catch (error) { if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(errorCode(error)))) throw new StoreFailure("busy"); throw error; }
    checkPaths(ctx); result = action(db);
  }
  finally {
    try { db.close(); } catch { poisoned.add(ctx.db); throw new StoreFailure("storage-uncertain"); }
  }
  try { checkPaths(ctx); sidecars(ctx); } catch { throw new StoreFailure("storage-uncertain"); }
  return result;
}
function transaction<T>(db: Database, action: () => T): T {
  try { db.exec("BEGIN IMMEDIATE"); }
  catch (error) { if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(errorCode(error)))) throw new StoreFailure("busy"); throw error; }
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) {
    try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { throw new StoreFailure("storage-uncertain"); }
    throw error;
  }
}
function decimalCounter(value: unknown): number {
  need(typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})$/u.test(value), "invalid-store");
  const n = BigInt(value); need(n <= BigInt(Number.MAX_SAFE_INTEGER), "invalid-store"); return Number(n);
}
function prepared(ctx: Context, s: RecoveryState, legacy: Uint8Array | null): RecoveryState {
  // Feeding original nested JSON to the model preserves its duplicate-key guard.
  let raw: string;
  try { raw = legacy === null ? "" : decoder.decode(legacy); } catch { throw new StoreFailure("invalid-store"); }
  const inputs = { databaseId: s.databaseId, deviceId: s.deviceId, productId: ctx.location.productId, serviceOrigin: ctx.location.serviceOrigin,
    ...(s.pending ? { legacyOperationId: s.pending.operationId } : {}) };
  const json = JSON.stringify(inputs); const state = prepareRecoveryState(legacy === null ? inputs : `${json.slice(0, -1)},"legacy":${raw}}`);
  need(state, "invalid-store"); return state;
}
function readRow(ctx: Context, db: Database): Stored {
  need(one(db, "PRAGMA application_id") === APP_ID && one(db, "PRAGMA user_version") === 1, "invalid-store");
  const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all();
  need(schema.length === 1 && JSON.stringify(schema[0]) === JSON.stringify({ type: "table", name: "recovery", tbl_name: "recovery", sql: SQL_SCHEMA }), "invalid-store");
  const rows = db.query(SELECT_ROW).all() as Record<string, unknown>[]; need(rows.length === 1, "invalid-store"); const row = rows[0]!;
  need(row.singleton === 1 && typeof row.state_json === "string" && encoder.encode(row.state_json).length <= 32768, "invalid-store");
  const state = parseRecoveryState(row.state_json); need(state && state.databaseId === row.database_id && state.productId === row.product_id && state.serviceOrigin === row.service_origin
    && state.productId === ctx.location.productId && state.serviceOrigin === ctx.location.serviceOrigin && state.bootstrap === row.bootstrap
    && state.revision === decimalCounter(row.revision) && state.generation === decimalCounter(row.generation), "invalid-store");
  need(row.legacy_bytes === null || (row.legacy_bytes instanceof Uint8Array && row.legacy_bytes.byteLength <= LEGACY_LIMIT), "invalid-store");
  const legacy = row.legacy_bytes as Uint8Array | null;
  need((legacy === null && row.legacy_sha256 === null) || (legacy !== null && row.legacy_sha256 === digest(legacy)), "invalid-store");
  if (state.bootstrap === "active") need(legacy === null && row.legacy_sha256 === null, "invalid-store");
  else need(JSON.stringify(prepared(ctx, state, legacy)) === JSON.stringify(state), "invalid-store");
  return { state, legacy, digest: row.legacy_sha256 as string | null };
}
function compareExpected(state: RecoveryState, expected: RecoveryStoreExpected): void {
  need(state.databaseId === expected.databaseId && state.revision === expected.revision && state.generation === expected.generation, "stale-state");
}
function update(db: Database, before: RecoveryState, after: RecoveryState): void {
  const result = db.query(UPDATE_ROW).run(BigInt(after.revision), BigInt(after.generation), after.bootstrap, JSON.stringify(after), null, null,
    before.databaseId, BigInt(before.revision), BigInt(before.generation));
  need(result.changes === 1, "stale-state");
}
function guarded<T>(input: unknown, create: boolean, action: (ctx: Context) => T): RecoveryStoreResult<T> {
  return attempt(() => {
    const location = locationInput(input), key = join(location.trustedBase, ...location.directory, `${location.productId}.v2.sqlite`);
    need(!occupied.has(key), "busy"); need(!poisoned.has(key), "storage-uncertain"); occupied.add(key);
    try { return action(context(location, create)); } finally { occupied.delete(key); }
  });
}
function existing<T>(ctx: Context, action: (db: Database, state: RecoveryState) => T): T {
  // Check both artifacts before opening SQLite; absence never becomes creation.
  privateFile(ctx, ctx.db, DB_LIMIT); const id = markerId(ctx, readBytes(ctx, ctx.marker, 1024)); need(id, "migration-conflict");
  const result = database(ctx, false, db => transaction(db, () => {
    const { state } = readRow(ctx, db); need(state.databaseId === id, "migration-conflict");
    need(state.bootstrap === "active", "bootstrap-required"); markerMatches(ctx, id); return action(db, state);
  }));
  try { markerMatches(ctx, id); checkPaths(ctx); } catch { throw new StoreFailure("storage-uncertain"); }
  return result;
}

/** May perform SQLite's physical hot-journal recovery, but no logical transition. */
export function readRecoveryStore(location: unknown): RecoveryStoreResult<RecoveryState> {
  return guarded(location, false, ctx => existing(ctx, (_db, state) => state));
}
export function checkRecoveryFence(location: unknown, expected: unknown): RecoveryStoreResult<RecoveryState> {
  let parsed: RecoveryStoreExpected; try { parsed = expectedInput(expected); } catch { return failure("invalid-input"); }
  return guarded(location, false, ctx => existing(ctx, (_db, state) => { compareExpected(state, parsed); return state; }));
}
/** Observation events remain trusted-adapter inputs; storage does not authenticate wire data. */
export function commitRecoveryEvent(location: unknown, expected: unknown, event: unknown): RecoveryStoreResult<RecoveryDecision> {
  let parsed: RecoveryStoreExpected; try { parsed = expectedInput(expected); } catch { return failure("invalid-input"); }
  return guarded(location, false, ctx => existing(ctx, (db, state) => {
    compareExpected(state, parsed); const decision = transitionRecoveryState(state, event);
    need(decision.kind !== "reject", decision.kind === "reject" && decision.reason === "counter-exhausted" ? "counter-exhausted" : "invalid-transition");
    if (decision.kind === "commit") update(db, state, decision.next);
    return decision;
  }));
}

type Fresh = Readonly<{ databaseId: string; deviceId: string; legacyOperationId?: string }>;
function freshInput(value: unknown): Fresh | null {
  if (value === null) return null;
  const row = fields(value, ["databaseId", "deviceId"], ["legacyOperationId"]);
  for (const key of Object.keys(row)) need(typeof row[key] === "string" && UUID.test(row[key]));
  return Object.freeze(row) as Fresh;
}
function freshState(ctx: Context, fresh: Fresh, legacy: Uint8Array | null): RecoveryState {
  const inputs = { ...fresh, productId: ctx.location.productId, serviceOrigin: ctx.location.serviceOrigin }, json = JSON.stringify(inputs);
  let state: RecoveryState | null = null;
  try { state = prepareRecoveryState(legacy === null ? inputs : `${json.slice(0, -1)},"legacy":${decoder.decode(legacy)}}`); } catch { /* Fixed failure only. */ }
  need(state, "migration-conflict"); return state;
}
function createDb(ctx: Context, stored: Stored): void {
  checkPaths(ctx); sidecars(ctx);
  const fd = openSync(ctx.db, fsFlags.O_RDWR | fsFlags.O_CREAT | fsFlags.O_EXCL | NOFOLLOW, 0o600);
  try { const stat = fstatSync(fd, { bigint: true }); ctx.dbIdentity = identity(ctx.db, stat); privateFile(ctx, ctx.db, DB_LIMIT); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDirectory(ctx.directory);
  database(ctx, true, db => transaction(db, () => {
    need(db.query("SELECT name FROM sqlite_schema").all().length === 0, "invalid-store");
    db.exec(SQL_SCHEMA); db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;`);
    const s = stored.state;
    db.query(INSERT_ROW).run(s.databaseId, s.productId, s.serviceOrigin, BigInt(s.revision), BigInt(s.generation), s.bootstrap, JSON.stringify(s), stored.digest, stored.legacy);
    readRow(ctx, db);
  }));
}
function finalize(ctx: Context, databaseId: string): RecoveryState {
  markerMatches(ctx, databaseId, true); syncDirectory(ctx.directory); checkPaths(ctx);
  const result = database(ctx, false, db => transaction(db, () => {
    const { state } = readRow(ctx, db); need(state.databaseId === databaseId, "migration-conflict"); markerMatches(ctx, databaseId);
    if (state.bootstrap === "active") return state;
    const decision = transitionRecoveryState(state, { type: "activate" }); need(decision.kind === "commit", "invalid-transition");
    update(db, state, decision.next); return decision.next;
  }));
  try { markerMatches(ctx, databaseId); checkPaths(ctx); } catch { throw new StoreFailure("storage-uncertain"); }
  return result;
}
function publishMarker(ctx: Context, stored: Stored): void {
  checkPaths(ctx); need(sameBytes(readBytes(ctx, ctx.marker, LEGACY_LIMIT, true), stored.legacy), "migration-conflict");
  const path = join(ctx.directory, `${ctx.location.productId}.${stored.state.databaseId}.v2-marker.tmp`);
  need(metadata(path) === null, "migration-conflict");
  const fd = openSync(path, fsFlags.O_WRONLY | fsFlags.O_CREAT | fsFlags.O_EXCL | NOFOLLOW, 0o600);
  let own: Identity | undefined, renamed = false;
  try {
    try {
      own = identity(path, fstatSync(fd, { bigint: true }));
      privateFile(ctx, path, 1024); const bytes = encoder.encode(markerText(ctx, stored.state.databaseId)); let offset = 0;
      while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); need(n > 0, "storage-uncertain"); offset += n; }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    checkPaths(ctx); need(sameBytes(readBytes(ctx, ctx.marker, LEGACY_LIMIT, true), stored.legacy), "migration-conflict");
    need(same(own, privateFile(ctx, path, 1024)), "unsafe-path"); renameSync(path, ctx.marker); renamed = true; syncDirectory(ctx.directory);
  } finally { if (!renamed && own && same(own, metadata(path))) unlinkSync(path); }
}
/** Explicit migration operation. No new IDs are generated and no remote operation runs. */
export function bootstrapRecoveryStore(location: unknown, fresh: unknown): RecoveryStoreResult<RecoveryState> {
  let parsed: Fresh | null; try { parsed = freshInput(fresh); } catch { return failure("invalid-input"); }
  return guarded(location, true, ctx => {
    const hasDb = privateFile(ctx, ctx.db, DB_LIMIT, true) !== null, bytes = readBytes(ctx, ctx.marker, LEGACY_LIMIT, true), id = markerId(ctx, bytes);
    if (hasDb) need(parsed === null, "invalid-input");
    if (id) { need(hasDb, "missing-store"); return finalize(ctx, id); }
    let lockFd: number;
    try { lockFd = openSync(ctx.lock, fsFlags.O_WRONLY | fsFlags.O_CREAT | fsFlags.O_EXCL | NOFOLLOW, 0o600); }
    catch (error) { if (errorCode(error) === "EEXIST") throw new StoreFailure("busy"); throw error; }
    let own: Identity | undefined;
    try {
      own = identity(ctx.lock, fstatSync(lockFd, { bigint: true }));
      privateFile(ctx, ctx.lock, 1024); checkPaths(ctx);
      const legacy = readBytes(ctx, ctx.marker, LEGACY_LIMIT, true); need(markerId(ctx, legacy) === null, "migration-conflict");
      let stored: Stored;
      if (hasDb) {
        stored = database(ctx, false, db => transaction(db, () => readRow(ctx, db)));
        need(stored.state.bootstrap === "prepared" && sameBytes(legacy, stored.legacy), "migration-conflict");
      } else {
        need(parsed, "missing-store"); const state = freshState(ctx, parsed, legacy);
        stored = { state, legacy, digest: legacy === null ? null : digest(legacy) }; createDb(ctx, stored);
      }
      publishMarker(ctx, stored); return finalize(ctx, stored.state.databaseId);
    } finally {
      try { closeSync(lockFd); } finally { need(own && same(own, metadata(ctx.lock)), "storage-uncertain"); unlinkSync(ctx.lock); }
    }
  });
}
