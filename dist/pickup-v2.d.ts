/** Inactive, portable v2 wire parsing only. No transport, credential issuance or state writes. */
export declare const CREDITS_CLAIM_CREATE_V2 = "hraness-credits-claim-create-v2";
export declare const CREDITS_CLAIM_CREATED_V2 = "hraness-credits-claim-created-v2";
export declare const CREDITS_PICKUP_REQUEST_V2 = "hraness-credits-pickup-request-v2";
export declare const CREDITS_PICKUP_RESPONSE_V2 = "hraness-credits-pickup-response-v2";
export declare const CREDITS_BALANCE_V2 = "hraness-credits-balance-v2";
export declare const CREDITS_V2_MAX_REQUEST_BYTES = 4096;
export declare const CREDITS_V2_MAX_RESPONSE_BYTES = 16384;
export type CreditsBindingV2 = Readonly<{
    claimId: string;
    productId: string;
    deviceId: string;
}>;
export type CreditsClaimCreateV2 = Readonly<{
    schemaVersion: typeof CREDITS_CLAIM_CREATE_V2;
    creationId: string;
    product: string;
    device: Readonly<{
        id: string;
        label?: string;
    }>;
    email?: string;
    packId?: string;
}>;
export type CreditsClaimCreatedV2 = Readonly<{
    schemaVersion: typeof CREDITS_CLAIM_CREATED_V2;
    creationId: string;
    binding: CreditsBindingV2;
    createdAt: string;
    expiresAt: string;
    payUrl: string;
}>;
export type CreditsCreationExpectationV2 = Readonly<{
    creationId: string;
    productId: string;
    deviceId: string;
    serviceOrigin: string;
    /** Set after the first accepted creation response to bind subsequent replays. */
    claimId?: string;
}>;
export type CreditsPickupOperationV2 = "status" | "credential" | "pickup" | "ack";
type RequestBase = Readonly<{
    schemaVersion: typeof CREDITS_PICKUP_REQUEST_V2;
    claimId: string;
}>;
export type CreditsPickupRequestV2 = RequestBase & (Readonly<{
    operation: "status" | "credential";
}> | Readonly<{
    operation: "pickup";
    pickupId: string;
    tokenSha256: string;
}> | Readonly<{
    operation: "ack";
    pickupId: string;
}>);
export type CreditsPickupResponseV2 = Readonly<{
    schemaVersion: typeof CREDITS_PICKUP_RESPONSE_V2;
    operation: CreditsPickupOperationV2;
    binding: CreditsBindingV2;
    payment: "pending" | "paid" | "expired";
    pickupState: "unregistered" | "registered" | "acknowledged" | "revoked";
    pickupId: string | null;
    usable: boolean | null;
}>;
export type CreditsPickupExpectationV2 = Readonly<{
    operation: CreditsPickupOperationV2;
    binding: CreditsBindingV2;
    /** Persisted candidate ID. Null is allowed only for unregistered status. */
    pickupId: string | null;
}>;
export type CreditsBalanceV2 = Readonly<{
    schemaVersion: typeof CREDITS_BALANCE_V2;
    product: Readonly<{
        id: string;
        name: string;
    }>;
    balance: Readonly<{
        microUsd: number;
        credits: number;
        usd: string;
    }>;
    held: Readonly<{
        microUsd: number;
    }>;
    lowBalance: boolean;
    packs: readonly Readonly<{
        id: string;
        label: string;
        usd: number;
        credits: number;
        bonusCredits: number;
    }>[];
    suggestedPackId: string;
}>;
declare const ERROR_STATUS: Readonly<{
    unavailable: 503;
    unauthorized: 401;
    not_found: 404;
    invalid_request: 400;
    conflict: 409;
    expired: 410;
    rate_limited: 429;
    product_disabled: 503;
    too_large: 413;
}>;
export type CreditsErrorV2 = Readonly<{
    error: keyof typeof ERROR_STATUS;
}>;
/** Accept an object or bounded JSON text. The claim bearer is deliberately absent from the body. */
export declare function parseCreditsClaimCreateV2(value: unknown): CreditsClaimCreateV2 | null;
/** Bind the original creation tuple; provide claimId on a replay after its first accepted response. */
export declare function parseCreditsClaimCreatedV2(value: unknown, expected: CreditsCreationExpectationV2): CreditsClaimCreatedV2 | null;
export declare function parseCreditsPickupRequestV2(value: unknown): CreditsPickupRequestV2 | null;
/** A status response may say unregistered despite an already persisted local candidate. */
export declare function parseCreditsPickupResponseV2(value: unknown, expected: CreditsPickupExpectationV2): CreditsPickupResponseV2 | null;
/** This response carries product identity only, not a claim/device proof or an activation decision. */
export declare function parseCreditsBalanceV2(value: unknown, expectedProductId: string): CreditsBalanceV2 | null;
/** Only the fixed v2 error body and its matching HTTP status are accepted; no echoed diagnostics. */
export declare function parseCreditsErrorV2(value: unknown, httpStatus: number): CreditsErrorV2 | null;
export {};
