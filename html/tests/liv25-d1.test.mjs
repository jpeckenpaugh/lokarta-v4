/**
 * D1 presentation reconciliation regression coverage.
 *
 * Pins the D1 items touched by the follow-up:
 *   - Tower Gate interactable in each floor's arrival room (D1 §0.4).
 *   - Strict slot-type rule (D1 §0.3) via `InventorySystem.validateMove`.
 *   - Role-aware key mapping (D1 §2.6) via `GestureEngine`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GestureEngine, InventorySystem, createPlayer, TILE_TYPES, CONFIG, EQUIPMENT_KEY_MAP } from '../engine/index.js';
import { generateFloor, getLevelSpec } from '../services/floor-generator.js';
import { ITEMS_CATALOG, UI_CATALOG, TOWER_LEVELS_CATALOG } from '../data/index.js';

const LEVELS = [1, 2, 3, 4, 5];

describe('Tower Gate (D1 §0.4)', () => {
  it('places exactly one walk-on town gate in each floor arrival room', () => {
    const policy = TOWER_LEVELS_CATALOG.townGatePolicy;
    assert.equal(policy.roomRole, 'entry');
    assert.equal(policy.countPerLevel, 1);
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      assert.equal(floor.town_gates.length, 1, `L${level} must place one town gate`);
      const gate = floor.town_gates[0];
      const spec = getLevelSpec(level);
      assert.equal(gate.room, spec.entryRoom, `L${level} gate sits in the arrival room`);
      assert.equal(floor.tiles[gate.y][gate.x], TILE_TYPES.TOWN_GATE, `L${level} gate tile type`);
      assert.equal(gate.propId, 'prop_town_gate');
    }
  });

  it('is deterministic for a fixed level', () => {
    const a = generateFloor(3).town_gates[0];
    const b = generateFloor(3).town_gates[0];
    assert.deepEqual({ x: a.x, y: a.y }, { x: b.x, y: b.y });
  });
});

describe('Role-aware key mapping (D1 §0.2/§2.6)', () => {
  it('maps active keys 1-4 to slot indices and equipment keys q/w/e/r to slots', () => {
    assert.equal(GestureEngine.keyToSlotIndex('1'), 0);
    assert.equal(GestureEngine.keyToSlotIndex('4'), 3);
    assert.equal(GestureEngine.keyToSlotIndex('5'), null);
    assert.equal(CONFIG.ACTIVE_SLOT_COUNT, 4);
    assert.equal(CONFIG.EQUIPMENT_SLOT_COUNT, 4);
    assert.equal(GestureEngine.keyToEquipmentSlot('q'), 'main_hand');
    assert.equal(GestureEngine.keyToEquipmentSlot('KeyW'), 'off_hand');
    assert.equal(GestureEngine.keyToEquipmentSlot('e'), 'armor');
    assert.equal(GestureEngine.keyToEquipmentSlot('r'), 'relic');
    assert.equal(GestureEngine.keyToEquipmentSlot('x'), null);
    assert.equal(EQUIPMENT_KEY_MAP.q, 'main_hand');
  });
});

describe('Strict slot typing (D1 §0.3)', () => {
  it('rejects equipment dropped into the wrong equipment key', () => {
    const player = createPlayer('magician');
    player.backpack[0] = { ...ITEMS_CATALOG.astral_scepter, quantity: 1 };
    const check = InventorySystem.validateMove(player, 'backpack:0', 'KeyE');
    assert.equal(check.valid, false);
    assert.equal(player.paperdoll.armor, null);
  });

  it('rejects equipment dropped into an active key and vice versa', () => {
    const player = createPlayer('magician');
    player.backpack[0] = { ...ITEMS_CATALOG.astral_scepter, quantity: 1 };
    player.backpack[1] = { ...ITEMS_CATALOG.health_potion, quantity: 1 };
    assert.equal(InventorySystem.validateMove(player, 'backpack:0', 'Digit1').valid, false);
    assert.equal(InventorySystem.validateMove(player, 'backpack:1', 'KeyQ').valid, false);
  });

  it('accepts a matching equipment key and an active item into 1-4', () => {
    const player = createPlayer('magician');
    player.backpack[0] = { ...ITEMS_CATALOG.astral_scepter, quantity: 1 };
    player.backpack[1] = { ...ITEMS_CATALOG.health_potion, quantity: 1 };
    assert.equal(InventorySystem.validateMove(player, 'backpack:0', 'KeyQ').valid, true);
    assert.equal(InventorySystem.validateMove(player, 'backpack:1', 'Digit1').valid, true);
  });

  it('rejects a wrong-vocation equipment key with an explicit reason', () => {
    const player = createPlayer('magician');
    player.backpack[0] = { ...ITEMS_CATALOG.tempered_broadsword, item_id: 'tempered_broadsword', quantity: 1 };
    const check = InventorySystem.validateMove(player, 'backpack:0', 'KeyQ');
    assert.equal(check.valid, false);
    assert.match(check.message, /Fighter/);
  });
});

describe('Entity bar catalog (D1 §3.2)', () => {
  it('exposes the D1 geometry + visibility fields', () => {
    assert.equal(UI_CATALOG.entityBars.widthPx, 24);
    assert.equal(UI_CATALOG.entityBars.bossWidthPx, 32);
    assert.equal(UI_CATALOG.entityBars.heightPx, 3);
    assert.equal(UI_CATALOG.entityBars.offsetAboveSpritePx, 6);
    assert.equal(UI_CATALOG.entityBars.playerShowWhen, 'always');
    assert.equal(UI_CATALOG.entityBars.enemyShowWhen, 'damaged');
  });
});
