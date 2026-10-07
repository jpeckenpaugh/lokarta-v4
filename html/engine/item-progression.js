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
import { EconomySystem } from './economy-system.js';

/**
 * Solo/legacy maximum item rank. The live cap scales with the party size
 * (FIX-13 / LIV-28) via `EconomySystem.maxRankForParty`; this constant remains
 * the fallback when no player/party is supplied.
 */
export const MAX_ITEM_RANK = 5;

/** Party-scaled rank cap for an optional owner, or the solo fallback. */
function rankCapFor(player) {
  return player ? EconomySystem.maxRankForParty(player) : MAX_ITEM_RANK;
}

/** Every slot an owned item may occupy. Paperdoll slots are visited first. */
const OWNED_SLOTS = ['main_hand', 'off_hand', 'armor', 'relic'];

/**
 * True when an item instance can be ranked up (owns an upgrade rule and is
 * below the rank cap). The cap scales with the party size of `player` when
 * supplied, otherwise it uses the solo `MAX_ITEM_RANK`.
 * @param {object|null} item
 * @param {object|number} [player] owner (or live party size) for the cap
 * @returns {boolean}
 */
export function canUpgradeItem(item, player) {
  if (!item || !item.item_id) return false;
  if (item.itemLevel >= rankCapFor(player)) return false;
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
 * @param {object|number} [opts.rankCapOwner] - party-bearing owner (or live party
 *   size) that resolves the rank cap when the acting `player` carries no `.party`
 *   (e.g. an auto ally borrowing the shared party's cap)
 * @returns {{ item: object, rank: number, notes: string[] }|null}
 */
export function applyItemRankUp(player, item, opts = {}) {
  const capOwner = opts.rankCapOwner || player;
  if (!player || !canUpgradeItem(item, capOwner)) return null;

  const catalogEntry = ITEMS_CATALOG[item.item_id] || {};
  const spec = catalogEntry.upgradeSpec || item.upgradeSpec || {};
  if (Object.keys(spec).length === 0) return null;

  const rng = opts.rng || null;
  const randomInt = (min, max) => {
    if (rng && typeof rng.randomInt === 'function') return rng.randomInt(min, max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  const prevRank = item.itemLevel || 1;
  item.itemLevel = Math.min(rankCapFor(capOwner), prevRank + 1);
  const rank = item.itemLevel;
  const notes = [];

  // Authored utility ceilings (FIX-15b). Catalog wins; a looted/hand-built
  // instance may carry its own `rankCaps`. A missing key is uncapped.
  const rankCaps = catalogEntry.rankCaps || item.rankCaps || {};
  const capFor = key => (typeof rankCaps[key] === 'number' ? rankCaps[key] : Infinity);

  /**
   * Applies a rank-scaled increment with an authored ceiling. The base stat is
   * recovered from the live instance field (subtracting the pre-rank capped
   * total) so the early ranks stay numerically identical to the former
   * incremental path while later ranks hold the ceiling instead of running away.
   */
  const applyCappedInc = (field, inc, capKey, fallback) => {
    const prevTotal = Math.min(inc * (prevRank - 1), capFor(capKey));
    const nextTotal = Math.min(inc * (rank - 1), capFor(capKey));
    const base = (typeof item[field] === 'number' ? item[field] : fallback) - prevTotal;
    item[field] = base + nextTotal;
  };

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
    applyCappedInc('range', spec.rangeInc, 'rangeInc', catalogEntry.range ?? 5);
    notes.push('+1 Range');
  }
  if (spec.manaCostInc) {
    applyCappedInc('manaCost', spec.manaCostInc, 'manaCostInc', catalogEntry.manaCost ?? 1);
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
    applyCappedInc('arrowCapacity', spec.arrowCapacityInc, 'arrowCapacityInc', 25);
    notes.push(`+${spec.arrowCapacityInc} Cap`);
  }
  if (spec.ammoRegenSecReduction) {
    const prevReduction = Math.min(spec.ammoRegenSecReduction * (prevRank - 1), capFor('ammoRegenSecReduction'));
    const nextReduction = Math.min(spec.ammoRegenSecReduction * (rank - 1), capFor('ammoRegenSecReduction'));
    const baseRegen = (typeof item.ammoRegenSec === 'number' ? item.ammoRegenSec : 5) + prevReduction;
    item.ammoRegenSec = Math.max(2.5, baseRegen - nextReduction);
    notes.push(`Regen ${item.ammoRegenSec.toFixed(1)}s`);
  }
  if (spec.dodgePctInc) {
    applyCappedInc('dodgePct', spec.dodgePctInc, 'dodgePctInc', 0);
    notes.push(`+${spec.dodgePctInc}% Dodge`);
  }
  if (spec.critChanceInc) {
    applyCappedInc('critChance', spec.critChanceInc, 'critChanceInc', 0);
    notes.push(`+${spec.critChanceInc}% Crit`);
  }
  if (spec.critMultInc) {
    applyCappedInc('critMult', spec.critMultInc, 'critMultInc', 0);
    notes.push(`+${spec.critMultInc.toFixed(2)} Crit Mult`);
  }
  if (spec.mitigationPctInc) {
    applyCappedInc('mitigationPct', spec.mitigationPctInc, 'mitigationPctInc', 0);
    notes.push(`+${spec.mitigationPctInc}% Mitig`);
  }
  if (spec.healPowerPctInc) {
    applyCappedInc('healPowerPct', spec.healPowerPctInc, 'healPowerPctInc', 0);
    notes.push(`+${spec.healPowerPctInc}% Heal`);
  }
  if (spec.stunInc) {
    applyCappedInc('stunSec', spec.stunInc, 'stunInc', 0);
    notes.push(`+${spec.stunInc.toFixed(1)}s Stun`);
  }
  if (spec.shieldAbsorbInc) {
    applyCappedInc('shieldAbsorb', spec.shieldAbsorbInc, 'shieldAbsorbInc', 0);
    notes.push(`+${spec.shieldAbsorbInc} Absorb`);
  }
  if (spec.shieldDurationInc) {
    applyCappedInc('shieldDuration', spec.shieldDurationInc, 'shieldDurationInc', 0);
    notes.push(`+${spec.shieldDurationInc}s Bubble`);
  }
  if (spec.shieldManaCostReduction) {
    notes.push(`-${spec.shieldManaCostReduction} MP`);
  }
  if (spec.cooldownReductionSec) {
    item.cooldownReductionSec = Math.min(spec.cooldownReductionSec, capFor('cooldownReductionSec'));
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
    applyCappedInc('markDurationSec', spec.markDurationInc, 'markDurationInc', catalogEntry.markDurationSec ?? 6);
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
