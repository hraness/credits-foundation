import { type CreditsFetch, type CreditsProductProfile, type CreditsRequiredEnvelope } from "./index.js";
export interface CreditsOutput {
    readonly isTTY?: boolean;
    write(text: string, callback?: (error?: Error | null) => void): unknown;
    on?(event: string, listener: (...args: any[]) => void): unknown;
    removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}
export interface CreditsStateOptions {
    /** Overrides `$XDG_STATE_HOME/hraness/credits`; tests point this at a temporary directory. */
    readonly stateDirectory?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
}
export interface CreditsCommandIo extends CreditsStateOptions {
    /** When present, output is written here as it is produced; the result still carries the same text. */
    readonly stdout?: CreditsOutput;
    readonly stderr?: CreditsOutput;
    /** Injectable transport; defaults to the global fetch. */
    readonly fetch?: CreditsFetch;
    /** Epoch milliseconds clock; deterministic hosts and tests inject one. */
    readonly now?: () => number;
    /** Sleep used between `wait` polls; tests inject one that advances the clock. */
    readonly sleep?: (ms: number) => Promise<void>;
    /** Label sent with new claims so a person can recognise this device. Defaults to the hostname; null sends none. */
    readonly deviceLabel?: string | null;
    readonly requestTimeoutMs?: number;
}
export interface CreditsCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
export type CreditsAudience = "agent" | "human";
export type CreditsStateResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    reason: "busy" | "state-unavailable";
};
/** `$XDG_STATE_HOME/hraness/credits`, else `~/.local/state/hraness/credits`. */
export declare function creditsStateDirectory(options?: CreditsStateOptions): string;
/** Read the device token a product attaches as `Authorization: Bearer` to its own metered requests. */
export declare function readStoredDeviceToken(profile: CreditsProductProfile, options?: CreditsStateOptions): Promise<CreditsStateResult<string | null>>;
/** Print a required envelope for products: one JSON line for agents, the human rendering otherwise. */
export declare function emitCreditsRequired(envelope: CreditsRequiredEnvelope, io?: Pick<CreditsCommandIo, "stderr">, audience?: CreditsAudience): Promise<boolean>;
/**
 * Run one `credits` subcommand. JSON goes to stdout only; human text goes to stderr. Network happens only
 * inside the commands the table marks as such. Exit codes: 0 success; 1 state unavailable, busy, or service
 * unreachable; 2 usage error, invalid id, or expired claim; 3 payment still required after `wait` timed out.
 */
export declare function runCreditsCommand(profile: CreditsProductProfile, argv?: readonly string[], io?: CreditsCommandIo): Promise<CreditsCommandResult>;
