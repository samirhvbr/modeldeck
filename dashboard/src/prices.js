// Pinned API price snapshot — VENDORED, never fetched at runtime.
//
// Source: BerriAI/litellm `model_prices_and_context_window.json`, snapshot taken
// 2026-08-11. Values are USD per single token, copied verbatim from that file's
// `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`
// and `cache_creation_input_token_cost` fields for each model id.
//
// Refresh policy (charter amendment decision 6): re-pin at releases; an override
// file may replace individual rows. No runtime fetching, ever.
export const PRICE_SNAPSHOT_DATE = '2026-08-11';
export const PRICE_SOURCE = 'LiteLLM model_prices_and_context_window.json';

export const PRICES = {
  'claude-fable-5': { input: 0.00001, output: 0.00005, cacheRead: 0.000001, cacheWrite: 0.0000125 },
  'claude-opus-5': { input: 0.000005, output: 0.000025, cacheRead: 5e-7, cacheWrite: 0.00000625 },
  'claude-sonnet-5': { input: 0.000002, output: 0.00001, cacheRead: 2e-7, cacheWrite: 0.0000025 },
  'claude-opus-4-8': { input: 0.000005, output: 0.000025, cacheRead: 5e-7, cacheWrite: 0.00000625 },
  'claude-sonnet-4-6': { input: 0.000003, output: 0.000015, cacheRead: 3e-7, cacheWrite: 0.00000375 },
  'claude-haiku-4-5-20251001': { input: 0.000001, output: 0.000005, cacheRead: 1e-7, cacheWrite: 0.00000125 },
  'gpt-5.6-sol': { input: 0.000005, output: 0.00003, cacheRead: 5e-7, cacheWrite: 0.00000625 },
  'gpt-5.6-luna': { input: 2e-7, output: 0.0000012, cacheRead: 2e-8, cacheWrite: 2.5e-7 },
  'gpt-5.6': { input: 0.000005, output: 0.00003, cacheRead: 5e-7, cacheWrite: 0.00000625 },
};

// Model ids that appear in the warehouse but not in the price table, mapped to
// the nearest priced sibling. Rows priced through an alias are flagged in the
// model table so the approximation is never silent.
export const PRICE_ALIASES = {
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5-20251001',
  'codex-auto-review': 'gpt-5.6-sol',
  sol: 'gpt-5.6-sol',
  '': 'gpt-5.6-sol',
};

/**
 * The rate for a model id, or nothing.
 *
 * Own properties only: a model id the warehouse happens to record as
 * 'constructor' or 'toString' would otherwise find a Function on the prototype
 * chain, and pricing a flow against it yields NaN — which then travels through
 * every sum on the cost lens and prints the whole page as NaN.
 */
export function priceFor(model) {
  const id = model || '';
  if (Object.hasOwn(PRICES, id)) return { rate: PRICES[id], via: null };
  const alias = Object.hasOwn(PRICE_ALIASES, id) ? PRICE_ALIASES[id] : null;
  if (alias && Object.hasOwn(PRICES, alias)) return { rate: PRICES[alias], via: alias };
  return { rate: null, via: null };
}

/**
 * API-$ equivalent for one measured token flow. Priced on provider-truth token
 * counts only (the proxy warehouse) — never on fitted or apportioned estimates.
 */
export function costOf(model, flow) {
  const { rate, via } = priceFor(model);
  if (!rate) return { usd: 0, priced: false, via: null };
  const usd =
    (flow.inputUncached || 0) * rate.input +
    (flow.inputCacheRead || 0) * rate.cacheRead +
    (flow.inputCacheWrite || 0) * rate.cacheWrite +
    (flow.outputTotal || 0) * rate.output;
  return { usd, priced: true, via };
}
