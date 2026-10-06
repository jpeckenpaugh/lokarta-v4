/**
 * Lokarta: Come Into The Light - Economy, Town & Recovery Subsystem
 *
 * Pure, dependency-free helpers for the Board overhaul:
 *   - gold drops from monsters + chests (item 6)
 *   - passive HP/MP recovery of ~1/10s (item 4)
 *   - healing springs with a charge gate (item 7)
 *   - town temple healing + shop purchase/upgrade (item 5)
 *
 * Every tunable originates in `html/data/economy.json` (no hardcoded constants)
 * and every lookup falls back gracefully. No DOM, worker, or storage I/O so the
 * native Node test runner can exercise it directly.
 */

import { ECONOMY_CATALOG, ITEMS_CATALOG, MONSTERS_CATALOG, UI_CATALOG } from '../data/index.js';

const DEFAULTS = {
  gold: { starting: 0, cap: 999999 },
  passiveRecovery: { intervalSec: 10, hpPerTick: 1, mpPerTick: 1 },
  springs: { hpPerSec: 5, mpPerSec: 5 },
  temple: { healCostPerHp: 1, healCostPerMp: 1, reviveAt: 'town_temple', reviveCostPct: 0 },
  // Shop tunables are catalog-owned (economy.json "shop"); no JS duplication.
};

function cfg(path, fallback) {
  const root = path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), ECONOMY_CATALOG);
  return root === undefined || root === null ? fallback : root;
}

/** Deterministic integer roll in [min, max] from a seeded rng. */
function rollInt(rng, min, max) {
  const lo = Number.isFinite(Number(min)) ? Math.floor(Number(min)) : 0;
  const hi = Number.isFinite(Number(max)) ? Math.floor(Number(max)) : lo;
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export class EconomySystem {
  static get startingGold() {
    return Number(cfg('gold.starting', DEFAULTS.gold.starting)) || 0;
  }

  static get goldCap() {
    return Number(cfg('gold.cap', DEFAULTS.gold.cap)) || DEFAULTS.gold.cap;
  }

  /**
   * Adds gold to a player, clamped to the catalog cap. Mutates `player.gold`.
   * @returns {number} the amount actually credited
   */
  static addGold(player, amount) {
    if (!player) return 0;
    const gain = Math.max(0, Math.floor(Number(amount) || 0));
    const before = Number(player.gold) || 0;
    player.gold = Math.min(EconomySystem.goldCap, before + gain);
    return player.gold - before;
  }

  /** Spends gold if affordable. Returns true when the purchase succeeded. */
  static spendGold(player, amount) {
    const cost = Math.max(0, Math.floor(Number(amount) || 0));
    if (!player || (Number(player.gold) || 0) < cost) return false;
    player.gold = (Number(player.gold) || 0) - cost;
    return true;
  }

  /**
   * Rolls the gold dropped by a defeated monster (item 6). Reads the per-type
   * range from `economy.monsterGold`, falling back to the monster catalog's
   * `baseXp`-derived range so an unauthored type still drops something.
   */
  static goldFromMonster(monster, rng = Math.random) {
    const type = monster?.type;
    const table = cfg('monsterGold', {});
    const range = (type && table && table[type]) || null;
    if (range) return rollInt(rng, range.min, range.max);
    const def = (type && MONSTERS_CATALOG[type]) || null;
    const base = def?.baseXp || 10;
    return rollInt(rng, Math.max(1, Math.floor(base * 0.15)), Math.max(2, Math.floor(base * 0.4)));
  }

  /** Rolls the gold contained in a chest by tier (item 6). */
  static goldFromChest(tier, rng = Math.random) {
    const table = cfg('chestGold', {});
    const range = tier && table && table[tier];
    if (!range) return 0;
    return rollInt(rng, range.min, range.max);
  }

  /** Passive recovery tunables (item 4). */
  static passiveRecovery() {
    const p = cfg('passiveRecovery', DEFAULTS.passiveRecovery);
    return {
      intervalSec: Number(p.intervalSec) || DEFAULTS.passiveRecovery.intervalSec,
      hpPerTick: Number(p.hpPerTick) || 0,
      mpPerTick: Number(p.mpPerTick) || 0,
    };
  }

  /**
   * Applies one passive-recovery tick. Returns the amount restored
   * `{ hp, mp }`. Never overheals.
   */
  static applyPassiveRecovery(player) {
    const { hpPerTick, mpPerTick } = EconomySystem.passiveRecovery();
    let hp = 0;
    let mp = 0;
    if (!player) return { hp, mp };
    if (player.hp < player.max_hp && hpPerTick > 0) {
      hp = Math.min(hpPerTick, player.max_hp - player.hp);
      player.hp += hp;
    }
    if (player.mana < player.max_mana && mpPerTick > 0) {
      mp = Math.min(mpPerTick, player.max_mana - player.mana);
      player.mana += mp;
    }
    return { hp, mp };
  }

  /** Healing-spring per-second regen tunables. */
  static springRegen() {
    const s = cfg('springs', DEFAULTS.springs);
    return {
      hpPerSec: Number(s.hpPerSec) || 0,
      mpPerSec: Number(s.mpPerSec) || 0,
    };
  }

  /**
   * True when an adjacent healing spring restores the whole party, not only the
   * member standing beside it. Catalog-driven via `economy.springs.healsParty`;
   * absent/true heals the party, explicit `false` keeps the legacy solo rule.
   */
  static springHealsParty() {
    const s = cfg('springs', DEFAULTS.springs);
    return s.healsParty !== false;
  }

  /**
   * Applies one second of adjacent-spring regeneration.
   * Restores up to `hpPerSec` / `mpPerSec`, never over max. Mutates the player
   * and returns the amount actually restored `{ hp, mp }`.
   */
  static applySpringRegen(player) {
    const { hpPerSec, mpPerSec } = EconomySystem.springRegen();
    let hp = 0;
    let mp = 0;
    if (!player) return { hp, mp };
    if (hpPerSec > 0 && player.hp < player.max_hp) {
      hp = Math.min(hpPerSec, player.max_hp - player.hp);
      player.hp += hp;
    }
    if (mpPerSec > 0 && player.mana < player.max_mana) {
      mp = Math.min(mpPerSec, player.max_mana - player.mana);
      player.mana += mp;
    }
    return { hp, mp };
  }

  /**
   * Temple heal cost to fully restore HP/MP (item 5). Catalog-driven and
   * floored at 0 so a free-heal config stays free.
   */
  static templeHealCost(player) {
    if (!player) return 0;
    const hpCost = Math.max(0, player.max_hp - player.hp) * Number(cfg('temple.healCostPerHp', 1));
    const mpCost = Math.max(0, player.max_mana - player.mana) * Number(cfg('temple.healCostPerMp', 1));
    return Math.max(0, Math.round(hpCost + mpCost));
  }

  /** Heals the player at the town temple, spending the computed gold cost. */
  static templeHeal(player, opts = {}) {
    if (!player) return { success: false, cost: 0, message: 'No character to heal.' };
    const cost = opts.free ? 0 : EconomySystem.templeHealCost(player);
    if (cost > 0 && (Number(player.gold) || 0) < cost) {
      return { success: false, cost, message: `The temple asks ${cost} gold; you carry ${Number(player.gold) || 0}.` };
    }
    if (cost > 0) EconomySystem.spendGold(player, cost);
    player.hp = player.max_hp;
    player.mana = player.max_mana;
    return { success: true, cost, message: cost > 0 ? `The temple restores you for ${cost} gold.` : 'The temple restores you.' };
  }

  /** Shop config. */
  static shopConfig() {
    const s = cfg('shop', {});
    return {
      sellRatePct: Number(s.sellRatePct) || 0,
      buyMarkupPct: Number(s.buyMarkupPct) || 0,
      upgradeBaseCost: Number(s.upgradeBaseCost) || 0,
      upgradeCostPerRank: Number(s.upgradeCostPerRank) || 0,
      maxRank: Number(s.maxRank) || 5,
      pawnFallbackValuePerStat: Number(s.pawnFallbackValuePerStat) || 0,
    };
  }

  /**
   * Returns the shop stock entries visible to a vocation (vocation-agnostic
   * entries plus matching affinity), each annotated with `cost` and item def.
   */
  static shopStock(vocation) {
    const stock = cfg('stock', []) || [];
    const out = [];
    for (const entry of stock) {
      const affinity = entry.vocationAffinity;
      if (affinity && vocation && affinity !== vocation && !(Array.isArray(affinity) && affinity.includes(vocation))) {
        continue;
      }
      const def = ITEMS_CATALOG[entry.itemId] || {};
      const markup = 1 + EconomySystem.shopConfig().buyMarkupPct / 100;
      out.push({
        itemId: entry.itemId,
        name: def.name || entry.itemId,
        type: def.type || 'item',
        quantity: entry.quantity || 1,
        price: Math.max(0, Math.round((entry.price || 0) * markup)),
        maxPurchases: Number(entry.maxPurchases) || 0,
      });
    }
    return out;
  }

  /**
   * Buy a shop entry. Spends gold and returns the item stack to grant.
   * The caller is responsible for adding the item to the inventory.
   * @returns {{ success, message, cost, item }}
   */
  static buyItem(player, itemId, opts = {}) {
    if (!player || !itemId) return { success: false, cost: 0, message: 'Nothing to buy.' };
    const entry = EconomySystem.shopStock(player.vocation).find(s => s.itemId === itemId);
    if (!entry) return { success: false, cost: 0, message: `${itemId} is not for sale here.` };
    if (entry.maxPurchases > 0 && opts.purchasedCount >= entry.maxPurchases) {
      return { success: false, cost: 0, message: `${entry.name} is out of stock.` };
    }
    if (!EconomySystem.spendGold(player, entry.price)) {
      return { success: false, cost: entry.price, message: `You need ${entry.price} gold for ${entry.name}.` };
    }
    const def = ITEMS_CATALOG[itemId] || {};
    return {
      success: true,
      cost: entry.price,
      message: `Purchased ${entry.name} for ${entry.price} gold.`,
      item: { ...def, item_id: itemId, quantity: entry.quantity || 1, pricePaid: entry.price },
    };
  }

  /** The gold cost to upgrade an owned item to its next rank. */
  static upgradeCost(item) {
    const { upgradeBaseCost, upgradeCostPerRank, maxRank } = EconomySystem.shopConfig();
    const rank = Math.max(1, Math.min(maxRank, Number(item?.itemLevel) || 1));
    return upgradeBaseCost + upgradeCostPerRank * (rank - 1);
  }

  /**
   * True when an item can still be upgraded in the shop. Falls back to the
   * catalog `upgradeSpec` so looted/banked gear (which never carries the spec
   * on its instance) is treated the same as crafted stock.
   */
  static canUpgrade(item) {
    if (!item || !item.item_id) return false;
    const { maxRank } = EconomySystem.shopConfig();
    if ((Number(item?.itemLevel) || 1) >= maxRank) return false;
    const spec = item.upgradeSpec || ITEMS_CATALOG[item.item_id]?.upgradeSpec;
    return Boolean(spec && Object.keys(spec).length > 0);
  }

  /**
   * Gold a merchant pays to pawn an item: the catalog
   * `sellRatePct` percentage of its purchase price. The base resolves from the
   * price actually paid, the authored price, the shop stock price, then a
   * catalog-driven stat-value fallback so authored loot is still sellable.
   */
  static pawnValue(item) {
    if (!item) return 0;
    const stockEntry = (cfg('stock', []) || []).find(entry => entry.itemId === item.item_id);
    const { sellRatePct, pawnFallbackValuePerStat } = EconomySystem.shopConfig();
    const authored = Number(item.pricePaid ?? item.price ?? stockEntry?.price);
    const base = Number.isFinite(authored) && authored > 0
      ? authored
      : (Number(item.stat_bonus) || 0) * pawnFallbackValuePerStat;
    return Math.max(0, Math.floor(base * (sellRatePct / 100)));
  }

  /**
   * Pawns an item out of a container for gold. The caller owns slot removal;
   * this helper pays the pawn value and builds the message.
   * @returns {{ success: boolean, value: number, message: string }}
   */
  static pawnItem(player, item) {
    if (!player || !item) return { success: false, value: 0, message: 'Nothing to pawn.' };
    if (item.droppable === false) {
      return { success: false, value: 0, message: `${item.name} cannot be pawned.` };
    }
    const value = EconomySystem.pawnValue(item);
    if (value <= 0) {
      return { success: false, value: 0, message: `${item.name} has no pawn value.` };
    }
    const credited = EconomySystem.addGold(player, value);
    return { success: true, value: credited, message: `Pawned ${item.name} for ${credited} gold.` };
  }

  /** Description of the town temple / revive rule (item 5). */
  static reviveLocation() {
    return String(cfg('temple.reviveAt', DEFAULTS.temple.reviveAt));
  }

  /** The town presentation config (name, subtitle, labels) from ui.json. */
  static townConfig() {
    const town = UI_CATALOG?.town || {};
    return {
      title: town.title || 'Havenreach',
      subtitle: town.subtitle || 'The town beneath the Crown Spire',
      shopName: town.shopName || "Merchant's Stall",
      templeName: town.templeName || 'Temple of the Dawn',
      enterTowerLabel: town.enterTowerLabel || 'Enter the Tower',
    };
  }
}
