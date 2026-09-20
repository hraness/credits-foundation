import { type RecoveryDecision, type RecoveryState } from "./recovery-state.js";
export type RecoveryLocation = Readonly<{
    trustedBase: string;
    directory: readonly string[];
    productId: string;
    serviceOrigin: string;
}>;
export type RecoveryStoreExpected = Readonly<{
    databaseId: string;
    revision: number;
    generation: number;
}>;
export type RecoveryStoreFailure = "invalid-input" | "unsupported-runtime" | "unsupported-filesystem" | "unsafe-path" | "missing-store" | "invalid-store" | "busy" | "bootstrap-required" | "migration-conflict" | "stale-state" | "invalid-transition" | "counter-exhausted" | "storage-uncertain";
export type RecoveryStoreResult<T> = Readonly<{
    ok: true;
    value: T;
}> | Readonly<{
    ok: false;
    reason: RecoveryStoreFailure;
}>;
/** This candidate profile is a runtime admission pin, not a claim of live activation. */
export declare const RECOVERY_SQLITE_PROFILE: Readonly<{
    bun: "1.3.14";
    platform: "darwin";
    arch: "arm64";
    filesystem: 26;
    sqlite: "3.51.0";
    sourceId: "2025-06-12 13:14:41 f0ca7bba1c5e232e5d279fad6338121ab55af0c8c68c84cdfb18ba5114dcaapl";
}>;
/** May perform SQLite's physical hot-journal recovery, but no logical transition. */
export declare function readRecoveryStore(location: unknown): RecoveryStoreResult<RecoveryState>;
export declare function checkRecoveryFence(location: unknown, expected: unknown): RecoveryStoreResult<RecoveryState>;
/** Observation events remain trusted-adapter inputs; storage does not authenticate wire data. */
export declare function commitRecoveryEvent(location: unknown, expected: unknown, event: unknown): RecoveryStoreResult<RecoveryDecision>;
/** Explicit migration operation. No new IDs are generated and no remote operation runs. */
export declare function bootstrapRecoveryStore(location: unknown, fresh: unknown): RecoveryStoreResult<RecoveryState>;
