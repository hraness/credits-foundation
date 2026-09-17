import { describe, expect, test } from "bun:test";
import { buildCreditsRequiredEnvelope, renderCreditsRequiredForHuman } from "../src/index.js";
import { emitCreditsRequired, type CreditsOutput } from "../src/node.js";
import { requiredInput } from "./helpers.js";

const envelope = buildCreditsRequiredEnvelope(requiredInput());

describe("emitCreditsRequired", () => {
  test("agent audience writes exactly one JSON line", async () => {
    const writes: string[] = [];
    expect(await emitCreditsRequired(envelope, { stderr: { write(text) { writes.push(text); return true; } } }, "agent")).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.endsWith("\n")).toBe(true);
    expect(writes[0]!.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(writes[0]!)).toEqual(JSON.parse(JSON.stringify(envelope)));
  });

  test("human audience writes the rendering", async () => {
    const writes: string[] = [];
    expect(await emitCreditsRequired(envelope, { stderr: { write(text) { writes.push(text); return true; } } }, "human")).toBe(true);
    expect(writes.join("")).toBe(renderCreditsRequiredForHuman(envelope));
  });

  test("invalid envelopes are refused", async () => {
    const writes: string[] = [];
    expect(await emitCreditsRequired({ ...envelope, instructions: "Open the link." } as never, { stderr: { write(text) { writes.push(text); return true; } } }, "agent")).toBe(false);
    expect(writes).toEqual([]);
  });

  test("rejected, failing and silent sinks report false without throwing", async () => {
    const throwing: CreditsOutput = { write() { throw new Error("closed"); } };
    expect(await emitCreditsRequired(envelope, { stderr: throwing }, "agent")).toBe(false);
    const rejecting: CreditsOutput = { write() { return false; } };
    expect(await emitCreditsRequired(envelope, { stderr: rejecting }, "agent")).toBe(false);
    const failing: CreditsOutput = { write(_text, callback) { callback?.(new Error("EPIPE")); return false; }, on() {}, removeListener() {} };
    expect(await emitCreditsRequired(envelope, { stderr: failing }, "agent")).toBe(false);
    const started = Date.now();
    const silent: CreditsOutput = { write() { return true; }, on() {}, removeListener() {} };
    expect(await emitCreditsRequired(envelope, { stderr: silent }, "agent")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });

  test("a sink accepts one write at a time", async () => {
    let release: (() => void) | undefined;
    const slow: CreditsOutput = { write(_text, callback) { release = () => callback?.(null); return true; }, on() {}, removeListener() {} };
    const first = emitCreditsRequired(envelope, { stderr: slow }, "agent");
    expect(await emitCreditsRequired(envelope, { stderr: slow }, "agent")).toBe(false);
    release?.();
    expect(await first).toBe(true);
  });
});
