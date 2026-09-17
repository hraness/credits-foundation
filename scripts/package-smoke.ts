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
    "package/dist/node.d.ts", "package/dist/server.d.ts", "package/README.md", "package/LICENSE", "package/docs/agents.md"]) {
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
import { emitCreditsRequired, readStoredDeviceToken, runCreditsCommand } from '@hraness/credits-foundation/node';
import { ceilingFor, createCreditsClient, type CreditsClientResult, type CreditsHold } from '@hraness/credits-foundation/server';
declare global { namespace NodeJS { interface ProcessEnv { readonly NODE_ENV: 'development' | 'production' | 'test'; } } }
const profile: CreditsProductProfile = { id: 'peopleblade', name: 'PeopleBlade', command: ['peopleblade'] };
const envelope: CreditsRequiredEnvelope = buildCreditsRequiredEnvelope(${requiredInput});
creditsProtocol(profile);
priceUnit(200000, 3);
priceCostPlus([{ microUsd: 1, basis: 'reported' }], { takeRate: 0.35, roundingStepMicroUsd: 10000, fixedOffsetMicroUsd: 2000, minPriceMicroUsd: 10000 });
parseCreditsStatus({});
runCreditsCommand(profile, ['protocol', '--json'], { env: {}, stderr: process.stderr });
emitCreditsRequired(envelope, { stderr: process.stderr }, 'agent');
readStoredDeviceToken(profile, { env: {} });
const client = createCreditsClient({ origin: 'https://credits.hraness.com', productKey: 'cr_prod_' + 'C'.repeat(43), fetch });
const hold: Promise<CreditsClientResult<CreditsHold>> = client.hold({ subjectToken: 'cr_dev_' + 'A'.repeat(43), operation: 'enrich_contact', idempotencyKey: 'k' });
void hold;
ceilingFor(${rateCard}, 'enrich_contact', 2);
`);
  await writeFile(join(scratch, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, noEmit: true, types: ["node"] }, include: ["consumer.ts"] }));
  run("node", [join(root, "node_modules/typescript/bin/tsc"), "--project", join(scratch, "tsconfig.json")], scratch);
  const stateHome = join(scratch, "state");
  const entry = join(scratch, "consumer.mjs");
  await writeFile(entry, `
import assert from 'node:assert/strict';
import { buildCreditsRequiredEnvelope, formatUsd, priceUnit } from '@hraness/credits-foundation';
import { emitCreditsRequired, readStoredDeviceToken, runCreditsCommand } from '@hraness/credits-foundation/node';
import { ceilingFor, createCreditsClient } from '@hraness/credits-foundation/server';
const profile = { id: 'peopleblade', name: 'PeopleBlade', command: ['peopleblade'] };
const io = { env: { XDG_STATE_HOME: ${JSON.stringify(stateHome)} }, fetch: async () => { throw new Error('no network in the smoke test'); } };
assert.equal(formatUsd(12500000), '12.50');
assert.equal(priceUnit(200000, 3), 600000);
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
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  if (Object.keys(manifest.dependencies ?? {}).length !== 0) throw new Error("Unexpected runtime dependency.");
  assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
  assert.equal(manifest.exports["./node"].types, "./dist/node.d.ts");
  assert.equal(manifest.exports["./server"].types, "./dist/server.d.ts");
  process.stdout.write("Packed strict TypeScript/Node consumers, broken-pipe host, and browser-safe root passed.\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
