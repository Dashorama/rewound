export interface PricingRow {
  match: string; // substring matched against the model name, case-insensitive
  input: number; // $ / Mtok
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// $/Mtok. Estimated — update here when Anthropic changes pricing.
export const PRICING_TABLE: PricingRow[] = [
  { match: "opus", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: "sonnet", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: "haiku", input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
];

export function findPricingRow(model: string | undefined): PricingRow | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  return PRICING_TABLE.find((row) => lower.includes(row.match));
}

export function estimateCostUsd(model: string | undefined, usage: UsageTokens): number {
  const row = findPricingRow(model);
  if (!row) return 0;
  return (
    (usage.input / 1_000_000) * row.input +
    (usage.output / 1_000_000) * row.output +
    (usage.cacheRead / 1_000_000) * row.cacheRead +
    (usage.cacheWrite / 1_000_000) * row.cacheWrite
  );
}
