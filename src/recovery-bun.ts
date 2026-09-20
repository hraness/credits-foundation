/** Optional qualified Bun store; existing CLI commands never import this entry. */
import * as storage from "./recovery-sqlite.js";

// Explicit value bindings retain the implementation in Bun 1.3.14 bundles.
export const bootstrapRecoveryStore = storage.bootstrapRecoveryStore;
export const checkRecoveryFence = storage.checkRecoveryFence;
export const commitRecoveryEvent = storage.commitRecoveryEvent;
export const readRecoveryStore = storage.readRecoveryStore;
export type {
  RecoveryLocation,
  RecoveryStoreExpected,
  RecoveryStoreFailure,
  RecoveryStoreResult,
} from "./recovery-sqlite.js";
