/**
 * LIV-23 (FIX-8) — Ally movement naturalness: per-ally stagger delay + wander.
 *
 * Locks the engine side of the FIX-11 v2 `party_ai.json` `movement` schema
 * (`cadenceSec`, `staggerSec`, `jitterSec`, `wanderChance`, `wanderRadius`,
 * `wanderCooldownSec`):
 *   - profiles resolve the nested movement block (vocation over catalog default
 *     over engine baseline) with safe fallbacks;
 *   - steps are paced by the cadence so allies do not move every 10 Hz tick;
 *   - settled allies load their per-vocation stagger before setting off, so the
 *     party does not march in lockstep;
 *   - settled allies occasionally take a short wander step inside
 *     `wanderRadius`, throttled by `wanderCooldownSec`;
 *   - `random` is injectable so these outcomes are deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { PartyAI, profileForVocation, DEFAULT_AI_MOVEMENT } from '../engine/party-ai.js';
import { createPartyMember, createPartyPlayer } from '../engine/party.js';
import { VOCATIONS_CATALOG, PARTY_AI_CATALOG } from '../data/index.js';

function floorGrid(width = 24, height = 24) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  }
  return grid;
}

function partyOf(activeVocation, members = []) {
  const player = createPartyPlayer(activeVocation);
  player.x = 0;
  player.y = 0;
  for (const member of members) player.party.push(member);
  return player;
}

/** Deterministic RNG stubs: min jitter, never / always wander. */
const lowRoll = () => 0;
const highRoll = () => 0.99;

test('LIV-23 movement schema: every vocation resolves the nested movement block', () => {
  const keys = Object.keys(DEFAULT_AI_MOVEMENT);
  for (const vocation of Object.keys(VOCATIONS_CATALOG)) {
    const profile = profileForVocation(vocation);
    assert.ok(profile.movement, `${vocation} has a resolved movement block`);
    for (const key of keys) {
      assert.equal(typeof profile.movement[key], 'number', `${vocation}.movement.${key} is numeric`);
      assert.ok(Number.isFinite(profile.movement[key]), `${vocation}.movement.${key} is finite`);
    }
    const authored = PARTY_AI_CATALOG.profiles[vocation].movement;
    assert.equal(profile.movement.cadenceSec, authored.cadenceSec, `${vocation} honors catalog cadence`);
    assert.equal(profile.movement.staggerSec, authored.staggerSec, `${vocation} honors catalog stagger`);
  }
  // Unknown vocation falls back to the catalog default movement block.
  const fallback = profileForVocation('not_a_vocation');
  assert.equal(fallback.movement.cadenceSec, PARTY_AI_CATALOG.default.movement.cadenceSec);
  assert.equal(fallback.movement.staggerSec, 0);
});

test('LIV-23 cadence: a moving ally steps at most once per cadence window', () => {
  const grid = floorGrid();
  const fighter = createPartyMember('fighter', { x: 10, y: 2 });
  const player = partyOf('magician', [fighter]);
  player.x = 2;
  player.y = 2;
  const cadence = profileForVocation('fighter').movement.cadenceSec;
  const ctx = { gridMap: grid, monsters: [], random: lowRoll };

  // First departure is immediate (no cadence armed yet).
  let events = PartyAI.updateAllies(player, { ...ctx, deltaSec: 0.1 });
  assert.equal(events[0].type, 'move');
  assert.equal(fighter.x, 9);

  // A tick shorter than the cadence holds position.
  events = PartyAI.updateAllies(player, { ...ctx, deltaSec: Math.max(0.01, cadence - 0.05) });
  assert.equal(events[0].type, 'idle', 'cadence blocks back-to-back steps');
  assert.equal(fighter.x, 9);

  // Once the cadence elapses the ally steps again.
  events = PartyAI.updateAllies(player, { ...ctx, deltaSec: cadence + 0.01 });
  assert.equal(events[0].type, 'move');
  assert.equal(fighter.x, 8);
});

test('LIV-23 stagger: settled allies do not all set off on the same tick', () => {
  const grid = floorGrid();
  const fighter = createPartyMember('fighter', { x: 3, y: 2 }); // stagger 0.00
  const magician = createPartyMember('magician', { x: 2, y: 4 }); // stagger 0.12
  const player = partyOf('archer', [fighter, magician]);
  player.x = 2;
  player.y = 2;

  // Settle both in formation (no wander via a high roll), loading their stagger.
  PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1, random: highRoll });
  assert.equal(fighter._followArmed, true);
  assert.equal(magician._followArmed, true);
  assert.ok(magician._followDelayTimer > fighter._followDelayTimer, 'magician is staggered later');

  // The leader departs; the fighter leads, the magician still waits.
  player.x = 12;
  player.y = 2;
  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.05, random: highRoll });
  const byMember = new Map(events.map((ev) => [ev.member, ev]));
  assert.equal(byMember.get(fighter).type, 'move', 'fighter set off immediately');
  assert.equal(byMember.get(magician).type, 'idle', 'magician waited its stagger');
});

test('LIV-23 wander: a settled ally may take a short step, then cools down', () => {
  const grid = floorGrid();
  const magician = createPartyMember('magician', { x: 9, y: 10 });
  const player = partyOf('fighter', [magician]);
  player.x = 10;
  player.y = 10;

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1, random: lowRoll });
  assert.equal(events[0].type, 'move', 'wander step emitted');
  const dist = Math.hypot(magician.x - player.x, magician.y - player.y);
  assert.ok(dist <= profileForVocation('magician').movement.wanderRadius, 'stayed within wanderRadius');
  assert.ok(magician._wanderCooldown > 0, 'wander cooldown armed');

  // Immediately after, the cooldown suppresses further wandering.
  const held = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1, random: lowRoll });
  assert.equal(held[0].type, 'idle', 'cooldown holds the ally still');
});

test('LIV-23 wanderRadius: a tight-radius ally with no legal tile does not move', () => {
  const grid = floorGrid();
  const fighter = createPartyMember('fighter', { x: 4, y: 5 }); // radius 1, followDistance 1
  const player = partyOf('magician', [fighter]);
  player.x = 5;
  player.y = 5;

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1, random: lowRoll });
  assert.equal(events[0].type, 'idle', 'every wander tile left the radius');
  assert.deepEqual({ x: fighter.x, y: fighter.y }, { x: 4, y: 5 });
});
