# Inactive recovery state model

`src/recovery-state.ts` is an internal, pure state model for a future credits adapter. It is not a public package entry and is not connected to the existing commands, state files, SQLite, network, payment or token generation. Existing v1 behavior is unchanged. Passing these tests does not qualify persistence, concurrent processes, transport authentication or a live credits service.

The model preserves one registration tuple across creation, pickup and ACK recovery. It also represents a returning device's authenticated v1 top-up without replacing its established token. Every imported state and event is read from `unknown`; accepted snapshots and decisions are recursively frozen. The state payload is limited to 32 KiB of UTF-8 JSON, with exact keys, bounded strings and safe nonnegative integer revision/generation. Ordinary accessors and `toJSON` are not invoked. This is not isolation from malicious Proxy traps or code running as the same OS user.

Prepared bootstrap requires revision/generation zero. Active state requires revision at least one and generation strictly below revision: activation advances revision first, and every later generation increment also advances revision. Imported snapshots cannot bypass those reachable counter relationships.

## State and transaction boundary

`prepareRecoveryState()` accepts injected database/device identifiers, product and exact service origin. It generates nothing. The result starts at revision/generation zero and `bootstrap: "prepared"`. A prepared record cannot expose a token, authorize an action or report successful signout. The adapter must complete the separately reviewed migration/version-fence protocol before requesting `activate`.

`transitionRecoveryState()` returns one of:

- `reject`: a fixed reason without the supplied values;
- `unchanged`: the immutable current snapshot;
- `commit`: an immutable `expected` database/revision/generation guard, proposed `next` state, and an optional `afterCommitAction` ticket.

A commit decision is only a proposed transaction. The adapter must read the authoritative row, compare the guard, update exactly one row under the storage transaction, satisfy its durability and marker checks, and commit before using the returned action. There is no network operation inside that transaction. A commit error is uncertain until the same store is inspected; it is not permission to create another tuple. This module makes no exactly-once, locking, crash-recovery or power-loss guarantee.

Tickets bind database, generation, operation ID, prepared revision and action. An observation must carry the exact current ticket. Stale replies are rejected without mutation; they are never used to resurrect a completed or signed-out operation. `recoveryAction()` selects only an action permitted by an already persisted pending phase. The adapter must obtain that state through its qualified authoritative-store path. A structurally valid state alone is not evidence of a committed row.

Observation events must be supplied only after the adapter authenticates the configured authority, sends the exact saved bearer/body to its pinned route, bounds and parses the response, and checks the expected operation/binding. The reducer rechecks the wire semantics and ticket, but valid JSON and a matching ticket do not authenticate a server. No event flag or parser result is presented as authentication proof.

## New-device registration

`prepare-registration` requires no active credential and no pending operation. It saves the validated canonical creation body, operation ID, claim secret, pickup ID and candidate token before creation. Repeating the same preparation is unchanged; changing any field conflicts. Creation replay uses the same saved body/secret and v2 creation ID. No pay URL is available until a bound successful creation reply is accepted and committed. The first response fixes the claim/product/device, original timestamps and exact configured-origin `/t/<claimId>` URL.

Authenticated status may advance payment from pending to paid. Local elapsed time never expires it. A pending or expired observation after the saved paid phase is contradictory and rejected. This preserves recovery for paid claims after their original unpaid-link TTL. Generic errors, malformed replies, unavailable service, timeout and uncertain outcomes do not remove or replace the tuple.

`begin-pickup` commits `pickup-pending` before dispatch. The future transport derives the request's SHA-256 from the exact saved candidate; this model does not store an independently supplied token/hash pair. Pickup success commits `ack-pending` before ACK is sent. Even an issuer policy that reports the registered credential as usable does not expose it through the ordinary reader yet.

In `ack-pending`, an acknowledged/usable ACK response, or an authenticated credential read confirming that state after a lost ACK reply, promotes precisely the saved candidate and removes pending secrets in the same proposed commit. Registered credential responses leave it pending. All v2 claim actions are pending-only in this slice; after promotion, ordinary balance/spend callers use the established token.

`readRecoveryToken()` returns only a locally established token from active bootstrap state. It never returns a pending candidate or claim secret. Its result is not a guarantee of current remote authorization: the authority still controls spending. The frozen authority may return generic 401 for a revoked established credential, so this model does not invent an active-revocation event or infer revocation from that error.

## Terminal state and signout

Authenticated claim-status evidence can mark an unpaid registration expired or a pending registration revoked. Both disable further pickup, preserving the saved tuple. Paid state cannot become unpaid expiry. `clear-expired` is allowed only for a saved authority-confirmed expired pending operation; it clears that operation and increments generation/revision, retaining any established credential. Revoked registration requires explicit signout before preparing a replacement.

`signout` succeeds only after bootstrap is active. It increments generation/revision and removes all active and pending bearer material from this logical payload. Device, database, product and origin remain. Old tickets cannot restore credentials; an already-authorized remote request can still finish. Counter exhaustion rejects without changing state.

This is forgetting credentials on this device. A pending purchase may then be unrecoverable here. It is not remote revocation or erasure from filesystem snapshots, journals or backups. During prepared migration, the old v1 file or retained original bytes may still contain a bearer, so signout rejects instead of claiming to have forgotten them. Prepared cancellation belongs to the storage recovery protocol. The activation transaction must remove any redundant secret-bearing legacy copy after verifying its fence, leaving only the necessary nonsecret fingerprint, before this signout guarantee can apply.

## Returning-device top-ups

`prepare-topup` requires an established token and saves the exact v1 body with the same product/device/subject token. This initial body subset contains product, device, subject token and optional email/pack ID; it adds no resume command. It never creates a candidate or claim secret. The authenticated create reply must retain the product and configured pay URL and contain no new credential or claim secret. The resulting status path is bound to the same credential and accepted claim ID. Pending leaves it intact; paid/consumed clears only the pending top-up; expired can be cleared explicitly. Replacement tokens, including an unexpected repeated token field, are rejected.

The current authenticated `POST /v1/claims` has no creation idempotency key. `dispatch-topup` therefore proposes a single durable transition to `create-dispatched` and returns its action once. Reopening that state does not produce another create action. A lost reply retains the exact intent and active token; it cannot redirect into v2 registration. Recovery of an unknown created claim ID is an unresolved link-recovery gap before active CLI adoption. A separately reviewed authority idempotency contract can close it; this module does not invent a lookup endpoint or claim exactly-once dispatch. Creating a top-up link is not itself a charge.

## Legacy preparation

Eligible input uses the existing exact v1 state schema and v1 product/device/token constraints, within the new product and payload bounds. Any `pendingClaim.secret` key is rejected, including malformed or undefined values. No consuming status probe is made. Token-only state is retained. A secretless pending claim requires an existing token and is imported as status-only `topup-v1/claim-pending`; the caller injects its local operation ID. Its original create body and pay URL are unknown and remain null. No body is fabricated from current options, and no creation replay is allowed for it.

An optional rate-card cache is validated using the existing public parser but omitted from the operational state. During preparation, the storage adapter must retain the exact original eligible legacy bytes/fingerprint according to its migration contract. It must reject concurrent/changed legacy input and remove the redundant secret-bearing copy upon activation. The pure model cannot establish safe paths, an unchanged old file, a version fence, or the absence of an old running waiter.

## Validation and remaining work

Focused tests cover the saved registration lifecycle, creation/ACK response loss, pre-ACK withholding under both issuer policies, wrong bindings and operations, paid recovery after TTL, terminal monotonicity, explicit expiry clearing, signout generation fencing, v1 top-up continuity and uncertain single-dispatch state, eligible/refused legacy inputs, hostile snapshots, counter exhaustion, immutable guards and 64 seeded lifecycle trials. Eight nonsecret responses are copied from an offline actual-handler authority fixture capture; model bearer inputs are synthetic. The tests use no real state or network and do not authenticate those synthetic credentials.

Storage implementation and actual file/lock/crash qualification, authenticated transport, migration/cancellation recovery, the v1 lost-create-link gap, CLI behavior and hosted metered-job/customer charging policies remain separate work. This module has no activation control and cannot activate any of them.
