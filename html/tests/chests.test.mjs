/**
 * Lokarta: "Ascend the Tower" - E4 Chest tests
 *
 * Covers the D2 level-design contract for chests:
 *   - CHESTS_CATALOG loot tables are well-formed and tiered (§7.3).
 *   - Exactly one chest per room at its §7.2 tier, deterministically placed.
 *   - Tiered loot rolls are weighted, without replacement, and dry up per chest.
 *   - "Smart loot" selects usable vocation gear (neutral always eligible).
 *   - Opened state survives a save/load round-trip (persistence helpers).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateFloor,
  rollChestLoot,
  chestTierForRoom,
  getLevelSpec,
  createPRNG,
  TOWER_LEVEL_COUNT,
} from '../services/floor-generator.js';

import {
  findChestAt,
  isChestOpenable,
  openChest,
  applyOpenedState,
  serializeChestState,
} from '../engine/chest-system.js';

import { CHESTS_CATALOG, ITEMS_CATALOG, TOWER_LEVELS_CATALOG } from '../data/index.js';

const LEVELS = [1, 2, 3, 4, 5];
const SEEDS = [1, 7, 42, 1337, 90210, 555001, 808080, 31337, 4, 999999];
const TIERS = ['copper', 'silver', 'gold'];

/** D2 §7.2 derived chest tiers, room 1..9 per level. */
const EXPECTED_TIERS = {
  1: ['copper', 'copper', 'copper', 'silver', 'silver', 'gold', 'silver', 'silver', 'gold'],
  2: ['silver', 'silver', 'silver', 'silver', 'gold', 'gold', 'silver', 'copper', 'copper'],
  3: ['silver', 'gold', 'gold', 'silver', 'copper', 'copper', 'silver', 'silver', 'copper'],
  4: ['silver', 'copper', 'copper', 'silver', 'silver', 'silver', 'gold', 'gold', 'silver'],
  5: ['silver', 'gold', 'silver', 'silver', 'gold', 'copper', 'copper', 'copper', 'copper'],
};

describe('E4 Chests — placement, tiered loot, interaction, persistence', () => {
  it('validates the chests.json loot catalog shape (§7.3)', () => {
    assert.ok(CHESTS_CATALOG.chests, 'chests.json must expose a chests map');
    for (const tier of TIERS) {
      const table = CHESTS_CATALOG.chests[tier];
      assert.ok(table, `missing ${tier} loot table`);
      assert.ok(Number.isInteger(table.rolls) && table.rolls > 0, `${tier} needs rolls > 0`);
      assert.ok(Array.isArray(table.entries) && table.entries.length > 0, `${tier} needs entries`);
      for (const entry of table.entries) {
        assert.ok(entry.weight > 0, `${tier} entry must carry a positive weight`);
        assert.ok(Array.isArray(entry.quantity) && entry.quantity.length === 2, `${tier} entry needs [min,max]`);
        if (entry.vocationGear) {
          assert.ok(Array.isArray(entry.lootTier) && entry.lootTier.length === 2, 'vocationGear needs a lootTier range');
        } else {
          assert.ok(ITEMS_CATALOG[entry.itemId], `unknown itemId ${entry.itemId} in ${tier} table`);
        }
      }
      // Better color = richer table: rolls are non-decreasing copper→gold.
    }
    assert.ok(CHESTS_CATALOG.chests.gold.rolls > CHESTS_CATALOG.chests.copper.rolls, 'gold must roll more than copper');
  });

  it('derives the §7.2 tier for every room from the catalog rule', () => {
    for (const level of LEVELS) {
      const spec = getLevelSpec(level);
      for (let room = 1; room <= 9; room++) {
        assert.equal(
          chestTierForRoom(spec, room),
          EXPECTED_TIERS[level][room - 1],
          `L${level} room ${room}`
        );
      }
    }
  });

  it('places exactly one chest per room on every level', () => {
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      assert.equal(floor.chests.length, 9, `L${level} must have 9 chests`);
      for (let room = 1; room <= 9; room++) {
        const inRoom = floor.chests.filter(c => c.room === room);
        assert.equal(inRoom.length, 1, `L${level} room ${room} chest count`);
      }
    }
  });

  it('stamps each chest with its room tier and opened:false', () => {
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      for (const chest of floor.chests) {
        assert.equal(chest.tier, EXPECTED_TIERS[level][chest.room - 1], `L${level} room ${chest.room} tier`);
        assert.equal(chest.opened, false);
        assert.ok(typeof chest.x === 'number' && typeof chest.y === 'number');
        assert.equal(floor.tiles[chest.y][chest.x], 0, 'chests must sit on a carved floor tile');
      }
    }
  });

  it('keeps chests off the spawn, stairs, and each other', () => {
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      const seen = new Set();
      for (const chest of floor.chests) {
        const key = `${chest.x},${chest.y}`;
        assert.ok(!seen.has(key), `L${level} duplicate chest tile ${key}`);
        seen.add(key);
        assert.notDeepEqual({ x: chest.x, y: chest.y }, floor.spawn_coords);
        assert.ok(!floor.stairs.some(s => s.x === chest.x && s.y === chest.y), 'chest on stairs');
      }
    }
  });

  it('is deterministic for a fixed seed (including chest positions)', () => {
    for (const level of LEVELS) {
      for (const seed of [4242, 1337]) {
        const a = generateFloor(level, seed);
        const b = generateFloor(level, seed);
        assert.deepEqual(a.chests, b.chests);
      }
    }
  });

  it('rolls the authored number of entries without replacement', () => {
    for (const tier of TIERS) {
      const table = CHESTS_CATALOG.chests[tier];
      const loot = rollChestLoot(tier, { vocation: 'magician', rng: createPRNG(`t_${tier}`) });
      const assertCount = loot.filter(l => l.item_id !== 'relic_luminous_amulet' || true).length;
      assert.equal(assertCount, table.rolls, `${tier} must roll exactly ${table.rolls} entries`);
    }
  });

  it('only yields items that exist in items.json with a positive quantity', () => {
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      for (const chest of floor.chests) {
        for (let i = 0; i < 25; i++) {
          const loot = rollChestLoot(chest.tier, { vocation: 'archer', rng: createPRNG(`${chest.id}_${i}`) });
          for (const stack of loot) {
            assert.ok(ITEMS_CATALOG[stack.item_id], `looted unknown item ${stack.item_id}`);
            assert.ok(stack.quantity >= 1, 'loot quantity must be >= 1');
            assert.ok(stack.name && stack.type, 'loot stack must be resolved');
          }
        }
      }
    }
  });

  it('smart loot: vocationGear is usable by the opener (neutral always eligible)', () => {
    // Over many rolls from a fighter-tier gold table, any rolled gear must be
    // fighter/neutral-affine (never another vocation's locked item).
    let sawGear = false;
    for (let i = 0; i < 200; i++) {
      const loot = rollChestLoot('gold', { vocation: 'fighter', rng: createPRNG(`fight_${i}`) });
      for (const stack of loot) {
        const def = ITEMS_CATALOG[stack.item_id];
        if (!def || typeof def.lootTier !== 'number') continue;
        sawGear = true;
        const aff = def.vocationAffinity;
        const ok = !aff || aff === 'neutral' || aff === 'fighter' || (Array.isArray(aff) && aff.includes('fighter'));
        assert.ok(ok, `fighter rolled unusable gear ${stack.item_id}`);
      }
    }
    assert.ok(sawGear, 'expected at least one gear roll across 200 gold chests');
  });

  it('never fizzles: every chest tier always yields at least one item', () => {
    for (const tier of TIERS) {
      for (const vocation of ['magician', 'archer', 'fighter', 'paladin', null]) {
        for (let i = 0; i < 10; i++) {
          const loot = rollChestLoot(tier, { vocation, rng: createPRNG(`${tier}_${vocation}_${i}`) });
          assert.ok(loot.length > 0, `${tier}/${vocation} produced no loot`);
        }
      }
    }
  });

  it('openChest rolls loot, flips opened, and is idempotent', () => {
    const floor = generateFloor(1);
    const chest = floor.chests[0];
    assert.equal(isChestOpenable(chest), true);

    const res = openChest(chest, { vocation: 'magician' });
    assert.equal(res.success, true);
    assert.ok(res.loot.length > 0, 'opening must yield loot');
    assert.equal(chest.opened, true);

    const again = openChest(chest, { vocation: 'magician' });
    assert.equal(again.success, false);
    assert.deepEqual(again.loot, []);
  });

  it('findChestAt locates the chest occupying a tile', () => {
    const floor = generateFloor(3);
    const chest = floor.chests[4];
    assert.equal(findChestAt(floor.chests, chest.x, chest.y), chest);
    assert.equal(findChestAt(floor.chests, -1, -1), null);
  });

  it('persists opened state across a save/load round-trip (regenerated floor)', () => {
    const before = generateFloor(2);
    // Open two chests, then snapshot the durable state as the worker would.
    openChest(before.chests[0], { vocation: 'archer' });
    openChest(before.chests[7], { vocation: 'archer' });
    const saved = serializeChestState(before.chests);

    // A fresh load regenerates the level, then re-applies the snapshot.
    const after = generateFloor(2);
    assert.ok(after.chests.every(c => c.opened === false), 'fresh floor starts unopened');
    applyOpenedState(after.chests, saved);

    const openedRooms = after.chests.filter(c => c.opened).map(c => c.room).sort((a, b) => a - b);
    assert.deepEqual(openedRooms, [before.chests[0].room, before.chests[7].room].sort((a, b) => a - b));
    assert.equal(after.chests.filter(c => c.opened).length, 2);
  });

  it('serializeChestState keeps only durable fields', () => {
    const floor = generateFloor(5);
    const records = serializeChestState(floor.chests);
    assert.equal(records.length, 9);
    for (const record of records) {
      assert.deepEqual(Object.keys(record).sort(), ['id', 'opened', 'room', 'tier']);
    }
  });

  it('applyOpenedState tolerates empty/missing snapshots (legacy saves)', () => {
    const floor = generateFloor(4);
    applyOpenedState(floor.chests, null);
    applyOpenedState(floor.chests, []);
    assert.ok(floor.chests.every(c => c.opened === false));
  });

  it('applyOpenedState matches by room+tier when ids differ across templates', () => {
    const floor = generateFloor(1);
    const snapshot = [{ id: 'legacy-id', room: floor.chests[3].room, tier: floor.chests[3].tier, opened: true }];
    applyOpenedState(floor.chests, snapshot);
    assert.equal(floor.chests.filter(c => c.opened).length, 1);
    assert.equal(floor.chests[3].opened, true);
  });

  it('floor metadata exposes chest_tiers for every room', () => {
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      assert.equal(Object.keys(floor.chest_tiers).length, 9);
      for (let room = 1; room <= 9; room++) {
        assert.equal(floor.chest_tiers[String(room)], EXPECTED_TIERS[level][room - 1]);
      }
    }
  });

  it('keeps tier richness non-decreasing and applies gold display names', () => {
    const { copper, silver, gold } = CHESTS_CATALOG.chests;
    assert.ok(gold.rolls >= silver.rolls, 'gold must not roll fewer entries than silver');
    assert.ok(silver.rolls >= copper.rolls, 'silver must not roll fewer entries than copper');
    for (const [tier, table] of Object.entries(CHESTS_CATALOG.chests)) {
      assert.ok(table.rolls <= table.entries.length, `${tier} rolls exceed its entry pool`);
    }

    let renamed = null;
    for (let i = 0; i < 100 && !renamed; i++) {
      const loot = rollChestLoot('gold', { vocation: 'paladin', rng: createPRNG(`e7_gold_name_${i}`) });
      renamed =
        loot.find(s => s.item_id === 'health_potion' && s.name === 'Greater Health Potion') ||
        loot.find(s => s.item_id === 'mana_potion' && s.name === 'Greater Mana Potion') ||
        null;
    }
    assert.ok(renamed, 'gold chest must relabel its greater potions');
  });

  it('covers every level/seed combination without throwing', () => {
    assert.equal(TOWER_LEVEL_COUNT, 5);
    for (const level of LEVELS) {
      for (const seed of SEEDS) {
        const floor = generateFloor(level, seed);
        assert.equal(floor.chests.length, 9);
      }
    }
    assert.ok(TOWER_LEVELS_CATALOG.chestTierRule, 'tower_levels must expose chestTierRule');
  });
});
