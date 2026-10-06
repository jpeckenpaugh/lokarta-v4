/**
 * Lokarta: Come Into The Light - Comprehensive Test Suite
 * Native Node.js test runner suite covering:
 * 1. Floor Generator (1-20)
 * 2. GridMap & Tile Bounds
 * 3. LightingSystem & LOS (10-Tile FOV)
 * 4. ProgressionSystem & 4 Vocations Leveling
 * 5. CombatSystem (No Class Multiplier) & Vocation-Locked Equipment
 * 6. InventorySystem (10 Action Slots, 6-Slot Backpack, 4-Slot Paperdoll)
 * 7. FateGrantSystem (5-Card Draft Offer & Placement)
 * 8. GestureEngine (Keys 1-9, 0 & Tap/Hold/Double-Tap)
 * 9. GameClient & Worker Protocol
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateFloor,
  getBiomeForFloor,
  BIOMES,
  FLOOR_TEMPLATE_VERSION,
} from '../services/floor-generator.js';

import {
  CONFIG,
  TILE_TYPES,
  DEFAULT_ARCHETYPES,
  createPlayer,
  GridMap,
  LightingSystem,
  ProgressionSystem,
  CombatSystem,
  EntityAI,
  InventorySystem,
  DoorSystem,
  FateGrantSystem,
  GestureEngine,
} from '../engine/index.js';

import { GameClient } from '../worker/game-client.js';
import { isStaleFloor } from '../worker/game-worker.js';

// ============================================================================
// 1. Floor Generator (1-20)
// ============================================================================

describe('Floor Generator (1-20)', () => {
  it('generates deterministic floors given the same seed', () => {
    const floorA = generateFloor(1, 4242);
    const floorB = generateFloor(1, 4242);

    assert.deepEqual(floorA.tiles, floorB.tiles);
    assert.deepEqual(floorA.spawn_coords, floorB.spawn_coords);
    assert.deepEqual(floorA.stairs_down_coords, floorB.stairs_down_coords);
    assert.equal(floorA.monsters.length, floorB.monsters.length);
    assert.deepEqual(floorA.items, floorB.items);
  });

  it('enforces 40x40 matrix boundaries on all floors 1 to 20', () => {
    for (let f = 1; f <= 20; f++) {
      const floor = generateFloor(f);
      assert.equal(floor.width, 40);
      assert.equal(floor.height, 40);
      assert.equal(floor.tiles.length, 40);
      for (let y = 0; y < 40; y++) {
        assert.equal(floor.tiles[y].length, 40);
      }
    }
  });

  it('places the level-1 spawn at the room-2 doorway and the stair room exit', () => {
    const floor1 = generateFloor(1);
    assert.deepEqual(floor1.spawn_coords, { x: 19, y: 2 });
    assert.equal(floor1.entry_room, 2);
    assert.deepEqual(floor1.stairs_down_coords, { x: 33, y: 33 });
    assert.equal(floor1.tiles[2][19], TILE_TYPES.FLOOR);
    assert.equal(floor1.tiles[33][33], TILE_TYPES.STAIRS);

    // Levels 2-5 spawn one tile off the arrival up-stair of the shaft.
    for (const level of [2, 3, 4, 5]) {
      const floor = generateFloor(level);
      assert.ok(floor.spawn_coords, `level ${level} must expose a spawn`);
      assert.equal(floor.tiles[floor.spawn_coords.y][floor.spawn_coords.x], TILE_TYPES.FLOOR);
      assert.equal(floor.tiles[floor.stairs_down_coords.y][floor.stairs_down_coords.x], TILE_TYPES.STAIRS);
    }
  });

  it('guarantees connectivity between the room-2 entry and the stair room on all floors', () => {
    for (let f = 1; f <= 20; f++) {
      const floor = generateFloor(f);
      const grid = new GridMap(40, 40);
      grid.loadFromMatrix(floor.tiles);

      // E3: gated doors physically block until keyed. This check owns the
      // structural guarantee, so unlock every gate (all keys earned) first.
      for (const [tier, gate] of Object.entries(floor.gates || {})) {
        for (const t of gate.tiles || []) {
          const tile = grid.getTile(t.x, t.y);
          if (tile) {
            tile.gateTier = tier;
            tile.gateOpen = false;
          }
        }
      }
      for (const tier of Object.keys(floor.gates || {})) {
        DoorSystem.openTierGates(grid, tier);
      }

      const start = floor.spawn_coords;
      const goal = floor.stairs_down_coords;
      const visited = new Set();
      const queue = [{ x: start.x, y: start.y }];
      visited.add(`${start.x},${start.y}`);
      let reachedStairs = false;

      while (queue.length > 0) {
        const { x, y } = queue.shift();
        if (x === goal.x && y === goal.y) {
          reachedStairs = true;
          break;
        }

        const neighbors = [
          { x: x + 1, y },
          { x: x - 1, y },
          { x, y: y + 1 },
          { x, y: y - 1 },
        ];

        for (const n of neighbors) {
          const key = `${n.x},${n.y}`;
          if (!visited.has(key) && grid.isWalkable(n.x, n.y)) {
            visited.add(key);
            queue.push(n);
          }
        }
      }

      assert.ok(reachedStairs, `Floor ${f} must have a walkable path from the entry to the stair room`);
    }
  });

  it('uses 64px tiles (CONFIG.GRID_SIZE = 64) for the graphics overhaul', () => {
    assert.equal(CONFIG.GRID_SIZE, 64, 'tile size must be 64x64 pixels to prepare for richer art');
  });

  it('keeps exterior walls exactly 1 tile thick on all floors', () => {
    for (let f = 1; f <= 20; f++) {
      const floor = generateFloor(f);
      const t = floor.tiles;

      // The outer ring (rows 0/39, cols 0/39) is wall and nothing more.
      for (let x = 0; x < 40; x++) {
        assert.equal(t[0][x], TILE_TYPES.WALL, `floor ${f}: exterior top (0,${x}) must be wall`);
        assert.equal(t[39][x], TILE_TYPES.WALL, `floor ${f}: exterior bottom (39,${x}) must be wall`);
      }
      for (let y = 0; y < 40; y++) {
        assert.equal(t[y][0], TILE_TYPES.WALL, `floor ${f}: exterior left (${y},0) must be wall`);
        assert.equal(t[y][39], TILE_TYPES.WALL, `floor ${f}: exterior right (${y},39) must be wall`);
      }

      // The ring is exactly 1 tile thick: the first interior row/col is open floor.
      assert.notEqual(t[1][1], TILE_TYPES.WALL, `floor ${f}: (1,1) must not be wall (exterior is 1 tile thick)`);
      assert.notEqual(t[1][38], TILE_TYPES.WALL, `floor ${f}: (1,38) must not be wall`);
      assert.notEqual(t[38][1], TILE_TYPES.WALL, `floor ${f}: (38,1) must not be wall`);
      assert.notEqual(t[38][38], TILE_TYPES.WALL, `floor ${f}: (38,38) must not be wall`);
    }
  });

  it('keeps internal room walls 1 tile thick (no 2x2 solid wall blocks) on all floors', () => {
    for (let f = 1; f <= 20; f++) {
      const floor = generateFloor(f);
      const t = floor.tiles;

      for (let y = 0; y < 39; y++) {
        for (let x = 0; x < 39; x++) {
          const solid2x2 =
            t[y][x] === TILE_TYPES.WALL &&
            t[y][x + 1] === TILE_TYPES.WALL &&
            t[y + 1][x] === TILE_TYPES.WALL &&
            t[y + 1][x + 1] === TILE_TYPES.WALL;
          assert.equal(solid2x2, false, `floor ${f}: 2x2 solid wall block at (${x},${y}) - internal walls must be 1 tile thick`);
        }
      }
    }
  });

  it('recovers significant internal floor space vs the legacy thick-walled layout', () => {
    for (let f = 1; f <= 20; f++) {
      const floor = generateFloor(f);
      let walls = 0;
      for (let y = 0; y < floor.height; y++) {
        for (let x = 0; x < floor.width; x++) {
          if (floor.tiles[y][x] === TILE_TYPES.WALL) walls++;
        }
      }
      // Legacy 40x40 layout used ~705-709 wall tiles; 1-tile walls use ~280-284,
      // reclaiming ~48% of the map as walkable interior space.
      assert.ok(
        walls <= 320,
        `floor ${f}: expected 1-tile walls to keep wall count low, got ${walls} wall tiles`
      );
    }
  });

  it('stamps every floor with the current template version so cached floors are invalidated', () => {
    assert.ok(FLOOR_TEMPLATE_VERSION >= 2, 'template version must be bumped for the 1-tile-wall overhaul');
    for (let f = 1; f <= 20; f++) {
      const floor = generateFloor(f);
      assert.equal(
        floor.template_version,
        FLOOR_TEMPLATE_VERSION,
        `floor ${f} must be stamped with the current template version`
      );
    }
  });

  it('assigns one tower tier per level for levels 1 to 5', () => {
    assert.equal(getBiomeForFloor(1).name, BIOMES.CRYPT.name);
    assert.equal(getBiomeForFloor(2).name, BIOMES.CATACOMBS.name);
    assert.equal(getBiomeForFloor(3).name, BIOMES.SHADOW_VAULTS.name);
    assert.equal(getBiomeForFloor(4).name, BIOMES.ABYSSAL_SANCTUM.name);
    assert.equal(getBiomeForFloor(5).name, BIOMES.CROWN_SPIRE.name);
    // Every level resolves to a distinct tier id/name.
    const names = new Set([1, 2, 3, 4, 5].map((l) => getBiomeForFloor(l).name));
    assert.equal(names.size, 5);
  });

  it('spawns The Spire Warden on the final level with exact stats (600 HP, 20 ATK, 6 DEF)', () => {
    const floor5 = generateFloor(5);
    const boss = floor5.monsters.find(m => m.type === 'abyssal_overlord');

    assert.ok(boss);
    assert.equal(boss.hp, 600);
    assert.equal(boss.max_hp, 600);
    assert.equal(boss.attack, 20);
    assert.equal(boss.defense, 6);
    assert.equal(boss.isBoss, true);
  });

  it('spawns a 3–4 monster group in every non-arrival room from the tower level pool', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const floor = generateFloor(level);
      const arrivalRooms = new Set([floor.entry_room, floor.stair_room]);
      // Boss and its guards are intentional final-floor content in room 5.
      const nonBoss = floor.monsters.filter(m => !m.isBoss && !m.isGuard);
      const expectedSize = level <= 2 ? 3 : 4;
      const byRoom = {};
      for (const m of nonBoss) byRoom[m.room] = (byRoom[m.room] || 0) + 1;
      // The entry room and stair room spawn no regular groups; the other
      // 7 rooms carry a group. Level 5's Summit (room 5) also holds the boss+guards.
      const expectedBase = 7 * expectedSize;
      assert.equal(nonBoss.length, expectedBase, `level ${level} must spawn regular groups only in non-arrival rooms`);
      for (const room of arrivalRooms) {
        assert.equal(byRoom[room], undefined, `level ${level} arrival room ${room} must have no regular group`);
      }
      assert.equal(Object.keys(byRoom).length, 7, `level ${level} regular groups must cover the 7 non-arrival rooms`);
    }
  });

  it('places the level-1 starter cache (arrows x22) near the spawn', () => {
    const floor1 = generateFloor(1);
    const spawnCoords = floor1.spawn_coords;

    const spawnArrows = floor1.items.find(i => i.item_id === 'arrows' && i.quantity === 22);
    assert.ok(spawnArrows, 'level-1 must carry the 22-arrow starter cache');
    assert.equal(spawnArrows.type, 'ammo');
    // Adjacent / near the player spawn (within the spawn room footprint).
    assert.ok(
      Math.abs(spawnArrows.x - spawnCoords.x) <= 8 && Math.abs(spawnArrows.y - spawnCoords.y) <= 8,
      'arrows starter cache must stay near the player spawn'
    );

    // Levels 2-5 use the health_potion starter cache from the catalog.
    // The Wooden Torch was removed, so no torch may be granted.
    for (const level of [2, 3, 4, 5]) {
      const floor = generateFloor(level);
      assert.ok(
        floor.items.some(i => i.item_id === 'health_potion'),
        `level ${level} starter cache must include a health potion`
      );
      assert.ok(
        !floor.items.some(i => i.item_id === 'torch'),
        `level ${level} starter cache must not include a removed torch`
      );
    }
  });
});

// ============================================================================
// 2. GridMap & Tile Bounds
// ============================================================================

describe('GridMap & Tile Bounds', () => {
  it('initializes an empty grid with specified dimensions filled with WALL tiles', () => {
    const grid = new GridMap(10, 15);
    assert.equal(grid.width, 10);
    assert.equal(grid.height, 15);
    assert.equal(grid.tiles.length, 15);
    assert.equal(grid.tiles[0].length, 10);
    assert.equal(grid.tiles[0][0].type, TILE_TYPES.WALL);
  });

  it('loads matrix data and correctly identifies tile types and bounds', () => {
    const matrix = [
      [1, 0, 2, 3],
    ];
    const grid = new GridMap(4, 1);
    grid.loadFromMatrix(matrix);

    assert.equal(grid.isWall(0, 0), true);
    assert.equal(grid.isWalkable(1, 0), true);
    assert.equal(grid.isStairs(2, 0), true);
    assert.equal(grid.isDoor(3, 0), true);
    assert.equal(grid.isInBounds(0, 0), true);
    assert.equal(grid.isInBounds(-1, 0), false);
  });

  it('manages tile items (add, get, pop, remove)', () => {
    const grid = new GridMap(10, 10);
    const item1 = { item_id: 'health_potion', name: 'Potion', quantity: 1 };
    const item2 = { item_id: 'potion', name: 'Potion', quantity: 2 };

    grid.addItem(3, 3, item1);
    grid.addItem(3, 3, item2);

    assert.equal(grid.getItems(3, 3).length, 2);
    assert.deepEqual(grid.popTopItem(3, 3), item2);
    assert.equal(grid.getItems(3, 3).length, 1);
    assert.deepEqual(grid.removeItem(3, 3, 0), item1);
    assert.equal(grid.getItems(3, 3).length, 0);
  });
});

// ============================================================================
// 3. LightingSystem & 10-Tile FOV
// ============================================================================

describe('LightingSystem & 10-Tile FOV', () => {
  it('computes player vision radius correctly (base: 10, degrading light spell: +3 -> +2 -> +1)', () => {
    const player = createPlayer('magician');

    // 1. Base vision: 10 tiles
    assert.equal(LightingSystem.computePlayerRadius(player), 10);

    // 2. The Wooden Torch was removed from the catalog, so a stray
    //    legacy torch stack no longer grants any light bonus.
    player.action_bar[0] = { item_id: 'torch' };
    assert.equal(LightingSystem.computePlayerRadius(player), 10);

    // 3. Light spell active degrading (+3 -> +2 -> +1)
    player.action_bar[0] = null;
    player.lightSpellTimer = 25; // 30-20s -> 13 tiles
    assert.equal(LightingSystem.computePlayerRadius(player), 13);

    player.lightSpellTimer = 15; // 19-10s -> 12 tiles
    assert.equal(LightingSystem.computePlayerRadius(player), 12);

    player.lightSpellTimer = 5;  // <10s -> 11 tiles
    assert.equal(LightingSystem.computePlayerRadius(player), 11);
  });

  it('casts light circle without wall occlusion', () => {
    const matrix = [
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0], // Wall at (3,2)
      [0, 0, 0, 0, 0, 0, 0],
    ];
    const grid = new GridMap(7, 4);
    grid.loadFromMatrix(matrix);

    LightingSystem.castLightCircle(grid, 1, 2, 5);

    assert.equal(grid.getTile(1, 2).isLit, true);
    assert.equal(grid.getTile(2, 2).isLit, true);
    assert.equal(grid.getTile(3, 2).isLit, true); // Wall illuminated
    assert.equal(grid.getTile(4, 2).isLit, true); // Illuminated through wall (no occlusion)
  });

  it('checks line of sight with Bresenham line', () => {
    const matrix = [
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0], // Wall at (2,1)
      [0, 0, 0, 0, 0],
    ];
    const grid = new GridMap(5, 3);
    grid.loadFromMatrix(matrix);

    assert.equal(LightingSystem.hasLineOfSight(grid, 0, 0, 4, 0), true);
    assert.equal(LightingSystem.hasLineOfSight(grid, 0, 1, 4, 1), false);
  });
});

// ============================================================================
// 4. ProgressionSystem & 4 Vocations Leveling
// ============================================================================

describe('ProgressionSystem & 4 Vocations Leveling', () => {
  it('supports 4 playable vocations with correct starting stats and empty inventories', () => {
    const vocations = ['magician', 'archer', 'fighter', 'paladin'];
    for (const v of vocations) {
      const p = createPlayer(v);
      assert.equal(p.vocation, v);
      assert.equal(p.level, 1);
      assert.equal(p.xp, 0);
      // 4 active slots (1-4) + 36-slot backpack (6x6).
      assert.equal(p.action_bar.length, 4);
      assert.ok(p.action_bar.every(s => s === null));
      assert.equal(p.backpack.length, 36);
      assert.ok(p.backpack.every(s => s === null));
      assert.ok(p.paperdoll.main_hand === null);
      assert.ok(p.paperdoll.off_hand === null);
      assert.ok(p.paperdoll.armor === null);
      assert.ok(p.paperdoll.relic === null);
    }

    assert.equal(DEFAULT_ARCHETYPES.magician.hp, 60);
    assert.equal(DEFAULT_ARCHETYPES.magician.mana, 150);
    assert.equal(DEFAULT_ARCHETYPES.archer.hp, 90);
    assert.equal(DEFAULT_ARCHETYPES.archer.mana, 80);
    assert.equal(DEFAULT_ARCHETYPES.fighter.hp, 140);
    assert.equal(DEFAULT_ARCHETYPES.fighter.mana, 30);
    assert.equal(DEFAULT_ARCHETYPES.paladin.hp, 120);
    assert.equal(DEFAULT_ARCHETYPES.paladin.mana, 90);
  });

  it('awards XP and scales stats per level for all 4 vocations', () => {
    // Magician (+8 HP, +16 MP)
    const mag = createPlayer('magician');
    ProgressionSystem.awardXP(mag, 100);
    assert.equal(mag.level, 2);
    assert.equal(mag.max_hp, 68);
    assert.equal(mag.max_mana, 166);

    // Archer (+14 HP, +8 MP)
    const arch = createPlayer('archer');
    ProgressionSystem.awardXP(arch, 100);
    assert.equal(arch.level, 2);
    assert.equal(arch.max_hp, 104);
    assert.equal(arch.max_mana, 88);

    // Fighter (+18 HP, +4 MP)
    const fgt = createPlayer('fighter');
    ProgressionSystem.awardXP(fgt, 100);
    assert.equal(fgt.level, 2);
    assert.equal(fgt.max_hp, 158);
    assert.equal(fgt.max_mana, 34);

    // Paladin (+15 HP, +10 MP)
    const pal = createPlayer('paladin');
    ProgressionSystem.awardXP(pal, 100);
    assert.equal(pal.level, 2);
    assert.equal(pal.max_hp, 135);
    assert.equal(pal.max_mana, 100);
  });
});

// ============================================================================
// 5. CombatSystem (No Class Multiplier) & Vocation-Locked Equipment
// ============================================================================

describe('CombatSystem (No Class Multiplier) & Vocation-Locked Equipment', () => {
  let grid;

  beforeEach(() => {
    grid = new GridMap(20, 20);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        grid.tiles[y][x].type = TILE_TYPES.FLOOR;
      }
    }
  });

  it('does not apply a legacy native-class multiplier (damage uses skillBoosts only)', () => {
    // Magician wielding a native weapon: base damage only, no 2.5x multiplier
    const mag = createPlayer('magician');
    mag.x = 2;
    mag.y = 2;
    const monster = { id: 'm1', name: 'Skeleton', type: 'crypt_skeleton', x: 4, y: 2, hp: 100, max_hp: 100 };

    const magRes = CombatSystem.executeWandSpark(mag, monster, grid, { damage: 100, manaCost: 1 });
    assert.equal(magRes.success, true);
    assert.equal(magRes.damageDealt, 100); // Base 1.0x skillBoosts - no class multiplier
    assert.equal(magRes.message.includes('Class Mastery'), false);

    // skillBoosts.damageMultiplier still scales damage (the real damage-boost path)
    const boosted = createPlayer('magician');
    boosted.x = 2;
    boosted.y = 2;
    boosted.skillBoosts.damageMultiplier = 2.5;
    const boostedRes = CombatSystem.executeWandSpark(boosted, monster, grid, { damage: 100, manaCost: 1 });
    assert.equal(boostedRes.success, true);
    assert.equal(boostedRes.damageDealt, 250); // 100 * skillBoots 2.5x, not class-based
  });

  it('applies 1.0x native base damage on spells and weapons without legacy multiplier', () => {
    // Magician Wand Spark: Native (1.0x base roll)
    const mag = createPlayer('magician');
    mag.x = 2;
    mag.y = 2;
    const monster = { id: 'm1', name: 'Skeleton', type: 'crypt_skeleton', x: 4, y: 2, hp: 100, max_hp: 100 };

    const magRes = CombatSystem.executeWandSpark(mag, monster, grid);
    assert.equal(magRes.success, true);
    assert.ok(magRes.damageDealt >= CONFIG.MAGICIAN_SPARK_DAMAGE_MIN);

    // Fighter Sword Slash: Native (1.0x base roll)
    const fgt = createPlayer('fighter');
    fgt.x = 2;
    fgt.y = 2;
    const adjMonster = { id: 'm2', name: 'Skeleton', type: 'crypt_skeleton', x: 3, y: 2, hp: 100, max_hp: 100 };

    const fgtRes = CombatSystem.executeSlash(fgt, adjMonster, grid);
    assert.equal(fgtRes.success, true);
    assert.ok(fgtRes.damageDealt >= CONFIG.FIGHTER_SLASH_DAMAGE_MIN);
  });

  it('extends Fighter melee reach one space beyond adjacent; out-of-reach targets whiff as a free swing', () => {
    // Player at (2,2). Orthogonal range-2 target at (4,2) -> dist 2.0 (in reach).
    const fgt = createPlayer('fighter');
    fgt.x = 2;
    fgt.y = 2;
    const range2 = { id: 'm1', name: 'Skeleton', type: 'crypt_skeleton', x: 4, y: 2, hp: 100, max_hp: 100 };
    const range2Res = CombatSystem.executeSlash(fgt, range2, grid);
    assert.equal(range2Res.success, true, 'orthogonal range-2 target must be within melee reach');
    assert.ok(range2Res.damageDealt >= CONFIG.FIGHTER_SLASH_DAMAGE_MIN);

    // Diagonal ("knight" ring) target at (4,3) -> dist ~2.24 (in reach).
    const fgt2 = createPlayer('fighter');
    fgt2.x = 2;
    fgt2.y = 2;
    const diag2 = { id: 'm2', name: 'Skeleton', type: 'crypt_skeleton', x: 4, y: 3, hp: 100, max_hp: 100 };
    const diag2Res = CombatSystem.executeSlash(fgt2, diag2, grid);
    assert.equal(diag2Res.success, true, 'diagonal range-2 target must be within melee reach');

    // Out of reach: target at (5,2) -> dist 3.0. Swing-always: the swing still
    // executes as a free swing (swoosh, no damage to the far target).
    const fgt3 = createPlayer('fighter');
    fgt3.x = 2;
    fgt3.y = 2;
    const far = { id: 'm3', name: 'Skeleton', type: 'crypt_skeleton', x: 5, y: 2, hp: 100, max_hp: 100 };
    const farRes = CombatSystem.executeSlash(fgt3, far, grid);
    assert.equal(farRes.success, true, 'swing-always: an out-of-reach target still executes a swing');
    assert.equal(far.hp, 100, 'an out-of-reach target must not take damage');
    assert.match(farRes.message, /cuts the air/i);
    const farSwoosh = farRes.projectiles.find(p => p.type === 'swoosh');
    assert.ok(farSwoosh, 'the free swing still emits a swoosh');
  });

  it('extends Paladin basic melee reach one space beyond adjacent; out-of-reach targets whiff as a free swing', () => {
    const pal = createPlayer('paladin');
    pal.x = 2;
    pal.y = 2;
    const range2 = { id: 'm1', name: 'Skeleton', type: 'crypt_skeleton', x: 4, y: 2, hp: 100, max_hp: 100 };
    const range2Res = CombatSystem.executeSlash(pal, range2, grid);
    assert.equal(range2Res.success, true, 'Paladin basic melee must hit a range-2 target');

    const palFar = createPlayer('paladin');
    palFar.x = 2;
    palFar.y = 2;
    const far = { id: 'm2', name: 'Skeleton', type: 'crypt_skeleton', x: 5, y: 2, hp: 100, max_hp: 100 };
    const farRes = CombatSystem.executeSlash(palFar, far, grid);
    assert.equal(farRes.success, true, 'swing-always: Paladin basic melee still swings for an out-of-reach target');
    assert.equal(far.hp, 100, 'out-of-reach target must not take damage');
  });

  it('emits a swoosh animation in the melee swing result', () => {
    const fgt = createPlayer('fighter');
    fgt.x = 2;
    fgt.y = 2;
    const target = { id: 'm1', name: 'Skeleton', type: 'crypt_skeleton', x: 4, y: 2, hp: 100, max_hp: 100 };

    const res = CombatSystem.executeSlash(fgt, target, grid);
    assert.equal(res.success, true);
    assert.ok(Array.isArray(res.projectiles), 'melee swing result must carry a projectiles array');
    const swoosh = res.projectiles.find(p => p.type === 'swoosh');
    assert.ok(swoosh, 'melee swing must emit a swoosh projectile');
    assert.equal(swoosh.sourceX, fgt.x);
    assert.equal(swoosh.sourceY, fgt.y);
    assert.equal(swoosh.targetX, target.x);
    assert.equal(swoosh.targetY, target.y);
    assert.ok(swoosh.durationMs > 0, 'swoosh must have a positive duration');
  });

  it('emits a swoosh with an arc radius that spans the ~2-tile melee reach', () => {
    const fgt = createPlayer('fighter');
    fgt.x = 2;
    fgt.y = 2;
    const target = { id: 'm1', name: 'Skeleton', type: 'crypt_skeleton', x: 4, y: 2, hp: 100, max_hp: 100 };

    const res = CombatSystem.executeSlash(fgt, target, grid);
    assert.equal(res.success, true);
    const swoosh = res.projectiles.find(p => p.type === 'swoosh');
    assert.ok(swoosh, 'melee swing must emit a swoosh projectile');
    assert.ok(
      swoosh.visual.arcRadiusTiles >= 1.6,
      `fighter swoosh arcRadiusTiles (${swoosh.visual.arcRadiusTiles}) must span the ~2-tile melee reach`
    );
  });

  it('Holy Strike hits one space beyond adjacent and emits a swoosh', () => {
    const pal = createPlayer('paladin');
    pal.x = 2;
    pal.y = 2;
    pal.mana = CONFIG.PALADIN_HOLY_STRIKE_MANA_COST * 2;
    const range2 = { id: 'm1', name: 'Skeleton', type: 'crypt_skeleton', x: 4, y: 2, hp: 100, max_hp: 100 };

    const res = CombatSystem.executeHolyStrike(pal, range2, grid);
    assert.equal(res.success, true, 'Holy Strike must hit a target one space beyond adjacent');
    assert.ok(res.damageDealt >= CONFIG.PALADIN_HOLY_STRIKE_DAMAGE_MIN, 'damage must register on the in-reach target');
    assert.equal(pal.mana, CONFIG.PALADIN_HOLY_STRIKE_MANA_COST, 'Holy Strike mana cost is consumed');
    const swoosh = res.projectiles.find(p => p.type === 'swoosh');
    assert.ok(swoosh, 'Holy Strike must emit a swoosh');
    assert.equal(swoosh.targetX, range2.x, 'Holy Strike swoosh is oriented toward the struck target');
    assert.equal(swoosh.targetY, range2.y);
  });

  it('a melee swing with no enemy in range still executes (swoosh, no damage, cooldown consumed)', () => {
    const fgt = createPlayer('fighter');
    fgt.x = 2;
    fgt.y = 2;
    fgt.facing = 'right';

    const res = CombatSystem.executeSlash(fgt, null, grid);
    assert.equal(res.success, true, 'swing must execute with no enemy in range');
    assert.equal(res.damageDealt, undefined, 'no damage registers when the damage area is empty');
    assert.match(res.message, /cuts the air/i);
    const swoosh = res.projectiles.find(p => p.type === 'swoosh');
    assert.ok(swoosh, 'the free swing emits a swoosh');
    assert.equal(fgt.cooldowns.slash, CONFIG.FIGHTER_SLASH_COOLDOWN_SEC, 'the free swing still consumes the cooldown');
  });

  it('a free swing damages an enemy inside the damage area (reach + facing arc)', () => {
    const fgt = createPlayer('fighter');
    fgt.x = 2;
    fgt.y = 2;
    fgt.facing = 'right';
    // Enemy directly ahead of the player at range 2 (inside reach and the 90° facing arc).
    const ahead = { id: 'm1', name: 'Skeleton', type: 'crypt_skeleton', x: 4, y: 2, hp: 100, max_hp: 100 };
    // Enemy behind the player at range 2 (inside reach but outside the facing arc).
    const behind = { id: 'm2', name: 'Skeleton', type: 'crypt_skeleton', x: 0, y: 2, hp: 100, max_hp: 100 };

    const res = CombatSystem.executeSlash(fgt, null, grid, { monsters: [ahead, behind], facing: 'right' });
    assert.equal(res.success, true);
    assert.ok(res.damageDealt >= CONFIG.FIGHTER_SLASH_DAMAGE_MIN, 'enemy inside the damage area must take damage');
    assert.equal(ahead.hp, 100 - res.damageDealt, 'the in-arc enemy takes the swing damage');
    assert.equal(behind.hp, 100, 'an enemy outside the facing arc is not hit');
    const swoosh = res.projectiles.find(p => p.type === 'swoosh');
    assert.ok(swoosh, 'the damaging free swing still emits a swoosh');
  });

  it('executes Archer Bow Shot and consumes arrows from Action Bar or Backpack', () => {
    const arch = createPlayer('archer');
    arch.action_bar[0] = { item_id: 'arrows', name: 'Arrows', type: 'ammo', quantity: 10 };
    arch.x = 2;
    arch.y = 2;
    const target = { id: 'm1', name: 'Rat', type: 'giant_rat', x: 5, y: 2, hp: 50, max_hp: 50 };

    const res = CombatSystem.executeBowShot(arch, target, grid);
    assert.equal(res.success, true);
    assert.equal(arch.action_bar[0].quantity, 9);
  });

  it('executes Paladin Healing Prayer and Holy Strike', () => {
    const pal = createPlayer('paladin');
    pal.hp = 50; // Damaged
    pal.mana = 90;

    const healRes = CombatSystem.executeHealingPrayer(pal);
    assert.equal(healRes.success, true);
    assert.ok(pal.hp > 50);
    assert.equal(pal.mana, 90 - CONFIG.PALADIN_HEAL_MANA_COST);

    pal.x = 2;
    pal.y = 2;
    const target = { id: 'm1', name: 'Skeleton', type: 'crypt_skeleton', x: 3, y: 2, hp: 100, max_hp: 100 };
    const strikeRes = CombatSystem.executeHolyStrike(pal, target, grid);
    assert.equal(strikeRes.success, true);
    assert.ok(strikeRes.damageDealt >= CONFIG.PALADIN_HOLY_STRIKE_DAMAGE_MIN);
  });
});

// ============================================================================
// 6. InventorySystem & Stacking
// ============================================================================

describe('InventorySystem & Stacking', () => {
  let grid;

  beforeEach(() => {
    grid = new GridMap(10, 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        grid.tiles[y][x].type = TILE_TYPES.FLOOR;
      }
    }
  });

  it('automatically picks up floor items into lowest empty Action Slot (0..9) first', () => {
    const player = createPlayer('magician');
    player.x = 2;
    player.y = 2;

    const pot = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 2, stat_bonus: 30 };
    grid.addItem(2, 2, pot);

    const res = InventorySystem.pickUpItem(player, grid);
    assert.equal(res.success, true);
    assert.equal(player.action_bar[0].item_id, 'health_potion');
    assert.equal(player.action_bar[0].quantity, 2);
  });

  it('equips items to 4 paperdoll slots (main_hand, off_hand, armor, relic)', () => {
    const player = createPlayer('fighter');
    player.action_bar[0] = { item_id: 'tempered_broadsword', name: 'Broadsword', type: 'weapon', quantity: 1 };
    player.action_bar[1] = { item_id: 'vanguard_shield', name: 'Vanguard Shield', type: 'offhand', quantity: 1 };
    player.action_bar[2] = { item_id: 'plate_armor', name: 'Plate Armor', type: 'armor', quantity: 1 };
    player.action_bar[3] = { item_id: 'relic_champions_crest', name: "Champion's Crest", type: 'relic', quantity: 1 };

    InventorySystem.equipItem(player, 'action_bar', 0);
    InventorySystem.equipItem(player, 'action_bar', 1);
    InventorySystem.equipItem(player, 'action_bar', 2);
    InventorySystem.equipItem(player, 'action_bar', 3);

    assert.equal(player.paperdoll.main_hand.item_id, 'tempered_broadsword');
    assert.equal(player.paperdoll.off_hand.item_id, 'vanguard_shield');
    assert.equal(player.paperdoll.armor.item_id, 'plate_armor');
    assert.equal(player.paperdoll.relic.item_id, 'relic_champions_crest');
  });

  it('rejects vocation-locked gear for the wrong class and accepts the correct class (array-aware)', () => {
    // Plate/crest are shared fighter+paladin gear (array affinity ["fighter","paladin"])
    const archer = createPlayer('archer');
    archer.action_bar[0] = { item_id: 'vanguard_shield', name: 'Vanguard Shield', type: 'offhand', slot: 'off_hand', quantity: 1 };
    const rejectArcher = InventorySystem.equipItem(archer, 'action_bar', 0);
    assert.equal(rejectArcher.success, false);
    assert.ok(rejectArcher.message.includes('Only a'));

    const magician = createPlayer('magician');
    magician.action_bar[0] = { item_id: 'plate_armor', name: 'Knight Plate Armor', type: 'armor', slot: 'armor', quantity: 1 };
    const rejectMagician = InventorySystem.equipItem(magician, 'action_bar', 0);
    assert.equal(rejectMagician.success, false);

    // Both Fighter and Paladin can equip the shared fighter/paladin gear
    const fighter = createPlayer('fighter');
    fighter.action_bar[0] = { item_id: 'vanguard_shield', name: 'Vanguard Shield', type: 'offhand', slot: 'off_hand', quantity: 1 };
    const fRes = InventorySystem.equipItem(fighter, 'action_bar', 0);
    assert.equal(fRes.success, true);
    assert.equal(fighter.paperdoll.off_hand.item_id, 'vanguard_shield');

    const paladin = createPlayer('paladin');
    paladin.action_bar[0] = { item_id: 'plate_armor', name: 'Knight Plate Armor', type: 'armor', slot: 'armor', quantity: 1 };
    const pRes = InventorySystem.equipItem(paladin, 'action_bar', 0);
    assert.equal(pRes.success, true);
    assert.equal(paladin.paperdoll.armor.item_id, 'plate_armor');
  });

  it('enforces class-specific gear affinity (archer/fighter/paladin sets)', () => {
    // Archer set: ranger_talisman equips for archers only
    const archer = createPlayer('archer');
    archer.action_bar[0] = { item_id: 'ranger_talisman', name: "Ranger's Talisman", type: 'relic', slot: 'relic', quantity: 1 };
    const ok = InventorySystem.equipItem(archer, 'action_bar', 0);
    assert.equal(ok.success, true);
    assert.equal(archer.paperdoll.relic.item_id, 'ranger_talisman');

    const fighter = createPlayer('fighter');
    fighter.action_bar[0] = { item_id: 'ranger_talisman', name: "Ranger's Talisman", type: 'relic', slot: 'relic', quantity: 1 };
    assert.equal(InventorySystem.equipItem(fighter, 'action_bar', 0).success, false);

    // Fighter set: iron_helm for fighters only
    const fg = createPlayer('fighter');
    fg.action_bar[0] = { item_id: 'iron_helm', name: 'Iron Helm', type: 'relic', slot: 'relic', quantity: 1 };
    assert.equal(InventorySystem.equipItem(fg, 'action_bar', 0).success, true);
    assert.equal(fg.paperdoll.relic.item_id, 'iron_helm');

    const archer2 = createPlayer('archer');
    archer2.action_bar[0] = { item_id: 'iron_helm', name: 'Iron Helm', type: 'relic', slot: 'relic', quantity: 1 };
    assert.equal(InventorySystem.equipItem(archer2, 'action_bar', 0).success, false);

    // Paladin set: holy_crown for paladins only
    const pal = createPlayer('paladin');
    pal.action_bar[0] = { item_id: 'holy_crown', name: 'Holy Crown', type: 'relic', slot: 'relic', quantity: 1 };
    assert.equal(InventorySystem.equipItem(pal, 'action_bar', 0).success, true);
    assert.equal(pal.paperdoll.relic.item_id, 'holy_crown');

    const fighter2 = createPlayer('fighter');
    fighter2.action_bar[0] = { item_id: 'holy_crown', name: 'Holy Crown', type: 'relic', slot: 'relic', quantity: 1 };
    assert.equal(InventorySystem.equipItem(fighter2, 'action_bar', 0).success, false);
  });

  it('unequips items from paperdoll into the backpack (bank rule)', () => {
    const player = createPlayer('magician');
    player.paperdoll.main_hand = { item_id: 'apprentice_wand', name: 'Apprentice Wand', type: 'weapon', quantity: 1 };

    const res = InventorySystem.unequipItem(player, 'main_hand');
    assert.equal(res.success, true);
    assert.equal(player.paperdoll.main_hand, null);
    assert.equal(player.backpack[0].item_id, 'apprentice_wand', 'unequipped gear banks into the backpack');
  });
});

// ============================================================================
// 7. FateGrantSystem
// ============================================================================

describe('FateGrantSystem', () => {
  it('generates a 5-card draft offer containing vocation-aligned or neutral cards at Level 1', () => {
    const vocations = ['magician', 'archer', 'fighter', 'paladin'];
    for (const v of vocations) {
      const offer = FateGrantSystem.generateDraftOffer(v, 1);
      assert.equal(offer.cards.length, 5);
      assert.equal(offer.requiredSelections.min, 2);
      assert.equal(offer.requiredSelections.max, 2);

      const invalidOffClass = offer.cards.some(c => {
        if (!c.vocationAffinity || c.vocationAffinity === 'neutral') return false;
        if (Array.isArray(c.vocationAffinity)) return !c.vocationAffinity.includes(v);
        return c.vocationAffinity !== v;
      });
      assert.equal(invalidOffClass, false, `Level 1 draft offer for ${v} must not contain off-class cards`);
    }
  });

  it('applies drafted cards into empty action slots then backpack', () => {
    const player = createPlayer('archer');
    const grid = new GridMap(10, 10);
    const offer = FateGrantSystem.generateDraftOffer('archer', 1);

    const chosenCards = offer.cards.slice(0, 2);
    const result = FateGrantSystem.applyDraftedCards(player, chosenCards, grid);

    assert.ok(result.addedToHotbar.length + result.addedToBackpack.length >= 2);
    // Drafted items populate either main_hand/off_hand paperdoll (auto-equip), action_bar or backpack
    const hasItemPlaced = player.paperdoll.main_hand !== null || player.paperdoll.off_hand !== null || player.action_bar[0] !== null || player.backpack[0] !== null;
    assert.ok(hasItemPlaced);
  });

  it('guarantees every level-1 grant offers >=1 main_hand and >=1 off_hand for all 4 vocations', () => {
    const vocations = ['magician', 'archer', 'fighter', 'paladin'];
    for (const v of vocations) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const offer = FateGrantSystem.generateDraftOffer(v, 1);
        const hasMainHand = offer.cards.some((c) => FateGrantSystem.resolveCardSlot(c) === 'main_hand');
        const hasOffHand = offer.cards.some((c) => FateGrantSystem.resolveCardSlot(c) === 'off_hand');
        assert.ok(hasMainHand, `${v} level-1 offer must include a main_hand card (attempt ${attempt})`);
        assert.ok(hasOffHand, `${v} level-1 offer must include an off_hand card (attempt ${attempt})`);
        assert.equal(offer.cards.length, 5, `${v} level-1 offer stays a 5-card draft`);
      }
    }
  });

  it('level-1 hand-slot rule injects an offered card WITHOUT equipping or forcing selection', () => {
    const vocations = ['magician', 'archer', 'fighter', 'paladin'];
    for (const v of vocations) {
      const player = createPlayer(v);
      const offer = FateGrantSystem.generateDraftOffer(player, 1);

      // The OFFER must carry both hand slots…
      assert.ok(offer.cards.some((c) => FateGrantSystem.resolveCardSlot(c) === 'main_hand'), `${v} must offer main_hand`);
      assert.ok(offer.cards.some((c) => FateGrantSystem.resolveCardSlot(c) === 'off_hand'), `${v} must offer off_hand`);

      // …but the rule only guarantees the offer: nothing is auto-equipped and
      // the player's paperdoll, action bar and backpack stay untouched.
      assert.equal(player.paperdoll.main_hand, null, `${v} main_hand must not be auto-equipped`);
      assert.equal(player.paperdoll.off_hand, null, `${v} off_hand must not be auto-equipped`);
      assert.equal(player.paperdoll.armor, null, `${v} armor must not be auto-equipped`);
      assert.equal(player.paperdoll.relic, null, `${v} relic must not be auto-equipped`);
      assert.ok(player.action_bar.every((s) => s === null), `${v} action_bar must stay empty`);
      assert.ok(player.backpack.every((s) => s === null), `${v} backpack must stay empty`);
      assert.equal(offer.requiredSelections.min, 2);
      assert.equal(offer.requiredSelections.max, 2);
    }
  });

  it('keeps level >1 drafts unaffected by the hand-slot rule (guard is level-1 only)', () => {
    const originalDatabase = FateGrantSystem.CARD_DATABASE;
    const originalShuffle = FateGrantSystem.shuffle;
    try {
      // Deterministic pool + no-op shuffle: with shuffle disabled the draft
      // takes the pool order, so a 5-card sample naturally omits the off_hand
      // card that sits at the end. Only the level-1 guard may inject it.
      FateGrantSystem.CARD_DATABASE = [
        { id: 'c_main', name: 'Broadsword', rarity: 'common', icon: 'x', vocationAffinity: 'fighter', item: { item_id: 'tempered_broadsword' } },
        { id: 'c_f1', name: 'Potion', rarity: 'common', icon: 'x', item: { item_id: 'mana_potion' } },
        { id: 'c_f2', name: 'Arrows', rarity: 'common', icon: 'x', item: { item_id: 'arrows' } },
        { id: 'c_f3', name: 'Potion', rarity: 'common', icon: 'x', item: { item_id: 'health_potion' } },
        { id: 'c_f4', name: 'Potion', rarity: 'common', icon: 'x', item: { item_id: 'mana_potion' } },
        { id: 'c_off', name: 'Vanguard Shield', rarity: 'common', icon: 'x', vocationAffinity: ['fighter', 'paladin'], item: { item_id: 'vanguard_shield' } },
      ];
      FateGrantSystem.shuffle = () => {};

      const levelTwo = FateGrantSystem.generateDraftOffer('fighter', 2);
      assert.equal(levelTwo.cards.length, 5);
      assert.equal(levelTwo.cards.some((c) => FateGrantSystem.resolveCardSlot(c) === 'off_hand'), false,
        'level 2 draft must NOT receive the off_hand injection');

      const levelOne = FateGrantSystem.generateDraftOffer('fighter', 1);
      assert.equal(levelOne.cards.length, 5);
      assert.equal(levelOne.cards.some((c) => FateGrantSystem.resolveCardSlot(c) === 'main_hand'), true,
        'level 1 draft must include a main_hand card');
      assert.equal(levelOne.cards.some((c) => FateGrantSystem.resolveCardSlot(c) === 'off_hand'), true,
        'level 1 draft must include an off_hand card (injected by the guard)');
    } finally {
      FateGrantSystem.CARD_DATABASE = originalDatabase;
      FateGrantSystem.shuffle = originalShuffle;
    }
  });

  it('converts duplicate wand/staff offers into Level Up upgrades up to Rank 5', () => {
    const player = createPlayer('magician');
    player.action_bar[0] = { item_id: 'apprentice_wand', name: 'Spark Wand', type: 'weapon', damage: 14, range: 5, manaCost: 1, itemLevel: 1 };

    let wandCard = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const offer = FateGrantSystem.generateDraftOffer(player, 2);
      wandCard = offer.cards.find(c => c.targetItemId === 'apprentice_wand');
      if (wandCard) break;
    }
    assert.ok(wandCard);
    assert.equal(wandCard.isUpgrade, true);
    assert.equal(wandCard.targetItemLevel, 1);

    FateGrantSystem.applyDraftedCards(player, [wandCard]);
    const wand = player.action_bar[0];
    assert.equal(wand.itemLevel, 2);
    assert.ok(wand.damage >= 18 && wand.damage <= 20); // +4-6 damage
    assert.equal(wand.range, 6);
    assert.equal(wand.manaCost, 2);

    // Max rank cap check at Rank 5
    wand.itemLevel = 5;
    const maxOffer = FateGrantSystem.generateDraftOffer(player, 6);
    const hasSpark = maxOffer.cards.some(c => c.targetItemId === 'apprentice_wand' || c.item?.item_id === 'apprentice_wand');
    assert.equal(hasSpark, false);
  });

  it('auto-equips Luminous Amulet to Relic slot and scales Max HP/MP by +5 per rank up to Rank 5', () => {
    const player = createPlayer('magician');
    const baseHp = player.max_hp;
    const baseMana = player.max_mana;

    const relicCard = {
      id: 'card_relic_luminous_amulet',
      name: 'Luminous Relic Amulet',
      item: { item_id: 'relic_luminous_amulet', name: 'Luminous Amulet', type: 'relic', slot: 'relic', itemLevel: 1 }
    };

    FateGrantSystem.applyDraftedCards(player, [relicCard]);
    assert.equal(player.paperdoll.relic?.item_id, 'relic_luminous_amulet');
    assert.equal(player.max_hp, baseHp + 5);
    assert.equal(player.max_mana, baseMana + 5);

    // Test Level Up card conversion & application to Rank 2
    let upgradeCard = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const offer = FateGrantSystem.generateDraftOffer(player, 2);
      upgradeCard = offer.cards.find(c => c.targetItemId === 'relic_luminous_amulet');
      if (upgradeCard) break;
    }
    assert.ok(upgradeCard);
    assert.equal(upgradeCard.isUpgrade, true);

    FateGrantSystem.applyDraftedCards(player, [upgradeCard]);
    assert.equal(player.paperdoll.relic.itemLevel, 2);
    assert.equal(player.max_hp, baseHp + 10);
    assert.equal(player.max_mana, baseMana + 10);
  });

  it("auto-equips Apprentice's Cape to Armor slot and scales Power Pulse up to Rank 5", () => {
    const player = createPlayer('magician');

    const capeCard = {
      id: 'card_apprentice_cape',
      name: "Apprentice's Cape",
      item: { item_id: 'apprentice_cape', name: "Apprentice's Cape", type: 'armor', slot: 'armor', itemLevel: 1 }
    };

    FateGrantSystem.applyDraftedCards(player, [capeCard]);
    assert.equal(player.paperdoll.armor?.item_id, 'apprentice_cape');
    assert.equal(player.paperdoll.armor?.itemLevel, 1);

    // Test Level Up upgrade to Rank 2
    let upgradeCard = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const offer = FateGrantSystem.generateDraftOffer(player, 2);
      upgradeCard = offer.cards.find(c => c.targetItemId === 'apprentice_cape');
      if (upgradeCard) break;
    }
    assert.ok(upgradeCard);
    assert.equal(upgradeCard.isUpgrade, true);

    FateGrantSystem.applyDraftedCards(player, [upgradeCard]);
    assert.equal(player.paperdoll.armor.itemLevel, 2);
  });
});

// ============================================================================
// 8. GestureEngine
// ============================================================================

describe('GestureEngine', () => {
  it('maps number keys 1-4 to the 4 active slots; 5-0 are unbound', () => {
    assert.equal(GestureEngine.keyToSlotIndex('1'), 0);
    assert.equal(GestureEngine.keyToSlotIndex('2'), 1);
    assert.equal(GestureEngine.keyToSlotIndex('4'), 3);
    assert.equal(GestureEngine.keyToSlotIndex('5'), null);
    assert.equal(GestureEngine.keyToSlotIndex('0'), null);
    assert.equal(GestureEngine.keyToSlotIndex('w'), null);

    assert.equal(GestureEngine.slotIndexToHotkey(0), '1');
    assert.equal(GestureEngine.slotIndexToHotkey(3), '4');
    assert.equal(GestureEngine.slotIndexToHotkey(4), '');
  });
});

// ============================================================================
// 9. GameClient & Worker Protocol
// ============================================================================

describe('GameClient & Worker Protocol', () => {
  class MockWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this.isTerminated = false;
    }

    postMessage(msg) {
      const { id, command, payload } = msg;
      queueMicrotask(() => {
        if (this.isTerminated) return;
        if (command === 'bootstrap') {
          this.onmessage?.({
            data: {
              id,
              ok: true,
              data: {
                player: createPlayer('fighter'),
                profile: { id: 'default_profile', soundEnabled: true },
                activeFloor: generateFloor(1),
              },
            },
          });
        } else if (command === 'newGame') {
          this.onmessage?.({
            data: {
              id,
              ok: true,
              data: {
                player: createPlayer(payload.vocation || 'magician'),
                floor: generateFloor(1),
              },
            },
          });
        }
      });
    }

    terminate() {
      this.isTerminated = true;
    }
  }

  it('bootstraps and initializes new game via client', async () => {
    const mockWorker = new MockWorker();
    const client = new GameClient(mockWorker);

    const bData = await client.bootstrap();
    assert.ok(bData.player);
    assert.equal(bData.player.vocation, 'fighter');

    const nData = await client.newGame('paladin');
    assert.equal(nData.player.vocation, 'paladin');

    client.terminate();
  });

  it('flags cached floors from older templates as stale so they regenerate', () => {
    // Missing floor -> stale
    assert.equal(isStaleFloor(null), true);
    assert.equal(isStaleFloor(undefined), true);

    // Floor stamped with the current template -> fresh
    assert.equal(isStaleFloor({ template_version: FLOOR_TEMPLATE_VERSION }), false);

    // Floor baked by the legacy thick-walled layout (v1 / no stamp) -> stale
    assert.equal(isStaleFloor({ template_version: 1 }), true);
    assert.equal(isStaleFloor({ floor_number: 2 }), true);
    assert.equal(isStaleFloor({ floor_number: 2, template_version: FLOOR_TEMPLATE_VERSION - 1 }), true);

    // Regression: every freshly generated floor is considered fresh
    for (let f = 1; f <= 20; f++) {
      assert.equal(isStaleFloor(generateFloor(f)), false, `floor ${f} from current template must not be stale`);
    }
  });
});
