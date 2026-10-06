/**
 * Lokarta: Come Into The Light - Shop Controller
 */

import { EconomySystem, InventorySystem } from '../engine/index.js';
import { applyItemRankUp } from '../engine/item-progression.js';
import { soundFX } from '../audio/index.js';
import { ModalManager } from './modal-manager.js';

/**
 * Town economy: shop stock, buy/pawn/upgrade, and temple healing.
 * Assigned onto `LokartaApp.prototype` from `app-controller.js`.
 */
export const shopControllerMethods = {
  /** The shop stock + upgrade/pawn lists for the current player. */
  buildShopState() {
    return {
      shopStock: EconomySystem.shopStock(this.player.vocation),
      ownedUpgradableItems: this.collectUpgradableItems(),
      pawnItems: this.collectPawnableItems(),
      templeCost: EconomySystem.templeHealCost(this.player),
    };
  },
  /** Banked/equipped items the shop can rank up (all four equipment slots). */
  collectUpgradableItems() {
    const out = [];
    const player = this.player;
    const push = (item, source, index) => {
      if (!item || !EconomySystem.canUpgrade(item, player)) return;
      out.push({ item, source, index, rank: item.itemLevel || 1, cost: EconomySystem.upgradeCost(item, player) });
    };
    // Paperdoll first so the four wearable slots are always offered.
    Object.entries(this.player.paperdoll || {}).forEach(([slot, item]) => {
      if (item && EconomySystem.canUpgrade(item, player)) {
        out.push({ item, source: 'equipment', index: slot, rank: item.itemLevel || 1, cost: EconomySystem.upgradeCost(item, player) });
      }
    });
    (this.player.backpack || []).forEach((item, i) => push(item, 'backpack', i));
    (this.player.action_bar || []).forEach((item, i) => push(item, 'action_bar', i));
    return out;
  },
  /** Backpack items the merchant will buy. */
  collectPawnableItems() {
    const out = [];
    (this.player.backpack || []).forEach((item, index) => {
      if (!item || item.droppable === false) return;
      const value = EconomySystem.pawnValue(item);
      if (value > 0) out.push({ item, source: 'backpack', index, value });
    });
    return out;
  },
  openShop() {
    const state = this.buildShopState();
    ModalManager.renderTownShop(this.townEl, { ...this, ...state }, {
      onBuy: itemId => this.buyShopItem(itemId),
      onUpgrade: (source, index) => this.upgradeShopItem(source, index),
      onPawn: (source, index) => this.pawnShopItem(source, index),
      onBack: () => this.showTown(),
    });
  },
  buyShopItem(itemId) {
    const purchased = this.purchasedCounts || (this.purchasedCounts = {});
    const res = EconomySystem.buyItem(this.player, itemId, { purchasedCount: purchased[itemId] || 0 });
    if (!res.success) {
      soundFX.play('uiBack');
      this.logCombat(res.message, 'warning');
      this.openShop();
      return;
    }
    // A purchase banks a second copy; it never ranks up an
    // already-owned item (that is the Upgrade Gear section's job).
    const addRes = InventorySystem.addItem(this.player, { ...res.item, quantity: res.item.quantity || 1 }, { allowRankUp: false });
    if (!addRes.success) {
      // No room: refund and tell the player.
      EconomySystem.addGold(this.player, res.cost);
      soundFX.play('uiBack');
      this.logCombat('Your pack is full — the purchase was refunded.', 'warning');
      this.openShop();
      return;
    }
    purchased[itemId] = (purchased[itemId] || 0) + 1;
    soundFX.play('coins');
    this.logCombat(res.message, 'loot');
    this.updateHUD();
    this.persistSave();
    this.openShop();
  },
  /**
   * Pawns a backpack item to the merchant for 50% of its purchase price
   *. Removes the item and credits gold.
   */
  pawnShopItem(source, index) {
    const item = (this.player.backpack || [])[Number(index)];
    if (!item) {
      this.openShop();
      return;
    }
    const res = EconomySystem.pawnItem(this.player, item);
    if (!res.success) {
      soundFX.play('uiBack');
      this.logCombat(res.message, 'warning');
      this.openShop();
      return;
    }
    this.player.backpack[Number(index)] = null;
    soundFX.play('coins');
    this.logCombat(res.message, 'loot');
    this.updateHUD();
    this.persistSave(true);
    this.openShop();
  },
  upgradeShopItem(source, index) {
    const entry = this.collectUpgradableItems().find(e => e.source === source && String(e.index) === String(index));
    if (!entry) {
      soundFX.play('uiBack');
      this.logCombat('That gear cannot be upgraded further.', 'warning');
      this.openShop();
      return;
    }
    if (!EconomySystem.spendGold(this.player, entry.cost)) {
      soundFX.play('uiBack');
      this.logCombat(`You need ${entry.cost} gold to upgrade ${entry.item.name}.`, 'warning');
      this.openShop();
      return;
    }
    const result = applyItemRankUp(this.player, entry.item, { source: 'shop' });
    if (!result) {
      EconomySystem.addGold(this.player, entry.cost);
      this.logCombat(`${entry.item.name} cannot be upgraded further.`, 'warning');
    } else {
      soundFX.play('levelUp');
      this.logCombat(`Upgraded ${entry.item.name} for ${entry.cost} gold!`, 'loot');
    }
    InventorySystem.recomputeGearBonuses(this.player);
    this.updateHUD();
    this.persistSave(true);
    this.openShop();
  },
  openTemple() {
    ModalManager.renderTownTemple(this.townEl, { ...this, templeCost: EconomySystem.templeHealCost(this.player) }, {
      onHeal: () => this.templeHeal(),
      onBack: () => this.showTown(),
    });
  },
  templeHeal() {
    const res = EconomySystem.templeHeal(this.player);
    if (res.success) {
      soundFX.play('holyChime');
      this.logCombat(res.message, 'spell');
      this.updateHUD();
      this.persistSave(true);
    } else {
      soundFX.play('uiBack');
      this.logCombat(res.message, 'warning');
    }
    this.openTemple();
  }
};
