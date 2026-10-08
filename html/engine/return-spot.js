/**
 * Lokarta: Come Into The Light - Return Spot
 *
 * Pure, browser-free model for the town return teleporter (LIV-75): when the
 * player exits a tower to town, the tower + floor are remembered on the save
 * envelope so a walk-on spot near the town entrance can re-enter the same
 * tower/floor. Data-driven and side-effect free — no DOM, canvas, or storage.
 *
 * The record lives on the shared run envelope (`player.lastTowerExit`), never on
 * a party member, so it persists across member swaps and save/reload. An
 * unknown/absent tower or a non-finite floor resolves to `null`, which hides the
 * spot rather than letting it soft-lock the player.
 */

import { isTowerId, towerLevelCount } from '../data/index.js';

/** Save-envelope field holding the last-exited tower/floor record. */
export const RETURN_SPOT_KEY = 'lastTowerExit';

/** Clamp a floor onto `towerId`'s authored 1..levelCount range. */
function clampFloor(floorNumber, towerId) {
  const n = Math.floor(Number(floorNumber));
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(towerLevelCount(towerId), n));
}

/**
 * Remembers the tower + floor the player just exited to town. Mutates and
 * returns the record, or `null` when the input is invalid — a bad value is never
 * recorded, so it can never produce an unusable return spot.
 *
 * @param {object} player
 * @param {string} towerId
 * @param {number} floorNumber
 * @returns {{ towerId: string, floor: number }|null}
 */
export function setReturnSpot(player, towerId, floorNumber) {
  if (!player || typeof player !== 'object') return null;
  if (!isTowerId(towerId)) return null;
  const floor = clampFloor(floorNumber, towerId);
  if (floor === null) return null;
  const record = { towerId, floor };
  player[RETURN_SPOT_KEY] = record;
  return record;
}

/**
 * The remembered tower/floor, or `null` when absent or invalid. Never throws;
 * an unknown tower id or non-finite floor is treated as "no return spot".
 *
 * @param {object|null} player
 * @returns {{ towerId: string, floor: number }|null}
 */
export function resolveReturnSpot(player) {
  const record = player && player[RETURN_SPOT_KEY];
  if (!record || typeof record !== 'object') return null;
  if (!isTowerId(record.towerId)) return null;
  const floor = clampFloor(record.floor, record.towerId);
  if (floor === null) return null;
  return { towerId: record.towerId, floor };
}

/**
 * Clears the remembered exit so the town return spot disappears (used when the
 * tower becomes invalid/locked — never a soft-lock). Mutates and returns the
 * player.
 *
 * @param {object|null} player
 * @returns {object|null}
 */
export function clearReturnSpot(player) {
  if (player && typeof player === 'object') delete player[RETURN_SPOT_KEY];
  return player;
}
