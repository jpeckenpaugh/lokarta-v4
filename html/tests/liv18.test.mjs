/**
 * Lokarta: Regression coverage.
 *
 * Pins the E9 fixes for items 1, 3, 4, 5 of 
 *   1. Duplicate chest loot levels up the owned item instead of duplicating.
 *   3. Chests are placed against room walls (and remain reachable).
 *   4. Acquired silver/gold keys render in full color (active sprite variant).
 *   5. Enemies cannot phase through the magician's projectile/wave attacks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  GridMap,
  TILE_TYPES,
  InventorySystem,
  createPlayer,
} from '../engine/index.js';
import {
  generateFloor,
  getLevelSpec,
  assertNoSoftlock,
  validateFloorSoftlock,
  TOWER_LEVEL_COUNT,
} from '../services/floor-generator.js';
import {
  findOwnedItem,
  applyItemRankUp,
  canUpgradeItem,
} from '../engine/item-progression.js';
import {
  tilesOnSegment,
  firstMonsterOnSegment,
  isInSweptBeam,
  monstersCaughtByBeam,
  wouldSwapPlaces,
} from '../engine/projectile-collision.js';
import { HUDManager } from '../app/hud-manager.js';
import { DoorSystem } from '../engine/door-system.js';
import { ITEMS_CATALOG } from '../data/index.js';

const LEVELS = [1, 2, 3, 4, 5];
const TOWER_DIR = resolve(process.cwd(), 'html', 'assets', 'openmoji');

describe('Duplicate chest loot levels up the owned item', () => {
  it('addItem on an owned unique gear ranks it up instead of duplicating', () => {
    const player = createPlayer('magician');
    const staff = { ...ITEMS_CATALOG.astral_scepter, itemLevel: 1, damage: 20 };
    assert.equal(InventorySystem.addItem(player, { ...staff }).success, true);

    const res = InventorySystem.addItem(player, { ...staff });
    assert.equal(res.success, true);
    assert.equal(res.upgraded, true, 'duplicate must be an upgrade');
    assert.equal(player.paperdoll.main_hand.itemLevel, 2, 'owned staff reached rank 2');

    const copies = [
      ...player.action_bar,
      ...player.backpack,
      player.paperdoll.main_hand,
      player.paperdoll.off_hand,
      player.paperdoll.armor,
      player.paperdoll.relic,
    ].filter(s => s && s.item_id === 'astral_scepter');
    assert.equal(copies.length, 1, 'inventory must never hold duplicate unique gear');
  });

  it('an owned item at rank 5 ignores the duplicate (no second copy)', () => {
    const player = createPlayer('magician');
    const staff = { ...ITEMS_CATALOG.astral_scepter, itemLevel: 5, damage: 40 };
    player.paperdoll.main_hand = staff;

    const res = InventorySystem.addItem(player, { ...staff });
    assert.equal(res.success, true);
    assert.equal(res.duplicateIgnored, true);
    const copies = [player.paperdoll.main_hand, ...player.action_bar, ...player.backpack]
      .filter(s => s && s.item_id === 'astral_scepter');
    assert.equal(copies.length, 1, 'at max rank the duplicate is discarded, not stacked');
  });

  it('stackable consumables still stack (only unique gear ranks up)', () => {
    const player = createPlayer('magician');
    InventorySystem.addItem(player, { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 3 });
    const res = InventorySystem.addItem(player, { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 2 });
    assert.equal(res.success, true);
    const total = [...player.action_bar, ...player.backpack]
      .filter(s => s && s.item_id === 'health_potion')
      .reduce((n, s) => n + s.quantity, 0);
    assert.equal(total, 5, 'potions stack to 5, never discarded');
  });

  it('findOwnedItem resolves by item_id and shared actionKey, paperdoll first', () => {
    const player = createPlayer('magician');
    player.action_bar[0] = { item_id: 'apprentice_wand', actionKey: 'wand_spark', itemLevel: 1 };
    player.paperdoll.off_hand = { item_id: 'golden_wand_base', actionKey: 'wand_spark', itemLevel: 2 };

    // Exact held id resolves the held copy.
    assert.equal(findOwnedItem(player, { item_id: 'apprentice_wand' }), player.action_bar[0]);

    // A Golden variant sharing an actionKey but a different item_id resolves the
    // owned instance of that action (paperdoll searched before the action bar).
    const goldenVariant = { item_id: 'some_golden_wand', actionKey: 'wand_spark' };
    assert.equal(findOwnedItem(player, goldenVariant), player.paperdoll.off_hand);
  });

  it('applyItemRankUp is capped at rank 5 and reports the delta', () => {
    const player = createPlayer('magician');
    const staff = { ...ITEMS_CATALOG.astral_scepter, itemLevel: 4, damage: 30, stepDamageBonus: 0 };
    assert.equal(canUpgradeItem(staff), true);
    const result = applyItemRankUp(player, staff, { rng: { randomInt: () => 5 } });
    assert.equal(result.rank, 5);
    assert.ok(result.notes.length > 0);
    assert.equal(canUpgradeItem(staff), false, 'rank 5 cannot upgrade further');
    assert.equal(applyItemRankUp(player, staff), null);
  });

  it('opening a chest that rolls an owned item upgrades it end to end', () => {
    const player = createPlayer('magician');
    // Give the player a rank-1 Beam Staff (astral_scepter) and force its loot
    // to roll that exact item, then apply the roll the way the controller does.
    const staff = { ...ITEMS_CATALOG.astral_scepter, itemLevel: 1, damage: 20 };
    player.paperdoll.main_hand = staff;

    const rolledLoot = [{ ...ITEMS_CATALOG.astral_scepter, quantity: 1 }];
    for (const stack of rolledLoot) {
      const res = InventorySystem.addItem(player, { ...stack });
      assert.equal(res.upgraded, true);
    }
    assert.equal(player.paperdoll.main_hand.itemLevel, 2);
    assert.equal(player.paperdoll.main_hand.stepDamageBonus, 5, 'Beam Staff +5 wave dmg at rank 2');
  });
});

describe('Chests are placed against room walls', () => {
  it('every generated chest sits on a wall-adjacent walkable tile', () => {
    for (const level of LEVELS) {
      const floor = generateFloor(level);
      for (const chest of floor.chests) {
        const tile = floor.tiles[chest.y][chest.x];
        assert.notEqual(tile, TILE_TYPES.WALL, `L${level} room ${chest.room} chest on wall`);
        const neighbors = [
          floor.tiles[chest.y - 1]?.[chest.x],
          floor.tiles[chest.y + 1]?.[chest.x],
          floor.tiles[chest.y]?.[chest.x - 1],
          floor.tiles[chest.y]?.[chest.x + 1],
        ];
        const wallAdjacent = neighbors.some(n => n === undefined || n === TILE_TYPES.WALL);
        assert.ok(wallAdjacent, `L${level} room ${chest.room} chest not against a wall`);
      }
    }
  });

  it('chest wall placement holds across many seeds and levels', () => {
    for (const level of LEVELS) {
      for (const seed of [1, 7, 42, 1337, 90210, 555001, 31337]) {
        const floor = generateFloor(level, seed);
        for (const chest of floor.chests) {
          const n = [
            floor.tiles[chest.y - 1]?.[chest.x],
            floor.tiles[chest.y + 1]?.[chest.x],
            floor.tiles[chest.y]?.[chest.x - 1],
            floor.tiles[chest.y]?.[chest.x + 1],
          ];
          assert.ok(
            n.some(t => t === undefined || t === TILE_TYPES.WALL),
            `L${level} seed ${seed} chest room ${chest.room} floated mid-room`
          );
        }
      }
    }
  });

  it('generator + soft-lock oracles still pass on every level', () => {
    for (const level of LEVELS) {
      assert.equal(assertNoSoftlock(level), true, `L${level} soft-locked`);
      const result = validateFloorSoftlock(getLevelSpec(level));
      assert.equal(result.ok, true, `L${level} ${result.failures?.join('; ')}`);
      const floor = generateFloor(level);
      assert.equal(floor.chests.length, 9, `L${level} must still place 9 chests`);
    }
    assert.equal(TOWER_LEVEL_COUNT, 5);
  });
});

describe('Acquired keys render in full color', () => {
  it('silver/gold keys author a full-color active sprite variant', () => {
    for (const [tier, itemId] of [['copper', 'key_copper'], ['silver', 'key_silver'], ['gold', 'key_gold']]) {
      const item = ITEMS_CATALOG[itemId];
      assert.ok(item.svgCode, `${tier} key needs a locked sprite`);
      assert.ok(item.svgCodeActive, `${tier} key needs an active full-color sprite`);
      assert.notEqual(item.svgCodeActive, item.svgCode, `${tier} active sprite must differ`);
      assert.ok(
        existsSync(resolve(TOWER_DIR, `${item.svgCodeActive}.svg`)),
        `${tier} active asset ${item.svgCodeActive}.svg must exist`
      );
    }
  });

  it('renderKeyIndicators swaps to the full-color sprite once earned', () => {
    const player = createPlayer('magician');
    player.current_floor = 2;

    const locked = HUDManager.renderKeyIndicators(player);
    const silverLocked = locked.match(/data-tier="silver"[\s\S]*?src="\.\/assets\/openmoji\/([^"]+)\.svg"/);
    assert.ok(silverLocked, 'silver slot rendered');
    assert.equal(silverLocked[1], ITEMS_CATALOG.key_silver.svgCode, 'locked shows the neutral sprite');

    DoorSystem.grantKey(player, 2, 'silver');
    DoorSystem.grantKey(player, 2, 'gold');
    const active = HUDManager.renderKeyIndicators(player);
    assert.equal((active.match(/level-key active/g) || []).length, 2, 'two earned keys active');

    const silverActive = active.match(/level-key active[^>]*data-tier="silver"[\s\S]*?src="\.\/assets\/openmoji\/([^"]+)\.svg"/);
    assert.ok(silverActive, 'silver active slot rendered');
    assert.equal(
      silverActive[1],
      ITEMS_CATALOG.key_silver.svgCodeActive,
      'earned silver key renders the full-color sprite'
    );

    const goldActive = active.match(/level-key active[^>]*data-tier="gold"[\s\S]*?src="\.\/assets\/openmoji\/([^"]+)\.svg"/);
    assert.equal(goldActive[1], ITEMS_CATALOG.key_gold.svgCodeActive, 'earned gold key full color');
  });
});

describe('Enemies cannot phase through attacks', () => {
  it('tilesOnSegment covers the whole span (no skipped tiles)', () => {
    const tiles = tilesOnSegment(1, 1, 5, 1);
    assert.deepEqual(
      tiles.map(t => `${t.x},${t.y}`),
      ['1,1', '2,1', '3,1', '4,1', '5,1']
    );
  });

  it('firstMonsterOnSegment hits a monster that moved into the swept span', () => {
    // Projectile travelled from tile 1 to tile 5. A monster now stands at the
    // intermediate tile 3 (it swapped places) and must still be hit.
    const monsters = [{ id: 'm1', x: 3, y: 1, hp: 10 }];
    const hit = firstMonsterOnSegment(monsters, 1, 1, 5, 1, () => false);
    assert.ok(hit && hit.monster, 'monster in the swept span must be hit');
    assert.equal(hit.monster.id, 'm1');
    assert.equal(hit.tile.x, 3);
  });

  it('a wall stops the sweep before a monster behind it', () => {
    const monsters = [{ id: 'm1', x: 4, y: 1, hp: 10 }];
    const hit = firstMonsterOnSegment(monsters, 1, 1, 5, 1, (x) => x === 3);
    assert.equal(hit.stoppedByWall, true);
    assert.equal(hit.monster, null, 'monster behind the wall is not hit');
  });

  it('isInSweptBeam catches a monster that stepped behind the wave front', () => {
    // Beam origin (1,1) travelling right, front at step 2 (waves swept x=2,3,4).
    const geometry = { originX: 1, originY: 1, fX: 1, fY: 0, frontIndex: 2 };
    assert.equal(isInSweptBeam({ x: 2, y: 1 }, geometry.originX, geometry.originY, 1, 0, 2), true);
    assert.equal(isInSweptBeam({ x: 3, y: 1 }, geometry.originX, geometry.originY, 1, 0, 2), true);
    // A monster far in front is not yet swept.
    assert.equal(isInSweptBeam({ x: 8, y: 1 }, geometry.originX, geometry.originY, 1, 0, 2), false);
  });

  it('monstersCaughtByBeam re-catches a monster that swapped behind the front', () => {
    // Front at step 2. Monster "phaser" had been at x=5 then stepped back to
    // x=3 (already swept) — it must be caught, not passed through.
    const monsters = [
      { id: 'phaser', x: 3, y: 1, hp: 50 },
      { id: 'ahead', x: 6, y: 1, hp: 50 },
    ];
    const wave = [{ x: 4, y: 1, isWall: false }]; // current front tile
    const geometry = { originX: 1, originY: 1, fX: 1, fY: 0, frontIndex: 2 };
    const caught = monstersCaughtByBeam(monsters, wave, geometry, []);
    const ids = caught.map(m => m.id);
    assert.ok(ids.includes('phaser'), 'monster behind the front is re-caught');
    assert.ok(!ids.includes('ahead'), 'monster in front is not swept yet');
  });

  it('wouldSwapPlaces detects a monster/attack tile swap', () => {
    assert.equal(
      wouldSwapPlaces({ x: 4, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }),
      true,
      'moving into the tile the attack is leaving is a swap'
    );
    assert.equal(
      wouldSwapPlaces({ x: 5, y: 1 }, { x: 4, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }),
      false
    );
  });

  it('a beam wave catches a monster that walks back into a swept tile (integration)', async () => {
    const { LokartaApp } = await import('../app/app-controller.js');
    globalThis.soundFX = { play: () => {}, playAt: () => {} };
    globalThis.CONFIG = { GRID_SIZE: 64 };

    const mockApp = Object.create(LokartaApp.prototype);
    mockApp.particles = [];
    mockApp.floatingTexts = [];
    mockApp.logCombat = () => {};
    mockApp.addFloatingText = () => {};
    mockApp.triggerImpactBurst = () => {};
    mockApp.handleCombatResult = () => {};
    mockApp.gridMap = {
      width: 10,
      height: 10,
      isWall: () => false,
      isInBounds: () => true,
      isWalkable: () => true,
    };
    // Monster starts in front of the wave, then steps back into the swept zone.
    mockApp.monsters = [{ id: 'phaser', name: 'Goblin', x: 4, y: 1, hp: 100 }];
    mockApp.projectiles = [
      {
        type: 'energy_beam',
        sourceX: 1,
        sourceY: 1,
        fX: 1,
        fY: 0,
        currentWaveIndex: -1,
        elapsedMs: 0,
        stepIntervalMs: 100,
        stepDamage: [30, 30, 30, 30, 30],
        stepVolumes: [1, 1, 1, 1, 1],
        hitMonsterIds: [],
        waves: [
          { tiles: [{ x: 2, y: 1, isWall: false }] },
          { tiles: [{ x: 3, y: 1, isWall: false }] },
          { tiles: [{ x: 4, y: 1, isWall: false }] },
          { tiles: [{ x: 5, y: 1, isWall: false }] },
        ],
      },
    ];

    // Step 0 sweeps x=2; monster at x=4 is not caught yet.
    mockApp.updateAnimations(50);
    assert.equal(mockApp.monsters[0].hp, 100, 'monster ahead of the front is untouched');

    // Monster "swaps" backward into the already-swept tile x=2.
    mockApp.monsters[0].x = 2;
    mockApp.updateAnimations(50); // step 1 -> swept backstop catches it
    assert.ok(mockApp.monsters[0].hp < 100, 'monster that swapped into the swept zone is hit');
  });
});
