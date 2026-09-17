import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  MAX_MICRO_USD, bonusMicroUsd, ceilToStep, priceCostPlus, priceUnit, type CreditsCostBasis, type CreditsCostInput,
  type CreditsCostPlusPricing,
} from "../src/index.js";

const pricing: CreditsCostPlusPricing = { takeRate: 0.35, roundingStepMicroUsd: 10_000, fixedOffsetMicroUsd: 2_000, minPriceMicroUsd: 10_000 };
const BASES: readonly CreditsCostBasis[] = ["reported", "contractual", "estimated", "unknown"];

/** Exact reference in BigInt: price × 4e6 must be at least Σ cost × k × (1e6 + take) + offset × 4e6. */
function exactScaled(costs: readonly CreditsCostInput[], p: CreditsCostPlusPricing): bigint {
  const take = BigInt(Math.round(p.takeRate * 1_000_000));
  let quarters = 0n;
  for (const cost of costs) quarters += BigInt(cost.microUsd) * (cost.basis === "estimated" || cost.basis === "unknown" ? 5n : 4n);
  return quarters * (1_000_000n + take) + BigInt(p.fixedOffsetMicroUsd) * 4_000_000n;
}

describe("pricing helpers", () => {
  test("ceilToStep", () => {
    expect(ceilToStep(12_345, 10_000)).toBe(20_000);
    expect(ceilToStep(20_000, 10_000)).toBe(20_000);
    expect(ceilToStep(0, 10_000)).toBe(0);
    expect(ceilToStep(1, 1)).toBe(1);
    expect(() => ceilToStep(1, 0)).toThrow(RangeError);
    expect(() => ceilToStep(-1, 10)).toThrow(RangeError);
    expect(() => ceilToStep(MAX_MICRO_USD - 1, 7)).toThrow(RangeError);
    expect(ceilToStep(MAX_MICRO_USD - 1, 10_000)).toBe(MAX_MICRO_USD);
  });

  test("priceUnit", () => {
    expect(priceUnit(200_000, 3)).toBe(600_000);
    expect(priceUnit(200_000)).toBe(200_000);
    expect(() => priceUnit(200_000, 0)).toThrow(RangeError);
    expect(() => priceUnit(200_000, 1.5)).toThrow(RangeError);
    expect(() => priceUnit(MAX_MICRO_USD, 2)).toThrow(RangeError);
  });

  test("priceCostPlus follows the contract formula", () => {
    // 100000 × 1.35 + 2000 = 137000 → step 10000 → 140000
    expect(priceCostPlus([{ microUsd: 100_000, basis: "reported" }], pricing)).toBe(140_000);
    // estimated: 100000 × 1.25 × 1.35 + 2000 = 170750 → 180000
    expect(priceCostPlus([{ microUsd: 100_000, basis: "estimated" }], pricing)).toBe(180_000);
    expect(priceCostPlus([{ microUsd: 100_000, basis: "unknown" }], pricing)).toBe(180_000);
    expect(priceCostPlus([{ microUsd: 50_000, basis: "reported" }, { microUsd: 50_000, basis: "contractual" }], pricing)).toBe(140_000);
    // Minimum price wins for tiny costs: 1 × 1.35 + 2000 → 10000.
    expect(priceCostPlus([{ microUsd: 1, basis: "reported" }], pricing)).toBe(10_000);
  });

  test("zero reported cost charges the minimum price", () => {
    expect(priceCostPlus([], pricing)).toBe(10_000);
    expect(priceCostPlus([{ microUsd: 0, basis: "reported" }], pricing)).toBe(10_000);
    expect(priceCostPlus([], { ...pricing, fixedOffsetMicroUsd: 50_000 })).toBe(10_000);
  });

  test("priceCostPlus validates inputs", () => {
    expect(() => priceCostPlus([{ microUsd: 1.5, basis: "reported" }], pricing)).toThrow(RangeError);
    expect(() => priceCostPlus([{ microUsd: 1, basis: "guess" as CreditsCostBasis }], pricing)).toThrow(TypeError);
    expect(() => priceCostPlus([], { ...pricing, takeRate: -0.1 })).toThrow(RangeError);
    expect(() => priceCostPlus([], { ...pricing, takeRate: Number.NaN })).toThrow(RangeError);
    expect(() => priceCostPlus([], { ...pricing, roundingStepMicroUsd: 0 })).toThrow(RangeError);
    expect(() => priceCostPlus([{ microUsd: MAX_MICRO_USD, basis: "reported" }], pricing)).toThrow(RangeError);
  });

  test("bonusMicroUsd floors", () => {
    expect(bonusMicroUsd(25_000_000, 6)).toBe(1_500_000);
    expect(bonusMicroUsd(10_000_000, 0)).toBe(0);
    expect(bonusMicroUsd(1, 50)).toBe(0);
    expect(bonusMicroUsd(3, 50)).toBe(1);
    expect(() => bonusMicroUsd(1, 1_001)).toThrow(RangeError);
    expect(() => bonusMicroUsd(-1, 10)).toThrow(RangeError);
  });

  const arbitraryCost = fc.record({ microUsd: fc.integer({ min: 0, max: 1_000_000_000 }), basis: fc.constantFrom(...BASES) });
  const arbitraryPricing = fc.record({
    takeRate: fc.integer({ min: 0, max: 10_000 }).map(bp => bp / 10_000),
    roundingStepMicroUsd: fc.integer({ min: 1, max: 1_000_000 }),
    fixedOffsetMicroUsd: fc.integer({ min: 0, max: 1_000_000 }),
    minPriceMicroUsd: fc.integer({ min: 0, max: 1_000_000 }),
  });

  test("price is never below cost × (1 + take) + offset, respects the step and the minimum", () => {
    fc.assert(fc.property(fc.array(arbitraryCost, { maxLength: 8 }), arbitraryPricing, (costs, p) => {
      const price = priceCostPlus(costs, p);
      expect(price >= p.minPriceMicroUsd).toBe(true);
      const total = costs.reduce((sum, cost) => sum + cost.microUsd, 0);
      if (total === 0) {
        expect(price).toBe(p.minPriceMicroUsd);
        return;
      }
      const exact = exactScaled(costs, p);
      expect(BigInt(price) * 4_000_000n >= exact).toBe(true);
      expect(price === p.minPriceMicroUsd || price % p.roundingStepMicroUsd === 0).toBe(true);
      // Tight: rounding never adds a full step beyond the exact value unless the minimum applies.
      const ceiling = (exact + 3_999_999n) / 4_000_000n;
      const bound = ceiling + BigInt(p.roundingStepMicroUsd);
      expect(BigInt(price) <= (bound > BigInt(p.minPriceMicroUsd) ? bound : BigInt(p.minPriceMicroUsd))).toBe(true);
    }), { numRuns: 400 });
  });

  test("price is monotonic in every cost", () => {
    fc.assert(fc.property(
      fc.array(arbitraryCost, { minLength: 1, maxLength: 6 }), arbitraryPricing, fc.nat(), fc.integer({ min: 0, max: 1_000_000 }),
      (costs, p, pick, delta) => {
        const index = pick % costs.length;
        const increased = costs.map((cost, i) => i === index ? { ...cost, microUsd: cost.microUsd + delta } : cost);
        expect(priceCostPlus(increased, p) >= priceCostPlus(costs, p)).toBe(true);
      },
    ), { numRuns: 300 });
  });

  test("estimated costs never price below reported costs", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), arbitraryPricing, (microUsd, p) => {
      expect(priceCostPlus([{ microUsd, basis: "estimated" }], p) >= priceCostPlus([{ microUsd, basis: "reported" }], p)).toBe(true);
    }), { numRuns: 200 });
  });

  test("ceilToStep and priceUnit agree with integer arithmetic", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10 ** 12 }), fc.integer({ min: 1, max: 10 ** 6 }), (value, step) => {
      const rounded = ceilToStep(value, step);
      expect(rounded % step).toBe(0);
      expect(rounded >= value && rounded - value < step).toBe(true);
    }), { numRuns: 200 });
    fc.assert(fc.property(fc.integer({ min: 0, max: 10 ** 9 }), fc.integer({ min: 1, max: 10 ** 5 }), (unit, units) => {
      expect(BigInt(priceUnit(unit, units))).toBe(BigInt(unit) * BigInt(units));
    }), { numRuns: 200 });
  });
});
