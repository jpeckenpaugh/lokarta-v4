/**
 * LIV-13 WS4 — Party auto-AI, loop/render integration, ally collision and
 * generalized monster targeting.
 *
 * Locks the auto-allies contract layered on the LIV-9 party model and the
 * LIV-11 actor contract:
 *   - profiles come from `party_ai.json`; abilities from `abilities.json` and
 *     dispatch on the declared `actionKey` (unknown keys are skipped);
 *   - auto allies follow the active member, engage nearby monsters with their
 *     vocation kit, retreat when hurt and heal hurt allies;
 *   - ally movement respects the grid and never stacks on another actor;
 *   - monsters target the nearest living party member, not just the top-level
 *     player;
 *   - auto casts never friendly-fire and never drain the active member's ammo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { CombatSystem } from '../engine/combat-system.js';
import { EntityAI } from '../engine/entity-ai.js';
import { PartyAI, profileForVocation, DEFAULT_AI_PROFILE } from '../engine/party-ai.js';
import {
  createPartyMember,
  createPartyPlayer,
  PARTY_FACTION,
  MONSTER_FACTION,
} from '../engine/party.js';
import { MONSTERS_CATALOG, ABILITIES_CATALOG, PARTY_AI_CATALOG, VOCATIONS_CATALOG } from '../data/index.js';

function floorGrid(width = 20, height = 20) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  }
  return grid;
}

function enemy(x, y, overrides = {}) {
  return {
    id: `enemy_${x}_${y}`,
    type: 'giant_rat',
    name: 'Giant Rat',
    faction: MONSTER_FACTION,
    x,
    y,
    hp: 100,
    max_hp: 100,
    damageScale: 1,
    attackCooldown: 0,
    attackCadence: 1.5,
    moveCooldown: 0,
    isAggroed: true,
    visible: true,
    ...overrides,
  };
}

/** A player with the active member plus `members` appended to the party. */
function partyOf(activeVocation, members = []) {
  const player = createPartyPlayer(activeVocation);
  player.x = 0;
  player.y = 0;
  for (const member of members) player.party.push(member);
  return player;
}

test('LIV-13 profiles: catalog covers every vocation and falls back safely', () => {
  for (const vocation of Object.keys(VOCATIONS_CATALOG)) {
    const profile = profileForVocation(vocation);
    assert.ok(Array.isArray(profile.preferredAbilities));
    for (const id of profile.preferredAbilities) {
      assert.ok(ABILITIES_CATALOG[id], `${vocation} prefers a real ability (${id})`);
    }
  }
  assert.deepEqual(profileForVocation('not_a_vocation').preferredAbilities, DEFAULT_AI_PROFILE.preferredAbilities);
  assert.equal(profileForVocation('paladin').healAlliesWhenHurt, true);
  assert.ok(PARTY_AI_CATALOG.default);
});

test('LIV-13 membership: inactive == living auto non-active members', () => {
  const manual = createPartyMember('archer', { x: 2, y: 2, aiMode: 'manual' });
  const downed = createPartyMember('fighter', { x: 3, y: 3, hp: 0 });
  const ally = createPartyMember('paladin', { x: 4, y: 4 });
  const player = partyOf('magician', [manual, downed, ally]);

  const inactive = PartyAI.inactiveMembers(player);
  assert.deepEqual(inactive.map((m) => m.vocation), ['paladin']);
  assert.ok(PartyAI.livingAllies(player).includes(player));
  assert.equal(PartyAI.livingAllies(player).filter((m) => m.memberId === player.activeMemberId).length, 0, 'stale active mirror excluded');
  assert.equal(PartyAI.partyMemberAt(player, 4, 4), ally);
  assert.equal(PartyAI.partyMemberAt(player, 0, 0), null, 'active tile is not an ally');
});

test('LIV-13 follow: an ally trails the active member to formation distance', () => {
  const grid = floorGrid();
  const fighter = createPartyMember('fighter', { x: 10, y: 2 });
  const player = partyOf('magician', [fighter]);
  player.x = 2;
  player.y = 2;

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'move');
  assert.equal(fighter.x, 9, 'stepped toward the active member');
  assert.equal(fighter.y, 2);

  // Within followDistance (fighter = 1) the ally holds position.
  fighter.x = 2;
  fighter.y = 1;
  const held = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1 });
  assert.equal(held[0].type, 'idle');
  assert.equal(fighter.x, 2);
});

test('LIV-13 engage: a ready career ability is cast with per-actor cost', () => {
  const grid = floorGrid();
  const fighter = createPartyMember('fighter', { x: 5, y: 5 });
  const player = partyOf('magician', [fighter]);
  const rat = enemy(6, 5);

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [rat], deltaSec: 0.1 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ability');
  assert.equal(events[0].abilityId, 'fighter_cleave');
  assert.ok(rat.hp < 100, 'the monster took cleave damage');
  assert.ok(fighter.cooldowns.cleave > 0, 'cooldown landed on the ally');
  assert.ok(fighter.mana < 30, 'mana was spent on the ally');
});

test('LIV-13 ability dispatch: beam only on-axis, otherwise spark', () => {
  const grid = floorGrid();
  const onAxis = createPartyMember('magician', { x: 5, y: 5, mana: 150 });
  const player = partyOf('fighter', [onAxis]);
  const aligned = enemy(9, 5);
  const alignedEvents = PartyAI.updateAllies(player, { gridMap: grid, monsters: [aligned], deltaSec: 0.1 });
  assert.equal(alignedEvents[0].abilityId, 'magician_beam');

  const offAxis = createPartyMember('magician', { x: 4, y: 4, mana: 150 });
  const player2 = partyOf('fighter', [offAxis]);
  const diagonal = enemy(7, 6);
  const diagonalEvents = PartyAI.updateAllies(player2, { gridMap: grid, monsters: [diagonal], deltaSec: 0.1 });
  assert.equal(diagonalEvents[0].abilityId, 'magician_spark');
});

test('LIV-13 retreat: a badly hurt ally disengages from a nearby threat', () => {
  const grid = floorGrid();
  const fighter = createPartyMember('fighter', { x: 5, y: 5, hp: 20, max_hp: 140 });
  const player = partyOf('magician', [fighter]);
  const rat = enemy(8, 5);
  const before = Math.hypot(fighter.x - rat.x, fighter.y - rat.y);

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [rat], deltaSec: 0.1 });
  assert.equal(events[0].type, 'move');
  const after = Math.hypot(fighter.x - rat.x, fighter.y - rat.y);
  assert.ok(after > before, 'moved away from the threat');
});

test('LIV-13 heal: the healer restores the most-injured ally', () => {
  const grid = floorGrid();
  const paladin = createPartyMember('paladin', { x: 5, y: 5 });
  const fighter = createPartyMember('fighter', { x: 6, y: 5, hp: 20, max_hp: 140 });
  const player = partyOf('magician', [paladin, fighter]);

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1 });
  const heal = events.find((ev) => ev.abilityId === 'paladin_heal');
  assert.ok(heal, 'paladin cast the heal');
  assert.ok(fighter.hp > 20, 'the hurt ally was healed');
  assert.ok(paladin.cooldowns.healing_prayer > 0);
});

test('LIV-13 friendly fire: auto allies never damage each other', () => {
  const grid = floorGrid();
  const fighter = createPartyMember('fighter', { x: 5, y: 5 });
  const archer = createPartyMember('archer', { x: 5, y: 6, hp: 60, max_hp: 90 });
  const player = partyOf('magician', [fighter, archer]);
  const rat = enemy(6, 5);

  PartyAI.updateAllies(player, { gridMap: grid, monsters: [rat], deltaSec: 0.1 });
  assert.equal(archer.hp, 60, 'an adjacent ally took no cleave damage');
  assert.ok(rat.hp < 100);
});

test('LIV-13 collision: auto allies respect grid occupancy', () => {
  const grid = floorGrid();
  // An archer blocks the direct lane; the fighter must route around, never stack.
  const fighter = createPartyMember('fighter', { x: 2, y: 2 });
  const archer = createPartyMember('archer', { x: 2, y: 3, aiMode: 'manual' });
  const player = partyOf('magician', [fighter, archer]);
  player.x = 2;
  player.y = 4;

  PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1 });
  assert.notDeepEqual({ x: fighter.x, y: fighter.y }, { x: 2, y: 3 }, 'fighter did not step onto the archer');
  assert.notDeepEqual({ x: fighter.x, y: fighter.y }, { x: 2, y: 4 }, 'fighter did not step onto the active member');

  // Adjacent to the active member -> hold.
  const heldFighter = createPartyMember('fighter', { x: 2, y: 3 });
  const player2 = partyOf('magician', [heldFighter]);
  player2.x = 2;
  player2.y = 4;
  PartyAI.updateAllies(player2, { gridMap: grid, monsters: [], deltaSec: 0.1 });
  assert.deepEqual({ x: heldFighter.x, y: heldFighter.y }, { x: 2, y: 3 });
});

test('LIV-13 monster targeting: hostile AI picks the nearest party member', () => {
  const grid = floorGrid();
  const ally = createPartyMember('fighter', { x: 8, y: 2 });
  const player = partyOf('magician', [ally]);
  player.x = 2;
  player.y = 2;
  const rat = enemy(7, 2);

  assert.equal(EntityAI.selectTarget(rat, [player, ally]), ally);

  const results = EntityAI.updateMonsters([rat], player, grid, 0.1, PartyAI.livingAllies(player));
  assert.equal(results.length, 1);
  assert.equal(results[0].target, ally, 'the blow routed to the nearest member');
  assert.ok(ally.hp < ally.max_hp, 'the ally took the hit');
  assert.equal(player.hp, player.max_hp, 'the far player was untouched');
});

test('LIV-13 ammo: auto bow casts use free ammo, manual casts still consume', () => {
  const grid = floorGrid();
  const autoArcher = createPartyMember('archer', { x: 2, y: 2 });
  const autoTarget = enemy(5, 2);
  const autoRes = CombatSystem.executePowerShot(autoArcher, autoTarget, grid, null, { freeAmmo: true });
  assert.equal(autoRes.success, true);
  assert.ok(autoTarget.hp < 100);

  const manualArcher = createPartyMember('archer', { x: 2, y: 2 });
  const manualTarget = enemy(5, 2);
  const manualRes = CombatSystem.executePowerShot(manualArcher, manualTarget, grid, null);
  assert.equal(manualRes.success, false, 'no arrows -> the manual cast is refused');
  assert.equal(manualTarget.hp, 100);
});

test('LIV-13 integration: the loop and renderer are wired for allies', async () => {
  const { readControllerSources } = await import('./helpers/app-source.mjs');
  const source = readControllerSources();
  assert.match(source, /PartyAI\.updateAllies\(/, 'game-loop drives the party AI');
  assert.match(source, /updatePartyAllies\(/, 'ally timers/status tick each frame');
  assert.match(source, /PartyAI\.livingAllies\(/, 'monsters target the living party');
  assert.match(source, /5b\. Party Allies Layer/, 'the renderer draws the allies');
  assert.match(source, /layoutPartyOnFloor\(/, 'floor load places/revives allies');
});
