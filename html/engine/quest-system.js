/**
 * Lokarta: Come Into The Light - Quest System (browser-free)
 *
 * Pure, side-effect-light quest state machine for the LIV-58 Island 1 quest
 * chain. Everything is data-driven through `html/data/quests.json`: objective
 * kinds and reward kinds resolve through the dispatch tables below, so a new
 * quest is catalog data plus (only if it introduces a genuinely new mechanic) a
 * handler function — never a per-quest branch (LIV-55 §5, agents.md §2).
 *
 * The module owns no DOM, no canvas, and no storage. `player.questState` and
 * `player.worldFlags` ride the character envelope (see `party.js`), so quest
 * progress persists per slot with the rest of the save.
 */

import {
  QUESTS_CATALOG,
  ITEMS_CATALOG,
  getQuestDefinition,
  listQuestDefinitions,
} from '../data/index.js';
import { ProgressionSystem } from './progression-system.js';
import { EconomySystem } from './economy-system.js';
import { InventorySystem } from './inventory-system.js';

/** Quest lifecycle. `inactive -> active -> complete -> turned_in`. */
export const QUEST_STATUS = Object.freeze({
  INACTIVE: 'inactive',
  ACTIVE: 'active',
  COMPLETE: 'complete',
  TURNED_IN: 'turned_in',
});

const VALID_STATUS = new Set(Object.values(QUEST_STATUS));

/** A fresh, empty quest state for a new save. */
export function createQuestState() {
  return { version: 1, quests: {} };
}

/** A fresh, empty world-flag bag for a new save. */
export function createWorldFlags() {
  return {};
}

/**
 * Normalizes a persisted quest state: filters to authored quest ids, drops
 * unknown statuses, and clamps objective counters to their catalog `count`.
 * Returns the original reference when already clean (idempotent migration).
 * @param {object|null} state
 * @returns {{ version: number, quests: Record<string, object> }}
 */
export function normalizeQuestState(state) {
  const normalized = { version: 1, quests: {} };
  const sourceQuests = state && typeof state === 'object' && state.quests && typeof state.quests === 'object'
    ? state.quests
    : {};
  for (const [questId, entry] of Object.entries(sourceQuests)) {
    const def = getQuestDefinition(questId);
    if (!def || !entry || !VALID_STATUS.has(entry.status)) continue;
    const objectives = {};
    for (const obj of def.objectives || []) {
      const target = Math.max(1, Number(obj.count) || 1);
      const raw = Number(entry.objectives ? entry.objectives[obj.id] : 0) || 0;
      objectives[obj.id] = Math.max(0, Math.min(raw, target));
    }
    normalized.quests[questId] = { status: entry.status, objectives };
  }
  if (state && typeof state === 'object' && JSON.stringify(state) === JSON.stringify(normalized)) {
    return state;
  }
  return normalized;
}

/** Normalizes a world-flag bag to a plain object (same ref when already one). */
export function normalizeWorldFlags(flags) {
  if (flags && typeof flags === 'object' && !Array.isArray(flags)) return flags;
  return {};
}

/**
 * Idempotently guarantees `player.questState` / `player.worldFlags` exist and
 * are normalized. Mutates the player and returns it.
 * @param {object} player
 * @returns {object}
 */
export function ensureQuestState(player) {
  if (!player || typeof player !== 'object') return player;
  const questState = normalizeQuestState(player.questState);
  const worldFlags = normalizeWorldFlags(player.worldFlags);
  if (questState !== player.questState) player.questState = questState;
  if (worldFlags !== player.worldFlags) player.worldFlags = worldFlags;
  return player;
}

/** Current status of `questId` (`inactive` when untouched/unknown). */
export function getQuestStatus(state, questId) {
  const entry = state && state.quests ? state.quests[questId] : null;
  return entry && VALID_STATUS.has(entry.status) ? entry.status : QUEST_STATUS.INACTIVE;
}

/** Recorded count for one objective, or 0. */
export function getObjectiveCount(state, questId, objectiveId) {
  const entry = state && state.quests ? state.quests[questId] : null;
  return Number(entry?.objectives?.[objectiveId]) || 0;
}

export function isQuestActive(state, questId) {
  return getQuestStatus(state, questId) === QUEST_STATUS.ACTIVE;
}

export function isQuestTurnedIn(state, questId) {
  return getQuestStatus(state, questId) === QUEST_STATUS.TURNED_IN;
}

/** True when every objective of `questDef` has reached its catalog count. */
export function areAllObjectivesComplete(state, questDef) {
  if (!questDef || !Array.isArray(questDef.objectives)) return false;
  return questDef.objectives.every((obj) => {
    const target = Math.max(1, Number(obj.count) || 1);
    return getObjectiveCount(state, questDef.id, obj.id) >= target;
  });
}

/** Every `prerequisites` quest has been turned in. */
export function prerequisitesMet(state, questDef) {
  const reqs = Array.isArray(questDef?.prerequisites) ? questDef.prerequisites : [];
  return reqs.every((id) => isQuestTurnedIn(state, id));
}

/** `levelGuard.minLevel` satisfied (no guard => always true). */
export function levelGuardMet(player, questDef) {
  const guard = questDef?.levelGuard;
  if (!guard || guard.minLevel == null) return true;
  return (Number(player?.level) || 1) >= Number(guard.minLevel);
}

/**
 * Whether `questId` can be offered to the player right now.
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function canAcceptQuest(state, player, questId) {
  const def = getQuestDefinition(questId);
  if (!def) return { ok: false, reason: 'unknown_quest' };
  const status = getQuestStatus(state, questId);
  if (status !== QUEST_STATUS.INACTIVE) return { ok: false, reason: 'already_started' };
  if (!prerequisitesMet(state, def)) return { ok: false, reason: 'prerequisites' };
  if (!levelGuardMet(player, def)) return { ok: false, reason: 'level_guard' };
  return { ok: true, reason: null };
}

/**
 * Accepts a quest, initializing every objective counter to zero. Idempotent:
 * a quest already active/complete/turned_in is left untouched.
 * @returns {{ ok: boolean, reason: string|null, questId: string, status: string }}
 */
export function acceptQuest(state, player, questId) {
  ensureQuestState(player);
  const check = canAcceptQuest(state, player, questId);
  if (!check.ok) {
    return { ok: false, reason: check.reason, questId, status: getQuestStatus(state, questId) };
  }
  const def = getQuestDefinition(questId);
  const objectives = {};
  for (const obj of def.objectives || []) objectives[obj.id] = 0;
  state.quests[questId] = { status: QUEST_STATUS.ACTIVE, objectives };
  return { ok: true, reason: null, questId, status: QUEST_STATUS.ACTIVE };
}

/** True when the quest exists and is `complete` (ready to hand in). */
export function canTurnIn(state, questId) {
  return getQuestStatus(state, questId) === QUEST_STATUS.COMPLETE;
}

/**
 * Objective-kind dispatch table. A handler receives the objective definition
 * and a game event and returns the amount to advance (0 = no match).
 * Catalog `type` values: talk|kill|fetch|reach|interact.
 */
export const OBJECTIVE_HANDLERS = {
  kill: (obj, event) => (
    event.type === 'kill' && event.monsterType === obj.targetMonsterType
      ? (Number(event.quantity) || 1)
      : 0
  ),
  talk: (obj, event) => (
    event.type === 'talk' && event.npcId === obj.targetNpcId ? 1 : 0
  ),
  fetch: (obj, event) => (
    event.type === 'fetch' && event.itemId === obj.itemId
      ? (Number(event.quantity) || 1)
      : 0
  ),
  reach: (obj, event) => {
    if (event.type !== 'reach' || event.sceneId !== obj.sceneId) return 0;
    const radius = Math.max(0, Number(obj.radius) || 0);
    return Math.abs((Number(event.x) || 0) - obj.x) <= radius
      && Math.abs((Number(event.y) || 0) - obj.y) <= radius
      ? 1
      : 0;
  },
  interact: (obj, event) => (
    event.type === 'interact' && event.targetId === obj.targetId ? 1 : 0
  ),
};

/**
 * Feeds one game event to every active quest. Advances matching objective
 * counters (clamped to the catalog count) and flips a quest to `complete` the
 * moment all its objectives are satisfied. Mutates `state` in place.
 * @returns {object[]} change records for HUD cues / logging
 */
export function recordEvent(state, event) {
  const changes = [];
  if (!state || !event || !state.quests) return changes;
  for (const [questId, entry] of Object.entries(state.quests)) {
    if (!entry || entry.status !== QUEST_STATUS.ACTIVE) continue;
    const def = getQuestDefinition(questId);
    if (!def) continue;
    let changed = false;
    for (const obj of def.objectives || []) {
      const target = Math.max(1, Number(obj.count) || 1);
      const current = Number(entry.objectives[obj.id]) || 0;
      if (current >= target) continue;
      const handler = OBJECTIVE_HANDLERS[obj.type];
      if (!handler) continue;
      const amount = handler(obj, event);
      if (!amount) continue;
      const next = Math.min(target, current + amount);
      if (next === current) continue;
      entry.objectives[obj.id] = next;
      changed = true;
      changes.push({
        questId,
        questName: def.name,
        objectiveId: obj.id,
        count: next,
        target,
        logKey: obj.logKey,
      });
    }
    if (changed && entry.status === QUEST_STATUS.ACTIVE && areAllObjectivesComplete(state, def)) {
      entry.status = QUEST_STATUS.COMPLETE;
      changes.push({ questId, questName: def.name, completed: true, status: QUEST_STATUS.COMPLETE });
    }
  }
  return changes;
}

/**
 * Reward-kind dispatch table. Each handler mutates the player and returns a
 * small descriptor for logging/tests. Catalog `type` values:
 * xp|gold|item|unlock_tower|set_flag.
 */
export const REWARD_HANDLERS = {
  xp: (player, reward) => {
    const amount = Number(reward.amount) || 0;
    const res = ProgressionSystem.awardXP(player, amount);
    return { type: 'xp', amount, leveledUp: res.leveledUp, newLevel: res.newLevel };
  },
  gold: (player, reward) => {
    const gained = EconomySystem.addGold(player, Number(reward.amount) || 0);
    return { type: 'gold', amount: gained };
  },
  item: (player, reward) => {
    // `vocationItems` is a data-only selector: grant the active member's
    // vocation variant, falling back to `itemId`. No per-quest JS branch.
    const vocation = player?.vocation;
    const itemId = (reward.vocationItems && vocation && reward.vocationItems[vocation]) || reward.itemId;
    const entry = ITEMS_CATALOG[itemId];
    if (!entry) return { type: 'item', itemId, success: false, missing: true };
    const res = InventorySystem.addItem(player, {
      ...entry,
      item_id: entry.item_id || itemId,
      quantity: Number(reward.quantity) || 1,
    });
    return { type: 'item', itemId, name: entry.name, success: res.success };
  },
  set_flag: (player, reward) => {
    player.worldFlags = normalizeWorldFlags(player.worldFlags);
    player.worldFlags[reward.flag] = reward.value === undefined ? true : reward.value;
    return { type: 'set_flag', flag: reward.flag, value: player.worldFlags[reward.flag] };
  },
  unlock_tower: (player, reward) => {
    if (!player.towerProgress || !Array.isArray(player.towerProgress.unlockedTowerIds)) {
      player.towerProgress = { completedTowerIds: [], unlockedTowerIds: [] };
    }
    if (!player.towerProgress.unlockedTowerIds.includes(reward.towerId)) {
      player.towerProgress.unlockedTowerIds.push(reward.towerId);
    }
    return { type: 'unlock_tower', towerId: reward.towerId };
  },
};

/**
 * Applies every reward of `questDef` through the reward dispatch table.
 * @returns {object[]} applied effect descriptors
 */
export function applyRewards(player, questDef) {
  const effects = [];
  ensureQuestState(player);
  for (const reward of questDef?.rewards || []) {
    const handler = REWARD_HANDLERS[reward.type];
    if (!handler) continue;
    const effect = handler(player, reward, questDef);
    if (effect) effects.push(effect);
  }
  return effects;
}

/**
 * Turns in a completed quest and grants its rewards. Idempotent: replaying a
 * turned-in quest grants nothing and reports `alreadyTurnedIn`.
 * @returns {{ ok: boolean, questId: string, rewards: object[], alreadyTurnedIn?: boolean }}
 */
export function turnInQuest(state, player, questId) {
  ensureQuestState(player);
  const entry = state && state.quests ? state.quests[questId] : null;
  if (!entry || entry.status === QUEST_STATUS.TURNED_IN) {
    return { ok: false, questId, rewards: [], alreadyTurnedIn: true };
  }
  if (entry.status !== QUEST_STATUS.COMPLETE) {
    return { ok: false, questId, rewards: [], reason: 'objectives_incomplete' };
  }
  entry.status = QUEST_STATUS.TURNED_IN;
  const rewards = applyRewards(player, getQuestDefinition(questId));
  return { ok: true, questId, rewards };
}

/**
 * Snapshot the dialogue condition evaluator reads: per-quest status, world
 * flags, and the player's level. Pure and allocation-bounded (one object per
 * dialogue open, not per tick).
 */
export function dialogueSnapshot(state, player) {
  const quests = {};
  for (const quest of listQuestDefinitions()) quests[quest.id] = getQuestStatus(state, quest.id);
  return { quests, flags: normalizeWorldFlags(player?.worldFlags), level: Number(player?.level) || 1 };
}

/** Evaluates one dialogue stage `when` clause against a snapshot. */
export function whenMatches(when, snapshot) {
  if (!when || typeof when !== 'object') return true;
  if (when.questId && (!snapshot.quests || snapshot.quests[when.questId] !== when.status)) return false;
  if (when.flag && !(snapshot.flags && snapshot.flags[when.flag])) return false;
  if (when.levelMin != null && (Number(snapshot.level) || 1) < Number(when.levelMin)) return false;
  return true;
}

/**
 * Plays the first stage whose `when` matches, else the stage named by the
 * dialogue's `fallback`, else the last stage. Returns null for a malformed tree.
 */
export function selectDialogueStage(dialogueDef, snapshot) {
  if (!dialogueDef || !Array.isArray(dialogueDef.stages) || dialogueDef.stages.length === 0) return null;
  for (const stage of dialogueDef.stages) {
    if (whenMatches(stage.when, snapshot)) return stage;
  }
  if (dialogueDef.fallback) {
    const fallback = dialogueDef.stages.find((stage) => stage.id === dialogueDef.fallback);
    if (fallback) return fallback;
  }
  return dialogueDef.stages[dialogueDef.stages.length - 1];
}

/**
 * Active/completed quests for the HUD log, with resolved objective rows.
 * @returns {object[]}
 */
export function questLogEntries(state) {
  const out = [];
  if (!state || !state.quests) return out;
  for (const [questId, entry] of Object.entries(state.quests)) {
    if (!entry || (entry.status !== QUEST_STATUS.ACTIVE && entry.status !== QUEST_STATUS.COMPLETE)) continue;
    const def = getQuestDefinition(questId);
    if (!def) continue;
    const objectives = (def.objectives || []).map((obj) => {
      const target = Math.max(1, Number(obj.count) || 1);
      const count = Number(entry.objectives?.[obj.id]) || 0;
      return {
        id: obj.id,
        logKey: obj.logKey,
        hintKey: obj.hintKey || null,
        count,
        target,
        done: count >= target,
      };
    });
    out.push({ questId, name: def.name, status: entry.status, objectives });
  }
  return out;
}

/** Convenience re-export for consumers that only need the raw catalog. */
export const QUESTS = QUESTS_CATALOG;
