/** Product backend client for the credits service. Fetch only; never throws on HTTP errors. */
import { type CreditsClaim, type CreditsCostBasis, type CreditsFetch, type CreditsPack, type CreditsPrice, type CreditsRateCard, type CreditsStatus } from "./index.js";
export interface CreditsClientOptions {
    readonly origin: string;
    readonly productKey: string;
    readonly fetch?: CreditsFetch;
    readonly timeoutMs?: number;
}
export interface CreditsHoldInput {
    readonly subjectToken: string;
    readonly operation: string;
    readonly units?: number;
    readonly ceilingMicroUsd?: number;
    readonly idempotencyKey: string;
    readonly context?: Readonly<Record<string, string>>;
}
export type CreditsLedgerBalance = Readonly<{
    microUsd: number;
    availableMicroUsd: number;
}>;
export type CreditsHold = Readonly<{
    holdId: string;
    ceilingMicroUsd: number;
    balance: CreditsLedgerBalance;
    expiresAt: string;
}>;
export interface CreditsCost {
    readonly provider: string;
    readonly operation: string;
    readonly microUsd: number;
    readonly basis: CreditsCostBasis;
}
export interface CreditsSettleInput {
    readonly units?: number;
    readonly costs?: readonly CreditsCost[];
}
export type CreditsSettlement = Readonly<{
    holdId: string;
    state: "settled";
    chargedMicroUsd: number;
    balance: CreditsLedgerBalance;
    lowBalance: boolean;
    topup?: Readonly<{
        url: string;
    }>;
}>;
export type CreditsRelease = Readonly<{
    holdId: string;
    state: "released";
    balance: CreditsLedgerBalance;
}>;
export interface CreditsClaimInput {
    readonly product: string;
    readonly device: Readonly<{
        id: string;
        label?: string;
    }>;
    readonly subjectToken?: string;
    readonly email?: string;
    readonly packId?: string;
    readonly resume?: Readonly<{
        argv: readonly string[];
    }>;
}
export type CreditsInsufficientError = Readonly<{
    code: "insufficient_credits";
    status: 402;
    message?: string;
    required: CreditsPrice;
    balance: Readonly<{
        microUsd: number;
        usd: string;
        availableMicroUsd: number;
    }>;
    topup: Readonly<{
        claimId: string;
        url: string;
        expiresAt: string;
        packs: readonly CreditsPack[];
        suggestedPackId: string;
    }>;
}>;
export type CreditsClientError = CreditsInsufficientError
/** No HTTP exchange completed: invalid input (status 0), or the service was unreachable (status 0). */
 | Readonly<{
    code: "invalid_request" | "unreachable";
    status: 0;
    message: string;
}> | Readonly<{
    code: "malformed_response";
    status: number;
    message: string;
}> | Readonly<{
    code: string;
    status: number;
    message?: string;
    readonly [field: string]: unknown;
}>;
export type CreditsClientResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: CreditsClientError;
};
/** Local mirror of the service's public unit pricing: `unitPrice × units`, or null when the operation has no public unit price. */
export declare function ceilingFor(rateCard: CreditsRateCard, operation: string, units?: number): number | null;
export declare function createCreditsClient(options: CreditsClientOptions): Readonly<{
    /** Reserve a ceiling for one operation; 402 returns `insufficient_credits` with a topup link bound to the subject's wallet. */
    hold(input: CreditsHoldInput): Promise<CreditsClientResult<CreditsHold>>;
    /** Charge `min(price, ceiling)` from reported costs or units; retrying a settled hold returns the recorded result. */
    settle(holdId: string, input?: CreditsSettleInput): Promise<CreditsClientResult<CreditsSettlement>>;
    /** Release a hold without charging. */
    release(holdId: string): Promise<CreditsClientResult<CreditsRelease>>;
    /** Balance for a subject token, in the same shape as the CLI status. */
    balance(subjectToken: string): Promise<CreditsClientResult<CreditsStatus>>;
    /** Create a claim on behalf of a subject, for products that hand out topup links from their own backend. */
    claim(input: CreditsClaimInput): Promise<CreditsClientResult<CreditsClaim>>;
}>;
export type CreditsClient = ReturnType<typeof createCreditsClient>;
