import test from 'node:test';
import assert from 'node:assert/strict';

import { composeSceneById } from '../services/scene-composer.js';
import { GridMap } from '../engine/grid-map.js';
import { NPCS_CATALOG, QUESTS_CATALOG } from '../data/index.js';
import { SPRITE_CATALOG, SPRITE_MANIFEST, PROP_CATALOG, PROP_MANIFEST } from '../assets/sprites/index.js';
import {
  buildNpcDef,
  listNpcArtifacts,
  NPC_ANIMATIONS,
} from '../../tools/integrate-npc-bake.mjs';
import {
  validateSpriteDef,
  paletteCapFor,
  nativePerTile,
} from '../../tools/validate-sprite-def.mjs';

test('LIV-134 3D-baked Havenreach NPCs & props', async (t) => {
  await t.test('1. every retained NPC ships a 3D-baked N64 runtime def (baked artifact linked)', () => {
    const artifacts = listNpcArtifacts();
    assert.equal(artifacts.length, NPCS_CATALOG.npcs.length, 'one baked artifact per NPC');
    for (const npc of NPCS_CATALOG.npcs) {
      const id = npc.npcSpriteId;
      assert.ok(artifacts.includes(id), `missing baked artifact for ${id}`);
      const def = SPRITE_CATALOG[id];
      assert.ok(def, `catalog missing ${id}`);
      assert.equal(def.kind, 'npc', `${id} kind`);
      assert.equal(def.baked3d, true, `${id} is 3D-baked`);
      assert.equal(def.renderTier, 'baked', `${id} renderTier`);
      assert.equal(def.outline, false, `${id} drops the outline`);
      assert.deepEqual(def.native, { w: 64, h: 64 }, `${id} N64 native`);
      assert.equal(nativePerTile(def), 64, `${id} is 64 px/tile`);
      assert.ok(Object.keys(def.palette).length <= paletteCapFor(def), `${id} palette cap`);
      assert.deepEqual(validateSpriteDef(def, { label: id }).errors, [], id);
    }
  });

  await t.test('2. only directional idle+walk are authored (renderer falls back)', () => {
    for (const npc of NPCS_CATALOG.npcs) {
      const def = SPRITE_CATALOG[npc.npcSpriteId];
      assert.deepEqual(Object.keys(def.animations).sort(), ['idle', 'walk'], `${def.id} states`);
      for (const dir of ['down', 'up', 'side']) {
        assert.deepEqual(def.animations.idle[dir], NPC_ANIMATIONS.idle[dir], `${def.id} idle ${dir}`);
        assert.deepEqual(def.animations.walk[dir], NPC_ANIMATIONS.walk[dir], `${def.id} walk ${dir}`);
        for (const fid of [...def.animations.idle[dir], ...def.animations.walk[dir]]) {
          assert.ok(def.frames[fid], `${def.id} missing frame ${fid}`);
        }
      }
      assert.equal(def.animations.walk.advanceOn, 'step', `${def.id} walk is step-driven`);
    }
  });

  await t.test('3. the runtime defs match the GLB-free integrator (no drift)', () => {
    for (const id of listNpcArtifacts()) {
      assert.deepEqual(SPRITE_CATALOG[id], buildNpcDef(id), `${id} drifted from the bake artifact`);
    }
    // The manifest mirrors the baked native/anchor + kind for every NPC.
    for (const npc of NPCS_CATALOG.npcs) {
      const meta = SPRITE_MANIFEST.actors[npc.npcSpriteId];
      assert.equal(meta.kind, 'npc', `${npc.npcSpriteId} manifest kind`);
      assert.deepEqual(meta.native, { w: 64, h: 64 }, `${npc.npcSpriteId} manifest native`);
      assert.deepEqual(meta.anchor, { x: 32, y: 62 }, `${npc.npcSpriteId} manifest anchor`);
    }
  });

  await t.test('4. quest givers stand in the top-row doorways, facing down, ids/quest wiring intact', () => {
    const byId = Object.fromEntries(NPCS_CATALOG.npcs.map((n) => [n.id, n]));
    const expected = [
      ['captain_halden', 3, 5, 'rats_in_the_gutter'],
      ['wick', 20, 5, 'the_lantern_wreck'],
      ['elder_rowan_vane', 12, 7, 'rite_of_the_beacon'],
    ];
    for (const [id, x, y, questId] of expected) {
      const npc = byId[id];
      assert.ok(npc, `${id} present`);
      assert.equal(npc.x, x, `${id} x`);
      assert.equal(npc.y, y, `${id} y`);
      assert.equal(npc.facing, 'down', `${id} faces down`);
      assert.equal(npc.aiType, 'stationary', `${id} stationary`);
      const quest = (QUESTS_CATALOG.quests || QUESTS_CATALOG).find((q) => q.id === questId);
      assert.equal(quest.giverNpcId, id, `${questId} giver wiring`);
    }
  });

  await t.test('5. the ! marker/stage chain is data-driven (Q2 after Q1, Q3 after Q2)', () => {
    const quests = QUESTS_CATALOG.quests || QUESTS_CATALOG;
    const byId = Object.fromEntries(quests.map((q) => [q.id, q]));
    assert.deepEqual(byId.rats_in_the_gutter.prerequisites || [], [], 'Q1 open at start');
    assert.deepEqual(byId.the_lantern_wreck.prerequisites, ['rats_in_the_gutter'], 'Q2 gated on Q1');
    assert.deepEqual(byId.rite_of_the_beacon.prerequisites, ['the_lantern_wreck'], 'Q3 gated on Q2');
  });

  await t.test('6. the four 3D props are catalogued and placed (barrel replaces the 2D barrel)', () => {
    for (const id of ['prop_wooden_barrel', 'prop_wooden_dock', 'prop_palm_tree', 'prop_rock_pile']) {
      assert.ok(PROP_CATALOG[id], `catalog missing ${id}`);
      assert.ok(PROP_MANIFEST[id], `manifest missing ${id}`);
      assert.equal(PROP_CATALOG[id].baked3d, true, `${id} 3D-baked`);
      assert.ok(PROP_CATALOG[id].camera && PROP_CATALOG[id].camera.rise === 60, `${id} at 60° baseline`);
    }
    const scene = composeSceneById('town_havenreach');
    const placed = scene.props;
    assert.ok(placed.some((p) => p.propId === 'prop_wooden_barrel' && p.x === 3 && p.y === 8 && p.layer === 'prop'), 'wooden barrel at (3,8)');
    assert.ok(placed.some((p) => p.propId === 'prop_wooden_dock' && p.layer === 'decor'), 'walk-over dock placed');
    assert.ok(placed.some((p) => p.propId === 'prop_palm_tree' && p.layer === 'prop'), 'palm placed');
    assert.ok(placed.some((p) => p.propId === 'prop_rock_pile' && p.layer === 'prop'), 'rock placed');
    assert.ok(!placed.some((p) => p.propId === 'prop_barrel'), '2D barrel retired from the town');
  });

  await t.test('7. no soft-lock: quest givers + shop/temple/inn stay reachable from spawn', () => {
    const scene = composeSceneById('town_havenreach');
    const grid = new GridMap();
    grid.loadFromMatrix(scene.tiles);
    for (const b of scene.buildings) {
      const fp = b.footprint;
      if (!Array.isArray(fp) || fp.length < 4) continue;
      for (let y = fp[1]; y <= fp[3]; y++) for (let x = fp[0]; x <= fp[2]; x++) grid.blockTile(x, y, true);
    }
    for (const p of scene.props) if (p.layer === 'prop') grid.blockTile(p.x, p.y, true);
    for (const n of scene.npcs) if (n.blocks !== false) grid.blockTile(n.x, n.y, true);

    const W = grid.width;
    const seen = new Set();
    const q = [scene.spawn];
    seen.add(scene.spawn.y * W + scene.spawn.x);
    for (let h = 0; h < q.length; h++) {
      const { x, y } = q[h];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = ny * W + nx;
        if (seen.has(k) || !grid.isWalkable(nx, ny)) continue;
        seen.add(k); q.push({ x: nx, y: ny });
      }
    }
    const reachable = (x, y) => seen.has(y * W + x);
    // The player can interact from any orthogonally adjacent reachable tile.
    const canReach = (x, y) => reachable(x + 1, y) || reachable(x - 1, y) || reachable(x, y + 1) || reachable(x, y - 1);
    for (const npc of scene.npcs) {
      const interactive = /quest|shop|temple|rest|dialogue/.test(JSON.stringify(npc.interact || {}));
      if (!interactive) continue;
      assert.ok(canReach(npc.x, npc.y), `${npc.id}@(${npc.x},${npc.y}) is unreachable (soft-lock)`);
    }
    for (const portal of scene.portals) {
      assert.ok(reachable(portal.x, portal.y), `portal ${portal.id} unreachable`);
    }
  });
});
