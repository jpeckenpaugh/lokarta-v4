/**
 * LIV-21 — Primary swaps tiles with an ally instead of being blocked.
 *
 * Board T2 round 2 item 3 (LIV-8 rejection 5319a0a7): "The primary player
 * character should not be blocked ... If the primary player tries to 'walk
 * over' the same tile that another party member is already standing on, they
 * will simply swap positions/places to prevent blocking situations."
 *
 * Locks the pure engine contract in `party-swap.js`: an active member walking
 * onto a living ally's tile trades places with it; the ally never pins the
 * primary. Downed members and the active member's own mirror are not swap
 * targets, and a second ally can still be traded with afterwards without any
 * two members ending on the same tile.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { swapWithPartyMemberAt } from '../engine/party-swap.js';
import { PartyAI } from '../engine/party-ai.js';
import { createPartyMember, createPartyPlayer } from '../engine/party.js';

function partyOf(activeVocation, members = []) {
  const player = createPartyPlayer(activeVocation);
  player.x = 0;
  player.y = 0;
  for (const member of members) player.party.push(member);
  return player;
}

test('LIV-21 swap: walking into a living ally trades tiles', () => {
  const ally = createPartyMember('fighter', { x: 1, y: 0 });
  const player = partyOf('magician', [ally]);
  player.x = 0;
  player.y = 0;

  assert.equal(PartyAI.partyMemberAt(player, 1, 0), ally, 'the ally is a collision body');
  const swapped = swapWithPartyMemberAt(player, 1, 0);

  assert.equal(swapped, ally, 'the ally at the target tile is returned');
  assert.deepEqual({ x: player.x, y: player.y }, { x: 1, y: 0 }, 'the primary advances onto the ally tile');
  assert.deepEqual({ x: ally.x, y: ally.y }, { x: 0, y: 0 }, 'the ally takes the primary previous tile');
});

test('LIV-21 swap: an empty tile returns null and moves nothing', () => {
  const ally = createPartyMember('fighter', { x: 5, y: 5 });
  const player = partyOf('magician', [ally]);
  player.x = 3;
  player.y = 3;

  const swapped = swapWithPartyMemberAt(player, 4, 3);

  assert.equal(swapped, null);
  assert.deepEqual({ x: player.x, y: player.y }, { x: 3, y: 3 }, 'primary is untouched');
  assert.deepEqual({ x: ally.x, y: ally.y }, { x: 5, y: 5 }, 'ally is untouched');
});

test('LIV-21 swap: a downed ally is not treated as a body to trade with', () => {
  const downed = createPartyMember('fighter', { x: 1, y: 0, hp: 0 });
  const player = partyOf('magician', [downed]);
  player.x = 0;
  player.y = 0;

  assert.equal(PartyAI.partyMemberAt(player, 1, 0), null, 'downed members are not collision bodies');
  assert.equal(swapWithPartyMemberAt(player, 1, 0), null);
  assert.deepEqual({ x: player.x, y: player.y }, { x: 0, y: 0 });
});

test('LIV-21 swap: the active member mirror is never a swap target', () => {
  const player = createPartyPlayer('magician');
  player.x = 0;
  player.y = 0;

  // The active member's own durable party entry sits on the same tile; the
  // active top-level state must not "swap" with its own mirror.
  const active = player.party[0];
  active.x = 1;
  active.y = 0;

  assert.equal(PartyAI.partyMemberAt(player, 1, 0), null);
  assert.equal(swapWithPartyMemberAt(player, 1, 0), null);
});

test('LIV-21 swap: two allies can be passed in sequence without stacking', () => {
  const first = createPartyMember('fighter', { x: 1, y: 0 });
  const second = createPartyMember('paladin', { x: 2, y: 0 });
  const player = partyOf('magician', [first, second]);
  player.x = 0;
  player.y = 0;

  swapWithPartyMemberAt(player, 1, 0);
  assert.deepEqual({ x: player.x, y: player.y }, { x: 1, y: 0 });
  assert.deepEqual({ x: first.x, y: first.y }, { x: 0, y: 0 });

  swapWithPartyMemberAt(player, 2, 0);
  assert.deepEqual({ x: player.x, y: player.y }, { x: 2, y: 0 });
  assert.deepEqual({ x: second.x, y: second.y }, { x: 1, y: 0 }, 'second ally takes the vacated tile');
  assert.notDeepEqual(
    { x: first.x, y: first.y },
    { x: second.x, y: second.y },
    'no two members end on the same tile'
  );
});

test('LIV-21 swap: a monster tile is not swapped through', () => {
  const player = partyOf('magician', []);
  player.x = 0;
  player.y = 0;
  const monster = { id: 'm1', x: 1, y: 0, hp: 10, max_hp: 10, faction: 'monsters' };

  // No ally on the tile; the caller's monster-targeting path owns this case.
  assert.equal(swapWithPartyMemberAt(player, 1, 0), null);
  assert.deepEqual({ x: player.x, y: player.y }, { x: 0, y: 0 });
  assert.equal(monster.x, 1);
});
