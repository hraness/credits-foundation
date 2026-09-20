# Hraness credits foundation

`@hraness/credits-foundation` is the shared library through which Hraness
products meter paid work against prepaid credits. It fixes the vocabulary a
product, its command line, its backend, and the agents driving it use to talk
about money and payment: an integer micro-USD ledger with one credit equal to
one cent, versioned JSON shapes for balances, claims, rate cards and estimates,
one fixed envelope a metered command prints when it cannot proceed, and typed
clients for the credits service. With it a product can refuse work it cannot
charge for, tell a person or an agent exactly what the work costs and where to
pay, and resume once the payment lands.

The package holds no ledger. The credits service owns balances, prices, packs
and checkout; this library parses what the service says and presents it. It
never enters card details, never opens a browser, and never sends email itself.

## Why it exists

- **One money vocabulary.** Every amount is an integer number of micro-USD;
  `credits` is that amount in whole cents and `usd` is the same cents as a
  two-decimal string, so agents read both and people see dollars. The pure
  helpers (`creditsFromMicroUsd`, `formatUsd`, `microUsdFromUsd`, `priceUnit`,
  `ceilToStep`, `priceCostPlus`, `bonusMicroUsd`) use safe integers and BigInt
  and throw a `RangeError` beyond one billion dollars instead of drifting.
  They mirror the service's formulas for tests and local pre-checks; the
  service's answer is the price.
- **One payment handoff.** `buildCreditsRequiredEnvelope` produces the exact
  `hraness-credits-required-v1` line, with a fixed instruction sentence, and
  `renderCreditsRequiredForHuman` turns it into four lines for a terminal. The
  parser accepts only that sentence, so an envelope cannot carry other
  instructions to an agent. The envelope is guidance for cooperating agents;
  it cannot force one to behave.
- **A device that remembers its purchase.** The Node adapter keeps one small
  state file per product: a device ID, the pending topup link, a five-minute
  rate-card cache, and the device token the service issues once when a
  purchase started from this device is paid. Products attach that token to
  their own metered requests. State is per device and per product; nothing
  synchronizes it elsewhere.
- **Opaque pricing.** Rate cards carry packs and public unit prices only.
  Operations priced from actual usage expose no price before settlement, and
  `estimate` says so with `known: false`.

## Install

Consumers install an immutable commit of this repository; `dist/` is
committed so no build step runs on install. The root entry has no runtime
dependencies, filesystem access, or network access.

```json
{ "dependencies": { "@hraness/credits-foundation": "github:hraness/credits-foundation#<full commit SHA>" } }
```

## Tell someone what to pay

The first thing a product needs is the message it prints when a metered
command cannot proceed. Given the `402 insufficient_credits` answer from the
credits service (or its own knowledge of the shortfall), build the envelope
and render it:

```ts
import { buildCreditsRequiredEnvelope, renderCreditsRequiredForHuman } from "@hraness/credits-foundation";

const envelope = buildCreditsRequiredEnvelope({
  product: { id: "peopleblade", name: "PeopleBlade" },
  command: ["peopleblade"],
  operation: "enrich_contact",
  requiredMicroUsd: 12_500_000,
  balanceMicroUsd: 0,
  topup: {
    url: "https://credits.hraness.com/t/clm_8f3k2q",
    expiresAt: "2026-09-17T22:00:00Z",
    packs: [{ id: "p10", usd: 10, credits: 1000, bonusCredits: 0 }, { id: "p25", usd: 25, credits: 2500, bonusCredits: 150 }],
    suggestedPackId: "p25",
  },
  resume: { argv: ["peopleblade", "cloud", "enrich", "--list", "founders"], automatic: true },
});
process.stderr.write(renderCreditsRequiredForHuman(envelope));
```

The call writes these four lines and nothing else; no state or network is
involved:

```
PeopleBlade needs $12.50 in credits for enrich_contact; this device has $0.00.
Add credits: https://credits.hraness.com/t/clm_8f3k2q (valid until 2026-09-17T22:00:00Z; packs $10, $25 suggested).
After payment, rerun peopleblade cloud enrich --list founders or run peopleblade credits wait; the work resumes.
Not at this terminal? Email the link: peopleblade credits email --to <address>
```

`JSON.stringify(envelope)` is the one-line agent form. The Node helper
`emitCreditsRequired(envelope, { stderr }, "agent" | "human")` writes either
form through a bounded write that never throws, so a closed pipe cannot change
the product's exit code. The product still exits with its own failure code and,
in its own `--json` envelope, sets `error.code` to `credits_required`.

## Parse the v2 recovery wire

The root entry exports pure parsers for v2 claim creation, credential pickup,
acknowledgement and balance responses. Pass the identity saved by the caller
and its configured service origin; malformed, contradictory or mismatched
responses return `null`. Accepted values are deeply frozen copies.

These exports support an inactive protocol. They do not add v2 commands,
transport or durable credential recovery, and do not enable the authority's
v2 endpoints. Existing CLI commands below continue to use v1. See the
[v2 wire reference](docs/pickup-v2.md) for the exact caller bindings, limits
and compatibility boundary.

## Retain a recoverable credential handoff

`@hraness/credits-foundation/recovery` exports the pure recovery state model.
It binds a saved creation request, candidate credential and pickup operation
before a caller dispatches them, then accepts only responses for that identity.
The optional `@hraness/credits-foundation/recovery/bun` entry stores those
transitions with a SQLite transaction and a revision/generation check.

The store is initially qualified only for Bun 1.3.14 on macOS arm64 with APFS
and its pinned SQLite runtime. Other environments return `unsupported-runtime`
or `unsupported-filesystem`. Ordinary Node imports select a no-I/O stub without
loading `bun:sqlite`; the root and pure recovery entries remain browser safe.
Importing an entry neither migrates state nor calls the credits service.

Adoption is an explicit operation. It preserves an eligible legacy identity,
fences older writers, and refuses a pending once-only legacy claim secret.
A returned storage error may follow a committed transition: read the same
store to reconcile it. Never invent a new identity to recover an uncertain
write. See the [state contract](docs/recovery-state.md) and
[storage contract](docs/recovery-sqlite.md) for bootstrap, concurrency and
interruption behavior. Process-death tests do not establish power-loss safety.

These APIs provide local recovery primitives. Existing `./node` commands still
use v1; no transport, provider dispatch or paid endpoint is activated.

## Connect a CLI

Import `runCreditsCommand` from `@hraness/credits-foundation/node`, route the
arguments after the product's `credits` subcommand to it, and set the process
exit code from the result:

```ts
import { runCreditsCommand } from "@hraness/credits-foundation/node";

const profile = { id: "peopleblade", name: "PeopleBlade", command: ["peopleblade"] };
const result = await runCreditsCommand(profile, argv, { stdout: process.stdout, stderr: process.stderr });
process.exitCode = result.exitCode;
```

`command` is the executable and fixed prefix arguments as argv elements, never
shell text; every command array the package prints starts with it. When
`stdout` and `stderr` sinks are passed, output is written as it is produced
(`wait` announces itself before polling); the result carries the same text
either way. JSON goes to stdout only, human text to stderr only.

| Arguments after `credits` | Effect | stdout |
| --- | --- | --- |
| `protocol --json` | Describe commands and lifecycle. Pure. | `hraness-credits-protocol-v1` |
| `status [--json]` | Read the balance for the stored device token; without a token, report `signedOut: true` and the topup command. Network only with a token. | `hraness-credits-status-v1` |
| `topup [--usd N \| --pack id] [--email addr] [--json]` | Create a claim, bound to the stored token when one exists, and print the link. `--usd` picks the pack with that price from the rate card. Network. | `hraness-credits-claim-v1` without `claimSecret` |
| `email --to <addr> [--claim id]` | Ask the service to email the pending claim's link. Network. | `{ "sentTo": addr }` |
| `wait [--claim id] [--timeout 15m] [--json]` | Poll the pending claim every 5 s until paid, expired, or the timeout; store the device token when one is issued. Network. | `hraness-credits-claim-status-v1` without `token` |
| `estimate <operation> [--units N] [--json]` | Show the public unit price and total when the operation has one. Network unless the rate card was fetched within 5 minutes. | `hraness-credits-estimate-v1` |
| `signout` | Forget the stored token for this product. | `{ "signedOut": true }` |

Exit codes: `0` success; `1` state unavailable, busy, or service unreachable;
`2` usage error, invalid ID, or expired claim; `3` payment still required after
`wait` timed out. With `--json`, a failure also prints `{ "error": code,
"message": text, ...fields }` on stdout; `wait` includes the last claim status
under `claim`.

Every request carries `user-agent: hraness-credits-foundation/<version>
(<product id>)` and a 10-second timeout; nothing retries except `wait`, which
keeps polling through outages until its deadline. HTTP errors become exit
codes, never exceptions. The `io` argument also accepts an injectable `fetch`,
`env`, `stateDirectory`, `now`, `sleep`, `requestTimeoutMs`, and `deviceLabel`
(the label sent with a new claim so a person can recognise the device; it
defaults to the hostname and `null` sends none). Product code reads the token
for its own metered requests with `readStoredDeviceToken(profile)`, which
returns `{ ok: true, value: token | null }` or reports unavailable state.

### Local state

The adapter stores `<productId>.json` under `$XDG_STATE_HOME/hraness/credits`,
or `~/.local/state/hraness/credits`, in a directory created with mode `0700`.
The file (`hraness-credits-state-v1`) holds the product ID, a random device
UUID, the device token when one was issued, the pending claim with its secret,
and the cached rate card. Writes go to a temporary file, are fsynced and
renamed into place; reads refuse symlinks and anything over 16 KiB. A
nonblocking `<productId>.lock` serializes commands; a lock left by a crashed
process is never stolen, so the busy message names it. Malformed state is left
untouched and reported as unavailable, never reset.

Commands never print device tokens or claim secrets. The one exception is a
rescue: if `wait` receives the once-only token and then cannot write the state
file, the failure message includes the token so the paid purchase is not lost.

## Meter work from a product backend

`@hraness/credits-foundation/server` uses `fetch` only and suits Node, Bun and
edge runtimes:

```ts
import { createCreditsClient, ceilingFor } from "@hraness/credits-foundation/server";

const credits = createCreditsClient({ origin: "https://credits.hraness.com", productKey: process.env.CREDITS_PRODUCT_KEY! });
const hold = await credits.hold({ subjectToken, operation: "enrich_contact", units: 3, idempotencyKey: jobId });
if (!hold.ok) {
  if (hold.error.code === "insufficient_credits") return payment(hold.error); // carries required, balance and topup
  return failure(hold.error);                                                // { code, status, message?, ...fields }
}
// do the work, then
const settlement = await credits.settle(hold.value.holdId, { units: 3 }); // or costs: [{ provider, operation, microUsd, basis }]
// Inspect settlement.ok and settlement.value.state before recording a charge.
```

`hold`, `settle`, `release`, `balance` (`POST /v1/subjects/balance`) and
`claim` (`POST /v1/claims` on behalf of a subject) return `{ ok: true, value }`
or `{ ok: false, error }` and never throw on HTTP errors. Successful settle and
release responses preserve the authority's actual terminal state: `settled`,
`released`, or `expired`. `ok: true` means the response is valid; it does not
mean the requested action changed an already terminal hold. Settlement retains
the recorded `chargedMicroUsd`; released/expired settlements charge zero. The
release wire supplies no charged amount, so a replay reporting `settled` neither
proves a zero charge nor refunds it. Responses for another hold are rejected.
Retain an unresolved billing intent for reconciliation when the observed state
differs from the intended one. Invalid input returns
`invalid_request` with status `0` before any request, and an unreachable
service returns `unreachable`. Every response is parsed from `unknown` against
the contract; anything else is `malformed_response`. `ceilingFor(rateCard,
operation, units)` mirrors the service's public unit pricing so a backend can
pre-check a request locally; it returns `null` for operations without a public
unit price. A `402` maps directly onto `buildCreditsRequiredEnvelope`.

## Agent behavior

`<product> credits protocol --json` returns `hraness-credits-protocol-v1`: the
command arrays for this product, placeholders, exit codes, schema names and
lifecycle guidance. The same value comes from `creditsProtocol(profile)` in the
root entry. An agent that sees a `hraness-credits-required-v1` line shows the
person the link and the price, offers the email command when they are not at
the terminal, and after payment runs `wait` or reruns the original command. It
never retries before payment, never enters card details, and never opens the
link itself. See [agent integration](docs/agents.md).

## What not to infer

- Prices come from the service. The pricing helpers exist so the service and
  its tests share one implementation; a product never learns a rate or a
  provider's cost, and `estimate` reports `known: false` when an operation is
  priced from actual usage at settlement.
- A device token is issued only when a purchase created from that device is
  paid. `topup` on a device that already holds a token binds the claim to the
  same wallet; a new device needs its own purchase.
- `email` asks the service to send the link; the package sends nothing itself
  and attaches no address to any other request. The device label defaults to
  the hostname; pass `deviceLabel: null` to send none. There is no telemetry.
- Parsers are strict: unknown keys, non-integer amounts, non-`https` links
  (loopback `http` excepted for local testing), and control characters in text
  are rejected and reported as an unreadable response.
- The root entry runs in browsers and edge runtimes; `./node` needs Node 22 or
  later (`fetch`, `AbortSignal.timeout`); `./server` needs only `fetch`.
- Nothing here proves that a deployed credits service or Stripe configuration
  is live. Local checks use an in-process transport.

## Verify

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

The gate typechecks, runs the tests (money and pricing laws with fast-check,
parsers for every service payload, the envelope and renderers, the state
lifecycle under a temporary `XDG_STATE_HOME`, every command against a fetch
stub including `wait` token pickup, and the server client's success and 402
paths), builds `dist`, then packs the package and checks a detached strict
TypeScript consumer with `skipLibCheck: false`, plain-Node execution, a host
with a closed stderr pipe, a browser build of the root, and the absence of
runtime dependencies. No test touches real user state or the network.

## Where the rest is

- [Agent integration](docs/agents.md): the protocol and envelope an agent
  follows, with the sentences it should and should not say.
- Generated declarations in `dist/*.d.ts` are the public type surface.
- [AGENTS.md](AGENTS.md) records the rules for changing this repository.

### Replayable returning top-ups

Version 0.4.0 adds pure `parseCreditsTopupCreateV2`, `parseCreditsTopupCreatedV2` and `parseCreditsTopupStatusV2` exports, plus a distinct `topup-v2` recovery state. It retains one canonical creation request and the existing device credential before dispatch, so a future transport can recover the same link after a lost reply. Late paid status clears only that pending purchase; it does not issue or rotate a token.

The optional Bun store uses its existing schema and guards. Older readers reject an unfamiliar pending kind without resetting it. Existing v1 commands, uncertain v1 creation and status-only legacy migration retain their behavior. This release adds no active transport or CLI wiring and does not enable the source-disabled authority. See [recovery semantics](./docs/recovery-state.md) and [wire contracts](./docs/pickup-v2.md).
