// Issue #377 — is a mid-session model change a DOWNGRADE?
//
// The ladder is a short list of FAMILY TOKENS, never model ids: Claude Code
// reports whatever id the account is entitled to (claude-fable-5,
// claude-opus-5-20260214, …) and new dated ids ship without warning, so an
// id table would go stale silently — the failure mode this issue exists to
// end. A model carrying none of these tokens has NO rank and can therefore
// never raise a drop, the same fail-closed discipline as #395's "unconfirmed
// pool membership never alarms".
//
// Ordered strongest → weakest. Order is the only claim made here; nothing in
// this module knows or cares about price.
export const CLAUDE_MODEL_LADDER = ['fable', 'opus', 'sonnet', 'haiku'];

/// The ladder rung a model id (or display name) sits on, or null when the id
/// carries no known family token. Higher `rank` is stronger.
export function claudeModelTier(model) {
  if (typeof model !== 'string') return null;
  const id = model.toLowerCase();
  for (const [index, family] of CLAUDE_MODEL_LADDER.entries()) {
    // Letter-boundary match so a family token is never found inside a longer
    // word; digits and separators around it are fine ("claude-opus-5",
    // "Opus 5", "opus_5").
    if (new RegExp(`(^|[^a-z])${family}([^a-z]|$)`, 'u').test(id)) {
      return { family, rank: CLAUDE_MODEL_LADDER.length - index };
    }
  }
  return null;
}

/// True only when both models are rankable AND the move is to a weaker rung.
/// An unrankable model on either side reads as "no opinion", never a drop.
export function isModelDowngrade(fromModel, toModel) {
  const from = claudeModelTier(fromModel);
  const to = claudeModelTier(toModel);
  if (!from || !to) return false;
  return to.rank < from.rank;
}

/// True when `toModel` is at least as strong as `fromModel` — the recovery
/// test that clears a standing drop.
export function isModelRecovery(fromModel, toModel) {
  const from = claudeModelTier(fromModel);
  const to = claudeModelTier(toModel);
  if (!from || !to) return false;
  return to.rank >= from.rank;
}
