/**
 * Lokarta: LIV-149 — turning BEHAVIORS on the 8-direction frames (LIV-146/147).
 *
 * Three behaviors, each pinned at its pure/deterministic seam:
 *
 *   1. Idle turn-in-place — `NEUTRAL_AI_HANDLERS.stationary` periodically rotates
 *      a stationary NPC's facing (never a 180-degree flip) on a jittered cooldown
 *      window, and never changes tile.
 *   2. Dialogue dual turn-to-face — `facingToward` resolves each party's target
 *      direction so both animate toward each other around a talk; `advanceTurn`
 *      eases both simultaneously.
 *   3. Attack facing — `facingToward` resolves the fire/target direction an
 *      attacker rotates to. Opponents reuse the same AI `getFacing` seam.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  facingToward,
  createAnimState,
  advanceTurn,
} from '../app/animation-state.js';
import { EntityAI } from '../engine/entity-ai.js';
import {
  makeNpcRuntime,
  updateNpcs,
  NEUTRAL_AI_HANDLERS,
} from '../engine/npc-system.js';

const withRandom = (values, fn) => {
  const real = Math.random;
  let i = 0;
  Math.random = () => (i < values.length ? values[i++] : 0);
  try { return fn(); } finally { Math.random = real; }
};

test('LIV-149 facing behaviors', async (t) => {
  await t.test('1. stationary NPCs idle-turn in place and never change tile', () => {
    const npc = makeNpcRuntime({ id: 'giver', name: 'Giver', x: 4, y: 4, aiType: 'stationary', facing: 'right' });
    npc._idleTurnCooldownSec = 0;
    // Deterministic turn tick: cooldown elapsed, reschedule, chance passes, arc -1.
    const turned = withRandom([0.0, 0.0, 0.0, 0.0], () => NEUTRAL_AI_HANDLERS.stationary(npc, null, 0));
    assert.equal(turned, false, 'a turn is not a move');
    assert.equal(npc.facing, 'down_right', 'rotated one 45-degree bucket, not a 180');
    assert.deepEqual([npc.x, npc.y], [4, 4], 'stayed on its tile');
    assert.ok(npc._idleTurnCooldownSec > 0, 'rescheduled a cooldown');

    // The cooldown gates the next turn: a small delta leaves facing untouched.
    const before = npc.facing;
    NEUTRAL_AI_HANDLERS.stationary(npc, null, 0.1);
    assert.equal(npc.facing, before, 'gated by the cooldown window');
  });

  await t.test('1b. a stationary tick can also choose to hold its facing', () => {
    const npc = makeNpcRuntime({ id: 'giver', name: 'Giver', x: 4, y: 4, aiType: 'stationary', facing: 'down' });
    npc._idleTurnCooldownSec = 0;
    // reschedule random 0.9, then chance check 0.9 (>= 0.35) -> no turn.
    withRandom([0.9, 0.9], () => NEUTRAL_AI_HANDLERS.stationary(npc, null, 0));
    assert.equal(npc.facing, 'down', 'held its facing');
    assert.ok(npc._idleTurnCooldownSec > 0, 'still rescheduled');
  });

  await t.test('1c. updateNpcs never moves a stationary NPC over time', () => {
    const npcs = [makeNpcRuntime({ id: 'still', name: 'Still', x: 2, y: 2, aiType: 'stationary' })];
    const grid = { width: 10, isWalkable: () => true };
    for (let i = 0; i < 200; i++) updateNpcs(npcs, grid, 0.1, new Set());
    assert.deepEqual([npcs[0].x, npcs[0].y], [2, 2], 'turns only, never steps');
  });

  await t.test('2. dialogue: both parties resolve a turn-to-face direction toward each other', () => {
    // Orthogonal neighbours talk across a cardinal axis.
    const player = { x: 5, y: 5, facing: 'up' };
    const npc = { x: 5, y: 6, facing: 'down' };
    npc.facing = facingToward(npc.x, npc.y, player.x, player.y);
    player.facing = facingToward(player.x, player.y, npc.x, npc.y);
    assert.equal(player.facing, 'down', 'player faces the NPC');
    assert.equal(npc.facing, 'up', 'NPC faces the player');

    // Diagonal neighbours resolve the 45-degree frames, not a cardinal snap.
    assert.equal(facingToward(5, 5, 6, 6), 'down_right');
    assert.equal(facingToward(6, 6, 5, 5), 'up_left');
    assert.equal(facingToward(3, 3, 3, 3), 'down', 'coincident falls back to down');
  });

  await t.test('2b. advanceTurn eases BOTH parties simultaneously through the 8 angles', () => {
    const player = { x: 5, y: 5, facing: 'up', anim: createAnimState('up') };
    const npc = { x: 5, y: 6, facing: 'down', anim: createAnimState('down') };
    player.facing = facingToward(player.x, player.y, npc.x, npc.y);
    npc.facing = facingToward(npc.x, npc.y, player.x, player.y);
    // One 90-degree step each: both tick through a shared intermediate frame.
    player.anim.dir = 'right';
    npc.anim.dir = 'left';
    advanceTurn(player, 1000, 50);
    advanceTurn(npc, 1000, 50);
    assert.equal(player.anim.dir, 'down', 'player eased to face the NPC');
    assert.equal(npc.anim.dir, 'up', 'NPC eased to face the player (via up_left)');
  });

  await t.test('3. attack facing: the shooter rotates to the fire direction', () => {
    // Archer firing down-right at a target 3 right / 2 down.
    assert.equal(facingToward(2, 2, 5, 4), 'down_right');
    // Orthogonal shots stay cardinal.
    assert.equal(facingToward(2, 2, 6, 2), 'right');
    assert.equal(facingToward(2, 6, 2, 2), 'up');
    // Opponents reuse the AI getFacing seam for the same resolution.
    assert.equal(EntityAI.getFacing(2, 2, 5, 4), facingToward(2, 2, 5, 4));
    assert.equal(EntityAI.getFacing(4, 4, 4, 4), 'down');
  });
});
