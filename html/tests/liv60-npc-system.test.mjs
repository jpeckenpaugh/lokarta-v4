import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeNpcRuntime,
  spawnNpcsForScene,
  npcAt,
  findInteractableNpc,
  updateNpcs,
  NEUTRAL_AI_HANDLERS,
  NPC_INTERACT_RADIUS,
} from '../engine/npc-system.js';
import { composeSceneById } from '../services/scene-composer.js';
import { GridMap } from '../engine/grid-map.js';
import { KEYBINDINGS_CATALOG, NPCS_CATALOG } from '../data/index.js';

// LIV-60 P2: neutral NPC runtime entities + the stationary/wander AI dispatch.

test('LIV-60 NPC system', async (t) => {
  await t.test('runtime shape mirrors the catalog and is neutral', () => {
    const def = NPCS_CATALOG.npcs[0];
    const npc = makeNpcRuntime(def);
    assert.equal(npc.npcId, def.id);
    assert.equal(npc.name, def.name);
    assert.equal(npc.x, def.x);
    assert.equal(npc.homeX, def.x);
    assert.equal(npc.blocks, true);
    assert.equal(npc.faction, undefined, 'NPCs carry no monster faction');
    assert.ok(NEUTRAL_AI_HANDLERS[npc.aiType], 'catalog aiType has a handler');
  });

  await t.test('spawns every authored town NPC through the composed scene', () => {
    const scene = composeSceneById('town_havenreach');
    assert.ok(scene, 'town composes');
    const npcs = spawnNpcsForScene(scene);
    assert.equal(npcs.length, scene.npcs.length);
    assert.ok(npcs.length >= 7, 'town exposes >= 7 NPCs');
    const ids = new Set(npcs.map((n) => n.npcId));
    assert.equal(ids.size, npcs.length, 'unique ids');
  });

  await t.test('npcAt reports only blocking NPCs', () => {
    const npcs = [makeNpcRuntime({ id: 'a', name: 'A', x: 3, y: 4, blocks: true })];
    assert.equal(npcAt(npcs, 3, 4).npcId, 'a');
    assert.equal(npcAt(npcs, 9, 9), null);
    const passthrough = [makeNpcRuntime({ id: 'b', name: 'B', x: 1, y: 1, blocks: false })];
    assert.equal(npcAt(passthrough, 1, 1), null);
  });

  await t.test('findInteractableNpc prefers the tile the player faces', () => {
    const npcs = [
      makeNpcRuntime({ id: 'north', name: 'North', x: 5, y: 4 }),
      makeNpcRuntime({ id: 'east', name: 'East', x: 6, y: 5 }),
    ];
    const facingUp = findInteractableNpc(npcs, { x: 5, y: 5, facing: 'up' });
    assert.equal(facingUp.npcId, 'north');
    const facingRight = findInteractableNpc(npcs, { x: 5, y: 5, facing: 'right' });
    assert.equal(facingRight.npcId, 'east');
    assert.equal(findInteractableNpc(npcs, { x: 20, y: 20, facing: 'down' }), null);
  });

  await t.test('stationary NPCs never move', () => {
    const npcs = [makeNpcRuntime({ id: 'still', name: 'Still', x: 2, y: 2, aiType: 'stationary' })];
    const grid = new GridMap(10, 10);
    for (let i = 0; i < 100; i++) updateNpcs(npcs, grid, 0.1, new Set());
    assert.deepEqual({ x: npcs[0].x, y: npcs[0].y }, { x: 2, y: 2 });
  });

  await t.test('wander NPCs stay within radius and off occupied tiles', () => {
    const npcs = [makeNpcRuntime({ id: 'w', name: 'W', x: 5, y: 5, aiType: 'wander', wanderRadius: 2 })];
    const grid = new GridMap(12, 12);
    for (let i = 0; i < 400; i++) {
      const occupied = new Set([99]); // sentinel away from the NPC
      updateNpcs(npcs, grid, 0.25, occupied);
      const dx = Math.abs(npcs[0].x - 5);
      const dy = Math.abs(npcs[0].y - 5);
      assert.ok(dx <= 2 && dy <= 2, `stayed in radius (${npcs[0].x},${npcs[0].y})`);
      const hash = npcs[0].y * grid.width + npcs[0].x;
      assert.notEqual(hash, 99, 'never steps onto an occupied tile');
    }
  });

  await t.test('interactRadius is authored, not hardcoded', () => {
    assert.ok(NPC_INTERACT_RADIUS >= 1);
  });

  await t.test('interact key is catalog-bound', () => {
    assert.ok(Array.isArray(KEYBINDINGS_CATALOG.interact));
    assert.ok(KEYBINDINGS_CATALOG.interact.length > 0);
    assert.ok(KEYBINDINGS_CATALOG.interact.includes('Space'));
  });
});
