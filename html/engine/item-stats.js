/**
 * Lokarta: Come Into The Light - Item Stat Projection
 *
 * Rank-scaled fields on `items.json` are authored as *per-rank increments*
 * (`upgradeSpec`) or as rank-1 baselines (`damageMin`/`damageMax`/`range`/
 * `manaCost`). This module projects an item instance at its current
 * `itemLevel` onto the concrete stats the combat/render code reads, so a
 * rank-5 weapon is strong regardless of whether its instance object was
 * assembled by the fate draft, a chest roll, or a save migration.
 *
 * It is the single place that knows how to derive rank-scaled numbers. The
 * combat system and the HUD both call it; neither re-implements the math.
 *
 * Pure: no DOM, worker, or storage I/O.
 */

import { ITEMS_CATALOG } from '../data/index.js';
import { CONFIG } from './config.js';

/** Creates a deterministic-enough uniform integer in [min,max] for projection. */
function averageInt(min, max) {
  return Math.round((min + max) / 2);
}

/**
 * Effective damage for a weapon/staff at its current rank.
 * Rank-1 weapons roll `damageMin`..`damageMax`; each rank adds the midpoint of
 * `upgradeSpec.randomDamageInc` (fixed specs contribute their exact delta).
 *
 * @param {object} item
 * @returns {number}
 */
export function getEffectiveDamage(item) {
  if (!item) return 0;
  const catalog = ITEMS_CATALOG[item.item_id] || {};
  const rank = Math.max(1, item.itemLevel || 1);
  const base =
    typeof item.damage === 'number'
      ? item.damage
      : (catalog.damageMin || 0);
  if (base === 0) return 0;

  const spec = catalog.upgradeSpec || item.upgradeSpec || {};
  let bonusPerRank = 0;
  if (spec.randomDamageInc) bonusPerRank = averageInt(spec.randomDamageInc[0], spec.randomDamageInc[1]);
  // `item.damage` already accumulates the precise rolled increments as the item
  // ranks up, so only project from the catalog when no concrete damage is set.
  if (typeof item.damage === 'number') return item.damage;
  if (spec.stepDamageInc) bonusPerRank += spec.stepDamageInc;
  return base + bonusPerRank * (rank - 1);
}

/**
 * Effective maximum range for a ranged/spell weapon at its current rank.
 * @param {object} item
 * @returns {number}
 */
export function getEffectiveRange(item) {
  if (!item) return 0;
  const catalog = ITEMS_CATALOG[item.item_id] || {};
  const rank = Math.max(1, item.itemLevel || 1);
  const base = typeof item.range === 'number' ? item.range : (catalog.range || 0);
  const spec = catalog.upgradeSpec || item.upgradeSpec || {};
  const perRank = typeof spec.rangeInc === 'number' ? spec.rangeInc : 0;
  return base + perRank * (rank - 1);
}

/**
 * Effective mana cost for an item's granted ability at its current rank.
 *
 * Two rank-scaled levers apply:
 *  - authored per-rank deltas: `manaCostInc` (weapons that intentionally get
 *    pricier as they rank) and `shieldManaCostReduction` (shields that get
 *    cheaper).
 *  - the Promoted-item rule: every promoted rank label above Rank 1
 *    lowers the consumed MP by 1. "Promoted label" = the `Rank N` an item
 *    gains through the upgrade/rank-up system (`itemLevel`). Rank 1 is
 *    unpromoted (discount 0); Rank 5 has four promotions (discount 4).
 *
 * Floored at 0 MP. Pure: no DOM/worker/storage I/O.
 *
 * @param {object} item
 * @returns {number}
 */
export function getEffectiveManaCost(item) {
  if (!item) return CONFIG.MAGICIAN_SPARK_MANA_COST;
  const catalog = ITEMS_CATALOG[item.item_id] || {};
  const rank = Math.max(1, item.itemLevel || 1);
  const base = typeof item.manaCost === 'number' ? item.manaCost : (catalog.manaCost || 0);
  const spec = catalog.upgradeSpec || item.upgradeSpec || {};
  const perRank = typeof spec.manaCostInc === 'number' ? spec.manaCostInc : 0;
  const shieldPerRank = typeof spec.shieldManaCostReduction === 'number' ? spec.shieldManaCostReduction : 0;
  const promotionDiscount = Math.max(0, rank - 1);
  return Math.max(0, base + (perRank - shieldPerRank) * (rank - 1) - promotionDiscount);
}

/**
 * Effective ability cooldown (seconds) for an item at its current rank:
 * the catalog cooldown shortened by `upgradeSpec.cooldownReductionSec` per
 * rank beyond 1, floored at 1s.
 *
 * @param {object} item
 * @param {number} [fallback=1.5]
 * @returns {number}
 */
export function getEffectiveCooldown(item, fallback = 1.5) {
  const catalog = ITEMS_CATALOG[item?.item_id] || {};
  const base = typeof item?.cooldown === 'number'
    ? item.cooldown
    : (typeof catalog.cooldown === 'number' ? catalog.cooldown : fallback);
  const rank = Math.max(1, item?.itemLevel || 1);
  const spec = catalog.upgradeSpec || item?.upgradeSpec || {};
  const perRank = typeof spec.cooldownReductionSec === 'number' ? spec.cooldownReductionSec : 0;
  return Math.max(1, base - perRank * (rank - 1));
}
