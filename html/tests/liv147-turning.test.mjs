/**
 * Lokarta: LIV-147 — directional turning logic for NPCs, Player, and opponents.
 *
 * The actor contract has eight 45-degree directions (LIV-146). This suite pins
 * the pure turning seams shared by the simulation and the renderer:
 *
 *   1. `dir8Delta` / `rotateDir8` are the shortest-arc 45-degree bucket math.
 *   2. `turnTowardDir8` advances at most N buckets toward a target, never past it.
 *   3. `advanceTurn` eases an actor's drawn facing (`anim.dir`) toward its logical
 *      `facing` through the intermediate angle frames, deterministically, and
 *      leaves the logical `facing` untouched.
 *   4. `EntityAI.getFacing` resolves a direction of interest to the correct
 *      8-dir bucket (diagonal targets -> 45-degree frames; grid steps cardinal).
 *   5. The NPC wander handler turns left/right in place through the 45-degree
 *      buckets (never a 180-degree flip).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIR8,
  dir8Delta,
  rotateDir8,
  turnTowardDir8,
  normalizeDir8,
  dirFromFacing,
  createAnimState,
  setAnimState,
  advanceTurn,
} from '../app/animation-state.js';

import { EntityAI } from '../engine/entity-ai.js';
import { NEUTRAL_AI_HANDLERS } from '../engine/npc-system.js';

const withRandom = (values, fn) => {
  const real = Math.random;
  let i = 0;
  Math.random = () => (i < values.length ? values[i++] : 0);
  try { return fn(); } finally { Math.random = real; }
};

const grid = (width = 20) => ({ width, isWalkable: () => true });

describe('LIV-147 directional turning logic', () => {
  it('1. dir8Delta is the shortest signed 45-degree arc, ties clockwise', () => {
    assert.equal(dir8Delta('down', 'down'), 0);
    assert.equal(dir8Delta('down', 'down_right'), 1);
    assert.equal(dir8Delta('right', 'down'), -2);
    assert.equal(dir8Delta('down', 'left'), -2, 'goes the short way round');
    assert.equal(dir8Delta('down', 'up'), 4, 'the 180 tie resolves clockwise');
    assert.equal(dir8Delta('up', 'down'), 4, 'and is symmetric');
    // Every pair is within one half turn and reversible.
    for (const a of DIR8) {
      for (const b of DIR8) {
        const d = dir8Delta(a, b);
        assert.ok(d >= -4 && d <= 4, `${a}->${b} in range`);
        const rev = d === 4 || d === 0 ? d : -d;
        assert.equal(dir8Delta(b, a), rev, `${a}<->${b} reversible`);
      }
    }
  });

  it('2. rotateDir8 wraps both ways and normalizes legacy aliases', () => {
    assert.equal(rotateDir8('down', 1), 'down_right');
    assert.equal(rotateDir8('down', -1), 'down_left');
    assert.equal(rotateDir8('down', 8), 'down');
    assert.equal(rotateDir8('down', 9), 'down_right');
    assert.equal(rotateDir8('down', -9), 'down_left');
    assert.equal(rotateDir8('side', 1), 'up_right', 'authored side aliases right');
    assert.equal(rotateDir8('nonsense', 1), 'down_right', 'unknown defaults down');
  });

  it('3. turnTowardDir8 steps at most N buckets and never overshoots', () => {
    assert.equal(turnTowardDir8('right', 'down', 1), 'down_right', 'one intermediate frame');
    assert.equal(turnTowardDir8('down_right', 'down', 1), 'down');
    assert.equal(turnTowardDir8('right', 'down', 5), 'down', 'clamped to the target');
    assert.equal(turnTowardDir8('right', 'down', 0), 'down_right', 'min step is one');
    assert.equal(turnTowardDir8('right', 'right', 3), 'right', 'already there');
    // Walking a 180-degree turn one bucket at a time visits all intermediates.
    let dir = 'up';
    const seen = [dir];
    for (let i = 0; i < 4; i++) { dir = turnTowardDir8(dir, 'down', 1); seen.push(dir); }
    assert.deepEqual(seen, ['up', 'up_left', 'left', 'down_left', 'down']);
  });

  it('4. advanceTurn eases anim.dir toward the logical facing through intermediates', () => {
    const actor = { id: 'a', x: 0, y: 0, facing: 'right' };
    actor.anim = createAnimState('right');
    assert.equal(actor.anim.dir, 'right');
    assert.equal(actor.anim.turnAccumMs, 0);

    actor.facing = 'down'; // target 2 buckets counter-clockwise (right -> down)
    advanceTurn(actor, 30, 50);
    assert.equal(actor.anim.dir, 'right', 'no bucket until stepMs accrues');
    assert.equal(actor.anim.turnAccumMs, 30);

    advanceTurn(actor, 20, 50);
    assert.equal(actor.anim.dir, 'down_right', 'first intermediate frame');
    assert.equal(actor.anim.turnAccumMs, 0, 'accumulator spent');

    advanceTurn(actor, 300, 50);
    assert.equal(actor.anim.dir, 'down', 'clamps to the target, never overshoots');
    assert.equal(actor.anim.turnAccumMs, 0, 'a settled turn clears its accumulator');
    assert.equal(actor.facing, 'down', 'the logical facing is authoritative, never mutated');

    // Idempotent when already aligned.
    const before = actor.anim.dir;
    advanceTurn(actor, 1000, 50);
    assert.equal(actor.anim.dir, before);
  });

  it('4b. a 180-degree reversal turns through every 45-degree frame', () => {
    const actor = { facing: 'up', anim: createAnimState('up') };
    actor.facing = 'down';
    const trail = [];
    for (let i = 0; i < 5; i++) { advanceTurn(actor, 50, 50); trail.push(actor.anim.dir); }
    assert.deepEqual(trail, ['up_left', 'left', 'down_left', 'down', 'down']);
  });

  it('4c. setAnimState no longer snaps the drawn facing', () => {
    const actor = { facing: 'right', anim: createAnimState('right') };
    actor.facing = 'down';
    setAnimState(actor, 'walk');
    assert.equal(actor.anim.state, 'walk');
    assert.equal(actor.anim.dir, 'right', 'advanceTurn owns anim.dir');
    assert.equal(actor.anim.flipX, false);
  });

  it('4d. createAnimState seeds the 8-dir bucket and mirror for the facing', () => {
    assert.equal(createAnimState('left').dir, 'left');
    assert.equal(createAnimState('left').flipX, true);
    assert.equal(createAnimState('down_side').dir, 'down_right', 'authored alias folds');
    assert.equal(dirFromFacing({ x: 1, y: -1 }), 'up_right');
    assert.equal(normalizeDir8('up_side'), 'up_right');
  });

  it('5. EntityAI.getFacing resolves a direction of interest to 8-dir buckets', () => {
    // Orthogonal directions (grid steps) stay cardinal.
    assert.equal(EntityAI.getFacing(2, 2, 3, 2), 'right');
    assert.equal(EntityAI.getFacing(2, 2, 1, 2), 'left');
    assert.equal(EntityAI.getFacing(2, 2, 2, 3), 'down');
    assert.equal(EntityAI.getFacing(2, 2, 2, 1), 'up');
    // Diagonal directions of interest resolve to the 45-degree frames.
    assert.equal(EntityAI.getFacing(0, 0, 1, 1), 'down_right');
    assert.equal(EntityAI.getFacing(0, 0, 1, -1), 'up_right');
    assert.equal(EntityAI.getFacing(0, 0, -1, -1), 'up_left');
    assert.equal(EntityAI.getFacing(0, 0, -1, 1), 'down_left');
    // Dominant axis still wins for shallow angles.
    assert.equal(EntityAI.getFacing(0, 0, 3, 2), 'down_right', 'true diagonal');
    assert.equal(EntityAI.getFacing(0, 0, 3, 1), 'right', 'shallow angle snaps to dominant axis');
    assert.equal(EntityAI.getFacing(0, 0, 3, 0), 'right');
  });

  it('6. NPC wander turns in place through the 45-degree buckets, never 180', () => {
    const warn = NEUTRAL_AI_HANDLERS.wander;

    // Force the idle-turn branch: cooldown reset, then < npcIdleTurnChance.
    // arc = sign * magnitude -> +1 bucket (right -> up_right).
    const npc = { x: 5, y: 5, homeX: 5, homeY: 5, wanderRadius: 2, facing: 'right', aiType: 'wander' };
    const moved = withRandom([0.0, 0.1, 0.9, 0.1], () => warn(npc, grid(), 10, null, 20));
    assert.equal(moved, false, 'an idle turn does not step');
    assert.equal(npc.facing, 'up_right', 'turned one 45-degree bucket, not a 180');
    assert.equal(npc.x, 5, 'stayed put');
    assert.equal(npc.y, 5, 'stayed put');

    // Forcing the opposite sign yields the other adjacent bucket.
    const npc2 = { x: 5, y: 5, homeX: 5, homeY: 5, wanderRadius: 2, facing: 'right', aiType: 'wander' };
    withRandom([0.0, 0.1, 0.1, 0.1], () => warn(npc2, grid(), 10, null, 20));
    assert.equal(npc2.facing, 'down_right', 'mirrored 45-degree bucket');

    // A moving tick keeps the step facing cardinal (the takeaway a walk reads).
    const npc3 = { x: 5, y: 5, homeX: 5, homeY: 5, wanderRadius: 2, facing: 'down', aiType: 'wander' };
    withRandom([0.0, 0.9, 0.9, 0.0], () => warn(npc3, grid(), 10, null, 20));
    assert.equal(npc3.x, 6, 'stepped right');
    assert.equal(npc3.facing, 'right', 'faces the movement heading');
  });
});
