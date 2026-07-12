import { describe, it, expect } from "vitest";
import { estimateCostUsd, PRICING_TABLE } from "../src/pricing.js";

describe("pricing", () => {
  it("prices a known opus model via substring match", () => {
    const cost = estimateCostUsd("claude-opus-4-8", {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    });
    expect(cost).toBeCloseTo(15 + 75 + 1.5 + 18.75, 5);
  });

  it("prices a known sonnet model via substring match", () => {
    const cost = estimateCostUsd("claude-sonnet-4-5-20250101", {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(cost).toBeCloseTo(3, 5);
  });

  it("prices a known haiku model via substring match", () => {
    const cost = estimateCostUsd("claude-haiku-4-5", {
      input: 0,
      output: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(cost).toBeCloseTo(4, 5);
  });

  it("returns 0 for an unknown model", () => {
    const cost = estimateCostUsd("some-future-model-x", {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    });
    expect(cost).toBe(0);
  });

  it("returns 0 for an undefined model", () => {
    const cost = estimateCostUsd(undefined, {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    });
    expect(cost).toBe(0);
  });

  it("scales linearly with partial token counts", () => {
    const cost = estimateCostUsd("claude-sonnet-4-5", {
      input: 500_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(cost).toBeCloseTo(1.5, 5);
  });

  it("exposes the pricing table as a single exported const", () => {
    expect(PRICING_TABLE.length).toBeGreaterThan(0);
    expect(PRICING_TABLE.some((row) => row.match === "opus")).toBe(true);
  });
});
