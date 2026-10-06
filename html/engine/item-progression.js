/**
 * Lokarta: Come Into The Light - Item Rank-Up Helper
 *
 * Single source of truth for the "grant an item the player already owns"
 * path used by chest loot, fate drafts, and any future reward channel.
 *
 * Ownership is resolved by `item_id` with an `actionKey` fallback (a Golden
 * weapon variant can share another entry's action), and the rank escalation
 * itself is data-driven: every stat delta comes from the catalog item's
 * `upgradeSpec`, mirroring the FateGrant LEVEL UP path. The one shared helper
 * replaces the former private `applyDraftedCards` logic so chest loot, drafts,
 * and tests cannot drift apart.
 *
 * Pure: no DOM, worker, or storage I/O, so the native Node test runner can
 * exercise it directly.
 */

import { ITEMS_CATALOG } from '../data/index.js';

/** Maximum rank any item can reach (matches the fate-grant LEVEL UP cap). */
export const MAX_ITEM_RANK = 5;

/** Every slot an owned item may occupy. Paperdoll slots are visited first. */
const OWNED_SLOTS = ['main_hand', 'off_hand', 'armor', 'relic'];

/**
 * True when an item instance can be ranked up (owns an upgrade rule and is
 * below the rank cap).
 * @param {object|null} item
 * @returns {boolean}
 */
export function canUpgradeItem(item) {
  if (!item || !item.item_id) return false;
  if (item.itemLevel >= MAX_ITEM_RANK) return false;
  const spec = ITEMS_CATALOG[item.item_id]?.upgradeSpec || item.upgradeSpec;
  return Boolean(spec && Object.keys(spec).length > 0);
}

/**
 * Finds the player's owned instance of the item carried by a loot stack or
 * card. Matches by `item_id` first, then by shared `actionKey` so a Golden
 * variant found in a chest ranks up the equipped base weapon. Paperdoll slots
 * are searched before the action bar/backpack so an equipped copy wins.
 *
 * @param {object} player
 * @param {object} item - loot stack or card item payload
 * @returns {object|null} the owned instance, or null
 */
export function findOwnedItem(player, item) {
  if (!player || !item) return null;
  const itemId = item.item_id;
  const actionKey = item.actionKey || ITEMS_CATALOG[itemId]?.actionKey;

  const paperdoll = player.paperdoll || {};
  const candidates = [
    ...OWNED_SLOTS.map(slot => paperdoll[slot]),
    ...(player.action_bar || []),
    ...(player.backpack || []),
  ];

  const byId = candidates.find(candidate => candidate && candidate.item_id === itemId);
  if (byId) return byId;
  if (!actionKey) return null;
  return candidates.find(candidate => {
    if (!candidate) return false;
    const candidateAction = candidate.actionKey || ITEMS_CATALOG[candidate.item_id]?.actionKey;
    return candidateAction === actionKey;
  }) || null;
}

/**
 * Applies one rank-up to an owned item using the catalog `upgradeSpec`.
 *
 * Returns null (no mutation) when the item cannot rank up or no spec exists.
 * Otherwise the item's `itemLevel` increases by one and every authored stat
 * delta is applied. The optional `rng` only feeds variable deltas
 * (`randomDamageInc`); pass a seeded PRNG for deterministic tests.
 *
 * @param {object} player - owner (for Max HP/MP escalations)
 * @param {object} item - the owned instance to rank up
 * @param {object} [opts]
 * @param {Function} [opts.rng] - random source with `.random()`/`.randomInt()`
 * @param {number} [opts.upgradeDmgInc] - pre-rolled damage increment to honor
 *   (fate cards roll this when the offer is generated, then re-apply it here)
 * @param {string} [opts.source] - free-text origin recorded on the display label
 * @returns {{ item: object, rank: number, notes: string[] }|null}
 */
export function applyItemRankUp(player, item, opts = {}) {
  if (!player || !canUpgradeItem(item)) return null;

  const catalogEntry = ITEMS_CATALOG[item.item_id] || {};
  const spec = catalogEntry.upgradeSpec || item.upgradeSpec || {};
  if (Object.keys(spec).length === 0) return null;

  const rng = opts.rng || null;
  const randomInt = (min, max) => {
    if (rng && typeof rng.randomInt === 'function') return rng.randomInt(min, max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  const prevRank = item.itemLevel || 1;
  item.itemLevel = Math.min(MAX_ITEM_RANK, prevRank + 1);
  const rank = item.itemLevel;
  const notes = [];

  // --- Offense escalations (weapons / staff / wand) ---
  if (spec.randomDamageInc) {
    const [min, max] = spec.randomDamageInc;
    const dmgInc = (typeof opts.upgradeDmgInc === 'number' && opts.upgradeDmgInc > 0)
      ? opts.upgradeDmgInc
      : randomInt(min, max);
    if (dmgInc) item.damage = (item.damage || catalogEntry.damageMin || 12) + dmgInc;
    notes.push(`+${dmgInc || 0} Dmg`);
  }
  if (spec.stepDamageInc) {
    item.stepDamageBonus = (item.stepDamageBonus || 0) + spec.stepDamageInc;
    notes.push(`+${spec.stepDamageInc} Wave Dmg`);
  }
  if (spec.rangeInc) {
    item.range = (item.range || catalogEntry.range || 5) + spec.rangeInc;
    notes.push('+1 Range');
  }
  if (spec.manaCostInc) {
    item.manaCost = (item.manaCost || catalogEntry.manaCost || 1) + spec.manaCostInc;
    notes.push(`+${spec.manaCostInc} MP`);
  }

  // --- Stat escalations (equivalent on any slot) ---
  if (spec.maxHpInc) {
    player.max_hp = (player.max_hp || 100) + spec.maxHpInc;
    player.hp = Math.min(player.max_hp, (player.hp || 100) + spec.maxHpInc);
    notes.push(`+${spec.maxHpInc} Max HP`);
  }
  if (spec.maxMpInc) {
    player.max_mana = (player.max_mana || 100) + spec.maxMpInc;
    player.mana = Math.min(player.max_mana, (player.mana || 100) + spec.maxMpInc);
    notes.push(`+${spec.maxMpInc} Max MP`);
  }
  if (spec.mpPulseInc) {
    const pulseSec = Math.max(12, 22 - 2 * rank);
    notes.push(`Pulse +${rank} MP / ${pulseSec}s`);
  }

  // --- Golden spec keys ---
  if (spec.arrowCapacityInc) {
    item.arrowCapacity = (item.arrowCapacity || 25) + spec.arrowCapacityInc;
    notes.push(`+${spec.arrowCapacityInc} Cap`);
  }
  if (spec.ammoRegenSecReduction) {
    item.ammoRegenSec = Math.max(2.5, (item.ammoRegenSec || 5) - spec.ammoRegenSecReduction);
    notes.push(`Regen ${item.ammoRegenSec.toFixed(1)}s`);
  }
  if (spec.dodgePctInc) {
    item.dodgePct = (item.dodgePct || 0) + spec.dodgePctInc;
    notes.push(`+${spec.dodgePctInc}% Dodge`);
  }
  if (spec.critChanceInc) {
    item.critChance = (item.critChance || 0) + spec.critChanceInc;
    notes.push(`+${spec.critChanceInc}% Crit`);
  }
  if (spec.critMultInc) {
    item.critMult = (item.critMult || 0) + spec.critMultInc;
    notes.push(`+${spec.critMultInc.toFixed(2)} Crit Mult`);
  }
  if (spec.mitigationPctInc) {
    item.mitigationPct = (item.mitigationPct || 0) + spec.mitigationPctInc;
    notes.push(`+${spec.mitigationPctInc}% Mitig`);
  }
  if (spec.healPowerPctInc) {
    item.healPowerPct = (item.healPowerPct || 0) + spec.healPowerPctInc;
    notes.push(`+${spec.healPowerPctInc}% Heal`);
  }
  if (spec.stunInc) {
    item.stunSec = (item.stunSec || 0) + spec.stunInc;
    notes.push(`+${spec.stunInc.toFixed(1)}s Stun`);
  }
  if (spec.shieldAbsorbInc) {
    item.shieldAbsorb = (item.shieldAbsorb || 0) + spec.shieldAbsorbInc;
    notes.push(`+${spec.shieldAbsorbInc} Absorb`);
  }
  if (spec.shieldDurationInc) {
    item.shieldDuration = (item.shieldDuration || 0) + spec.shieldDurationInc;
    notes.push(`+${spec.shieldDurationInc}s Bubble`);
  }
  if (spec.shieldManaCostReduction) {
    notes.push(`-${spec.shieldManaCostReduction} MP`);
  }
  if (spec.cooldownReductionSec) {
    item.cooldownReductionSec = spec.cooldownReductionSec;
    notes.push(`-${spec.cooldownReductionSec}s CD`);
  }

  // --- Archer primary-item ability escalations ---
  if (spec.poisonDpsInc) {
    item.poisonDps = (item.poisonDps || catalogEntry.poisonDps || 2) + spec.poisonDpsInc;
    notes.push(`Poison +${spec.poisonDpsInc}/s`);
  }
  if (spec.siphonHpInc) {
    item.siphonHp = (item.siphonHp || catalogEntry.siphonHp || 5) + spec.siphonHpInc;
    notes.push(`+${spec.siphonHpInc} Siphon HP`);
  }
  if (spec.markDurationInc) {
    item.markDurationSec = (item.markDurationSec || catalogEntry.markDurationSec || 6) + spec.markDurationInc;
    notes.push(`+${spec.markDurationInc}s Mark`);
  }
  if (spec.rangedDamageBonusInc) {
    item.rangedDamageBonus = (item.rangedDamageBonus || catalogEntry.rangedDamageBonus || 0) + spec.rangedDamageBonusInc;
    notes.push(`+${spec.rangedDamageBonusInc} Ranged Dmg`);
  }

  return { item, rank, notes, source: opts.source || null };
}

/**
 * Builds the human-readable rank-up message used by combat logs and tests.
 * @param {object} result - return value of applyItemRankUp
 * @returns {string}
 */
export function formatRankUpMessage(result) {
  if (!result) return '';
  const notes = result.notes && result.notes.length ? ` (${result.notes.join(', ')})` : '';
  return `${result.item.name || result.item.item_id} leveled up to Rank ${result.rank}${notes}!`;
}
