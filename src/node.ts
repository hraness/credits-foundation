import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  CREDITS_ESTIMATE_SCHEMA, CREDITS_FOUNDATION_VERSION, CREDITS_SERVICE_ORIGIN, CREDITS_STATE_SCHEMA, CREDITS_STATUS_SCHEMA,
  claimUrl, creditsProtocol, formatArgv, formatDollars, isCreditsClaimId, isCreditsClaimSecret, isCreditsDeviceToken,
  isCreditsEmail, isCreditsOperation, isCreditsPackId, isCreditsTimestamp, microUsdFromUsd, moneyFromMicroUsd,
  parseCreditsClaim, parseCreditsClaimStatus, parseCreditsErrorEnvelope, parseCreditsProfile, parseCreditsRateCard,
  parseCreditsRequiredEnvelope, parseCreditsStatus, priceUnit, renderCreditsRequiredForHuman, summarizePacks,
  type CreditsClaim, type CreditsClaimStatus, type CreditsEstimate, type CreditsFetch, type CreditsProductProfile,
  type CreditsRateCard, type CreditsRequiredEnvelope, type CreditsSignedOutStatus, type CreditsStatus,
} from "./index.js";
import { UUID, errorCode, plainText, safeInteger, sanitizeText, shape } from "./internal.js";
import { DEFAULT_TIMEOUT_MS, requestJson, type ServiceResponse } from "./transport.js";

const STATE_MAX_BYTES = 16_384;
const POLL_MS = 5_000;
const DEFAULT_WAIT = "15m";
const MAX_WAIT_MS = 24 * 60 * 60_000;
const RATE_CARD_TTL_MS = 5 * 60_000;
const OUTPUT_TIMEOUT_MS = 500;
const LOCK_RETRIES = 5;
const LOCK_RETRY_MS = 200;
const pendingOutputs = new WeakMap<CreditsOutput, symbol>();
const USAGE = "Usage: credits <protocol --json | status [--json] | topup [--usd N | --pack id] [--email addr] [--json] | email --to <addr> [--claim id] | wait [--claim id] [--timeout 15m] [--json] | estimate <operation> [--units N] [--json] | signout>";

export interface CreditsOutput {
  readonly isTTY?: boolean;
  write(text: string, callback?: (error?: Error | null) => void): unknown;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface CreditsStateOptions {
  /** Overrides `$XDG_STATE_HOME/hraness/credits`; tests point this at a temporary directory. */
  readonly stateDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CreditsCommandIo extends CreditsStateOptions {
  /** When present, output is written here as it is produced; the result still carries the same text. */
  readonly stdout?: CreditsOutput;
  readonly stderr?: CreditsOutput;
  /** Injectable transport; defaults to the global fetch. */
  readonly fetch?: CreditsFetch;
  /** Epoch milliseconds clock; deterministic hosts and tests inject one. */
  readonly now?: () => number;
  /** Sleep used between `wait` polls; tests inject one that advances the clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Label sent with new claims so a person can recognise this device. Defaults to the hostname; null sends none. */
  readonly deviceLabel?: string | null;
  readonly requestTimeoutMs?: number;
}

export interface CreditsCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CreditsAudience = "agent" | "human";
export type CreditsStateResult<T> = { ok: true; value: T } | { ok: false; reason: "busy" | "state-unavailable" };

interface PendingClaim { id: string; secret?: string; expiresAt: string }
interface RateCardCache { fetchedAt: number; body: CreditsRateCard }
interface CreditsState {
  schemaVersion: typeof CREDITS_STATE_SCHEMA;
  product: string;
  deviceId: string;
  token?: string;
  pendingClaim?: PendingClaim;
  rateCard?: RateCardCache;
}
type StateAction<T> = { value: T; changed?: boolean };
type StateResult<T> = CreditsStateResult<T> | { ok: false; reason: "state-unavailable"; partial: T };

interface Failure {
  readonly code: string;
  readonly exitCode: 1 | 2 | 3;
  readonly message: string;
  readonly service?: Readonly<{ status: number; code?: string }>;
  readonly fields?: Readonly<Record<string, unknown>>;
}
interface Success {
  readonly exitCode: 0;
  readonly json: unknown;
  readonly human: string;
  /** Commands whose stdout is always JSON (`email`, `signout`). */
  readonly jsonAlways?: boolean;
}
type Outcome = Success | Failure;
type Client = ReturnType<typeof serviceClient>;
interface Context {
  readonly profile: CreditsProductProfile;
  readonly io: CreditsCommandIo;
  readonly client: Client;
  readonly emitter: Emitter;
  readonly json: boolean;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

function isFailure<T extends object>(value: T | Failure): value is Failure {
  return "code" in value;
}

function usage(message: string): Failure {
  return { code: "usage_error", exitCode: 2, message: `${message} ${USAGE}` };
}

// ---------------------------------------------------------------------------
// State

/** `$XDG_STATE_HOME/hraness/credits`, else `~/.local/state/hraness/credits`. */
export function creditsStateDirectory(options: CreditsStateOptions = {}): string {
  if (options.stateDirectory !== undefined) return options.stateDirectory;
  const env = options.env ?? process.env;
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "hraness", "credits");
}

function initialState(productId: string): CreditsState {
  return { schemaVersion: CREDITS_STATE_SCHEMA, product: productId, deviceId: randomUUID() };
}

function parseState(value: unknown, productId: string): CreditsState {
  if (!shape(value, ["schemaVersion", "product", "deviceId"], ["token", "pendingClaim", "rateCard"])
    || value.schemaVersion !== CREDITS_STATE_SCHEMA || value.product !== productId
    || typeof value.deviceId !== "string" || !UUID.test(value.deviceId)
    || (value.token !== undefined && !isCreditsDeviceToken(value.token))) {
    throw new Error("Invalid credits state.");
  }
  const state: CreditsState = { schemaVersion: CREDITS_STATE_SCHEMA, product: productId, deviceId: value.deviceId };
  if (value.token !== undefined) state.token = value.token;
  if (value.pendingClaim !== undefined) {
    const claim = value.pendingClaim;
    if (!shape(claim, ["id", "expiresAt"], ["secret"]) || !isCreditsClaimId(claim.id) || !isCreditsTimestamp(claim.expiresAt)
      || (claim.secret !== undefined && !isCreditsClaimSecret(claim.secret))) {
      throw new Error("Invalid pending claim in credits state.");
    }
    state.pendingClaim = { id: claim.id, ...(claim.secret === undefined ? {} : { secret: claim.secret }), expiresAt: claim.expiresAt };
  }
  if (value.rateCard !== undefined) {
    const cache = value.rateCard;
    if (!shape(cache, ["fetchedAt", "body"]) || !safeInteger(cache.fetchedAt, 0, Number.MAX_SAFE_INTEGER)) {
      throw new Error("Invalid rate card cache in credits state.");
    }
    const body = parseCreditsRateCard(cache.body);
    if (body === null) throw new Error("Invalid rate card cache in credits state.");
    state.rateCard = { fetchedAt: cache.fetchedAt, body };
  }
  return state;
}

function serializeState(state: CreditsState): string {
  return `${JSON.stringify({
    schemaVersion: state.schemaVersion,
    product: state.product,
    deviceId: state.deviceId,
    ...(state.token === undefined ? {} : { token: state.token }),
    ...(state.pendingClaim === undefined ? {} : { pendingClaim: state.pendingClaim }),
    ...(state.rateCard === undefined ? {} : { rateCard: state.rateCard }),
  })}\n`;
}

async function readLocalJson(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > STATE_MAX_BYTES) throw new Error("Invalid credits state file.");
    const buffer = Buffer.alloc(STATE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > STATE_MAX_BYTES) throw new Error("Oversized credits state file.");
    return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeLocalText(directory: string, name: string, text: string): Promise<void> {
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, name));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function writeState(directory: string, state: CreditsState): Promise<void> {
  let text = serializeState(state);
  if (Buffer.byteLength(text) > STATE_MAX_BYTES) {
    delete state.rateCard;
    text = serializeState(state);
    if (Buffer.byteLength(text) > STATE_MAX_BYTES) throw new Error("Credits state exceeds its size limit.");
  }
  await writeLocalText(directory, `${state.product}.json`, text);
}

/** One nonblocking local lock per product; never steal a lock whose owner may still be alive. */
async function withState<T>(
  profile: CreditsProductProfile,
  options: CreditsStateOptions,
  action: (state: CreditsState) => StateAction<T> | Promise<StateAction<T>>,
): Promise<StateResult<T>> {
  let lock;
  let lockPath: string | undefined;
  try {
    const directory = creditsStateDirectory(options);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    lockPath = join(directory, `${profile.id}.lock`);
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      return { ok: false, reason: errorCode(error) === "EEXIST" ? "busy" : "state-unavailable" };
    }
    const raw = await readLocalJson(join(directory, `${profile.id}.json`));
    const state = raw === undefined ? initialState(profile.id) : parseState(raw, profile.id);
    const result = await action(state);
    if (result.changed) {
      try {
        await writeState(directory, state);
      } catch {
        return { ok: false, reason: "state-unavailable", partial: result.value };
      }
    }
    return { ok: true, value: result.value };
  } catch {
    return { ok: false, reason: "state-unavailable" };
  } finally {
    if (lock !== undefined) {
      await lock.close().catch(() => {});
      if (lockPath !== undefined) await unlink(lockPath).catch(() => {});
    }
  }
}

async function withStateRetrying<T>(
  context: Context,
  action: (state: CreditsState) => StateAction<T> | Promise<StateAction<T>>,
): Promise<StateResult<T>> {
  let result = await withState(context.profile, context.io, action);
  for (let attempt = 0; attempt < LOCK_RETRIES && !result.ok && result.reason === "busy"; attempt += 1) {
    await context.sleep(LOCK_RETRY_MS);
    result = await withState(context.profile, context.io, action);
  }
  return result;
}

function stateFailure(context: Context, reason: "busy" | "state-unavailable"): Failure {
  const directory = creditsStateDirectory(context.io);
  return reason === "busy"
    ? { code: "busy", exitCode: 1, message: `Another ${context.profile.name} credits command holds the state lock; try again in a moment. If none is running, remove ${join(directory, `${context.profile.id}.lock`)}.` }
    : { code: "state_unavailable", exitCode: 1, message: `${context.profile.name} credits state is unavailable or malformed under ${directory}; it was left unchanged.` };
}

/** Read the device token a product attaches as `Authorization: Bearer` to its own metered requests. */
export async function readStoredDeviceToken(
  profile: CreditsProductProfile,
  options: CreditsStateOptions = {},
): Promise<CreditsStateResult<string | null>> {
  try {
    const parsed = parseCreditsProfile(profile);
    if (parsed === null) throw new TypeError("Invalid credits product profile.");
    const raw = await readLocalJson(join(creditsStateDirectory(options), `${parsed.id}.json`));
    if (raw === undefined) return { ok: true, value: null };
    return { ok: true, value: parseState(raw, parsed.id).token ?? null };
  } catch {
    return { ok: false, reason: "state-unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Output

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** A stream callback reports accepted output, never human reading or consent. */
async function writeOutput(sink: CreditsOutput, message: string): Promise<boolean> {
  if (pendingOutputs.has(sink)) return false;
  const operation = Symbol();
  pendingOutputs.set(sink, operation);
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const stream = typeof sink.on === "function" && typeof sink.removeListener === "function";
    const cleanup = () => {
      try { sink.removeListener?.("error", onError); } catch { /* Host output cleanup is best effort. */ }
      try { sink.removeListener?.("close", onClose); } catch { /* Preserve the command result. */ }
      if (pendingOutputs.get(sink) === operation) pendingOutputs.delete(sink);
    };
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const finished = (ok: boolean) => {
      settle(ok);
      // Node invokes failed-write callbacks before emitting `error`. Keep the
      // listener through that turn so a broken pipe cannot escape this call.
      if (stream) setTimeout(cleanup, 0).unref();
      else cleanup();
    };
    const onError = () => finished(false);
    const onClose = () => finished(false);
    timer = setTimeout(() => {
      settle(false);
      // An in-flight stream may emit later. Its one error listener remains
      // until its callback/error/close, without extending this deadline.
    }, OUTPUT_TIMEOUT_MS);
    try {
      if (stream) {
        sink.on!("error", onError);
        sink.on!("close", onClose);
        sink.write(message, error => finished(!error));
      } else {
        const result = sink.write(message);
        Promise.resolve(result).then(value => finished(value !== false), () => finished(false));
      }
    } catch {
      finished(false);
    }
  });
}

class Emitter {
  stdout = "";
  stderr = "";
  constructor(private readonly io: CreditsCommandIo) {}
  async out(text: string): Promise<void> {
    this.stdout += text;
    if (this.io.stdout !== undefined) await writeOutput(this.io.stdout, text);
  }
  async err(text: string): Promise<void> {
    this.stderr += text;
    if (this.io.stderr !== undefined) await writeOutput(this.io.stderr, text);
  }
}

/** Print a required envelope for products: one JSON line for agents, the human rendering otherwise. */
export async function emitCreditsRequired(
  envelope: CreditsRequiredEnvelope,
  io: Pick<CreditsCommandIo, "stderr"> = {},
  audience: CreditsAudience = "agent",
): Promise<boolean> {
  try {
    const parsed = parseCreditsRequiredEnvelope(envelope);
    if (parsed === null) return false;
    const sink = io.stderr ?? process.stderr;
    return await writeOutput(sink, audience === "human" ? renderCreditsRequiredForHuman(parsed) : json(parsed));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Service

function serviceClient(profile: CreditsProductProfile, io: CreditsCommandIo) {
  const origin = profile.serviceOrigin ?? CREDITS_SERVICE_ORIGIN;
  const fetch: CreditsFetch = io.fetch ?? globalThis.fetch;
  const userAgent = `hraness-credits-foundation/${CREDITS_FOUNDATION_VERSION} (${profile.id})`;
  const timeoutMs = io.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    origin,
    get: (path: string, bearer?: string) => requestJson({ fetch, method: "GET", url: `${origin}${path}`, userAgent, timeoutMs, ...(bearer === undefined ? {} : { bearer }) }),
    post: (path: string, body: unknown, bearer?: string) => requestJson({ fetch, method: "POST", url: `${origin}${path}`, userAgent, timeoutMs, body, ...(bearer === undefined ? {} : { bearer }) }),
  };
}

function serviceFailure(response: ServiceResponse, activity: string): Failure {
  if (response.kind === "unreachable") {
    return { code: "service_unreachable", exitCode: 1, message: `The credits service could not be reached while ${activity}: ${response.message}` };
  }
  if (response.kind === "malformed") {
    return { code: "service_error", exitCode: 1, service: { status: response.status }, message: `The credits service sent an unexpected response (HTTP ${response.status}) while ${activity}: ${response.message}` };
  }
  const envelope = parseCreditsErrorEnvelope(response.body);
  const status = response.status;
  const service = { status, ...(envelope === null ? {} : { code: envelope.code }) };
  const detail = envelope?.message === undefined ? "" : ` ${envelope.message}`;
  const code = envelope?.code ?? `http_${status}`;
  if (status === 401 || status === 403) {
    return { code: "unauthorized", exitCode: 2, service, message: `The credits service rejected the stored credentials while ${activity}.${detail} If this device was signed out elsewhere, run signout and then topup.` };
  }
  if (status === 404) return { code: "not_found", exitCode: 2, service, message: `The credits service found no such claim or product while ${activity}.${detail}` };
  if (status === 410) return { code: "expired", exitCode: 2, service, message: `That topup link has expired. Run topup to create a new one.${detail}` };
  if (status === 400 || status === 402 || status === 409 || status === 413) {
    return { code: "invalid_request", exitCode: 2, service, message: `The credits service refused the request while ${activity} (${code}).${detail}` };
  }
  if (status === 429) return { code: "rate_limited", exitCode: 1, service, message: `The credits service is rate limiting this device while ${activity}; try again later.${detail}` };
  if (status === 503 && (code === "product_disabled" || code === "email_unavailable")) {
    return { code, exitCode: 1, service, message: `The credits service reports ${code.replaceAll("_", " ")} while ${activity}.${detail}` };
  }
  return { code: "service_error", exitCode: 1, service, message: `The credits service failed (HTTP ${status}, ${code}) while ${activity}.${detail}` };
}

function malformed(activity: string, status: number): Failure {
  return { code: "service_error", exitCode: 1, service: { status }, message: `The credits service sent a response this version cannot read while ${activity}.` };
}

async function loadRateCard(context: Context, state: CreditsState): Promise<{ card: CreditsRateCard; fetched: boolean } | Failure> {
  const now = context.now();
  const cached = state.rateCard;
  if (cached !== undefined && now >= cached.fetchedAt && now - cached.fetchedAt < RATE_CARD_TTL_MS) {
    return { card: cached.body, fetched: false };
  }
  const response = await context.client.get(`/v1/rate-cards/${context.profile.id}`);
  if (response.kind !== "json" || response.status !== 200) return serviceFailure(response, "reading the rate card");
  const card = parseCreditsRateCard(response.body);
  if (card === null) return malformed("reading the rate card", response.status);
  state.rateCard = { fetchedAt: now, body: card };
  return { card, fetched: true };
}

// ---------------------------------------------------------------------------
// Arguments

interface Args { readonly positional: readonly string[]; readonly flags: ReadonlyMap<string, string | true> }

function parseArgs(args: readonly string[], valueFlags: readonly string[], booleanFlags: readonly string[]): Args | Failure {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!plainText(arg, 512)) return usage("Arguments must be plain text.");
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    const name = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    if (flags.has(name)) return usage(`Option --${name} was given twice.`);
    if (booleanFlags.includes(name)) {
      if (separator !== -1) return usage(`Option --${name} takes no value.`);
      flags.set(name, true);
      continue;
    }
    if (!valueFlags.includes(name)) return usage(`Unknown option --${name}.`);
    const value = separator === -1 ? args[index += 1] : arg.slice(separator + 1);
    if (value === undefined || !plainText(value, 512)) return usage(`Option --${name} needs a value.`);
    flags.set(name, value);
  }
  return { positional, flags };
}

function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function parseDuration(text: string): number | null {
  const match = /^(\d{1,5})(s|m|h)$/u.exec(text);
  if (match === null) return null;
  const amount = Number(match[1]);
  const ms = amount * (match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000);
  return ms >= 1_000 && ms <= MAX_WAIT_MS ? ms : null;
}

function parseUnits(text: string | undefined): number | null {
  if (text === undefined) return 1;
  return /^[1-9]\d{0,8}$/u.test(text) ? Number(text) : null;
}

// ---------------------------------------------------------------------------
// Rendering

function argvText(context: Context, ...parts: string[]): string {
  return formatArgv([...context.profile.command, "credits", ...parts]);
}

function renderStatus(status: CreditsStatus): string {
  const held = status.held.microUsd > 0 ? `, ${moneyFromMicroUsd(status.held.microUsd).usd} held for work in progress` : "";
  return [
    `${status.product.name} credits: $${status.balance.usd} (${status.balance.credits} credits)${held === "" ? "" : `, $${held.slice(2)}`}${status.lowBalance ? " — balance is low" : ""}.`,
    ...(status.account.email === undefined ? [] : [`Account: ${status.account.email}`]),
    ...(status.lastPrice === undefined ? [] : [`Last operation cost $${status.lastPrice.usd}.`]),
    `Add credits: ${status.topup.url} (packs ${summarizePacks(status.topup.packs, status.topup.suggestedPackId)})`,
  ].join("\n") + "\n";
}

function renderClaim(context: Context, claim: CreditsClaim): string {
  const packs = claim.packs.map(pack =>
    `${formatDollars(pack.usd)} = ${pack.credits}${pack.bonusCredits > 0 ? ` + ${pack.bonusCredits} bonus` : ""} credits${pack.id === claim.suggestedPackId ? " (suggested)" : ""}`,
  ).join("; ");
  return [
    `Add ${claim.product.name} credits: ${claim.url}`,
    `Packs: ${packs}.`,
    `The link is valid until ${claim.expiresAt}. After paying, run ${argvText(context, "wait")} or rerun your command.`,
    `Not at this terminal? ${argvText(context, "email", "--to")} <address>`,
    ...(claim.balance === undefined ? [] : [`Current balance: $${claim.balance.usd} (${claim.balance.credits} credits).`]),
  ].join("\n") + "\n";
}

function renderEstimate(estimate: CreditsEstimate): string {
  if (estimate.unitPrice === undefined || estimate.total === undefined) {
    return `${estimate.product.name} ${estimate.label} is priced at settlement from actual usage; there is no fixed unit price to show.\n`;
  }
  return `${estimate.product.name} ${estimate.label}: $${estimate.unitPrice.usd} per unit; ${estimate.units} ${estimate.units === 1 ? "unit" : "units"} = $${estimate.total.usd} (${estimate.total.credits} credits).\n`;
}

function signedOut(context: Context): CreditsSignedOutStatus {
  return Object.freeze({
    schemaVersion: CREDITS_STATUS_SCHEMA,
    product: Object.freeze({ id: context.profile.id, name: context.profile.name }),
    signedOut: true,
    topup: Object.freeze({ command: Object.freeze([...context.profile.command, "credits", "topup", "--json"]) }),
  });
}

function deviceLabel(io: CreditsCommandIo): string | undefined {
  if (io.deviceLabel === null) return undefined;
  const label = io.deviceLabel ?? safeHostname();
  return plainText(label, 64) ? label : undefined;
}

function safeHostname(): string {
  try { return hostname(); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Commands

async function statusCommand(context: Context, rest: readonly string[]): Promise<Outcome> {
  const args = parseArgs(rest, [], ["json"]);
  if ("code" in args) return args;
  if (args.positional.length > 0) return usage("status takes no arguments.");
  const state = await withState(context.profile, context.io, s => ({ value: s.token }));
  if (!state.ok) return stateFailure(context, state.reason);
  if (state.value === undefined) {
    return {
      exitCode: 0,
      json: signedOut(context),
      human: `No ${context.profile.name} credits are set up on this device. Add credits: ${argvText(context, "topup")}\n`,
    };
  }
  const response = await context.client.get("/v1/balance", state.value);
  if (response.kind !== "json" || response.status !== 200) return serviceFailure(response, "reading the balance");
  const status = parseCreditsStatus(response.body);
  if (status === null) return malformed("reading the balance", response.status);
  return { exitCode: 0, json: status, human: renderStatus(status) };
}

async function topupCommand(context: Context, rest: readonly string[]): Promise<Outcome> {
  const args = parseArgs(rest, ["usd", "pack", "email"], ["json"]);
  if ("code" in args) return args;
  if (args.positional.length > 0) return usage("topup takes options only.");
  const usd = flag(args, "usd");
  const pack = flag(args, "pack");
  const email = flag(args, "email");
  if (usd !== undefined && pack !== undefined) return usage("Choose either --usd or --pack.");
  if (pack !== undefined && !isCreditsPackId(pack)) return usage("--pack must be a pack id such as p25.");
  if (email !== undefined && !isCreditsEmail(email)) return usage("--email must be a valid address.");
  let usdMicro: number | undefined;
  if (usd !== undefined) {
    try { usdMicro = microUsdFromUsd(usd); } catch { return usage("--usd must be a dollar amount such as 25."); }
  }
  const label = deviceLabel(context.io);
  const result = await withState<Outcome>(context.profile, context.io, async state => {
    let changed = false;
    let packId = pack;
    if (usdMicro !== undefined) {
      const loaded = await loadRateCard(context, state);
      if ("code" in loaded) return { value: loaded };
      changed = loaded.fetched;
      const match = loaded.card.packs.find(candidate => microUsdFromUsd(candidate.usd) === usdMicro);
      if (match === undefined) {
        return { value: usage(`No ${context.profile.name} pack costs $${formatDollars(Number(usd)).slice(1)}. Packs: ${summarizePacks(loaded.card.packs, loaded.card.suggestedPackId)}.`), changed };
      }
      packId = match.id;
    }
    const response = await context.client.post("/v1/claims", {
      product: context.profile.id,
      device: { id: state.deviceId, ...(label === undefined ? {} : { label }) },
      ...(state.token === undefined ? {} : { subjectToken: state.token }),
      ...(email === undefined ? {} : { email }),
      ...(packId === undefined ? {} : { packId }),
    });
    if (response.kind !== "json" || response.status !== 201) return { value: serviceFailure(response, "creating a topup link"), changed };
    const claim = parseCreditsClaim(response.body);
    if (claim === null) return { value: malformed("creating a topup link", response.status), changed };
    state.pendingClaim = { id: claim.claimId, ...(claim.claimSecret === undefined ? {} : { secret: claim.claimSecret }), expiresAt: claim.expiresAt };
    const { claimSecret: _secret, ...visible } = claim;
    return { value: { exitCode: 0, json: visible, human: renderClaim(context, claim) }, changed: true };
  });
  if (!result.ok) {
    if ("partial" in result && !isFailure(result.partial)) {
      return { code: "state_unavailable", exitCode: 1, message: `A ${context.profile.name} topup link was created but could not be saved under ${creditsStateDirectory(context.io)}. Repair that directory and run topup again; the unsaved link expires unpaid.` };
    }
    return stateFailure(context, result.reason);
  }
  return result.value;
}

async function emailCommand(context: Context, rest: readonly string[]): Promise<Outcome> {
  const args = parseArgs(rest, ["to", "claim"], ["json"]);
  if ("code" in args) return args;
  if (args.positional.length > 0) return usage("email takes options only.");
  const to = flag(args, "to");
  const claim = flag(args, "claim");
  if (to === undefined || !isCreditsEmail(to)) return usage("email needs --to <address>.");
  if (claim !== undefined && !isCreditsClaimId(claim)) return usage("--claim must be a claim id.");
  const state = await withState(context.profile, context.io, s => ({ value: { token: s.token, pending: s.pendingClaim } }));
  if (!state.ok) return stateFailure(context, state.reason);
  const credentials = claimCredentials(context, state.value, claim);
  if (isFailure(credentials)) return credentials;
  const response = await context.client.post(`/v1/claims/${credentials.claimId}/email`, { to }, credentials.bearer);
  if (response.kind === "json" && response.status === 410) await forgetPendingClaim(context, credentials.claimId);
  if (response.kind !== "json" || response.status !== 202) return serviceFailure(response, "emailing the link");
  const body = response.body;
  if (!shape(body, ["sentTo"]) || !isCreditsEmail(body.sentTo)) return malformed("emailing the link", response.status);
  return {
    exitCode: 0,
    json: { sentTo: body.sentTo },
    jsonAlways: true,
    human: `Sent the ${context.profile.name} credits link to ${body.sentTo}.\n`,
  };
}

function claimCredentials(
  context: Context,
  state: { token: string | undefined; pending: PendingClaim | undefined },
  requested: string | undefined,
): { claimId: string; bearer: string; expiresAt?: string } | Failure {
  const claimId = requested ?? state.pending?.id;
  if (claimId === undefined) {
    return { code: "no_pending_claim", exitCode: 2, message: `No pending ${context.profile.name} topup link on this device. Run ${argvText(context, "topup")} first, or pass --claim <id>.` };
  }
  const own = state.pending?.id === claimId ? state.pending : undefined;
  const bearer = own?.secret ?? state.token;
  if (bearer === undefined) {
    return { code: "unauthorized", exitCode: 2, message: `This device holds no credentials for claim ${claimId}. Run ${argvText(context, "topup")} to create a link it can follow.` };
  }
  return { claimId, bearer, ...(own === undefined ? {} : { expiresAt: own.expiresAt }) };
}

async function forgetPendingClaim(context: Context, claimId: string): Promise<void> {
  await withStateRetrying(context, state => {
    if (state.pendingClaim?.id !== claimId) return { value: false };
    delete state.pendingClaim;
    return { value: true, changed: true };
  });
}

async function waitCommand(context: Context, rest: readonly string[]): Promise<Outcome> {
  const args = parseArgs(rest, ["claim", "timeout"], ["json"]);
  if ("code" in args) return args;
  if (args.positional.length > 0) return usage("wait takes options only.");
  const claim = flag(args, "claim");
  if (claim !== undefined && !isCreditsClaimId(claim)) return usage("--claim must be a claim id.");
  const timeoutText = flag(args, "timeout") ?? DEFAULT_WAIT;
  const timeoutMs = parseDuration(timeoutText);
  if (timeoutMs === null) return usage("--timeout must be a duration between 1s and 24h, such as 90s or 15m.");
  const state = await withState(context.profile, context.io, s => ({ value: { token: s.token, pending: s.pendingClaim } }));
  if (!state.ok) return stateFailure(context, state.reason);
  const credentials = claimCredentials(context, state.value, claim);
  if (isFailure(credentials)) return credentials;
  // Prove the state store accepts writes before a once-only token can arrive.
  const preflight = await withStateRetrying(context, () => ({ value: true, changed: true }));
  if (!preflight.ok) return stateFailure(context, preflight.reason);
  const { claimId, bearer } = credentials;
  if (!context.json) {
    const validity = credentials.expiresAt === undefined ? "" : `; link valid until ${credentials.expiresAt}`;
    await context.emitter.err(`Waiting for payment at ${claimUrl(context.client.origin, claimId)} (polling every 5 s for up to ${timeoutText}${validity}).\n`);
  }
  const deadline = context.now() + timeoutMs;
  let last: CreditsClaimStatus | undefined;
  for (;;) {
    const response = await context.client.get(`/v1/claims/${claimId}`, bearer);
    if (response.kind === "json") {
      if (response.status === 200) {
        const status = parseCreditsClaimStatus(response.body);
        if (status === null) return malformed("waiting for payment", response.status);
        last = status;
        if (status.state !== "pending") return settleClaim(context, status, state.value.token !== undefined);
      } else if (response.status === 410) {
        await forgetPendingClaim(context, claimId);
        return serviceFailure(response, "waiting for payment");
      } else if (response.status < 500 && response.status !== 429) {
        return serviceFailure(response, "waiting for payment");
      }
    }
    const remaining = deadline - context.now();
    if (remaining <= 0) break;
    await context.sleep(Math.min(POLL_MS, remaining));
  }
  if (last === undefined) {
    return { code: "service_unreachable", exitCode: 1, message: `The credits service gave no usable answer while waiting for payment of claim ${claimId} for ${timeoutText}.` };
  }
  return {
    code: "timeout",
    exitCode: 3,
    fields: { claim: last },
    message: `Not paid yet after ${timeoutText}. After payment, run ${argvText(context, "wait")} again or rerun your command.`,
  };
}

async function settleClaim(context: Context, status: CreditsClaimStatus, hadToken: boolean): Promise<Outcome> {
  const { token, ...visible } = status;
  if (status.state === "expired") {
    await forgetPendingClaim(context, status.claimId);
    return { code: "expired", exitCode: 2, fields: { claim: visible }, message: `That topup link has expired. Run ${argvText(context, "topup")} to create a new one.` };
  }
  if (status.state === "consumed" && !hadToken && token === undefined) {
    await forgetPendingClaim(context, status.claimId);
    return { code: "consumed", exitCode: 2, fields: { claim: visible }, message: `Claim ${status.claimId} was paid, but its device token was already collected by another process on this device.` };
  }
  const stored = await withStateRetrying(context, state => {
    if (token !== undefined) state.token = token;
    if (state.pendingClaim?.id === status.claimId) delete state.pendingClaim;
    return { value: true, changed: true };
  });
  if (!stored.ok) {
    const rescue = token === undefined ? "" : ` The issued device token could not be stored; add it as "token" in that file to keep this purchase usable here: ${token}`;
    return { code: stored.reason === "busy" ? "busy" : "state_unavailable", exitCode: 1, message: `Paid, but the ${context.profile.name} credits state under ${creditsStateDirectory(context.io)} could not be updated.${rescue}` };
  }
  const balance = status.balance === undefined ? "" : ` ${context.profile.name} balance: $${status.balance.usd} (${status.balance.credits} credits).`;
  return {
    exitCode: 0,
    json: visible,
    human: `Paid.${balance}${token === undefined ? "" : " This device is now signed in."}\n`,
  };
}

async function estimateCommand(context: Context, rest: readonly string[]): Promise<Outcome> {
  const args = parseArgs(rest, ["units"], ["json"]);
  if ("code" in args) return args;
  const operation = args.positional[0];
  if (args.positional.length !== 1 || !isCreditsOperation(operation)) return usage("estimate needs one operation name.");
  const units = parseUnits(flag(args, "units"));
  if (units === null) return usage("--units must be a whole number from 1 to 999999999.");
  const result = await withState<CreditsRateCard | Failure>(context.profile, context.io, async state => {
    const loaded = await loadRateCard(context, state);
    return "code" in loaded ? { value: loaded } : { value: loaded.card, changed: loaded.fetched };
  });
  if (!result.ok) return stateFailure(context, result.reason);
  if (isFailure(result.value)) return result.value;
  const card = result.value;
  const known = Object.keys(card.operations);
  const entry = Object.prototype.hasOwnProperty.call(card.operations, operation) ? card.operations[operation] : undefined;
  if (entry === undefined) {
    return { code: "unknown_operation", exitCode: 2, message: `${context.profile.name} has no operation "${operation}". Known operations: ${known.length === 0 ? "none" : known.join(", ")}.` };
  }
  let estimate: CreditsEstimate;
  if (entry.unitPrice === undefined) {
    estimate = Object.freeze({ schemaVersion: CREDITS_ESTIMATE_SCHEMA, product: card.product, operation, label: entry.label, units, known: false });
  } else {
    let total: number;
    try { total = priceUnit(entry.unitPrice.microUsd, units); } catch { return usage("That many units exceed the supported total."); }
    estimate = Object.freeze({
      schemaVersion: CREDITS_ESTIMATE_SCHEMA, product: card.product, operation, label: entry.label, units, known: true,
      unitPrice: entry.unitPrice, total: moneyFromMicroUsd(total),
    });
  }
  return { exitCode: 0, json: estimate, human: renderEstimate(estimate) };
}

async function signoutCommand(context: Context, rest: readonly string[]): Promise<Outcome> {
  const args = parseArgs(rest, [], ["json"]);
  if ("code" in args) return args;
  if (args.positional.length > 0) return usage("signout takes no arguments.");
  const result = await withState(context.profile, context.io, state => {
    const had = state.token !== undefined;
    delete state.token;
    return { value: had, changed: had };
  });
  if (!result.ok) return stateFailure(context, result.reason);
  return {
    exitCode: 0,
    json: { signedOut: true },
    jsonAlways: true,
    human: result.value
      ? `Forgot the ${context.profile.name} credits token on this device.\n`
      : `No ${context.profile.name} credits token was stored on this device.\n`,
  };
}

async function dispatch(context: Context, argv: readonly string[]): Promise<Outcome> {
  const [command, ...rest] = argv;
  switch (command) {
    case "protocol":
      if (rest.length !== 1 || rest[0] !== "--json") return usage("protocol requires --json.");
      return { exitCode: 0, json: creditsProtocol(context.profile), human: "" };
    case "status": return statusCommand(context, rest);
    case "topup": return topupCommand(context, rest);
    case "email": return emailCommand(context, rest);
    case "wait": return waitCommand(context, rest);
    case "estimate": return estimateCommand(context, rest);
    case "signout": return signoutCommand(context, rest);
    default: return usage(command === undefined ? "A credits command is required." : `Unknown credits command "${sanitizeText(command, 40)}".`);
  }
}

/**
 * Run one `credits` subcommand. JSON goes to stdout only; human text goes to stderr. Network happens only
 * inside the commands the table marks as such. Exit codes: 0 success; 1 state unavailable, busy, or service
 * unreachable; 2 usage error, invalid id, or expired claim; 3 payment still required after `wait` timed out.
 */
export async function runCreditsCommand(
  profile: CreditsProductProfile,
  argv: readonly string[] = [],
  io: CreditsCommandIo = {},
): Promise<CreditsCommandResult> {
  const emitter = new Emitter(io);
  const args = Array.from(argv);
  const wantsJson = args.includes("--json");
  let outcome: Outcome;
  try {
    const parsed = parseCreditsProfile(profile);
    if (parsed === null) {
      outcome = { code: "usage_error", exitCode: 2, message: "Invalid credits product profile." };
    } else {
      const context: Context = {
        profile: parsed,
        io,
        client: serviceClient(parsed, io),
        emitter,
        json: wantsJson,
        now: io.now ?? Date.now,
        sleep: io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      };
      outcome = await dispatch(context, args);
    }
  } catch (error) {
    outcome = { code: "internal_error", exitCode: 1, message: `The credits command failed: ${sanitizeText(error, 200)}` };
  }
  if (isFailure(outcome)) {
    if (wantsJson) {
      await emitter.out(json({
        error: outcome.code,
        message: outcome.message,
        ...(outcome.service === undefined ? {} : { service: outcome.service }),
        ...(outcome.fields ?? {}),
      }));
    }
    await emitter.err(`${outcome.message}\n`);
  } else {
    if (wantsJson || outcome.jsonAlways === true) await emitter.out(json(outcome.json));
    if (!wantsJson && outcome.human !== "") await emitter.err(outcome.human);
  }
  return { exitCode: outcome.exitCode, stdout: emitter.stdout, stderr: emitter.stderr };
}
