/** Default export condition: never load SQLite or inspect local state. */
const unavailable = () => Object.freeze({ ok: false, reason: "unsupported-runtime" } as const);

export const bootstrapRecoveryStore: typeof import("./recovery-sqlite.js").bootstrapRecoveryStore = unavailable;
export const checkRecoveryFence: typeof import("./recovery-sqlite.js").checkRecoveryFence = unavailable;
export const commitRecoveryEvent: typeof import("./recovery-sqlite.js").commitRecoveryEvent = unavailable;
export const readRecoveryStore: typeof import("./recovery-sqlite.js").readRecoveryStore = unavailable;
export type { RecoveryLocation, RecoveryStoreExpected, RecoveryStoreFailure, RecoveryStoreResult } from "./recovery-sqlite.js";
