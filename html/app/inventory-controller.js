/**
 * Lokarta: Come Into The Light - Inventory Controller
 */

import {
  InventorySystem,
  ChestSystem,
  EconomySystem,
  DoorSystem,
  LightingSystem,
} from '../engine/index.js';
import { soundFX } from '../audio/index.js';
import { UI_CATALOG } from '../data/index.js';

/** Loot floating-text lifetime, shared by pickup and chest messages. */
const FLOATING_TEXT = UI_CATALOG?.floatingText || {};
const FLOATING_LOOT_MS = Number(FLOATING_TEXT.lootDurationMs) || 2400;

/**
 * Special ground-pickup dispatch keyed by an item's catalog `pickupType`.
 * Normal inventory items fall through to `InventorySystem.pickUpItem`. Keeps
 * currency and keys out of the backpack so gold credits the purse and a key
 * unlocks its per-level gate.
 */
const GROUND_PICKUP_HANDLERS = {
  currency: (app, item) => {
    const gained = EconomySystem.addGold(app.player, item.quantity || 0);
    app.gridMap.popTopItem(app.player.x, app.player.y);
    if (gained > 0) {
      soundFX.play('coins');
      app.logCombat(`Picked up ${gained} gold.`, 'loot');
      app.addFloatingText(`+${gained}g`, app.player.x, app.player.y, '#fbbf24', { durationMs: FLOATING_LOOT_MS });
      app.updateHUD();
    }
    return gained > 0;
  },
  key: (app, item) => {
    const level = app.player?.current_floor || 1;
    const newlyEarned = DoorSystem.grantKey(app.player, level, item.keyTier);
    app.gridMap.popTopItem(app.player.x, app.player.y);
    soundFX.play('keyJangle');
    app.logCombat(
      newlyEarned
        ? `Picked up the ${item.name}. Walk onto the ${item.keyTier} door to open it.`
        : `The ${item.name} was already earned on this floor.`,
      'loot'
    );
    app.addFloatingText(`+${item.name}`, app.player.x, app.player.y, '#facc15', { durationMs: FLOATING_LOOT_MS });
    app.updateHUD();
    return newlyEarned;
  },
};

/**
 * Loot and inventory interaction: walk-over pickup, chest opening, drop, and unequip.
 * Assigned onto `LokartaApp.prototype` from `app-controller.js`.
 */
export const inventoryControllerMethods = {
  async handlePickUp() {
    soundFX.init();
    // Items 4/5: currency and keys resolve through a typed dispatch so
    // they credit the purse / unlock the level rather than banking as items.
    const tileItems = this.gridMap.getItems(this.player.x, this.player.y);
    const topItem = tileItems[tileItems.length - 1];
    const specialHandler = topItem && GROUND_PICKUP_HANDLERS[topItem.pickupType];
    if (specialHandler) {
      if (specialHandler(this, topItem)) await this.persistSave();
      return;
    }

    const res = InventorySystem.pickUpItem(this.player, this.gridMap);
    if (res.success) {
      soundFX.play('itemPickup');
      this.logCombat(res.message, 'loot');
      this.addFloatingText(`+${res.item?.name}`, this.player.x, this.player.y, '#22c55e', { durationMs: FLOATING_LOOT_MS });
      this.updateHUD();
      await this.persistSave();
    }
  },
  /**
   * Opens the chest under the player (walk-on) or at an explicit tile and picks
   * up its contents in the same turn: the chest is opened, its loot
   * goes straight into the inventory, and nothing is left on the ground to
   * require a second walk-over. Persists the opened state.
   * @returns {Promise<boolean>} true when a chest was opened
   */
  async handleOpenChest(gridX = this.player?.x, gridY = this.player?.y) {
    const chest = ChestSystem.findChestAt(this.chests, gridX, gridY);
    if (!ChestSystem.isChestOpenable(chest)) return false;

    soundFX.init();
    const res = ChestSystem.openChest(chest, { vocation: this.player?.vocation });
    if (!res.success) {
      this.logCombat(res.message, 'warning');
      return false;
    }

    this.logCombat(res.message, 'loot');
    this.addFloatingText(`OPENED ${chest.tier.toUpperCase()} CHEST`, chest.x, chest.y, '#ffd700', { durationMs: FLOATING_LOOT_MS });

    // Gold from chests, in addition to the rolled item loot.
    const goldDrop = EconomySystem.goldFromChest(chest.tier);
    if (goldDrop > 0) {
      EconomySystem.addGold(this.player, goldDrop);
      this.logCombat(`Found ${goldDrop} gold in the chest.`, 'loot');
      this.addFloatingText(`+${goldDrop}g`, chest.x, chest.y, '#fbbf24');
    }

    // Single-turn open + collect: grant the rolled loot directly to the player.
    let picked = 0;
    const pickedNames = [];
    for (const stack of res.loot) {
      const addRes = InventorySystem.addItem(this.player, { ...stack });
      if (addRes.success) {
        picked += 1;
        pickedNames.push(stack.name);
      } else {
        // No room: leave the item on the tile so it is not lost.
        this.gridMap.addItem(chest.x, chest.y, { ...stack, x: chest.x, y: chest.y });
        this.logCombat(`${stack.name} does not fit — left on the ground.`, 'warning');
      }
    }

    if (picked > 0) {
      soundFX.play('itemPickup');
      this.addFloatingText(`+${pickedNames.join(', ')}`, this.player.x, this.player.y, '#22c55e', { durationMs: FLOATING_LOOT_MS });
    }
    this.updateHUD();
    await this.persistChests();
    return true;
  },
  async handleDropItem(source, slotIndex) {
    soundFX.init();
    const res = InventorySystem.dropItem(this.player, source, slotIndex, this.gridMap);
    if (res.success) {
      soundFX.play('unequip');
      this.logCombat(res.message, 'system');
      this.updateHUD();
      await this.persistSave();
    } else {
      this.logCombat(res.message, 'warning');
    }
  },
  async handleUnequip(slotName) {
    soundFX.init();
    const res = InventorySystem.unequipItem(this.player, slotName);
    if (res.success) {
      soundFX.play('unequip');
      this.logCombat(res.message, 'system');
      LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);
      this.updateHUD();
      await this.persistSave();
    } else {
      this.logCombat(res.message, 'warning');
    }
  }
};
