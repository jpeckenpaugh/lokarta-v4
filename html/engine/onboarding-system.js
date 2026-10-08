/**
 * Lokarta: Come Into The Light - Onboarding System (I10)
 *
 * Pure, browser-free model for the first-~5-minutes onboarding prompts. The
 * prompt sequence lives in `ui.json.onboarding`; the player envelope carries
 * `onboardingSeenIds` (an array of prompt ids) so a prompt fires at most once
 * per save.
 *
 * Design notes: prompts are informational only — no streaks, no timers, no
 * gated progression. A trigger is a plain string (`game_start`, `first_defeat`,
 * `enter_tower`, `low_hp`) so adding a prompt is a data edit, never a JS branch.
 */

import { UI_CATALOG } from '../data/index.js';

const CONFIG = (UI_CATALOG && UI_CATALOG.onboarding) || {};

/** True when the onboarding sequence is enabled by the catalog. */
export function isOnboardingEnabled() {
  return CONFIG.enabled !== false;
}

/** All authored onboarding prompts in catalog order (invalid entries dropped). */
export function listOnboardingPrompts() {
  const prompts = Array.isArray(CONFIG.prompts) ? CONFIG.prompts : [];
  return prompts.filter(
    (p) => p && typeof p.id === 'string' && typeof p.trigger === 'string'
  );
}

/**
 * Normalizes a raw persisted `onboardingSeenIds` value into a deduped array of
 * authored prompt ids (in catalog order). Never throws.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeSeenPromptIds(raw) {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(listOnboardingPrompts().map((p) => p.id));
  const seen = new Set();
  for (const id of raw) {
    if (valid.has(id)) seen.add(id);
  }
  const ordered = listOnboardingPrompts().map((p) => p.id).filter((id) => seen.has(id));
  // Preserve the caller's array reference when already clean (identity no-op).
  if (ordered.length === raw.length) {
    let same = true;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i] !== raw[i]) { same = false; break; }
    }
    if (same) return raw;
  }
  return ordered;
}

/** True when the player has already seen `promptId`. */
export function hasSeenPrompt(player, promptId) {
  return Array.isArray(player && player.onboardingSeenIds) && player.onboardingSeenIds.includes(promptId);
}

/**
 * The first unseen prompt whose `trigger` matches, or null. Pure.
 * @param {object|null} player
 * @param {string} trigger
 * @returns {object|null}
 */
export function nextOnboardingPrompt(player, trigger) {
  if (!isOnboardingEnabled() || typeof trigger !== 'string') return null;
  const seen = new Set(normalizeSeenPromptIds(player && player.onboardingSeenIds));
  for (const prompt of listOnboardingPrompts()) {
    if (prompt.trigger === trigger && !seen.has(prompt.id)) return prompt;
  }
  return null;
}

/**
 * Stamps `promptId` as seen on the player envelope. Idempotent and
 * non-mutating: returns the same reference when nothing changed, or a shallow
 * copy with the ordered, deduped list when it did.
 * @param {object|null} player
 * @param {string} promptId
 * @returns {{ player: object|null, isNew: boolean }}
 */
export function markOnboardingSeen(player, promptId) {
  if (!player || !listOnboardingPrompts().some((p) => p.id === promptId)) {
    return { player, isNew: false };
  }
  const current = normalizeSeenPromptIds(player.onboardingSeenIds);
  if (current.includes(promptId)) return { player, isNew: false };
  const next = normalizeSeenPromptIds([...current, promptId]);
  return { player: { ...player, onboardingSeenIds: next }, isNew: true };
}
