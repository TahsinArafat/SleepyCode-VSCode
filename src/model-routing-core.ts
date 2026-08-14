export type AutoModelCandidate = {
  id: string;
  name?: string;
};

export type AutoModelPrice = {
  modelId: string;
  name?: string;
  inputPrice?: number;
  outputPrice?: number;
};

function labelOf(model: AutoModelCandidate): string {
  return (model.name || model.id).trim() || model.id;
}

export function compareModelsA2Z(a: AutoModelCandidate, b: AutoModelCandidate): number {
  return labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base', numeric: true })
    || a.id.localeCompare(b.id, undefined, { sensitivity: 'base', numeric: true });
}

export function sortModelsA2Z<T extends AutoModelCandidate>(models: readonly T[]): T[] {
  return [...models].sort(compareModelsA2Z);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export type AutoModelChoice = {
  id: string;
  reason: string;
  combinedPrice?: number;
};

/**
 * SleepyCode Auto is intentionally deterministic:
 * 1. Prefer the cheapest model with complete input + output pricing.
 * 2. Free models (0 + 0) naturally win.
 * 3. Break equal-price ties A-Z.
 * 4. If no candidate has complete pricing, choose the first model A-Z.
 */
export function chooseAutoModel(
  candidates: readonly AutoModelCandidate[],
  prices: readonly AutoModelPrice[],
): AutoModelChoice | undefined {
  if (!candidates.length) return undefined;
  const ordered = sortModelsA2Z(candidates);
  const priceById = new Map<string, AutoModelPrice>();
  const priceByName = new Map<string, AutoModelPrice>();
  for (const price of prices) {
    if (price.modelId) priceById.set(price.modelId, price);
    if (price.name) priceByName.set(price.name, price);
  }

  const priced = ordered.flatMap(model => {
    const price = priceById.get(model.id) || priceByName.get(labelOf(model));
    const input = finiteNonNegative(price?.inputPrice);
    const output = finiteNonNegative(price?.outputPrice);
    if (input === undefined || output === undefined) return [];
    return [{ model, combinedPrice: input + output }];
  });

  if (priced.length) {
    priced.sort((a, b) => a.combinedPrice - b.combinedPrice || compareModelsA2Z(a.model, b.model));
    const winner = priced[0]!;
    return {
      id: winner.model.id,
      combinedPrice: winner.combinedPrice,
      reason: winner.combinedPrice === 0 ? 'Cheapest SleepyAI model · free' : 'Cheapest SleepyAI model',
    };
  }

  return { id: ordered[0]!.id, reason: 'A–Z fallback' };
}
