/**
 * Lokarta: Come Into The Light - Faction & Friendly-Fire Rules
 *
 * Pure, allocation-free helpers that classify combatants and decide whether two
 * of them may damage each other. Introduced by LIV-11 (WS3 of Dev Sprint 001)
 * so multi-actor combat can never friendly-fire.
 *
 * Contract:
 *   - `faction` is a lowercase string tag declared on every combatant
 *     (`party` members, `monsters`). It is data/identity, not behavior.
 *   - Two combatants are **friendly** only when both declare the same,
 *     non-empty faction. A missing faction is never "friendly" with anything,
 *     so legacy/factionless entities keep taking damage exactly as before.
 *   - `isHostile(a, b)` is simply `!isFriendly(a, b)`; an unknown faction is
 *     therefore treated as hostile (damage applies), the safe default.
 *
 * No DOM, worker, storage, or timers.
 */

/** Faction tag shared by every player-controlled party member. */
export const PARTY_FACTION = 'party';

/** Faction tag for hostile monsters. */
export const MONSTER_FACTION = 'monsters';

/** Neutral tag for environment objects that never take part in combat. */
export const NEUTRAL_FACTION = 'neutral';

/**
 * Normalized faction tag for a combatant, or `null` when it declares none.
 * @param {object|null|undefined} entity
 * @returns {string|null}
 */
export function factionOf(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const raw = entity.faction;
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().toLowerCase();
  return tag.length > 0 ? tag : null;
}

/**
 * True only when both combatants declare the same, non-empty faction. A missing
 * faction on either side returns false so unknown entities do not become
 * accidentally immune.
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function isFriendly(a, b) {
  const fa = factionOf(a);
  const fb = factionOf(b);
  return fa !== null && fb !== null && fa === fb;
}

/**
 * True when `a` may damage `b`. Deliberately the complement of `isFriendly`:
 * entities without a declared faction are hostile to everything, preserving the
 * pre-party combat behavior.
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function isHostile(a, b) {
  return !isFriendly(a, b);
}

/**
 * True when `a` and `b` are the same combatant. Matches by object identity,
 * `memberId` (party members) and `activeMemberId` (the top-level mirrored active
 * member), so the active member is never double-counted when its party entry is
 * passed alongside it.
 * @param {object|null|undefined} a
 * @param {object|null|undefined} b
 * @returns {boolean}
 */
export function sameActor(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.memberId && b.memberId && a.memberId === b.memberId) return true;
  if (a.activeMemberId && b.memberId && a.activeMemberId === b.memberId) return true;
  if (b.activeMemberId && a.memberId && b.activeMemberId === a.memberId) return true;
  return false;
}
