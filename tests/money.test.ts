import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  MAX_MICRO_USD, creditsFromMicroUsd, formatDollars, formatUsd, microUsdFromUsd, moneyFromMicroUsd, priceFromMicroUsd,
} from "../src/index.js";

describe("credits and dollars", () => {
  test("credits are whole cents rounded toward negative infinity", () => {
    expect(creditsFromMicroUsd(12_500_000)).toBe(1250);
    expect(creditsFromMicroUsd(12_505_000)).toBe(1250);
    expect(creditsFromMicroUsd(9_999)).toBe(0);
    expect(creditsFromMicroUsd(0)).toBe(0);
    expect(creditsFromMicroUsd(-5_000)).toBe(-1);
    expect(creditsFromMicroUsd(-10_000)).toBe(-1);
    expect(() => creditsFromMicroUsd(1.5)).toThrow(RangeError);
    expect(() => creditsFromMicroUsd(MAX_MICRO_USD + 1)).toThrow(RangeError);
  });

  test("formatUsd shows two decimals", () => {
    expect(formatUsd(12_500_000)).toBe("12.50");
    expect(formatUsd(0)).toBe("0.00");
    expect(formatUsd(5)).toBe("0.00");
    expect(formatUsd(10_000)).toBe("0.01");
    expect(formatUsd(-5_000)).toBe("-0.01");
    expect(formatUsd(MAX_MICRO_USD)).toBe("1000000000.00");
  });

  test("microUsdFromUsd parses strings and numbers exactly", () => {
    expect(microUsdFromUsd("12.50")).toBe(12_500_000);
    expect(microUsdFromUsd(12.5)).toBe(12_500_000);
    expect(microUsdFromUsd("25")).toBe(25_000_000);
    expect(microUsdFromUsd(0.1)).toBe(100_000);
    expect(microUsdFromUsd("0.000001")).toBe(1);
    expect(microUsdFromUsd("-0.01")).toBe(-10_000);
    for (const bad of ["1e3", "abc", "", "1.2345678", "$5", " 5"]) expect(() => microUsdFromUsd(bad)).toThrow(TypeError);
    expect(() => microUsdFromUsd(Number.NaN)).toThrow(TypeError);
    expect(() => microUsdFromUsd("1000000000.01")).toThrow(RangeError);
    expect(() => microUsdFromUsd("10000000000")).toThrow(TypeError);
  });

  test("money and price projections carry the same integer", () => {
    expect(moneyFromMicroUsd(12_500_000)).toEqual({ microUsd: 12_500_000, credits: 1250, usd: "12.50" });
    expect(priceFromMicroUsd(200_000)).toEqual({ microUsd: 200_000, usd: "0.20" });
    expect(Object.isFrozen(moneyFromMicroUsd(1))).toBe(true);
  });

  test("formatDollars", () => {
    expect(formatDollars(25)).toBe("$25");
    expect(formatDollars(7.5)).toBe("$7.50");
    expect(() => formatDollars(-1)).toThrow(RangeError);
  });

  test("formatting is idempotent and consistent with credits", () => {
    fc.assert(fc.property(fc.integer({ min: -MAX_MICRO_USD, max: MAX_MICRO_USD }), microUsd => {
      const usd = formatUsd(microUsd);
      expect(usd).toMatch(/^-?\d+\.\d{2}$/u);
      expect(formatUsd(microUsdFromUsd(usd))).toBe(usd);
      const credits = creditsFromMicroUsd(microUsd);
      expect(credits * 10_000 <= microUsd).toBe(true);
      expect((credits + 1) * 10_000 > microUsd).toBe(true);
      expect(microUsdFromUsd(usd)).toBe(credits * 10_000);
      expect(moneyFromMicroUsd(microUsd).credits).toBe(credits);
    }), { numRuns: 300 });
  });
});
