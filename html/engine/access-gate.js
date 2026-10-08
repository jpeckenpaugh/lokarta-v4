/**
 * Lokarta: Come Into The Light - Access Gate
 *
 * Pure, browser-free evaluation of a data-driven `accessGate` declared on a
 * tower definition (`tower_levels.json`) and of an overworld scene gate
 * (`islands.json`/`towns.json` `gates[]`). The persistent **source of truth**
 * for a tower remains `player.towerProgress.unlockedTowerIds`: the quest system
 * writes it via the `unlock_tower` reward, and the legacy migration backfills
 * it so veteran saves stay unlocked. The `accessGate` declaration adds a second
 * data-authored path (quest turned in / world flag / required item + level)
 * plus a catalog denial hint, and is consulted at **every** entry point — the
 * island Tide Gate and the worker `handleSelectTower` — so a locked tower can
 * never be entered by bypassing the picker (LIV-55 D7, agents.md §2).
 *
 * No DOM, no canvas, no storage, no per-tower JS branches.
 */

import { getTowerDefinition, isTowerId } from '../data/index.js';
import { isTowerUnlocked } from './party.js';
import { getQuestStatus, normalizeWorldFlags, QUEST_STATUS } from './quest-system.js';

/** True when any party container holds at least one of `itemId`. */
function playerHasItem(player, itemId) {
  if (!player || !itemId) return false;
  const containers = [player.action_bar, player.backpack];
  const paperdoll = player.paperdoll || {};
  for (const slot of Object.values(paperdoll)) if (slot) containers.push([slot]);
  for (const list of containers) {
    if (!Array.isArray(list)) continue;
    for (const slot of list) {
      if (slot && slot.item_id === itemId && (Number(slot.quantity) || 1) > 0) return true;
    }
  }
  return false;
}

/** Quest lifecycle state a `kind: 'quest'` access gate can require. */
const DEFAULT_GATE_STATE = QUEST_STATUS.TURNED_IN;

/**
 * Evaluates a tower's `accessGate` against the live player. Returns
 * `{ towerId, unlocked, reason, hintKey }`:
 *   - `unlocked: true` when `towerProgress.unlockedTowerIds` already holds the
 *     tower (source of truth), or the gate's flag/quest clause is satisfied;
 *   - otherwise `unlocked: false` with a machine `reason` and the catalog
 *     `deniedHintKey` for the prompt copy.
 *
 * @param {object} player
 * @param {string} towerId
 * @returns {{ towerId: string, unlocked: boolean, reason: string|null, hintKey: string|null }}
 */
export function evaluateTowerAccess(player, towerId) {
  if (!isTowerId(towerId)) {
    return { towerId, unlocked: false, reason: 'unknown_tower', hintKey: null };
  }
  // Source of truth first: an explicit unlock (quest reward, legacy backfill,
  // or the completed-tower chain) always opens the gate.
  if (isTowerUnlocked(player?.towerProgress, towerId)) {
    return { towerId, unlocked: true, reason: null, hintKey: null };
  }
  const tower = getTowerDefinition(towerId);
  const gate = tower && tower.accessGate;
  if (!gate) {
    return { towerId, unlocked: false, reason: 'locked_chain', hintKey: null };
  }

  // Anti-soft-lock flag clause: a set world flag keeps the gate open even if an
  // authored required item is somehow lost.
  const flags = normalizeWorldFlags(player?.worldFlags);
  if (gate.flag && flags[gate.flag]) {
    return { towerId, unlocked: true, reason: null, hintKey: null };
  }
  if (gate.kind === 'quest' && gate.questId) {
    const questOk = getQuestStatus(player?.questState, gate.questId) === (gate.state || DEFAULT_GATE_STATE);
    const levelOk = gate.minLevel == null || (Number(player?.level) || 1) >= Number(gate.minLevel);
    const itemOk = !gate.requiredItem || playerHasItem(player, gate.requiredItem);
    if (questOk && levelOk && itemOk) {
      return { towerId, unlocked: true, reason: null, hintKey: null };
    }
  }
  return { towerId, unlocked: false, reason: 'access_gate', hintKey: gate.deniedHintKey || null };
}

/** Convenience boolean form of {@link evaluateTowerAccess}. */
export function isTowerAccessible(player, towerId) {
  return evaluateTowerAccess(player, towerId).unlocked;
}

/**
 * Evaluates an overworld scene gate (`islands.json`/`towns.json` `gates[]`)
 * against the live player. A gate with no `requireQuestId` is always open; a
 * gated one opens once the named quest is `turned_in`.
 *
 * @param {object} player
 * @param {object} gate
 * @returns {{ open: boolean, promptKey: string|null }}
 */
export function evaluateSceneGate(player, gate) {
  if (!gate || typeof gate !== 'object') return { open: false, promptKey: null };
  if (!gate.requireQuestId) return { open: true, promptKey: gate.openPromptKey || null };
  const open = getQuestStatus(player?.questState, gate.requireQuestId) === QUEST_STATUS.TURNED_IN;
  return { open, promptKey: (open ? gate.openPromptKey : gate.lockedPromptKey) || null };
}

/** The scene gate whose `tiles` include `(x, y)`, or null. */
export function sceneGateAt(scene, x, y) {
  const gates = scene && scene.gates;
  if (!Array.isArray(gates)) return null;
  for (const gate of gates) {
    if (!Array.isArray(gate.tiles)) continue;
    for (const tile of gate.tiles) {
      if (tile && tile[0] === x && tile[1] === y) return gate;
    }
  }
  return null;
}
