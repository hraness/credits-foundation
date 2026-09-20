import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "credits-package-"));
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
}
const rateCard = `{product:{id:'peopleblade',name:'PeopleBlade'},packs:[{id:'p25',usd:25,credits:2500,bonusCredits:150}],suggestedPackId:'p25',minUsd:10,maxUsd:500,operations:{enrich_contact:{label:'contact enrichment',unitPrice:{microUsd:200000,usd:'0.20'}}}}`;
const requiredInput = `{product:{id:'peopleblade',name:'PeopleBlade'},command:['peopleblade'],operation:'enrich_contact',requiredMicroUsd:12500000,balanceMicroUsd:0,topup:{url:'https://credits.hraness.com/t/clm_1',expiresAt:'2026-09-17T22:00:00Z',packs:[{id:'p25',usd:25,credits:2500,bonusCredits:150}],suggestedPackId:'p25'},resume:{argv:['peopleblade','enrich'],automatic:true}}`;
try {
  const archive = join(scratch, "credits.tgz");
  run(process.execPath, ["pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"], root);
  const members = run("tar", ["-tzf", archive], scratch).trim().split("\n");
  if (members.some(member => !member.startsWith("package/") || member.includes("..")
    || /(^|\/)(node_modules|\.env|tests)(\/|$)/u.test(member))) {
    throw new Error("Unexpected packed file.");
  }
  for (const required of ["package/dist/index.js", "package/dist/node.js", "package/dist/server.js", "package/dist/index.d.ts",
    "package/dist/node.d.ts", "package/dist/server.d.ts", "package/dist/pickup-v2.d.ts", "package/src/pickup-v2.ts",
    "package/dist/recovery.js", "package/dist/recovery.d.ts", "package/dist/recovery-bun.js", "package/dist/recovery-bun.d.ts",
    "package/dist/recovery-unavailable.js", "package/dist/recovery-state.d.ts", "package/dist/recovery-sqlite.d.ts",
    "package/README.md", "package/LICENSE", "package/docs/agents.md", "package/docs/pickup-v2.md",
    "package/docs/recovery-state.md", "package/docs/recovery-sqlite.md"]) {
    if (!members.includes(required)) throw new Error(`Missing packed file ${required}.`);
  }
  const installed = join(scratch, "node_modules", "@hraness", "credits-foundation");
  await mkdir(installed, { recursive: true });
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", installed], scratch);
  // Compile a detached strict consumer with the same NODE_ENV augmentation
  // used by Next.js. Dependency implementations must not be re-typechecked
  // under the consumer's ambient declarations; only emitted .d.ts are public.
  await cp(join(root, "node_modules/@types/node"), join(scratch, "node_modules/@types/node"), { recursive: true, dereference: true });
  await cp(join(root, "node_modules/undici-types"), join(scratch, "node_modules/undici-types"), { recursive: true, dereference: true });
  await writeFile(join(scratch, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(join(scratch, "consumer.ts"), `
import { buildCreditsRequiredEnvelope, creditsProtocol, priceCostPlus, priceUnit, parseCreditsStatus, type CreditsProductProfile, type CreditsRequiredEnvelope } from '@hraness/credits-foundation';
import { parseCreditsClaimCreateV2, parseCreditsClaimCreatedV2, parseCreditsPickupRequestV2, parseCreditsPickupResponseV2, parseCreditsBalanceV2, parseCreditsErrorV2, type CreditsCreationExpectationV2, type CreditsPickupExpectationV2, type CreditsBalanceV2 } from '@hraness/credits-foundation';
import { emitCreditsRequired, readStoredDeviceToken, runCreditsCommand } from '@hraness/credits-foundation/node';
import { ceilingFor, createCreditsClient, type CreditsClientResult, type CreditsHold, type CreditsSettlement, type CreditsRelease, type CreditsTerminalHoldState } from '@hraness/credits-foundation/server';
import { prepareRecoveryState, readRecoveryToken, type RecoveryState } from '@hraness/credits-foundation/recovery';
import { bootstrapRecoveryStore, checkRecoveryFence, commitRecoveryEvent, readRecoveryStore, type RecoveryLocation, type RecoveryStoreResult } from '@hraness/credits-foundation/recovery/bun';
declare global { namespace NodeJS { interface ProcessEnv { readonly NODE_ENV: 'development' | 'production' | 'test'; } } }
const profile: CreditsProductProfile = { id: 'peopleblade', name: 'PeopleBlade', command: ['peopleblade'] };
const envelope: CreditsRequiredEnvelope = buildCreditsRequiredEnvelope(${requiredInput});
creditsProtocol(profile);
priceUnit(200000, 3);
priceCostPlus([{ microUsd: 1, basis: 'reported' }], { takeRate: 0.35, roundingStepMicroUsd: 10000, fixedOffsetMicroUsd: 2000, minPriceMicroUsd: 10000 });
parseCreditsStatus({});
const expected: CreditsCreationExpectationV2 = { creationId: '11111111-1111-4111-8111-111111111111', productId: 'peopleblade', deviceId: '22222222-2222-4222-8222-222222222222', serviceOrigin: 'https://credits.hraness.com' };
const pickup: CreditsPickupExpectationV2 = { operation: 'status', binding: { claimId: 'clm_1', productId: expected.productId, deviceId: expected.deviceId }, pickupId: null };
parseCreditsClaimCreateV2({});
parseCreditsClaimCreatedV2({}, expected);
parseCreditsPickupRequestV2({});
parseCreditsPickupResponseV2({}, pickup);
const balance: CreditsBalanceV2 | null = parseCreditsBalanceV2({}, expected.productId);
void balance;
parseCreditsErrorV2({ error: 'not_found' }, 404);
runCreditsCommand(profile, ['protocol', '--json'], { env: {}, stderr: process.stderr });
emitCreditsRequired(envelope, { stderr: process.stderr }, 'agent');
readStoredDeviceToken(profile, { env: {} });
const client = createCreditsClient({ origin: 'https://credits.hraness.com', productKey: 'cr_prod_' + 'C'.repeat(43), fetch });
const hold: Promise<CreditsClientResult<CreditsHold>> = client.hold({ subjectToken: 'cr_dev_' + 'A'.repeat(43), operation: 'enrich_contact', idempotencyKey: 'k' });
void hold;
const terminalState: CreditsTerminalHoldState = 'expired';
const needsReconciliation = (result: CreditsSettlement | CreditsRelease) => result.state === terminalState || result.state === 'released';
void needsReconciliation;
const recoveryLocation: RecoveryLocation = { trustedBase: '/private/temporary-fixture', directory: ['credits'], productId: 'peopleblade', serviceOrigin: 'https://credits.hraness.com' };
const recovery: RecoveryStoreResult<RecoveryState> = readRecoveryStore(recoveryLocation);
if (recovery.ok) readRecoveryToken(recovery.value);
prepareRecoveryState({});
bootstrapRecoveryStore(recoveryLocation, null);
checkRecoveryFence(recoveryLocation, {});
commitRecoveryEvent(recoveryLocation, {}, {});
ceilingFor(${rateCard}, 'enrich_contact', 2);
`);
  await writeFile(join(scratch, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, noEmit: true, types: ["node"] }, include: ["consumer.ts"] }));
  run("node", [join(root, "node_modules/typescript/bin/tsc"), "--project", join(scratch, "tsconfig.json")], scratch);
  const stateHome = join(scratch, "state");
  const entry = join(scratch, "consumer.mjs");
  await writeFile(entry, `
import assert from 'node:assert/strict';
import { buildCreditsRequiredEnvelope, formatUsd, priceUnit, parseCreditsClaimCreateV2, parseCreditsClaimCreatedV2 } from '@hraness/credits-foundation';
import { emitCreditsRequired, readStoredDeviceToken, runCreditsCommand } from '@hraness/credits-foundation/node';
import { ceilingFor, createCreditsClient } from '@hraness/credits-foundation/server';
import { parseRecoveryState } from '@hraness/credits-foundation/recovery';
import * as recoveryStore from '@hraness/credits-foundation/recovery/bun';
assert.equal(parseRecoveryState({}), null);
assert.deepEqual(Object.keys(recoveryStore).sort(), ['bootstrapRecoveryStore', 'checkRecoveryFence', 'commitRecoveryEvent', 'readRecoveryStore']);
for (const operation of Object.values(recoveryStore)) assert.deepEqual(operation(null, null, null), { ok: false, reason: 'unsupported-runtime' });
assert.ok(import.meta.resolve('@hraness/credits-foundation/recovery/bun').endsWith('/dist/recovery-unavailable.js'));
const profile = { id: 'peopleblade', name: 'PeopleBlade', command: ['peopleblade'] };
const io = { env: { XDG_STATE_HOME: ${JSON.stringify(stateHome)} }, fetch: async () => { throw new Error('no network in the smoke test'); } };
assert.equal(formatUsd(12500000), '12.50');
assert.equal(priceUnit(200000, 3), 600000);
const create = parseCreditsClaimCreateV2({ schemaVersion: 'hraness-credits-claim-create-v2', creationId: '11111111-1111-4111-8111-111111111111', product: 'peopleblade', device: { id: '22222222-2222-4222-8222-222222222222' } });
assert.ok(create && Object.isFrozen(create) && Object.isFrozen(create.device));
const createdWire = { schemaVersion: 'hraness-credits-claim-created-v2', creationId: create.creationId, binding: { claimId: 'clm_1', productId: create.product, deviceId: create.device.id }, createdAt: '2026-09-20T00:00:00.000Z', expiresAt: '2026-09-21T00:00:00.000Z', payUrl: 'https://credits.hraness.com/t/clm_1' };
const expected = { creationId: create.creationId, productId: create.product, deviceId: create.device.id, serviceOrigin: 'https://credits.hraness.com' };
const created = parseCreditsClaimCreatedV2(createdWire, expected);
assert.ok(created && Object.isFrozen(created.binding));
assert.equal(parseCreditsClaimCreatedV2({ ...createdWire, payUrl: 'https://elsewhere.invalid/t/clm_1' }, expected), null);
const protocol = await runCreditsCommand(profile, ['protocol', '--json'], io);
assert.equal(protocol.exitCode, 0);
assert.equal(JSON.parse(protocol.stdout).schemaVersion, 'hraness-credits-protocol-v1');
const status = await runCreditsCommand(profile, ['status', '--json'], io);
assert.equal(status.exitCode, 0);
assert.equal(JSON.parse(status.stdout).signedOut, true);
assert.deepEqual(await readStoredDeviceToken(profile, io), { ok: true, value: null });
const envelope = buildCreditsRequiredEnvelope(${requiredInput});
const writes = [];
assert.equal(await emitCreditsRequired(envelope, { stderr: { write(text) { writes.push(text); return true; } } }, 'agent'), true);
assert.equal(JSON.parse(writes[0]).schemaVersion, 'hraness-credits-required-v1');
const shortfall = { error: 'insufficient_credits', required: { microUsd: 12500000, usd: '12.50' }, balance: { microUsd: 0, usd: '0.00', availableMicroUsd: 0 }, topup: { claimId: 'clm_1', url: 'https://credits.hraness.com/t/clm_1', expiresAt: '2026-09-17T22:00:00Z', packs: [{ id: 'p25', usd: 25, credits: 2500, bonusCredits: 150 }], suggestedPackId: 'p25' } };
const client = createCreditsClient({ origin: 'https://credits.hraness.com', productKey: 'cr_prod_' + 'C'.repeat(43), fetch: async () => new Response(JSON.stringify(shortfall), { status: 402, headers: { 'content-type': 'application/json' } }) });
const hold = await client.hold({ subjectToken: 'cr_dev_' + 'A'.repeat(43), operation: 'enrich_contact', idempotencyKey: 'k' });
assert.equal(hold.ok, false);
assert.equal(hold.error.code, 'insufficient_credits');
assert.equal(hold.error.topup.url, 'https://credits.hraness.com/t/clm_1');
assert.equal(ceilingFor(${rateCard}, 'enrich_contact', 2), 400000);
`);
  run("node", [entry], scratch);
  const bunEntry = join(scratch, "bun-recovery.mjs");
  await writeFile(bunEntry, `
import assert from 'node:assert/strict';
import { constants as fsFlags, mkdirSync, realpathSync, statfsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import * as recoveryStore from '@hraness/credits-foundation/recovery/bun';
assert.ok(import.meta.resolve('@hraness/credits-foundation/recovery/bun').endsWith('/dist/recovery-bun.js'));
const base = ${JSON.stringify(join(scratch, "bun-state"))};
mkdirSync(base, { mode: 0o700 });
const location = { trustedBase: realpathSync(base), directory: ['credits'], productId: 'peopleblade', serviceOrigin: 'https://credits.example' };
const fresh = { databaseId: '00000000-0000-4000-8000-000000000001', deviceId: '00000000-0000-4000-8000-000000000002' };
const hostMatches = process.platform === 'darwin' && process.arch === 'arm64' && Bun.version === '1.3.14'
  && typeof process.getuid === 'function' && Number.isSafeInteger(process.getuid())
  && typeof fsFlags.O_NOFOLLOW === 'number' && typeof fsFlags.O_NONBLOCK === 'number';
let sqliteMatches = false;
if (hostMatches) {
  const probe = new Database(':memory:');
  try {
    const identity = probe.query('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get();
    const options = probe.query('PRAGMA compile_options').all().map(row => row.compile_options);
    sqliteMatches = identity.version === '3.51.0'
      && identity.sourceId === '2025-06-12 13:14:41 f0ca7bba1c5e232e5d279fad6338121ab55af0c8c68c84cdfb18ba5114dcaapl'
      && ['THREADSAFE=2', 'ENABLE_LOCKING_STYLE=1', 'DEFAULT_SYNCHRONOUS=2'].every(option => options.includes(option));
  } finally { probe.close(); }
}
const result = recoveryStore.bootstrapRecoveryStore(location, fresh);
if (hostMatches && sqliteMatches && statfsSync(base).type === 26) {
  assert.equal(result.ok, true);
  assert.deepEqual(recoveryStore.readRecoveryStore(location), result);
  assert.deepEqual(recoveryStore.bootstrapRecoveryStore(location, null), result);
  const { databaseId, revision, generation } = result.value;
  assert.deepEqual(recoveryStore.checkRecoveryFence(location, { databaseId, revision, generation }), result);
  assert.deepEqual(recoveryStore.commitRecoveryEvent(location, { databaseId, revision: revision + 1, generation }, { type: 'signout' }), { ok: false, reason: 'stale-state' });
} else {
  assert.deepEqual(result, { ok: false, reason: hostMatches && sqliteMatches ? 'unsupported-filesystem' : 'unsupported-runtime' });
}
`);
  run(process.execPath, [bunEntry], scratch);
  const brokenPipe = join(scratch, "broken-pipe.mjs");
  await writeFile(brokenPipe, `
import { buildCreditsRequiredEnvelope } from '@hraness/credits-foundation';
import { emitCreditsRequired, runCreditsCommand } from '@hraness/credits-foundation/node';
const envelope = buildCreditsRequiredEnvelope(${requiredInput});
const emitted = await emitCreditsRequired(envelope, { stderr: process.stderr }, 'human');
const profile = { id: 'peopleblade', name: 'PeopleBlade', command: ['peopleblade'] };
const result = await runCreditsCommand(profile, ['status'], { env: { XDG_STATE_HOME: ${JSON.stringify(join(scratch, "broken-pipe-state"))} }, stderr: process.stderr, fetch: async () => { throw new Error('offline'); } });
process.stdout.write(JSON.stringify({ emitted, exitCode: result.exitCode, stdout: result.stdout }));
`);
  const child = spawn("node", [brokenPipe], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.destroy();
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", resolvePromise);
  }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, "a real closed stderr pipe must not crash the installed Node host");
  assert.deepEqual(JSON.parse(stdout), { emitted: false, exitCode: 0, stdout: "" });
  const browser = await Bun.build({ entrypoints: [join(installed, "dist/index.js")], target: "browser" });
  if (!browser.success) throw new Error("Root must remain browser portable.");
  const browserRecovery = join(scratch, "browser-recovery.mjs");
  await writeFile(browserRecovery, `export { parseRecoveryState } from '@hraness/credits-foundation/recovery'; export { readRecoveryStore } from '@hraness/credits-foundation/recovery/bun';`);
  const recoveryBrowser = await Bun.build({ entrypoints: [browserRecovery], target: "browser" });
  if (!recoveryBrowser.success) throw new Error("Portable recovery model and unsupported store must bundle without SQLite.");
  for (const output of recoveryBrowser.outputs) assert.ok(!/bun:sqlite|node:fs|node:crypto/u.test(await output.text()), "Browser recovery bundle must not contain native storage");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  if (Object.keys(manifest.dependencies ?? {}).length !== 0) throw new Error("Unexpected runtime dependency.");
  assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
  assert.equal(manifest.exports["./node"].types, "./dist/node.d.ts");
  assert.equal(manifest.exports["./server"].types, "./dist/server.d.ts");
  assert.deepEqual(manifest.exports["./recovery/bun"], { types: "./dist/recovery-bun.d.ts", bun: "./dist/recovery-bun.js", default: "./dist/recovery-unavailable.js" });
  process.stdout.write("Packed strict TypeScript/Node consumers, qualified Bun recovery, unsupported runtime boundary, broken-pipe host, and browser-safe entries passed.\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
