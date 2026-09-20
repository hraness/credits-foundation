/** Inactive, internal pure recovery model. No persistence, transport or credential generation. */
import { type CreditsBindingV2, type CreditsClaimCreatedV2 } from "./pickup-v2.js";
export declare const RECOVERY_STATE_SCHEMA = "hraness-credits-recovery-state-v2";
export declare const RECOVERY_MAX_BYTES = 32768;
type RegistrationStage = "create-pending" | "payment-pending" | "paid" | "pickup-pending" | "ack-pending" | "expired" | "revoked";
export type RecoveryRegistration = Readonly<{
    kind: "registration-v2";
    operationId: string;
    canonicalCreateBody: string;
    claimSecret: string;
    pickupId: string;
    candidateToken: string;
    stage: RegistrationStage;
    created: CreditsClaimCreatedV2 | null;
}>;
export type RecoveryTopup = Readonly<{
    kind: "topup-v1";
    operationId: string;
    canonicalCreateBody: string | null;
    stage: "prepared" | "create-dispatched" | "claim-pending" | "expired";
    claim: Readonly<{
        claimId: string;
        expiresAt: string;
        payUrl: string | null;
    }> | null;
}>;
export type RecoveryState = Readonly<{
    schemaVersion: typeof RECOVERY_STATE_SCHEMA;
    databaseId: string;
    productId: string;
    serviceOrigin: string;
    deviceId: string;
    revision: number;
    generation: number;
    bootstrap: "prepared" | "active";
    active: Readonly<{
        token: string;
        source: "legacy" | "pickup-v2";
        binding: CreditsBindingV2 | null;
    }> | null;
    pending: RecoveryRegistration | RecoveryTopup | null;
}>;
export type RecoveryAction = "create-v2" | "status-v2" | "pickup-v2" | "credential-v2" | "ack-v2" | "create-topup-v1" | "status-topup-v1";
export type RecoveryActionTicket = Readonly<{
    databaseId: string;
    generation: number;
    operationId: string;
    preparedRevision: number;
    action: RecoveryAction;
}>;
/** Observation variants are adapter trust inputs, not an authentication mechanism. */
export type RecoveryEvent = Readonly<{
    type: "activate" | "signout" | "clear-expired" | "dispatch-topup" | "begin-pickup";
}> | Readonly<{
    type: "prepare-registration";
    operationId: string;
    body: unknown;
    claimSecret: string;
    pickupId: string;
    candidateToken: string;
}> | Readonly<{
    type: "prepare-topup";
    operationId: string;
    body: unknown;
}> | Readonly<{
    type: "uncertain";
    ticket: RecoveryActionTicket;
}> | Readonly<{
    type: "created-v2" | "status-v2" | "pickup-v2" | "ack-v2" | "credential-v2" | "created-topup-v1" | "status-topup-v1";
    ticket: RecoveryActionTicket;
    response: unknown;
}>;
export type RecoveryFailure = "invalid-state" | "invalid-event" | "invalid-transition" | "stale-ticket" | "counter-exhausted";
export type RecoveryDecision = Readonly<{
    kind: "reject";
    reason: RecoveryFailure;
}> | Readonly<{
    kind: "unchanged";
    state: RecoveryState;
}> | Readonly<{
    kind: "commit";
    expected: Readonly<{
        databaseId: string;
        revision: number;
        generation: number;
    }>;
    next: RecoveryState;
    afterCommitAction: RecoveryActionTicket | null;
}>;
export declare function parseRecoveryState(input: unknown): RecoveryState | null;
/** Adapter must retain the original legacy bytes/fingerprint until the reviewed fence is durable. */
export declare function prepareRecoveryState(input: unknown): RecoveryState | null;
export declare function recoveryAction(input: unknown, action: RecoveryAction): RecoveryActionTicket | null;
/** Returns a locally established credential; the authority still decides current spending validity. */
export declare function readRecoveryToken(input: unknown): string | null;
/**
 * Observation events MUST come from the adapter's authenticated pinned transport,
 * after the saved ticket was committed. Valid wire JSON alone is not authentication.
 * This function checks semantics/tickets; it neither authenticates nor persists.
 */
export declare function transitionRecoveryState(stateInput: unknown, eventInput: unknown): RecoveryDecision;
export {};
