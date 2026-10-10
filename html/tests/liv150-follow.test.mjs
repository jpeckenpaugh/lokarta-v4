import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeNpcRuntime,
  spawnNpcsForScene,
  updateNpcs,
  NEUTRAL_AI_HANDLERS,
} from '../engine/npc-system.js';
import { composeSceneById } from '../services/scene-composer.js';
import { GridMap } from '../engine/grid-map.js';
import { NPCS_CATALOG, listNpcDefinitions } from '../data/index.js';

// LIV-150: data-driven `follow` aiType — Kes (child_kes) trails Young Tam
// (pilgrims_apprentice_tam). The handler resolves its leader by id at runtime, so
// there is no per-name branch in the engine.

/** A fully walkable `w x h` grid (tile code 10 = PATH). */
function openGrid(w, h) {
  const matrix = Array.from({ length: h }, () => Array(w).fill(10));
  const grid = new GridMap(w, h);
  grid.loadFromMatrix(matrix);
  return grid;
}

/** Current actor-occupancy hash set for every NPC in `npcs`. */
function occupancy(npcs, width) {
  const set = new Set();
  for (const n of npcs) set.add(n.y * width + n.x);
  return set;
}

test('LIV-150 follower AI', async (t) => {
  await t.test('makeNpcRuntime forwards followTargetId + followDistance', () => {
    const def = NPCS_CATALOG.npcs.find((n) => n.id === 'child_kes');
    const kes = makeNpcRuntime(def);
    assert.equal(kes.aiType, 'follow');
    assert.equal(kes.followTargetId, 'pilgrims_apprentice_tam');
    assert.ok(kes.followDistance >= 1, 'followDistance authored or defaulted');
    assert.ok(NEUTRAL_AI_HANDLERS.follow, 'follow aiType has a dispatch handler');
  });

  await t.test('Kes is marked to follow Young Tam in the same scene', () => {
    const byId = Object.fromEntries(NPCS_CATALOG.npcs.map((n) => [n.id, n]));
    const kes = byId.child_kes;
    const tam = byId.pilgrims_apprentice_tam;
    assert.equal(kes.aiType, 'follow');
    assert.equal(kes.followTargetId, 'pilgrims_apprentice_tam');
    assert.equal(kes.sceneId, tam.sceneId, 'follower and leader share a scene');
  });

  await t.test('the behavior is generic: any npc can follow any named npc', () => {
    const leader = makeNpcRuntime({ id: 'leader_x', name: 'Leader X', x: 1, y: 1, aiType: 'stationary' });
    const kid = makeNpcRuntime({
      id: 'kid', name: 'Kid', x: 6, y: 1, aiType: 'follow', followTargetId: 'leader_x', followDistance: 1,
    });
    const npcs = [kid, leader];
    const grid = openGrid(10, 4);
    const moved = updateNpcs(npcs, grid, 1, occupancy(npcs, grid.width));
    assert.equal(moved, 1, 'the follower stepped toward its leader');
    assert.deepEqual({ x: kid.x, y: kid.y }, { x: 5, y: 1 }, 'closed one tile of the gap');
    assert.equal(kid.facing, 'left', 'faces its movement direction');
  });

  await t.test('holds position and faces the leader once inside followDistance', () => {
    const leader = makeNpcRuntime({ id: 'lead', name: 'Lead', x: 5, y: 5, aiType: 'stationary' });
    const kid = makeNpcRuntime({
      id: 'kid', name: 'Kid', x: 5, y: 8, aiType: 'follow', followTargetId: 'lead', followDistance: 3,
    });
    const npcs = [kid, leader];
    const grid = openGrid(12, 12);
    const moved = updateNpcs(npcs, grid, 1, occupancy(npcs, grid.width));
    assert.equal(moved, 0, 'did not step while inside the trailing gap');
    assert.deepEqual({ x: kid.x, y: kid.y }, { x: 5, y: 8 }, 'stayed put');
    assert.equal(kid.facing, 'up', 'turned to watch the leader');
  });

  await t.test('never steps onto the leader, a wall, or another occupied actor', () => {
    const grid = openGrid(8, 8);
    // A partial wall column between follower and leader forces a detour.
    for (let y = 1; y < 7; y++) grid.blockTile(3, y, true);
    const leader = makeNpcRuntime({ id: 'lead', name: 'Lead', x: 6, y: 3, aiType: 'stationary' });
    const kid = makeNpcRuntime({
      id: 'kid', name: 'Kid', x: 1, y: 3, aiType: 'follow', followTargetId: 'lead', followDistance: 1,
    });
    const npcs = [kid, leader];
    let sawDetour = false;
    for (let i = 0; i < 60; i++) {
      const occupied = occupancy(npcs, grid.width);
      updateNpcs(npcs, grid, 1, occupied);
      assert.ok(grid.isWalkable(kid.x, kid.y), `follower stays walkable (${kid.x},${kid.y})`);
      assert.ok(!(kid.x === leader.x && kid.y === leader.y), 'follower never stacks on the leader');
      assert.ok(kid.x !== 3 || kid.y === 0 || kid.y === 7, `follower never enters a wall tile (${kid.x},${kid.y})`);
      if (kid.y !== 3 && kid.x < 3) sawDetour = true;
    }
    assert.ok(sawDetour, 'path found a way around the wall instead of stalling on it');
  });

  await t.test('rejects a tile claimed by the player/monster occupancy set', () => {
    const leader = makeNpcRuntime({ id: 'lead', name: 'Lead', x: 1, y: 5, aiType: 'stationary' });
    const kid = makeNpcRuntime({
      id: 'kid', name: 'Kid', x: 5, y: 5, aiType: 'follow', followTargetId: 'lead', followDistance: 1,
    });
    const npcs = [kid, leader];
    const grid = openGrid(10, 10);
    const occupied = occupancy(npcs, grid.width);
    occupied.add(5 * grid.width + 4); // a monster/allied actor on tile (4,5)
    updateNpcs(npcs, grid, 1, occupied);
    assert.ok(!(kid.x === 4 && kid.y === 5), 'did not step onto the occupied tile');
    assert.deepEqual({ x: kid.x, y: kid.y }, { x: 5, y: 5 });
  });

  await t.test('a follower with no resolvable target stays put', () => {
    const kid = makeNpcRuntime({
      id: 'kid', name: 'Kid', x: 4, y: 4, aiType: 'follow', followTargetId: 'ghost', followDistance: 1,
    });
    const grid = openGrid(10, 10);
    const moved = updateNpcs([kid], grid, 1, occupancy([kid], grid.width));
    assert.equal(moved, 0);
    assert.deepEqual({ x: kid.x, y: kid.y }, { x: 4, y: 4 });
  });

  await t.test('step cadence throttles movement between ticks', () => {
    const leader = makeNpcRuntime({ id: 'lead', name: 'Lead', x: 5, y: 2, aiType: 'stationary' });
    const kid = makeNpcRuntime({
      id: 'kid', name: 'Kid', x: 5, y: 9, aiType: 'follow', followTargetId: 'lead', followDistance: 2,
    });
    const npcs = [kid, leader];
    const grid = openGrid(12, 14);
    assert.equal(updateNpcs(npcs, grid, 1, occupancy(npcs, grid.width)), 1, 'steps when the cadence elapses');
    const after = { x: kid.x, y: kid.y };
    assert.equal(updateNpcs(npcs, grid, 0.05, occupancy(npcs, grid.width)), 0, 'waits out the cadence');
    assert.deepEqual({ x: kid.x, y: kid.y }, after, 'did not move on the short tick');
    assert.equal(updateNpcs(npcs, grid, 1, occupancy(npcs, grid.width)), 1, 'steps again after the cadence');
  });

  await t.test('converges to the trailing distance and is deterministic', () => {
    const run = () => {
      const leader = makeNpcRuntime({ id: 'lead', name: 'Lead', x: 10, y: 2, aiType: 'stationary' });
      const kid = makeNpcRuntime({
        id: 'kid', name: 'Kid', x: 2, y: 10, aiType: 'follow', followTargetId: 'lead', followDistance: 2,
      });
      const npcs = [kid, leader];
      const grid = openGrid(14, 14);
      for (let i = 0; i < 200; i++) updateNpcs(npcs, grid, 1, occupancy(npcs, grid.width));
      return { kid: { x: kid.x, y: kid.y }, leader: { x: leader.x, y: leader.y } };
    };
    const a = run();
    const b = run();
    assert.deepEqual(a, b, 'identical inputs produce identical trails');
    const dist = Math.abs(a.kid.x - a.leader.x) + Math.abs(a.kid.y - a.leader.y);
    assert.ok(dist <= 2, `settled inside followDistance (got ${dist})`);
    assert.notDeepEqual(a.kid, a.leader, 'never stacks on the leader');
  });

  await t.test('town integration: Kes trails Tam without stacking or clipping', () => {
    const scene = composeSceneById('town_havenreach');
    const grid = new GridMap();
    grid.loadFromMatrix(scene.tiles);
    const npcs = spawnNpcsForScene(scene);
    const kes = npcs.find((n) => n.npcId === 'child_kes');
    const tam = npcs.find((n) => n.npcId === 'pilgrims_apprentice_tam');
    assert.ok(kes && tam, 'Kes and Tam spawn in the town');
    for (let i = 0; i < 600; i++) {
      updateNpcs(npcs, grid, 0.25, occupancy(npcs, grid.width));
      assert.notDeepEqual({ x: kes.x, y: kes.y }, { x: tam.x, y: tam.y }, 'Kes never stacks on Tam');
      assert.ok(grid.isWalkable(kes.x, kes.y), `Kes stays on walkable tiles (${kes.x},${kes.y})`);
    }
  });

  await t.test('the catalog only authors real follow targets', () => {
    const ids = new Set(listNpcDefinitions().map((n) => n.id));
    for (const npc of NPCS_CATALOG.npcs) {
      if (npc.aiType === 'follow') {
        assert.ok(npc.followTargetId && ids.has(npc.followTargetId), `${npc.id} target resolves`);
      }
    }
  });
});
