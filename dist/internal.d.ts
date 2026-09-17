/** Shared validation primitives. Pure, portable, and free of I/O. */
export declare const PRODUCT_ID: RegExp;
export declare const CLAIM_ID: RegExp;
export declare const HOLD_ID: RegExp;
export declare const PACK_ID: RegExp;
export declare const OPERATION: RegExp;
export declare const DEVICE_TOKEN: RegExp;
export declare const CLAIM_SECRET: RegExp;
export declare const PRODUCT_KEY: RegExp;
export declare const UUID: RegExp;
export declare const USD_STRING: RegExp;
export declare const TIMESTAMP: RegExp;
export declare const ERROR_CODE: RegExp;
export declare function record(value: unknown): value is Record<string, unknown>;
/** Exact-key discipline: every required key present, no key outside required ∪ optional. */
export declare function shape(value: unknown, required: readonly string[], optional?: readonly string[]): value is Record<string, unknown>;
export declare function plainText(value: unknown, max: number): value is string;
/** Strip control characters from text this package did not produce before it reaches a terminal or agent. */
export declare function sanitizeText(value: unknown, max: number): string;
export declare function safeInteger(value: unknown, min: number, max: number): value is number;
export declare function stringArray(value: unknown, maxItems: number, maxLength: number, minItems?: number): value is string[];
export declare function safeUrl(value: unknown): value is string;
/** An origin is a safe URL with no path, query, or fragment, written exactly as `new URL(value).origin`. */
export declare function origin(value: unknown): value is string;
export declare function email(value: unknown): value is string;
export declare function timestamp(value: unknown): value is string;
export declare function errorCode(error: unknown): string | undefined;
