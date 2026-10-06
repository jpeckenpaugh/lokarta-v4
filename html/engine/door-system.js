/**
 * Lokarta: Come Into The Light - Key & Gated-Door Subsystem
 *
 * Runtime half of the key-gated progression authored in `doors.json` /
 * `tower_levels.json`: key holders grant their key when defeated, a granted key
 * opens the matching GATED_DOOR when the player walks onto it, and closed gates
 * block movement.
 *
 * Keys are tracked **per tower level** on `player.levelKeys`:
 *   { "1": { copper: true, silver: true, gold: true }, "2": { ... } }
 * so each level keeps its own three-key set and re-entering a cleared level
 * keeps the keys it earned. Keys are never inventory items.
 *
 * Pure and data-driven — every tier resolves through `DOORS_CATALOG[tier]
 * .keyItemId`, never a hardcoded copper/silver/gold list.
 */

import { DOORS_CATALOG, ITEMS_CATALOG } from '../data/index.js';
import { TILE_TYPES } from './config.js';

export class DoorSystem {
  /** Every authored gate tier, in catalog order (copper -> silver -> gold). */
  static tiers() {
    return Object.keys(DOORS_CATALOG || {});
  }

  /** Resolves the key item id that opens `tier`, or null when unauthored. */
  static keyItemForTier(tier) {
    return DOORS_CATALOG?.[tier]?.keyItemId || null;
  }

  /**
   * Builds the guaranteed key drop for a key-holding monster, resolving the
   * item definition from `items.json`. Returns null for ordinary monsters.
   * @param {{ holdsKey?: string|null }} monster
   * @returns {object|null} serializable key stack, or null
   */
  static keyDropForMonster(monster) {
    const tier = monster?.holdsKey;
    if (!tier) return null;
    const itemId = DoorSystem.keyItemForTier(tier);
    if (!itemId) return null;
    const def = ITEMS_CATALOG?.[itemId] || {};
    return {
      item_id: itemId,
      name: def.name || `${tier} Key`,
      type: def.type || 'key',
      pickupType: def.pickupType || 'key',
      keyTier: tier,
      quantity: 1,
      ...(def.icon ? { icon: def.icon } : {}),
      ...(def.svgCode ? { svgCode: def.svgCode } : {}),
      ...(def.maxStack !== undefined ? { maxStack: def.maxStack } : {}),
    };
  }

  /** Normalizes any level reference to its `levelKeys` string key. */
  static levelKeyFor(player, level) {
    const raw = level ?? player?.current_floor ?? 1;
    const n = Math.floor(Number(raw));
    return String(Number.isFinite(n) ? n : 1);
  }

  /**
   * True when the player has earned `tier` on `level` (defaults to the level
   * they are currently on). Keys are per-level and never consume.
   */
  static hasKey(player, tier, level = null) {
    if (!tier) return false;
    const key = DoorSystem.levelKeyFor(player, level);
    return player?.levelKeys?.[key]?.[tier] === true;
  }

  /**
   * Grants `tier` for `level` (defaults to the current floor). Idempotent.
   * @returns {boolean} true when the key was newly earned
   */
  static grantKey(player, level, tier) {
    if (!player || !tier) return false;
    const key = DoorSystem.levelKeyFor(player, level);
    if (!player.levelKeys) player.levelKeys = {};
    if (!player.levelKeys[key]) player.levelKeys[key] = {};
    if (player.levelKeys[key][tier] === true) return false;
    player.levelKeys[key][tier] = true;
    return true;
  }

  /** Every gate tier the player has earned on `level`. */
  static unlockedTiers(player, level = null) {
    return DoorSystem.tiers().filter(tier => DoorSystem.hasKey(player, tier, level));
  }

  /**
   * Opens every closed GATED_DOOR tile tagged with `tier`. One-shot when the
   * player walks onto a gate, so the O(W*H) scan never touches a per-tick loop.
   * @returns {number} count of tiles unlocked
   */
  static openTierGates(gridMap, tier) {
    if (!gridMap || !tier) return 0;
    let opened = 0;
    for (let y = 0; y < gridMap.height; y++) {
      const row = gridMap.tiles[y];
      for (let x = 0; x < gridMap.width; x++) {
        const tile = row[x];
        if (
          tile.gateTier === tier &&
          !tile.gateOpen &&
          tile.type === TILE_TYPES.GATED_DOOR
        ) {
          tile.gateOpen = true;
          opened += 1;
        }
      }
    }
    return opened;
  }

  /**
   * Reopens every gate whose key the player already earned on the active level.
   * Called on floor load so returning to a level cannot soft-lock behind an
   * already-earned key.
   * @returns {number} count of tiles unlocked
   */
  static syncPlayerGates(gridMap, player, level = null) {
    let opened = 0;
    for (const tier of DoorSystem.unlockedTiers(player, level)) {
      opened += DoorSystem.openTierGates(gridMap, tier);
    }
    return opened;
  }
}
