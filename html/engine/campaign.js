/**
 * Lokarta: Come Into The Light - Campaign & Recruitment Model
 *
 * Pure, browser-free helpers for the tower campaign loop introduced by LIV-10
 * (WS2 of Dev Sprint 001). Builds on the locked party model in `party.js`
 * (LIV-9/WS1):
 *
 *   - which vocations can still be recruited onto the party;
 *   - starting a fresh recruit at level 1 so they receive the first Fate Grant
 *     (which guarantees a basic primary weapon offer);
 *   - recording a tower completion and unlocking the next tower in order;
 *   - the lock state the tower picker renders.
 *
 * Nothing here touches IndexedDB, the DOM, the Web Worker API, or timers.
 */

import {
  VOCATIONS_CATALOG,
  isTowerId,
  nextTowerIdAfter,
  towerUnlockRequires,
} from '../data/index.js';
import {
  MAX_PARTY_SIZE,
  allTowersCompleted,
  completeTower,
  createPartyMember,
  getActiveMember,
  isTowerUnlocked,
  normalizeTowerProgress,
  partyVocationIds,
  setActiveMember,
} from './party.js';

/** Catalog fallback when a party has no members yet. */
export const FALLBACK_VOCATION = 'magician';

/** Level range shared with `ProgressionSystem` (kept local so this module is pure). */
const MAX_LEVEL = 20;

/**
 * A fresh recruit always joins at level 1 (never aligned up to the party level)
 * so they are eligible for the first Fate Grant — the level-1 draft guarantees a
 * main_hand offer, i.e. a basic primary weapon. See LIV-16.
 */
export const RECRUIT_STARTING_LEVEL = 1;

function catalogVocationIds() {
  return Object.keys(VOCATIONS_CATALOG || {});
}

function normalizeVocation(vocation) {
  const key = String(vocation || '').toLowerCase();
  return VOCATIONS_CATALOG && VOCATIONS_CATALOG[key] ? key : null;
}

function normalizeProgressInput(progress) {
  // `completeTower` / `allTowersCompleted` normalize internally; passing a
  // safe empty shape keeps this module total.
  return progress && typeof progress === 'object'
    ? progress
    : { completedTowerIds: [], unlockedTowerIds: [] };
}

/** Highest level across the party (active member included), at least 1. */
export function partyLevel(player) {
  const levels = [];
  if (Array.isArray(player && player.party)) {
    for (const member of player.party) {
      const n = Math.floor(Number(member && member.level));
      if (Number.isFinite(n) && n > 0) levels.push(n);
    }
  }
  const top = Math.floor(Number(player && player.level));
  if (Number.isFinite(top) && top > 0) levels.push(top);
  return levels.length ? Math.max(...levels) : 1;
}

/** Vocation ids still missing from the party, in catalog order. */
export function recruitableVocations(player) {
  const owned = new Set(partyVocationIds(player));
  return catalogVocationIds().filter((id) => !owned.has(id));
}

/** True when the party has room and at least one vocation left to recruit. */
export function canRecruit(player) {
  const party = Array.isArray(player && player.party) ? player.party : [];
  return party.length < MAX_PARTY_SIZE && recruitableVocations(player).length > 0;
}

/**
 * Aligns a member's stats to `level`: catalog base stats plus per-level growth,
 * full HP/MP, refreshed skill boosts. Mutates and returns the member.
 * @param {object} member
 * @param {number} level
 * @returns {object}
 */
export function alignMemberToLevel(member, level) {
  const voc = VOCATIONS_CATALOG[member && member.vocation];
  if (!voc) return member;
  const lvl = Math.max(1, Math.min(MAX_LEVEL, Math.floor(Number(level)) || 1));
  const levelDelta = lvl - 1;
  member.level = lvl;
  member.max_hp = Number(voc.hp || voc.max_hp || 1) + levelDelta * Number(voc.hpPerLevel || 0);
  member.max_mana = Number(voc.mana || voc.max_mana || 0) + levelDelta * Number(voc.manaPerLevel || 0);
  member.hp = member.max_hp;
  member.mana = member.max_mana;
  member.xp = 0;
  member.xpToNextLevel = lvl * 100;
  member.skillBoosts = {
    damageMultiplier: Number((1.0 + levelDelta * Number(voc.damageStep || 0.1)).toFixed(2)),
    bonusRange: Math.floor(levelDelta / 4),
    bonusRegen: Math.floor(levelDelta / 3),
  };
  return member;
}

/**
 * Recruits `vocation` onto the party at level 1 and makes the recruit the active
 * member. Recruits are never aligned up to the party's level (LIV-16): starting
 * fresh at level 1 keeps them eligible for the first Fate Grant, whose level-1
 * guarantee offers a basic primary weapon. Mutates `player` and returns the new
 * member, or null when the vocation is unknown, already on the party, or the
 * party is full. A repeated recruit of the same vocation is rejected.
 * @param {object} player
 * @param {string} vocation
 * @returns {object|null}
 */
export function recruitMember(player, vocation) {
  if (!player || !Array.isArray(player.party)) return null;
  const key = normalizeVocation(vocation);
  if (!key) return null;
  if (partyVocationIds(player).includes(key)) return null;
  if (player.party.length >= MAX_PARTY_SIZE) return null;

  const member = createPartyMember(key);
  alignMemberToLevel(member, RECRUIT_STARTING_LEVEL);
  const active = getActiveMember(player);
  member.x = Number(active && active.x) || Number(player.x) || 0;
  member.y = Number(active && active.y) || Number(player.y) || 0;

  player.party.push(member);
  setActiveMember(player, member.memberId);
  return member;
}

/**
 * Records `towerId` as completed on the player's campaign progress and reports
 * the derived campaign state so the caller can pick the next screen.
 * @param {object} player
 * @param {string} [towerId=player.towerId]
 * @returns {{
 *   progress: object,
 *   completedTowerId: string|null,
 *   allComplete: boolean,
 *   nextTowerId: string|null,
 * }}
 */
export function completePlayerTower(player, towerId = null) {
  const target = towerId || (player && player.towerId) || null;
  const progress = normalizeProgressInput(player && player.towerProgress);
  if (!isTowerId(target)) {
    return {
      progress: normalizeTowerProgress(progress),
      completedTowerId: null,
      allComplete: allTowersCompleted(progress),
      nextTowerId: null,
    };
  }
  // Work on a copy: `completeTower` may mutate a clean progress object in place.
  const base = {
    completedTowerIds: Array.isArray(progress.completedTowerIds) ? [...progress.completedTowerIds] : [],
    unlockedTowerIds: Array.isArray(progress.unlockedTowerIds) ? [...progress.unlockedTowerIds] : [],
  };
  const completed = completeTower(base, target);
  return {
    progress: completed,
    completedTowerId: target,
    allComplete: allTowersCompleted(completed),
    nextTowerId: nextTowerIdAfter(target),
  };
}

/** Lock state for one tower card, driven entirely by campaign progress. */
export function towerUnlockInfo(progress, towerId) {
  const unlocked = isTowerUnlocked(progress, towerId);
  return {
    unlocked,
    requires: unlocked ? [] : towerUnlockRequires(towerId),
  };
}
