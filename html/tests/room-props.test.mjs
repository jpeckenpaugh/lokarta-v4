/**
 * Lokarta: D4 room props & themed decor
 *
 * Locks the placement contract in docs/art-direction-room-props.md:
 * manifest completeness, FLOOR-only non-overlapping placement, wall-class
 * invariants, chest spacing, non-blocking reachability, determinism, the
 * soft-lock oracle, chest-against-wall placement, per-level set identity, and
 * the bounded brazier light budget.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateFloor,
  validateFloorConnectivity,
  validateFloorSoftlock,
  TILE_TYPES,
} from '../services/floor-generator.js';
import { GridMap } from '../engine/index.js';
import { TILE_THEMES_CATALOG, TOWER_LEVELS_CATALOG } from '../data/index.js';
import { PROP_MANIFEST, PROP_CATALOG } from '../assets/sprites/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPRITES_DIR = path.join(HERE, '..', 'assets', 'sprites');
const LEVELS = [1, 2, 3, 4, 5];
const SEEDS = [1, 7, 42, 1337, 90210];
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function hasWallNeighbour(tiles, x, y) {
  return ORTHO.some(([dx, dy]) => {
    const row = tiles[y + dy];
    return !row || row[x + dx] === undefined || row[x + dx] === TILE_TYPES.WALL;
  });
}

/** Every entity tile a prop must never share (D4 §5 safety invariant). */
function entityTiles(floor) {
  const set = new Set();
  for (const s of floor.stairs) set.add(`${s.x},${s.y}`);
  set.add(`${floor.spawn_coords.x},${floor.spawn_coords.y}`);
  if (floor.entry) set.add(`${floor.entry.x},${floor.entry.y}`);
  for (const c of floor.chests) set.add(`${c.x},${c.y}`);
  for (const m of floor.monsters) set.add(`${m.x},${m.y}`);
  for (const it of floor.items) set.add(`${it.x},${it.y}`);
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      if (floor.tiles[y][x] === TILE_TYPES.WALL) set.add(`${x},${y}`);
    }
  }
  return set;
}

describe('D4 room props & decor', () => {
  it('1. every themed prop/decor resolves in the manifest + catalog and its file exists', () => {
    for (const [n, lv] of Object.entries(TILE_THEMES_CATALOG.levels)) {
      const block = lv.props;
      assert.ok(block, `level ${n} missing props block`);
      for (const id of block.set) {
        const key = `prop_${id}`;
        assert.ok(PROP_MANIFEST[key], `L${n} manifest missing ${key}`);
        assert.ok(PROP_CATALOG[key], `L${n} catalog missing ${key}`);
        assert.equal(PROP_MANIFEST[key].kind, 'prop', `${key} kind`);
        assert.ok(['wall', 'free'].includes(PROP_MANIFEST[key].class), `${key} class`);
        assert.ok(fs.existsSync(path.join(SPRITES_DIR, PROP_MANIFEST[key].file)), `${key} file missing`);
      }
      for (const id of block.decor) {
        const key = `decor_${id}`;
        assert.ok(PROP_MANIFEST[key], `L${n} manifest missing ${key}`);
        assert.ok(PROP_CATALOG[key], `L${n} catalog missing ${key}`);
        assert.equal(PROP_MANIFEST[key].kind, 'decor', `${key} kind`);
        assert.ok(fs.existsSync(path.join(SPRITES_DIR, PROP_MANIFEST[key].file)), `${key} file missing`);
      }
      assert.ok(block.set.includes(block.focal), `L${n} focal ${block.focal} must be in set`);
    }
  });

  it('2-5. props are FLOOR-only, unique, clear of entities/chests, class-correct and non-blocking', () => {
    const policy = TOWER_LEVELS_CATALOG.propPolicy;
    for (const lv of LEVELS) {
      const theme = TILE_THEMES_CATALOG.levels[String(lv)].props;
      for (const seed of SEEDS) {
        const floor = generateFloor(lv, seed);
        const entities = entityTiles(floor);
        const chestAdj = new Set();
        for (const c of floor.chests) {
          chestAdj.add(`${c.x},${c.y}`);
          for (const [dx, dy] of ORTHO) chestAdj.add(`${c.x + dx},${c.y + dy}`);
        }

        const seen = new Set();
        const perRoom = {};
        for (const prop of floor.props) {
          const key = `${prop.x},${prop.y}`;
          assert.equal(floor.tiles[prop.y][prop.x], TILE_TYPES.FLOOR, `L${lv}/${seed} ${prop.propId} off FLOOR`);
          assert.ok(!entities.has(key), `L${lv}/${seed} ${prop.propId} overlaps an entity at ${key}`);
          assert.ok(!chestAdj.has(key), `L${lv}/${seed} ${prop.propId} is adjacent to a chest`);
          assert.ok(!seen.has(key), `L${lv}/${seed} duplicate prop tile ${key}`);
          seen.add(key);
          assert.ok(prop.layer === 'prop' || prop.layer === 'decor', `L${lv}/${seed} bad layer`);

          const def = PROP_CATALOG[prop.propId];
          assert.ok(def, `catalog missing ${prop.propId}`);
          if (def.class === 'wall') {
            assert.ok(hasWallNeighbour(floor.tiles, prop.x, prop.y), `L${lv}/${seed} wall prop ${prop.propId} lacks a WALL neighbour`);
          }
          if (prop.layer === 'prop') perRoom[prop.room] = (perRoom[prop.room] || 0) + 1;
        }

        for (const [roomStr, count] of Object.entries(perRoom)) {
          const room = Number(roomStr);
          assert.ok(count <= theme.maxPerRoom, `L${lv}/${seed} room ${room} exceeds maxPerRoom`);
          assert.ok(count <= theme.density, `L${lv}/${seed} room ${room} exceeds density`);
          if (lv === 5 && room === policy.bossRoomFixed.room) continue;
          const tier = floor.room_tiers[String(room)];
          let cap = Math.min(policy.countByRoomTier[String(tier)], theme.maxPerRoom, theme.density);
          if (room === floor.entry_room || room === floor.stair_room) cap = Math.min(cap, policy.arrivalRoomMax);
          assert.ok(count <= cap, `L${lv}/${seed} room ${room} count ${count} > cap ${cap}`);
        }

        const grid = new GridMap();
        grid.loadFromMatrix(floor.tiles);
        for (const prop of floor.props) {
          // Furniture props block, floor decor stays walk-over.
          if (prop.layer === 'prop') {
            grid.blockTile(prop.x, prop.y, true);
            assert.equal(grid.isWalkable(prop.x, prop.y), false, `L${lv}/${seed} furniture ${prop.propId} must block`);
          } else {
            assert.equal(grid.isWalkable(prop.x, prop.y), true, `L${lv}/${seed} decor ${prop.propId} must stay walkable`);
          }
        }
        // Blocking decor must never wall off the spawn from a stair.
        assert.equal(validateFloorConnectivity(floor).ok, true, `L${lv}/${seed} floor not connected`);
      }
    }
  });

  it('6. props are deterministic for a fixed (level, seed)', () => {
    for (const lv of LEVELS) {
      for (const seed of [1, 7, 42]) {
        assert.deepEqual(generateFloor(lv, seed).props, generateFloor(lv, seed).props, `L${lv}/${seed} props drift`);
      }
    }
  });

  it('6b. the D2 §10 soft-lock oracle stays green across seeds', () => {
    for (const lv of LEVELS) {
      for (const seed of SEEDS) {
        const result = validateFloorSoftlock(lv);
        assert.equal(result.ok, true, `L${lv}/${seed}: ${result.failures.join('; ')}`);
      }
    }
  });

  it('7. every chest sits against a wall, exactly one per room', () => {
    for (const lv of LEVELS) {
      for (const seed of SEEDS) {
        const floor = generateFloor(lv, seed);
        assert.equal(floor.chests.length, 9, `L${lv}/${seed} chest count`);
        assert.equal(new Set(floor.chests.map(c => c.room)).size, 9, `L${lv}/${seed} chest rooms`);
        for (const chest of floor.chests) {
          assert.ok(hasWallNeighbour(floor.tiles, chest.x, chest.y), `L${lv}/${seed} chest room ${chest.room} not against a wall`);
        }
      }
    }
  });

  it('8. per-level identity: props are a subset of the theme set and L1 differs from L4', () => {
    const observed = lv => {
      const set = new Set(TILE_THEMES_CATALOG.levels[String(lv)].props.set);
      const ids = generateFloor(lv, 42).props.filter(p => p.layer === 'prop').map(p => p.propId.replace(/^prop_/, ''));
      for (const id of ids) assert.ok(set.has(id), `L${lv} placed ${id} outside its themed set`);
      return new Set(ids);
    };
    const l1 = observed(1);
    const l4 = observed(4);
    assert.notEqual([...l1].sort().join(','), [...l4].sort().join(','), 'L1 and L4 prop sets must differ');
  });

  it('9. brazier ambient lights are bounded and correspond to placed braziers', () => {
    const policy = TOWER_LEVELS_CATALOG.propPolicy;
    for (const lv of LEVELS) {
      for (const seed of SEEDS) {
        const floor = generateFloor(lv, seed);
        const braziers = floor.props.filter(p => p.propId === 'prop_brazier');
        const lights = floor.ambient_lights.filter(l => l.radius === policy.brazierLightRadius);
        assert.ok(lights.length <= policy.maxBrazierLights, `L${lv}/${seed} exceeds maxBrazierLights`);
        assert.ok(lights.length <= braziers.length, `L${lv}/${seed} brazier light without a brazier`);
        for (const light of lights) {
          assert.ok(braziers.some(b => b.x === light.x && b.y === light.y), `L${lv}/${seed} brazier light off any brazier`);
        }
      }
    }
  });
});
