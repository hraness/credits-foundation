# Bun recovery storage

`src/recovery-sqlite.ts` is the runtime storage adapter for the separate pure [recovery state model](./recovery-state.md). It is not connected to a credits command, network transport or hosted product. Importing the module does not create state, open a database, inspect the filesystem or generate credentials. Calling its explicit APIs can change local state. The module imports `bun:sqlite`; portable root, Node command and server entries must remain independent of it.

The initial runtime profile is deliberately narrow: Bun 1.3.14, macOS arm64, APFS filesystem type 26, and the recorded Apple SQLite 3.51.0 source identity. Every operation verifies that profile before state access. Unknown runtime or filesystem identities fail closed. Passing this source's offline tests does not enable an authority endpoint, qualify a different host profile or authorize a paid request.

## Four synchronous operations

All four functions return `{ok:true,value}` or `{ok:false,reason}`. Failures use a fixed reason with no exception text, SQL, file path, binding values or credentials. Successful values are private: state and decisions contain credentials and must not be logged. No SQLite connection, statement or raw descriptor is returned.

| Function | Behavior |
| --- | --- |
| `readRecoveryStore(location)` | Reads an existing active store with its matching marker. Never creates or activates one. SQLite may physically recover a hot rollback journal. |
| `checkRecoveryFence(location, expected)` | Performs the same checked read and requires the exact database UUID, revision and generation. It produces no new action. |
| `commitRecoveryEvent(location, expected, event)` | Begins an immediate transaction, checks expected counters, runs the pure transition against the stored row, then commits its result with a second SQL compare-and-swap. Returns an action only after commit, close and final fence checks succeed. |
| `bootstrapRecoveryStore(location, fresh)` | Explicitly creates/adopts a store through prepared database → durable version marker → active database. It can recover an incomplete adoption under the finite rules below. |

`location` has exactly `trustedBase`, `directory`, `productId` and `serviceOrigin`. The base is an existing canonical absolute directory; `directory` contains zero to eight bounded filename components. The configured authority origin and product are checked against the saved state on every operation. Paths are derived internally, never accepted from the saved marker. This adapter does not resolve environment defaults; an eventual command adapter supplies the reviewed location.

`expected` has exactly `databaseId`, `revision` and `generation`. A stale snapshot returns `stale-state` without applying its event. Normal commits accept events, not an arbitrary replacement state. Activation is available only to bootstrap; the pure model rejects it against an already active row.

For a new database, `fresh` supplies `databaseId` and `deviceId`, and optionally `legacyOperationId` for an imported secretless pending claim. These identifiers are injected, never generated here. An existing legacy device must match the proposed device. After the prepared row exists, retries require `fresh:null`; no replacement identifiers are accepted. A failure before the first prepared commit can leave an uninitialized DB. It is preserved and rejected rather than silently recreated.

The function calls are synchronous and close their connection before returning. No await, transport or externally supplied callback runs inside a transaction. An unchanged pure decision performs no UPDATE. A write increments the model's safe-integer revision; generation changes on signout, explicit clearing of an authority-confirmed expired pending claim, or completion of a new topup-v2 payment. SQL counters are bound as BigInt and read back as decimal TEXT to avoid lossy driver number conversion.

## Persistence and file boundaries

One product uses `<product>.v2.sqlite` and a nonsecret `<product>.json` marker inside its private directory. The marker's schema version is `hraness-credits-state-v2-sqlite`; it includes the exact product and database UUID. Existing v1 readers/writers reject that version. The SQLite file has one fixed STRICT table and one row. Unknown schema objects, missing rows, mismatched redundant columns, invalid payloads and unreachable counter relationships are rejected. State JSON is bounded to32KiB, original prepared legacy bytes to16KiB, the database to1MiB and a rollback journal to2MiB.

The qualified connection settings are DELETE journal mode, synchronousEXTRA, macOS fullfsyncON, lockingNORMAL, busy_timeout0, trusted_schemaOFF, secure_deleteON and temp_storeMEMORY. Existing stores with another journal mode are rejected; the adapter never silently converts WAL or deletes sidecars. Immediate transactions serialize logical reads and writes. Contention returns `busy`; there is no spin or automatic retry. EXTRA adds directory synchronization after removing a rollback journal. [SQLite pragma documentation](https://www.sqlite.org/pragma.html#pragma_synchronous).

The trusted base must be owned by the current user or root and not group/other writable. Application-owned directories require the current UID and exact0700. DB, marker, lock and rollback journal files require the current UID, exact0600, a regular file and a single hard link on the same device. Existing unsafe entries fail; they are never chmodded into apparent safety. Bootstrap creates missing application directories individually and syncs each new directory and its parent. The caller may resolve a documented OS base alias first; this API requires the canonical path itself.

SQLite uses READWRITE|NOFOLLOW without CREATE after an exclusive 0600 precreation during bootstrap. The raw creation descriptor closes before SQLite opens the DB. Metadata checks use lstat: no raw descriptor for the database is opened, read, copied or closed while the adapter's SQLite connection is live. This matters because closing another raw descriptor can release POSIX locks held by SQLite. [SQLite corruption hazards](https://www.sqlite.org/howtocorrupt.html).

WAL/SHM files are refused. A safe rollback journal is preserved for SQLite's normal recovery, including on a read call. Directory and DB identities are checked before and after access; marker identity is bound to the database UUID before an action can return. These checks protect against unsafe preexisting paths and accidental replacement under a cooperating-process model. They do not claim isolation from malicious code running as the same OS user.

Credentials remain plaintext to the OS account. Logical signout clears active and pending bearer values, advances generation and retains the permanent marker. It does not revoke remote credentials or erase filesystem snapshots/backups. The adapter does not keep a hidden suspended token or original legacy bearer blob after activation. `secure_delete` is not a forensic-erasure promise.

## Legacy adoption and interrupted bootstrap

Bootstrap acquires the existing exact `<product>.lock` with exclusive creation before reading legacy JSON. It never guesses that an old lock is stale. Lock order is legacy lock first, SQLite second. Normal active-store operations use SQLite alone and ignore a leftover legacy lock.

An original legacy claim containing any `secret` field is refused unchanged. An old v1 wait may already have released its lock while awaiting a consuming paid response, so probing that route or trying to migrate its token would be unsafe. Token-only state and token-bound pending claims without a secret can migrate; the exact device, token and pending claim survive. Original UTF-8 bytes are validated, including duplicate-key rejection, and retained with their SHA256 only in the prepared row.

After the prepared row commits, bootstrap rereads the exact legacy bytes or absence while retaining the lock. It writes the nonsecret marker through an exclusive 0600 temporary file, fsyncs it, renames it over the legacy path and fsyncs the directory. It then reads and syncs the marker again before a separate activation transaction. Activation updates the state and removes both original legacy bytes and fingerprint in one transaction. No duplicate secret JSON backup is created.

| Observed state | Recovery |
| --- | --- |
| Prepared DB and unchanged eligible legacy JSON | Retry with `fresh:null` after acquiring the legacy lock. |
| Prepared DB and matching marker | Sync marker and directory again, then finalize using SQLite alone; preserve any leftover legacy lock. |
| Active DB and matching marker | Read/use the existing state; never reimport. |
| Marker but missing DB, wrong UUID, corrupt/empty DB, changed legacy snapshot or active DB without marker | Fail closed and preserve artifacts. No automatic reset or marker reconstruction. |
| Dead owner's legacy lock before marker publication | Return `busy`; no automatic stale-lock deletion. |
| Orphan marker temporary file before publication | Return `migration-conflict`; no speculative deletion/overwrite. |

The marker and database are not an atomic two-file transaction. Prepared or conflicting state cannot expose a new token or return an action. Prepared cancellation is not implemented in this initial slice. If marker syncing previously failed after rename, reading it back alone is insufficient: finalization repeats both syncs before activation.

## Uncertainty and future transport duties

An unexpected transaction/commit/close error returns `storage-uncertain`. A failure in the final path/marker check also suppresses the successful result, even if the transaction committed. The caller must inspect the same saved database later; it must not generate replacement IDs, secrets or tokens. A close failure marks that path unavailable for the rest of the module instance because connection ownership is uncertain; reopen from a new process for reconciliation.

The adapter never returns `afterCommitAction` on those failures. For recoverable v2 actions, the pure model can derive an allowed action from the same persisted tuple after reconciliation. An authenticated v1 top-up create remains a single-dispatch intent: recovering a `create-dispatched` row does not produce another create action. Lost-response recovery of an unknown v1 claim ID remains an explicit legacy gap. New topup-v2 create-pending state can derive a replay action for its exact saved canonical request and original bearer; known migrated v1 claims stay status-only. No SQL schema, marker or store API migration accompanies the new pending kind. Older model versions reject it without reset.

Fence checking is not exactly-once dispatch. Signout can occur after a preflight returns, and an already-authorized remote request can still complete. A future transport must carry the saved generation and operation ticket around each request, authenticate the response from the pinned origin, and commit it with the expected counters. Parser-valid data alone is not authenticated authority evidence. This module has no fetch dependency and cannot make or retry a network request.

## Qualification scope

The focused suite uses private scratch directories and finite owned Bun subprocesses. It checks actual transaction contention, SIGKILL before/after API commits, a rollback journal with a nonzero hot header and spilled dirty pages, recovery through `readRecoveryStore`, and0600 journal creation under a permissive subprocess umask. Failure fixtures cover marker-file/directory sync, rename, SQLITE_FULL, corrupt/truncated state, unsafe paths/sidecars, stale counters, close/final-fence uncertainty and bootstrap interruption boundaries. It also pauses the actual legacy wait at a fake paid response and proves refused adoption leaves that v1 flow writable. No provider or user state is involved.

The fixture's raw inspection of the first eight journal-header bytes is test evidence only; the adapter does not parse or repair journals. Controlled fault seams live in child-process mocks, not production callbacks or runtime bypasses. Every held child is explicitly collected, and scratch is removed only after connections/processes close.

These are process-crash and lost-local-result checks. They are not empirical power-cut tests. Power-loss durability remains conditional on the SQLite VFS, OS and device honoring synchronization; unknown filesystems and unqualified runtimes remain unavailable. [SQLite atomic commit assumptions](https://www.sqlite.org/atomiccommit.html). Package import/install checks, independent review and the required aggregate gate are separate integration evidence. Live authority, transport, CLI and hosted charging activation remain outside this adapter.

Focused returning-topup cases exercise the same real store APIs for persisted intent/reopen, old-writer refusal, stale CAS, expired-to-late-paid reconciliation and signout. Owned subprocess tests interrupt immediately before/after the prepare commit and inject a lost commit result; recovery reads the same saved tuple. They add no runtime admission or physical power-cut claim.
