/**
 * Lokarta: Come Into The Light - Party & Campaign Progression Model
 *
 * Pure, browser-free helpers for the party data model introduced by LIV-9
 * (WS1 of Dev Sprint 001). A party is a set of `createPlayer(vocation)`-shaped
 * member objects. The active member's live state is mirrored onto the top-level
 * player object so every existing input / render / combat path keeps working
 * unchanged; `party` is the durable record for every member, active included.
 *
 * Contract:
 *   - The top-level player is authoritative for the active member while playing.
 *   - `captureActiveMember(player)` copies the top-level state into the active
 *     member entry (call before persisting).
 *   - `setActiveMember(player, memberId)` swaps which member is live.
 *   - `migratePlayerParty(player)` is idempotent and wraps a legacy
 *     single-character save into a one-member party without data loss.
 *
 * Nothing here touches IndexedDB, the DOM, the Web Worker API, or timers.
 */

import { createPlayer, INVENTORY_CONFIG } from './config.js';
import {
  VOCATIONS_CATALOG,
  TOWERS_CATALOG,
  ITEMS_CATALOG,
  firstTowerId,
  isTowerId,
  towerUnlockRequires,
} from '../data/index.js';
import {
  PARTY_FACTION,
  MONSTER_FACTION,
  NEUTRAL_FACTION,
  factionOf,
  isFriendly,
  isHostile,
  sameActor,
} from './faction.js';

// Faction constants and the friendly-fire helpers are owned by `faction.js`.
// Re-exported here so existing party-model consumers keep one import surface.
export {
  PARTY_FACTION,
  MONSTER_FACTION,
  NEUTRAL_FACTION,
  factionOf,
  isFriendly,
  isHostile,
  sameActor,
};

/** Default auto-AI mode for a party member. */
export const DEFAULT_AI_MODE = 'auto';

/** Largest party: exactly one member per authored vocation. */
export const MAX_PARTY_SIZE = Math.max(1, Object.keys(VOCATIONS_CATALOG || {}).length);

/**
 * Fields that live on the save envelope or the shared run, never on a single
 * member. Every other top-level player field is active-member state that is
 * mirrored into the active `party` entry on capture.
 *
 * `backpack` is the single **shared party backpack** (LIV-22): it stays on the
 * top-level player and is never swapped per member, so loot picked up by the
 * active member or an auto ally always lands in one stash. `action_bar` (the
 * per-character quick-use hotbar) and `paperdoll` (equipped gear) stay per
 * member.
 */
const MEMBER_EXCLUDED_KEYS = new Set([
  // Envelope / persistence bookkeeping.
  'party', 'activeMemberId', 'towerProgress',
  'slotId', 'slotIndex', 'saveVersion', 'playtimeMs',
  'createdAt', 'updatedAt', 'lastPlayedAt', 'floorEntry',
  // Shared run state (the whole party is on the same floor).
  'current_floor', 'towerId', 'location', 'townVisits',
  // Shared party backpack: one grid for the whole party (LIV-22).
  'backpack',
  // Member identity / meta (owned by the member entry, not copied from top level).
  'id', 'memberId', 'vocation', 'aiMode', 'faction', 'anim',
]);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** Catalog max stack for an item id (defaults to 1, never a heuristic). */
function itemMaxStack(item) {
  const entry = item && ITEMS_CATALOG[item.item_id];
  const max = entry && typeof entry.maxStack === 'number' ? entry.maxStack : 1;
  return max > 0 ? max : 1;
}

/**
 * Merges one ground/legacy stack into a shared container: stack onto an
 * existing slot first, then fill the first empty slot. Mirrors the
 * `InventorySystem` stacking rule without importing it (keeps `party.js`
 * dependency-light for the pure model).
 */
function mergeIntoSharedContainer(container, item) {
  if (!item) return;
  const maxStack = itemMaxStack(item);
  let remaining = Number(item.quantity) || 1;
  if (maxStack > 1) {
    for (let i = 0; i < container.length && remaining > 0; i++) {
      const slot = container[i];
      if (slot && slot.item_id === item.item_id && slot.quantity < maxStack) {
        const add = Math.min(maxStack - slot.quantity, remaining);
        slot.quantity += add;
        remaining -= add;
      }
    }
  }
  for (let i = 0; i < container.length && remaining > 0; i++) {
    if (container[i] === null) {
      const add = Math.min(maxStack, remaining);
      container[i] = { ...item, quantity: add };
      remaining -= add;
    }
  }
}

/** Resize a shared container to `size`, preserving existing entries. */
function resizeSharedContainer(container, size) {
  const next = new Array(size).fill(null);
  const source = Array.isArray(container) ? container : [];
  for (let i = 0; i < Math.min(size, source.length); i++) next[i] = source[i] || null;
  return next;
}

/**
 * Folds per-member backpacks from pre-LIV-22 saves into the shared top-level
 * backpack, then strips the per-member copies. The active member's live
 * backpack already *is* the top-level, so only non-active members contribute
 * overflow (never duplicated). Items that no longer fit are left in place
 * rather than dropped. The shared grid is normalized to the catalog size on the
 * first pass so migration is idempotent. Returns true when anything changed.
 */
function consolidateSharedInventory(player, members, activeId) {
  let changed = false;
  if (!Array.isArray(player.backpack) || player.backpack.length !== INVENTORY_CONFIG.BACKPACK_SLOTS) {
    player.backpack = resizeSharedContainer(player.backpack, INVENTORY_CONFIG.BACKPACK_SLOTS);
    changed = true;
  }
  for (const member of members) {
    if (member.memberId !== activeId && Array.isArray(member.backpack)) {
      for (const item of member.backpack) mergeIntoSharedContainer(player.backpack, item);
      changed = true;
    }
    if ('backpack' in member) {
      delete member.backpack;
      changed = true;
    }
  }
  return changed;
}

function normalizeVocation(vocation) {
  const key = String(vocation || '').toLowerCase();
  return VOCATIONS_CATALOG && VOCATIONS_CATALOG[key] ? key : null;
}

function authoredTowerIds() {
  return Array.isArray(TOWERS_CATALOG)
    ? TOWERS_CATALOG.map((tower) => tower && tower.id).filter(Boolean)
    : [];
}

function uniqueTowerIds(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const id of list) {
    if (isTowerId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Stable member id: one member per vocation, so the vocation is the key. */
export function makeMemberId(vocation) {
  return `member_${normalizeVocation(vocation) || 'magician'}`;
}

/**
 * Creates a catalog-shaped party member for a vocation (all `createPlayer`
 * fields plus member identity/meta).
 * @param {string} vocation
 * @param {object} [overrides]
 * @returns {object}
 */
export function createPartyMember(vocation, overrides = {}) {
  const key = normalizeVocation(vocation) || 'magician';
  const member = createPlayer(key, makeMemberId(key));
  member.memberId = makeMemberId(key);
  member.vocation = key;
  member.aiMode = DEFAULT_AI_MODE;
  member.faction = PARTY_FACTION;
  // The party shares one backpack held on the top-level player (LIV-22); a
  // member never carries its own copy. The hotbar and equipment stay per member.
  delete member.backpack;
  for (const [field, value] of Object.entries(overrides || {})) {
    if (field === 'memberId' || field === 'vocation' || field === 'faction') continue;
    member[field] = clone(value);
  }
  return member;
}

/** Normalizes one member's identity/meta fields; returns the same ref when clean. */
function normalizeMember(member) {
  if (!member || typeof member !== 'object') return null;
  const key = normalizeVocation(member.vocation);
  if (!key) return null;
  let changed = false;
  const out = { ...member };
  const memberId = typeof out.memberId === 'string' && out.memberId ? out.memberId : makeMemberId(key);
  if (out.memberId !== memberId) {
    out.memberId = memberId;
    changed = true;
  }
  if (out.vocation !== key) {
    out.vocation = key;
    changed = true;
  }
  if (out.aiMode !== 'auto' && out.aiMode !== 'manual') {
    out.aiMode = DEFAULT_AI_MODE;
    changed = true;
  }
  if (out.faction !== PARTY_FACTION) {
    out.faction = PARTY_FACTION;
    changed = true;
  }
  return changed ? out : member;
}

/** Index of the active member in `player.party`, or -1 when there is no party. */
export function activeMemberIndex(player) {
  const party = player && player.party;
  if (!Array.isArray(party) || party.length === 0) return -1;
  if (player.activeMemberId) {
    const byId = party.findIndex((m) => m && m.memberId === player.activeMemberId);
    if (byId >= 0) return byId;
  }
  if (player.vocation) {
    const byVocation = party.findIndex((m) => m && m.vocation === player.vocation);
    if (byVocation >= 0) return byVocation;
  }
  return 0;
}

/** The active member object, or null when there is no party. */
export function getActiveMember(player) {
  const idx = activeMemberIndex(player);
  return idx >= 0 ? player.party[idx] : null;
}

/** Vocation ids currently on the party, in party order. */
export function partyVocationIds(player) {
  if (!Array.isArray(player && player.party)) return [];
  return player.party.map((member) => member && member.vocation).filter(Boolean);
}

/**
 * Number of members currently on the party, at least 1. Legacy/absent party
 * data resolves to a single-member party so the campaign balance curve is a
 * no-op for pre-party saves.
 * @param {object} player
 * @returns {number}
 */
export function partySize(player) {
  if (player && Array.isArray(player.party) && player.party.length > 0) {
    return player.party.length;
  }
  return 1;
}

/**
 * Copies the authoritative top-level active state into the active member entry.
 * No-op when there is no active member. Mutates and returns the member.
 * @param {object} player
 * @returns {object|null}
 */
export function captureActiveMember(player) {
  if (!player || typeof player !== 'object') return null;
  const idx = activeMemberIndex(player);
  if (idx < 0) return null;
  const member = player.party[idx];
  for (const [key, value] of Object.entries(player)) {
    if (MEMBER_EXCLUDED_KEYS.has(key)) continue;
    member[key] = clone(value);
  }
  return member;
}

/**
 * Copies a member's state onto the top-level player and marks it active.
 * Mutates and returns the player.
 * @param {object} player
 * @param {object} member
 * @returns {object}
 */
export function applyActiveMember(player, member) {
  if (!player || !member || typeof member !== 'object') return player;
  for (const [key, value] of Object.entries(member)) {
    if (MEMBER_EXCLUDED_KEYS.has(key)) continue;
    player[key] = clone(value);
  }
  player.vocation = member.vocation || player.vocation;
  player.activeMemberId = member.memberId || player.activeMemberId;
  return player;
}

/**
 * Switches the live member to `memberId`, capturing the outgoing member first.
 * Returns the player unchanged when the id is not on the party.
 * @param {object} player
 * @param {string} memberId
 * @returns {object}
 */
export function setActiveMember(player, memberId) {
  if (!player || !Array.isArray(player.party)) return player;
  const target = player.party.find((m) => m && m.memberId === memberId);
  if (!target) return player;
  captureActiveMember(player);
  player.activeMemberId = target.memberId;
  applyActiveMember(player, target);
  return player;
}

/**
 * Cycles which party member the player controls (LIV-27 / FIX-12). `direction`
 * +1 selects the next living member in party order, any negative value the
 * previous one; the search wraps. Downed members are skipped so control never
 * lands on a corpse, and the active member's own mirror is never re-selected.
 * Every other member keeps its `aiMode` (`auto` by default) and stays driven by
 * the `party_ai.json` profiles, so no AI bookkeeping is needed here.
 *
 * Returns the newly active member, or null when control did not move (no party,
 * fewer than two members, or no other member is alive). Mutates and returns the
 * player through `setActiveMember`.
 * @param {object} player
 * @param {number} [direction=1]
 * @returns {object|null}
 */
export function cycleActiveMember(player, direction = 1) {
  if (!player || !Array.isArray(player.party) || player.party.length < 2) return null;
  const count = player.party.length;
  const current = activeMemberIndex(player);
  if (current < 0) return null;
  const step = Number(direction) < 0 ? -1 : 1;
  for (let offset = 1; offset < count; offset++) {
    const idx = (((current + step * offset) % count) + count) % count;
    const member = player.party[idx];
    if (!member || member.hp <= 0 || !member.memberId) continue;
    setActiveMember(player, member.memberId);
    return member;
  }
  return null;
}

/**
 * Creates the default campaign progress: no towers completed and only the first
 * tower in campaign order unlocked.
 * @returns {{ completedTowerIds: string[], unlockedTowerIds: string[] }}
 */
export function createTowerProgress() {
  return { completedTowerIds: [], unlockedTowerIds: [firstTowerId()] };
}

/**
 * Normalizes campaign progress: filters to authored tower ids, always keeps the
 * first tower unlocked, and re-derives unlocks from completed towers using each
 * tower's catalog `unlockRequires`. Returns the original reference when clean.
 * @param {object|null} progress
 * @returns {{ completedTowerIds: string[], unlockedTowerIds: string[] }}
 */
export function normalizeTowerProgress(progress) {
  const source = progress && typeof progress === 'object' ? progress : {};
  const completed = uniqueTowerIds(source.completedTowerIds);

  const unlockedSet = new Set(uniqueTowerIds(source.unlockedTowerIds));
  unlockedSet.add(firstTowerId());
  for (const id of completed) unlockedSet.add(id);
  for (const towerId of authoredTowerIds()) {
    const requires = towerUnlockRequires(towerId);
    if (requires.every((req) => completed.includes(req))) unlockedSet.add(towerId);
  }
  const unlocked = authoredTowerIds().filter((id) => unlockedSet.has(id));

  const clean = progress
    && Array.isArray(progress.completedTowerIds)
    && Array.isArray(progress.unlockedTowerIds)
    && progress.completedTowerIds.length === completed.length
    && progress.unlockedTowerIds.length === unlocked.length
    && progress.completedTowerIds.every((id, i) => id === completed[i])
    && progress.unlockedTowerIds.every((id, i) => id === unlocked[i]);
  if (clean) return progress;
  return { completedTowerIds: completed, unlockedTowerIds: unlocked };
}

/** True when `towerId` is currently unlocked in `progress`. */
export function isTowerUnlocked(progress, towerId) {
  return normalizeTowerProgress(progress).unlockedTowerIds.includes(towerId);
}

/** True when every authored tower is completed. */
export function allTowersCompleted(progress) {
  const ids = authoredTowerIds();
  if (ids.length === 0) return false;
  const completed = normalizeTowerProgress(progress).completedTowerIds;
  return ids.every((id) => completed.includes(id));
}

/**
 * Records a tower as completed and unlocks whatever `unlockRequires` reference
 * it. Idempotent.
 * @param {object|null} progress
 * @param {string} towerId
 * @returns {object}
 */
export function completeTower(progress, towerId) {
  const normalized = normalizeTowerProgress(progress);
  if (!isTowerId(towerId)) return normalized;
  if (!normalized.completedTowerIds.includes(towerId)) {
    normalized.completedTowerIds.push(towerId);
  }
  return normalizeTowerProgress(normalized);
}

/**
 * Idempotently migrates a persisted player onto the party model:
 *   - a valid party is normalized in place (identity/meta backfilled, active id
 *     repaired, `towerProgress` filled);
 *   - a legacy single-character save is wrapped into a one-member party with the
 *     top-level state preserved exactly (level, xp, inventory, gold, keys,
 *     spring charges, ...);
 *   - `towerProgress` is initialized with only the first tower unlocked.
 *
 * Returns the original reference when no field needs changing.
 * @param {object|null} player
 * @returns {object|null}
 */
export function migratePlayerParty(player) {
  if (!player || typeof player !== 'object') return player;

  const rawParty = Array.isArray(player.party) ? player.party : null;
  const members = [];
  let membersChanged = false;
  if (rawParty) {
    for (const raw of rawParty) {
      const normalized = normalizeMember(raw);
      if (normalized) {
        members.push(normalized);
        if (normalized !== raw) membersChanged = true;
      } else {
        membersChanged = true;
      }
    }
  }

  const progress = normalizeTowerProgress(player.towerProgress);
  const progressChanged = progress !== player.towerProgress;

  if (members.length > 0) {
    let activeId = player.activeMemberId;
    if (!members.some((m) => m.memberId === activeId)) activeId = null;
    if (!activeId) {
      const byVocation = members.find((m) => m.vocation === player.vocation);
      activeId = (byVocation || members[0]).memberId;
    }
    const activeIdChanged = activeId !== player.activeMemberId;
    // Fold any legacy per-member backpack/hotbar into the shared party stash
    // (LIV-22) and strip the per-member copies.
    const inventoryChanged = consolidateSharedInventory(player, members, activeId);
    if (!membersChanged && !progressChanged && !activeIdChanged && !inventoryChanged) return player;
    return { ...player, party: members, activeMemberId: activeId, towerProgress: progress };
  }

  // Legacy single-character save: wrap the top-level player into a 1-member party.
  const vocation = normalizeVocation(player.vocation) || 'magician';
  const member = createPartyMember(vocation);
  for (const [key, value] of Object.entries(player)) {
    if (MEMBER_EXCLUDED_KEYS.has(key)) continue;
    member[key] = clone(value);
  }
  const result = {
    ...player,
    vocation,
    party: [member],
    activeMemberId: member.memberId,
    towerProgress: progress,
  };
  // Normalize the shared containers (LIV-22) so a rerun is an idempotent no-op.
  consolidateSharedInventory(result, result.party, member.memberId);
  return result;
}

/**
 * A fresh, fully initialized campaign player (party + towerProgress) for a new
 * game or the title-screen fallback.
 * @param {string} [vocation]
 * @param {string} [id]
 * @returns {object}
 */
export function createPartyPlayer(vocation = 'magician', id = null) {
  return migratePlayerParty({ ...createPlayer(vocation, id), vocation: normalizeVocation(vocation) || 'magician' });
}
