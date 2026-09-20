/** Optional qualified Bun store; existing CLI commands never import this entry. */
import * as storage from "./recovery-sqlite.js";
export declare const bootstrapRecoveryStore: typeof storage.bootstrapRecoveryStore;
export declare const checkRecoveryFence: typeof storage.checkRecoveryFence;
export declare const commitRecoveryEvent: typeof storage.commitRecoveryEvent;
export declare const readRecoveryStore: typeof storage.readRecoveryStore;
export type { RecoveryLocation, RecoveryStoreExpected, RecoveryStoreFailure, RecoveryStoreResult, } from "./recovery-sqlite.js";
