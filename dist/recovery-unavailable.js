// src/recovery-unavailable.ts
var unavailable = () => Object.freeze({ ok: false, reason: "unsupported-runtime" });
var bootstrapRecoveryStore = unavailable;
var checkRecoveryFence = unavailable;
var commitRecoveryEvent = unavailable;
var readRecoveryStore = unavailable;
export {
  readRecoveryStore,
  commitRecoveryEvent,
  checkRecoveryFence,
  bootstrapRecoveryStore
};
