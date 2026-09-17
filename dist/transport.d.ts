/** Bounded JSON transport shared by the Node adapter and the server client. Never throws on HTTP errors. */
import type { CreditsFetch } from "./index.js";
export declare const MAX_REQUEST_BYTES = 16384;
export declare const MAX_RESPONSE_BYTES = 65536;
export declare const DEFAULT_TIMEOUT_MS = 10000;
export type ServiceResponse = {
    readonly kind: "json";
    readonly status: number;
    readonly body: unknown;
} | {
    readonly kind: "unreachable";
    readonly message: string;
} | {
    readonly kind: "malformed";
    readonly status: number;
    readonly message: string;
};
export interface ServiceRequest {
    readonly fetch: CreditsFetch;
    readonly method: "GET" | "POST";
    readonly url: string;
    readonly userAgent: string;
    readonly timeoutMs: number;
    readonly bearer?: string;
    readonly body?: unknown;
}
export declare function requestJson(request: ServiceRequest): Promise<ServiceResponse>;
