/** Bounded JSON transport shared by the Node adapter and the server client. Never throws on HTTP errors. */
import type { CreditsFetch, CreditsFetchResponse } from "./index.js";
import { sanitizeText } from "./internal.js";

export const MAX_REQUEST_BYTES = 16_384;
export const MAX_RESPONSE_BYTES = 65_536;
export const DEFAULT_TIMEOUT_MS = 10_000;

export type ServiceResponse =
  | { readonly kind: "json"; readonly status: number; readonly body: unknown }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "malformed"; readonly status: number; readonly message: string };

export interface ServiceRequest {
  readonly fetch: CreditsFetch;
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly bearer?: string;
  readonly body?: unknown;
}

async function readBody(response: CreditsFetchResponse, max: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/u.test(declared.trim()) || Number(declared) > max)) {
    throw new Error("Response exceeds the size limit.");
  }
  const body = response.body;
  if (body === null || body === undefined) {
    const text = await response.text();
    if (text.length > max) throw new Error("Response exceeds the size limit.");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      length += value.byteLength;
      if (length > max) throw new Error("Response exceeds the size limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function requestJson(request: ServiceRequest): Promise<ServiceResponse> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": request.userAgent };
  if (request.bearer !== undefined) headers.authorization = `Bearer ${request.bearer}`;
  let body: string | undefined;
  if (request.body !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
    body = JSON.stringify(request.body);
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) throw new TypeError("Request body exceeds 16 KiB.");
  }
  let response: CreditsFetchResponse;
  try {
    response = await request.fetch(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(request.timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    return { kind: "unreachable", message: describe(error, request.timeoutMs) };
  }
  const status = response.status;
  const type = (response.headers.get("content-type") ?? "").trim();
  if (!/^application\/json(?:\s*;.*)?$/iu.test(type)) {
    return { kind: "malformed", status, message: `Unexpected content type ${type === "" ? "(none)" : sanitizeText(type, 80)}.` };
  }
  let text: string;
  try {
    text = await readBody(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    return { kind: "malformed", status, message: sanitizeText(error, 200) };
  }
  try {
    return { kind: "json", status, body: JSON.parse(text) as unknown };
  } catch {
    return { kind: "malformed", status, message: "Response is not valid JSON." };
  }
}

function describe(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return `No response within ${Math.round(timeoutMs / 1_000)} s.`;
  if (name === "AbortError") return "Request aborted.";
  const detail = sanitizeText(error, 200);
  return detail === "" ? "Request failed." : detail;
}
