/**
 * Lokarta: Come Into The Light - Inventory & Equipment Subsystem
 *
 * Inventory overhaul:
 *   - 8 keyed slots: `q w e r` = equipment (main_hand/off_hand/armor/relic),
 *     `1 2 3 4` = active items (consumables/usables).
 *   - One backpack grid, default 36 slots (6x6).
 *   - Potions/consumables auto-fill an empty active slot; equipment with no
 *     free keyed slot banks into the backpack. Banked gear can be swapped into
 *     any of the 8 keyed slots.
 *
 * Slot counts and rules are catalog-driven (`items.json`, `ui.json`,
 * `keybindings.json`); there are no hardcoded constants here.
 */

import { INVENTORY_CONFIG, EQUIPMENT_KEY_MAP, EQUIPMENT_SLOT_KEYS } from './config.js';
import { ITEMS_CATALOG, UI_CATALOG } from '../data/index.js';
import { findOwnedItem, applyItemRankUp, formatRankUpMessage } from './item-progression.js';
import { sameActor } from './faction.js';

const EQUIP_SLOT_ORDER = EQUIPMENT_SLOT_KEYS;

/** Item types that occupy an equipment slot (fallback when `slotRole` is absent). */
const EQUIPPABLE_TYPES = new Set(['weapon', 'offhand', 'armor', 'relic']);

/** Slot-role dispatch (D1 §0.3): catalog-declared, never a string heuristic. */
const ITEM_SLOT_ROLE = {
  active: 'active',
  equipment: 'equipment',
  bank: 'bank',
};

/**
 * Restorable resources keyed by catalog `effect.resource`. `current` mutates the
 * player pool, `max` clamps it; labels are for player-facing messages.
 */
const RESTORE_RESOURCES = {
  hp: { current: 'hp', max: 'max_hp', label: 'HP', full: 'Health' },
  mp: { current: 'mana', max: 'max_mana', label: 'MP', full: 'Mana' },
};

/** Consumable effect dispatch keyed by catalog `effect.kind` (items.json). */
const CONSUMABLE_EFFECTS = {
  restore: (player, item, effect, removeCallback) => {
    const res = RESTORE_RESOURCES[effect.resource];
    if (!res) return { success: false, message: `Unknown consumable resource: ${effect.resource}` };
    const amount = Number(item.stat_bonus) || Number(effect.amount) || 0;

    // `effect.scope: 'party'` (items.json) turns one drink into a shared restore:
    // every living party member missing that resource is topped up (LIV-24).
    // Unscoped/`self` consumables keep the original single-target behavior.
    const partyScope = effect.scope === 'party';
    const targets = partyScope
      ? restoreTargets(player, res)
      : (Number(player[res.current]) < Number(player[res.max]) ? [player] : []);
    if (targets.length === 0) {
      return { success: false, message: `${res.full} is already full!` };
    }

    let restored = 0;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const before = Number(target[res.current]) || 0;
      const max = Number(target[res.max]) || 0;
      restored += Math.min(amount, max - before);
      target[res.current] = Math.min(max, before + amount);
    }
    removeCallback();

    if (partyScope && targets.length > 1) {
      return {
        success: true,
        message: `Drank ${item.name}. Restored +${restored} ${res.label} across the party (${targets.length}).`,
        item,
        restored,
        targets: targets.length,
      };
    }
    return {
      success: true,
      message: `Drank ${item.name}. Restored +${restored} ${res.label} (${player[res.current]}/${player[res.max]}).`,
      item,
      restored,
      targets: targets.length,
    };
  },
};

/**
 * Living party members that would actually gain from a restore of `res`, with
 * the authoritative top-level active member included exactly once. A legacy /
 * party-less player resolves to just itself. Used by `effect.scope: 'party'`.
 * @param {object} player
 * @param {{ current: string, max: string }} res
 * @returns {object[]}
 */
function restoreTargets(player, res) {
  const out = [];
  if (!player) return out;
  const eligible = (actor) => actor
    && !(Number(actor.hp) <= 0)
    && Number(actor[res.max]) > 0
    && Number(actor[res.current]) < Number(actor[res.max]);

  if (eligible(player)) out.push(player);

  const party = Array.isArray(player.party) ? player.party : null;
  if (party) {
    for (let i = 0; i < party.length; i++) {
      const member = party[i];
      if (!member || Number(member.hp) <= 0) continue;
      if (sameActor(player, member)) continue; // active mirror already counted
      if (eligible(member)) out.push(member);
    }
  }
  return out;
}

export class InventorySystem {
  /**
   * Resolves an item's D1 `slotRole` from the instance or its catalog entry.
   * @returns {'active'|'equipment'|'bank'|null}
   */
  static slotRole(item) {
    if (!item) return null;
    const catalogItem = ITEMS_CATALOG[item.item_id] || {};
    const role = item.slotRole || catalogItem.slotRole || null;
    if (role && ITEM_SLOT_ROLE[role]) return role;
    // Legacy fallback for saves/items authored before `slotRole` existed.
    const type = item.type || catalogItem.type;
    if (type === 'consumable' || type === 'item') return 'active';
    if (EQUIPPABLE_TYPES.has(type)) return 'equipment';
    return 'bank';
  }

  static getMaxStack(itemId) {
    if (ITEMS_CATALOG[itemId] && typeof ITEMS_CATALOG[itemId].maxStack === 'number') {
      return ITEMS_CATALOG[itemId].maxStack;
    }
    return 1;
  }

  /** The paperdoll target slot for an item, or null when it is not equippable. */
  static equipSlotFor(item) {
    if (!item) return null;
    const catalogItem = ITEMS_CATALOG[item.item_id];
    const slot = item.slot || catalogItem?.slot;
    if (slot) return slot;
    const type = item.type || catalogItem?.type;
    if (type === 'weapon') return 'main_hand';
    if (type === 'offhand') return 'off_hand';
    if (type === 'armor') return 'armor';
    if (type === 'relic') return 'relic';
    return null;
  }

  static isEquippable(item) {
    return InventorySystem.slotRole(item) === 'equipment';
  }

  /** True when the item belongs in an active slot (1-4), per its `slotRole`. */
  static isActiveItem(item) {
    return InventorySystem.slotRole(item) === 'active';
  }

  /**
   * Vocation-affinity check shared by equip/swap. Returns `null` when allowed,
   * or a human-readable denial reason (D1 §2.5).
   */
  static affinityDenial(player, item) {
    const affinity = item?.vocationAffinity || ITEMS_CATALOG[item?.item_id]?.vocationAffinity;
    if (!affinity || affinity === 'neutral' || !player?.vocation) return null;
    const matches = Array.isArray(affinity) ? affinity.includes(player.vocation) : affinity === player.vocation;
    if (matches) return null;
    const label = Array.isArray(affinity)
      ? affinity.map(v => v.charAt(0).toUpperCase() + v.slice(1)).join('/')
      : (affinity.charAt(0).toUpperCase() + affinity.slice(1));
    return `Only a ${label} can use ${item.name}.`;
  }

  /** Slot label for invalid-drop copy, e.g. `main_hand` -> `Main hand`. */
  static slotLabel(slotName) {
    const map = { main_hand: 'Main hand', off_hand: 'Off hand', armor: 'Armor', relic: 'Relic' };
    return map[slotName] || String(slotName || '').replace('_', ' ');
  }

  static ensureContainers(player) {
    if (!player) return;
    if (!Array.isArray(player.action_bar) || player.action_bar.length !== INVENTORY_CONFIG.ACTIVE_SLOTS) {
      const next = new Array(INVENTORY_CONFIG.ACTIVE_SLOTS).fill(null);
      for (let i = 0; i < Math.min(next.length, player.action_bar?.length || 0); i++) {
        next[i] = player.action_bar[i] || null;
      }
      player.action_bar = next;
    }
    if (!Array.isArray(player.backpack) || player.backpack.length !== INVENTORY_CONFIG.BACKPACK_SLOTS) {
      const next = new Array(INVENTORY_CONFIG.BACKPACK_SLOTS).fill(null);
      for (let i = 0; i < Math.min(next.length, player.backpack?.length || 0); i++) {
        next[i] = player.backpack[i] || null;
      }
      player.backpack = next;
    }
    if (!player.paperdoll) {
      player.paperdoll = { main_hand: null, off_hand: null, armor: null, relic: null };
    }
  }

  static firstEmpty(slots) {
    if (!slots) return -1;
    for (let i = 0; i < slots.length; i++) if (slots[i] === null) return i;
    return -1;
  }

  /**
   * Resolves a keyed slot request into `{ list, index }` or null.
   * `key` may be a keybinding code (`KeyQ`, `Digit1`), an equipment slot name
   * (`main_hand`), or an active-slot string ('active:1').
   */
  static resolveKeyedSlot(player, key) {
    if (!player || key === undefined || key === null) return null;
    const k = String(key);
    // Equipment accepted as a key code (`KeyQ`), a letter (`q`), or a slot name.
    const letter = k.length === 1 ? k.toLowerCase() : (k.startsWith('Key') ? k.slice(3).toLowerCase() : null);
    const slotName = (letter && EQUIPMENT_KEY_MAP[letter]) || (EQUIP_SLOT_ORDER.includes(k) ? k : null);
    if (slotName) return { kind: 'equipment', slot: slotName, list: null, index: -1 };
    const activeMatch = /^(Digit|active:)?([1-9])$/.exec(k);
    if (activeMatch) {
      const idx = Number(activeMatch[2]) - 1;
      if (idx >= 0 && idx < INVENTORY_CONFIG.ACTIVE_SLOTS) {
        return { kind: 'active', slot: `active_${idx}`, list: player.action_bar, index: idx };
      }
    }
    // Explicit container refs used by mouse-drag swaps: `backpack:3`, `active:2`.
    const backpackMatch = /^backpack:(\d+)$/.exec(k);
    if (backpackMatch) {
      const idx = Number(backpackMatch[1]);
      if (idx >= 0 && idx < player.backpack.length) {
        return { kind: 'backpack', slot: `backpack_${idx}`, list: player.backpack, index: idx };
      }
    }
    const activeRefMatch = /^active:(\d+)$/.exec(k);
    if (activeRefMatch) {
      const idx = Number(activeRefMatch[1]);
      if (idx >= 0 && idx < INVENTORY_CONFIG.ACTIVE_SLOTS) {
        return { kind: 'active', slot: `active_${idx}`, list: player.action_bar, index: idx };
      }
    }
    return null;
  }

  /**
   * Automatically collects the top ground item, routing consumables into empty
   * active slots and everything else into the backpack (equipment banks).
   *
   * The containers resolved here are the shared party inventory, so any party
   * actor (the active member or an auto ally) can collect a walk-over drop.
   * @param {object} player Shared-inventory owner (the top-level player).
   * @param {import('./grid-map.js').GridMap} gridMap
   * @param {number} [atX] Tile x to collect from; defaults to the player's.
   * @param {number} [atY] Tile y to collect from; defaults to the player's.
   */
  static pickUpItem(player, gridMap, atX, atY) {
    InventorySystem.ensureContainers(player);
    const x = Number.isFinite(atX) ? atX : player.x;
    const y = Number.isFinite(atY) ? atY : player.y;
    const tileItems = gridMap.getItems(x, y);
    if (tileItems.length === 0) {
      return { success: false, message: 'There is nothing here to pick up.' };
    }

    const groundItem = tileItems[tileItems.length - 1];
    const maxStack = InventorySystem.getMaxStack(groundItem.item_id);
    let totalPickedUp = 0;

    // 0. Floor arrow drops fill the equipped quiver first.
    if (groundItem.item_id === 'arrows') {
      const quiver = player.paperdoll?.off_hand;
      if (quiver && typeof quiver.arrowCount === 'number' && typeof quiver.arrowCapacity === 'number') {
        const space = quiver.arrowCapacity - quiver.arrowCount;
        if (space > 0) {
          const toFill = Math.min(space, groundItem.quantity);
          quiver.arrowCount += toFill;
          groundItem.quantity -= toFill;
          totalPickedUp += toFill;
        }
      }
    }

    const lists = [player.action_bar, player.backpack];

    // 1. Stack into any container that already holds the same item.
    if (maxStack > 1) {
      for (const list of lists) {
        for (let i = 0; i < list.length && groundItem.quantity > 0; i++) {
          const slotItem = list[i];
          if (slotItem && slotItem.item_id === groundItem.item_id && slotItem.quantity < maxStack) {
            const space = maxStack - slotItem.quantity;
            const toAdd = Math.min(space, groundItem.quantity);
            slotItem.quantity += toAdd;
            groundItem.quantity -= toAdd;
            totalPickedUp += toAdd;
          }
        }
      }
    }

    // 2. Consumables auto-fill an empty active slot (1-4).
    if (InventorySystem.isActiveItem(groundItem)) {
      while (groundItem.quantity > 0) {
        const emptyIndex = InventorySystem.firstEmpty(player.action_bar);
        if (emptyIndex === -1) break;
        const toMove = Math.min(maxStack, groundItem.quantity);
        groundItem.quantity -= toMove;
        totalPickedUp += toMove;
        player.action_bar[emptyIndex] = { ...groundItem, quantity: toMove };
      }
    }

    // 3. Anything remaining banks into the backpack grid.
    while (groundItem.quantity > 0) {
      const emptyIndex = InventorySystem.firstEmpty(player.backpack);
      if (emptyIndex === -1) break;
      const toMove = Math.min(maxStack, groundItem.quantity);
      groundItem.quantity -= toMove;
      totalPickedUp += toMove;
      player.backpack[emptyIndex] = { ...groundItem, quantity: toMove };
    }

    if (groundItem.quantity <= 0) {
      gridMap.popTopItem(x, y);
    }

    if (totalPickedUp === 0) {
      return { success: false, message: 'Active slots and backpack are full!' };
    }

    return {
      success: true,
      message: `Picked up ${groundItem.name}${totalPickedUp > 1 ? ` (x${totalPickedUp})` : ''}.`,
      item: groundItem,
    };
  }

  /**
   * Grants an item directly to the player: consumables to active slots, other
   * items bank into the backpack. Never drops to the ground. Duplicate unique
   * gear levels up the owned copy instead of stacking a second one.
   */
  static addItem(player, item, opts = {}) {
    if (!player || !item || !item.item_id) {
      return { success: false, message: 'Nothing to add.', item: null };
    }
    InventorySystem.ensureContainers(player);

    const maxStackForDup = InventorySystem.getMaxStack(item.item_id);
    // Shop purchases pass `allowRankUp: false` so buying a duplicate weapon
    // banks a second copy instead of silently ranking up the owned one
    //. Reward paths (chest loot, drafts) keep the rank-up.
    if (opts.allowRankUp !== false && maxStackForDup <= 1) {
      const owned = findOwnedItem(player, item);
      if (owned) {
        const upgrade = applyItemRankUp(player, owned, { source: 'duplicate' });
        if (upgrade) {
          return { success: true, message: formatRankUpMessage(upgrade), item: upgrade.item, upgraded: true, rank: upgrade.rank };
        }
        return { success: true, message: `${owned.name || owned.item_id} is already at max rank.`, item: owned, upgraded: false, duplicateIgnored: true };
      }
    }

    // Just-granted gear (chest loot, draft rewards) auto-equips into its empty
    // paperdoll slot; anything with no free slot banks into the backpack below.
    if (InventorySystem.autoEquipIfEmpty(player, item)) {
      return { success: true, message: `Equipped ${item.name}.`, item };
    }

    const maxStack = maxStackForDup;
    let remaining = item.quantity || 1;
    const lists = [player.action_bar, player.backpack];

    if (maxStack > 1) {
      for (const list of lists) {
        for (let i = 0; i < list.length && remaining > 0; i++) {
          const slot = list[i];
          if (slot && slot.item_id === item.item_id && slot.quantity < maxStack) {
            const toAdd = Math.min(maxStack - slot.quantity, remaining);
            slot.quantity += toAdd;
            remaining -= toAdd;
          }
        }
      }
    }

    // Consumables prefer an empty active slot before banking.
    if (InventorySystem.isActiveItem(item)) {
      for (let i = 0; i < player.action_bar.length && remaining > 0; i++) {
        if (player.action_bar[i] === null) {
          const toMove = Math.min(maxStack, remaining);
          player.action_bar[i] = { ...item, quantity: toMove };
          remaining -= toMove;
        }
      }
    }

    for (let i = 0; i < player.backpack.length && remaining > 0; i++) {
      if (player.backpack[i] === null) {
        const toMove = Math.min(maxStack, remaining);
        player.backpack[i] = { ...item, quantity: toMove };
        remaining -= toMove;
      }
    }

    if (remaining > 0) {
      return { success: false, message: 'Active slots and backpack are full!', item: null };
    }

    const qty = item.quantity || 1;
    return { success: true, message: `Added ${item.name}${qty > 1 ? ` (x${qty})` : ''}.`, item };
  }

  /** Expanding-ring radius for dropped-item placement. */
  static dropRingRadius() {
    const n = Number(UI_CATALOG?.lootPlacement?.dropRingRadius);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
  }

  /**
   * Nearest walkable in-bounds tile to `(cx, cy)` that holds no ground items
   * and is not already reserved by the current drop event. Searches ring by
   * ring (adjacent first, then expanding) and returns `{ x, y, key }` with an
   * integer coordinate hash, or `null` when no free tile exists in range so the
   * caller can fall back to stacking.
   * @param {import('./grid-map.js').GridMap} gridMap
   * @param {number} cx @param {number} cy
   * @param {Set<number>} [reserved] - integer hashes already claimed this event
   * @returns {{x:number,y:number,key:number}|null}
   */
  static findFreeGroundTile(gridMap, cx, cy, reserved) {
    if (!gridMap) return null;
    const maxRing = InventorySystem.dropRingRadius();
    for (let ring = 0; ring <= maxRing; ring++) {
      // Visit the ring shell nearest-first: orthogonal neighbours (Manhattan
      // distance == ring) before diagonals, so a directly adjacent tile wins.
      for (let manhattan = ring; manhattan <= 2 * ring; manhattan++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            if (Math.abs(dx) + Math.abs(dy) !== manhattan) continue;
            const x = cx + dx;
            const y = cy + dy;
            if (!gridMap.isInBounds(x, y) || !gridMap.isWalkable(x, y)) continue;
            const key = y * gridMap.width + x;
            if (reserved && reserved.has(key)) continue;
            if (gridMap.getItems(x, y).length > 0) continue;
            return { x, y, key };
          }
        }
      }
    }
    return null;
  }

  static dropItem(player, source, slotIndex, gridMap, reserved) {
    InventorySystem.ensureContainers(player);
    const list = source === 'action_bar' ? player.action_bar : player.backpack;
    if (!list || slotIndex < 0 || slotIndex >= list.length) {
      return { success: false, message: 'Invalid slot index.' };
    }
    const item = list[slotIndex];
    if (!item) return { success: false, message: 'Slot is empty.' };

    // Quest-critical items (catalog `droppable: false`) can never be dropped:
    // they must survive wipes and cannot be stranded on a floor (LIV-55 §4).
    if (item.droppable === false || ITEMS_CATALOG[item.item_id]?.droppable === false) {
      return { success: false, message: `${item.name} cannot be dropped.` };
    }

    // Never cover an existing ground item. Land on the nearest
    // free tile; only stack in place when the whole search radius is occupied.
    const free = InventorySystem.findFreeGroundTile(gridMap, player.x, player.y, reserved);
    const spot = free || { x: player.x, y: player.y, key: null };
    list[slotIndex] = null;
    gridMap.addItem(spot.x, spot.y, item);
    return { success: true, message: `Dropped ${item.name} on the floor.`, item, x: spot.x, y: spot.y };
  }

  static recomputeGearBonuses(player) {
    if (!player?.paperdoll) return;
    let hpBonus = 0;
    let manaBonus = 0;
    for (const slotName of Object.keys(player.paperdoll)) {
      const equipped = player.paperdoll[slotName];
      if (!equipped) continue;
      hpBonus += equipped.hpBonus || 0;
      manaBonus += equipped.manaBonus || 0;
    }

    if (player._gearBonusMaxHp === undefined || player._gearBonusMaxMana === undefined) {
      player._gearBonusMaxHp = hpBonus;
      player._gearBonusMaxMana = manaBonus;
      return;
    }

    const deltaHp = hpBonus - player._gearBonusMaxHp;
    const deltaMana = manaBonus - player._gearBonusMaxMana;
    if (deltaHp !== 0 || deltaMana !== 0) {
      player.max_hp = Math.max(1, (player.max_hp || 1) + deltaHp);
      player.max_mana = Math.max(1, (player.max_mana || 1) + deltaMana);
      if (deltaHp > 0) player.hp = Math.min(player.max_hp, (player.hp || 0) + deltaHp);
      if (deltaMana > 0) player.mana = Math.min(player.max_mana, (player.mana || 0) + deltaMana);
      player.hp = Math.min(player.max_hp, player.hp || 0);
      player.mana = Math.min(player.max_mana, player.mana || 0);
      player._gearBonusMaxHp = hpBonus;
      player._gearBonusMaxMana = manaBonus;
    }
  }

  /**
   * Auto-equips a just-granted item into its empty paperdoll slot. Kept for
   * draft/chest rewards so a first Golden piece lands directly on the player;
   * pickup banking for overflow is handled by `pickUpItem`.
   */
  static autoEquipIfEmpty(player, item) {
    if (!player || !item) return false;
    InventorySystem.ensureContainers(player);
    const targetSlot = InventorySystem.equipSlotFor(item);
    if (!targetSlot) return false;
    if (player.paperdoll[targetSlot] !== null && player.paperdoll[targetSlot] !== undefined) return false;

    const affinity = item.vocationAffinity || ITEMS_CATALOG[item.item_id]?.vocationAffinity;
    if (affinity && affinity !== 'neutral' && player.vocation) {
      const matches = Array.isArray(affinity) ? affinity.includes(player.vocation) : affinity === player.vocation;
      if (!matches) return false;
    }

    player.paperdoll[targetSlot] = { ...item, quantity: 1 };
    InventorySystem.recomputeGearBonuses(player);
    return true;
  }

  /**
   * Equips an item currently in the action bar or backpack into its paperdoll
   * slot, banking the previously equipped item into the backpack (bank rule).
   */
  static equipItem(player, source, slotIndex) {
    InventorySystem.ensureContainers(player);
    const list = source === 'action_bar' ? player.action_bar : player.backpack;
    if (!list || slotIndex < 0 || slotIndex >= list.length) {
      return { success: false, message: 'Invalid slot.' };
    }
    const item = list[slotIndex];
    if (!item) return { success: false, message: 'No item in selected slot.' };

    const targetSlot = InventorySystem.equipSlotFor(item);
    if (!targetSlot) return { success: false, message: `${item.name} cannot be equipped.` };

    const denial = InventorySystem.affinityDenial(player, item);
    if (denial) return { success: false, message: denial };

    const currentlyEquipped = player.paperdoll[targetSlot];

    if (item.quantity > 1) {
      item.quantity -= 1;
      player.paperdoll[targetSlot] = { ...item, quantity: 1 };
      if (currentlyEquipped) {
        const emptyIdx = InventorySystem.firstEmpty(player.backpack);
        if (emptyIdx !== -1) {
          player.backpack[emptyIdx] = currentlyEquipped;
        } else {
          item.quantity += 1;
          player.paperdoll[targetSlot] = currentlyEquipped;
          return { success: false, message: 'Cannot swap: backpack is full!' };
        }
      }
    } else {
      player.paperdoll[targetSlot] = item;
      list[slotIndex] = currentlyEquipped || null;
    }

    InventorySystem.recomputeGearBonuses(player);
    return { success: true, message: `Equipped ${item.name} in ${targetSlot.replace('_', ' ')}.`, item: player.paperdoll[targetSlot] };
  }

  static unequipItem(player, slotName) {
    InventorySystem.ensureContainers(player);
    if (!player.paperdoll || !player.paperdoll[slotName]) {
      return { success: false, message: `No item equipped in ${slotName.replace('_', ' ')}.` };
    }
    const item = player.paperdoll[slotName];
    const emptyBpIdx = InventorySystem.firstEmpty(player.backpack);
    if (emptyBpIdx !== -1) {
      player.paperdoll[slotName] = null;
      player.backpack[emptyBpIdx] = item;
      InventorySystem.recomputeGearBonuses(player);
      return { success: true, message: `Unequipped ${item.name} to backpack slot ${emptyBpIdx + 1}.`, item };
    }
    return { success: false, message: 'Cannot unequip: backpack is full!' };
  }

  static useBackpackItem(player, slotIndex) {
    InventorySystem.ensureContainers(player);
    if (slotIndex < 0 || slotIndex >= player.backpack.length) {
      return { success: false, message: 'Invalid backpack slot.' };
    }
    const item = player.backpack[slotIndex];
    if (!item) return { success: false, message: 'Slot is empty.' };

    if (item.type === 'consumable') {
      return InventorySystem.consumeItem(player, item, () => {
        if (item.quantity > 1) item.quantity -= 1;
        else player.backpack[slotIndex] = null;
      });
    }
    if (InventorySystem.isEquippable(item)) {
      return InventorySystem.equipItem(player, 'backpack', slotIndex);
    }
    return { success: false, message: `Cannot use ${item.name}.` };
  }

  static _readRef(player, ref) {
    return ref.kind === 'equipment' ? player.paperdoll[ref.slot] : ref.list[ref.index];
  }

  static _writeRef(player, ref, value) {
    if (ref.kind === 'equipment') player.paperdoll[ref.slot] = value;
    else ref.list[ref.index] = value;
  }

  /**
   * Strict destination validation (D1 §0.3): a moved item must match the target
   * row by `slotRole`, and (for equipment) by its natural slot key + affinity.
   * @returns {{ valid: boolean, message: string }}
   */
  static validateDestination(player, item, dst) {
    if (!item || !dst) return { valid: true, message: '' };
    if (dst.kind === 'equipment') {
      if (InventorySystem.slotRole(item) !== 'equipment') {
        return { valid: false, message: `The ${InventorySystem.slotLabel(dst.slot)} slot accepts equipment only.` };
      }
      const natural = InventorySystem.equipSlotFor(item);
      if (natural !== dst.slot) {
        return { valid: false, message: `${item.name} belongs in the ${InventorySystem.slotLabel(natural)} slot.` };
      }
      const denial = InventorySystem.affinityDenial(player, item);
      if (denial) return { valid: false, message: denial };
    }
    if (dst.kind === 'active' && InventorySystem.slotRole(item) !== 'active') {
      return { valid: false, message: `${item.name} is not an active item.` };
    }
    return { valid: true, message: '' };
  }

  /**
   * Read-only validity check for a drag/click move, used by the HUD to paint
   * `.drop-valid` / `.drop-invalid` before committing (D1 §2.4).
   * @returns {{ valid: boolean, message: string }}
   */
  static validateMove(player, from, to) {
    InventorySystem.ensureContainers(player);
    const src = InventorySystem.resolveKeyedSlot(player, from);
    const dst = InventorySystem.resolveKeyedSlot(player, to);
    if (!src || !dst) return { valid: false, message: 'Invalid swap target.' };
    const a = InventorySystem._readRef(player, src);
    const b = InventorySystem._readRef(player, dst);
    if (!a) return { valid: false, message: 'Slot is empty.' };
    const forward = InventorySystem.validateDestination(player, a, dst);
    if (!forward.valid) return forward;
    // A swap also moves the destination item into the source: both directions
    // must satisfy the strict slot-type rule.
    if (b) {
      const reverse = InventorySystem.validateDestination(player, b, src);
      if (!reverse.valid) return reverse;
    }
    return { valid: true, message: '' };
  }

  /**
   * Swaps a banked item (action bar or backpack) into a keyed slot
   * (`KeyQ`..`KeyR`, `Digit1`..`Digit4`) or back to the backpack. Equipment
   * destinations swap with the paperdoll; active destinations swap with the
   * action bar. Strict D1 §0.3 typing is enforced by `validateDestination`.
   *
   * @returns {{ success: boolean, message: string }}
   */
  static swapKeyedItem(player, from, to) {
    InventorySystem.ensureContainers(player);
    const src = InventorySystem.resolveKeyedSlot(player, from);
    const dst = InventorySystem.resolveKeyedSlot(player, to);
    if (!src || !dst) return { success: false, message: 'Invalid swap target.' };

    const a = InventorySystem._readRef(player, src);
    const b = InventorySystem._readRef(player, dst);

    const check = InventorySystem.validateDestination(player, a, dst);
    if (!check.valid) return { success: false, message: check.message };
    if (b) {
      const reverse = InventorySystem.validateDestination(player, b, src);
      if (!reverse.valid) return { success: false, message: reverse.message };
    }

    InventorySystem._writeRef(player, src, b || null);
    InventorySystem._writeRef(player, dst, a || null);
    InventorySystem.recomputeGearBonuses(player);

    const aName = a ? a.name : 'Empty';
    const bName = b ? b.name : 'Empty';
    return { success: true, message: `Swapped ${aName} ↔ ${bName}.` };
  }

  static consumeItem(player, item, removeCallback) {
    if (!item) return { success: false, message: 'No item to consume.' };
    const effect = item.effect || ITEMS_CATALOG[item.item_id]?.effect;
    const handler = effect && CONSUMABLE_EFFECTS[effect.kind];
    if (!handler) return { success: false, message: `Unknown consumable item: ${item.name}` };
    return handler(player, item, effect, removeCallback);
  }
}
