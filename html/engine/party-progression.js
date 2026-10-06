/**
 * Lokarta: Come Into The Light - Party-Wide Progression (LIV-20 / FIX-5)
 *
 * The whole party banks shared XP: every living member gains the same amount
 * per defeated monster so allies stay viable across towers (LIV-8 §8.3). The
 * active member's Fate Grant stays interactive (the draft modal); a non-active
 * ally drafts deterministically from a catalog policy and applies it with no
 * pause or modal.
 *
 * Pure: no DOM, worker, storage, or timers.
 */

import { PARTY_AI_CATALOG, VOCATIONS_CATALOG } from '../data/index.js';
import { getActiveMember } from './party.js';
import { ProgressionSystem } from './progression-system.js';
import { FateGrantSystem } from './fate-grant-system.js';

/**
 * Documented, data-overridable fallback for the auto-draft policy. Live values
 * belong in `party_ai.json` → `autoFateGrant` (Game Designer, LIV-26); this
 * default mirrors the `DEFAULT_AI_PROFILE` pattern in `party-ai.js` so the
 * mechanic is total even before the catalog entry lands.
 */
export const DEFAULT_AUTO_FATE_GRANT_POLICY = Object.freeze({
  picks: 2,
  priority: Object.freeze(['upgrade', 'main_hand', 'off_hand', 'affinity', 'rarity', 'offer_order']),
});

/**
 * Resolves the catalog auto-draft policy, falling back field-by-field so a
 * partial entry can never dead-end the mechanic.
 * @returns {{ picks: number, priority: string[] }}
 */
export function resolveAutoFateGrantPolicy() {
  const raw = PARTY_AI_CATALOG && PARTY_AI_CATALOG.autoFateGrant;
  const picks = raw && Number.isFinite(Number(raw.picks))
    ? Math.max(1, Math.floor(Number(raw.picks)))
    : DEFAULT_AUTO_FATE_GRANT_POLICY.picks;
  const priority = raw && Array.isArray(raw.priority) && raw.priority.length
    ? raw.priority.filter((token) => typeof token === 'string')
    : [...DEFAULT_AUTO_FATE_GRANT_POLICY.priority];
  return { picks, priority };
}

/** Display name for a party member, from the member or its vocation catalog. */
export function partyMemberName(member) {
  const voc = VOCATIONS_CATALOG[member && member.vocation];
  return (member && member.name) || (voc && voc.name) || 'Ally';
}

/**
 * Awards shared XP to the active member (top-level player) and every other
 * living party member. The active member's live state is authoritative on the
 * top level, so its stale `party` mirror is skipped to avoid double-award.
 *
 * @param {object} player
 * @param {number} amount
 * @returns {{ active: object|null, allies: Array<{member: object, result: object}> }}
 *   `active` is the active member's `awardXP` result; `allies` carries one entry
 *   per non-active member that leveled up (in party order).
 */
export function awardPartyXp(player, amount) {
  const xp = Math.max(0, Math.floor(Number(amount) || 0));
  const active = player ? ProgressionSystem.awardXP(player, xp) : null;

  const allies = [];
  const party = Array.isArray(player && player.party) ? player.party : [];
  if (party.length === 0) return { active, allies };

  const activeMember = getActiveMember(player);
  for (const member of party) {
    if (!member || member === activeMember) continue;
    // Downed allies do not bank or spend XP (awardXP would revive them to full).
    if (!(Number(member.hp) > 0)) continue;
    const result = ProgressionSystem.awardXP(member, xp);
    if (result.leveledUp) allies.push({ member, result });
  }

  return { active, allies };
}

/**
 * Generates and applies a deterministic Fate Grant draft for a non-active ally.
 * No modal, no pause, no player input.
 *
 * Members carry no backpack of their own (the party shares one on the
 * top-level player, LIV-22). When `stash` is supplied and the ally has no
 * backpack, the shared grid is lent to the draft for the duration of the apply
 * and then detached, so overflow lands in the shared stash and the member never
 * keeps a per-member copy. On a pre-LIV-22 member that still owns a backpack,
 * the drawer's own grid is used unchanged.
 *
 * @param {object} member
 * @param {number} level
 * @param {object} [gridMap] floor map used for the inventory-full floor-drop fallback
 * @param {object} [stash] top-level player holding the shared backpack
 * @returns {{ offer: object, chosen: object[], applied: object }}
 */
export function applyAutoFateGrant(member, level, gridMap = null, stash = null) {
  const offer = FateGrantSystem.generateDraftOffer(member, level);
  const chosen = FateGrantSystem.selectAutoDraft(offer, member, resolveAutoFateGrantPolicy());

  const hasOwnBackpack = Array.isArray(member && member.backpack);
  const sharedBackpack = stash && Array.isArray(stash.backpack) ? stash.backpack : null;
  const lendShared = !hasOwnBackpack && sharedBackpack ? sharedBackpack : null;
  if (lendShared) member.backpack = lendShared;
  let applied;
  try {
    applied = FateGrantSystem.applyDraftedCards(member, chosen, gridMap);
  } finally {
    if (lendShared) delete member.backpack;
  }
  return { offer, chosen, applied };
}
