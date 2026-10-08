/**
 * LIV-27 — FIX-12: 'a' / 's' cycle the controlled party member.
 *
 * Board T2 feedback round 3 item 1 (see LIV-8): bind 'a'/'s' to cycle the
 * controlled party member; non-controlled members default to AI.
 *
 * Locks the pure engine contract in `party.js::cycleActiveMember`: forward and
 * backward cycling wrap in party order, skip downed members, preserve the
 * outgoing member's live state through capture/apply, and leave every
 * non-active member on the `party_ai.json` auto-AI path (`aiMode: 'auto'`).
 * Also pins the catalog keybindings that drive the input layer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPartyPlayer,
  createPartyMember,
  cycleActiveMember,
  getActiveMember,
  activeMemberIndex,
} from '../engine/party.js';
import { PartyAI } from '../engine/party-ai.js';
import { evaluateParty } from '../engine/revive-system.js';
import { KEYBINDINGS_CATALOG } from '../data/index.js';
import { PARTY_CYCLE_BINDINGS } from '../engine/config.js';

function partyOf(activeVocation, vocations) {
  const player = createPartyPlayer(activeVocation);
  for (const vocation of vocations) player.party.push(createPartyMember(vocation));
  return player;
}

test('LIV-27 catalog: party cycle keys are data-driven (A previous, S next)', () => {
  assert.ok(Array.isArray(PARTY_CYCLE_BINDINGS.prev), 'prev is a key-code list');
  assert.ok(Array.isArray(PARTY_CYCLE_BINDINGS.next), 'next is a key-code list');
  assert.deepEqual(PARTY_CYCLE_BINDINGS.prev, ['KeyA']);
  assert.deepEqual(PARTY_CYCLE_BINDINGS.next, ['KeyS']);
  assert.deepEqual(KEYBINDINGS_CATALOG.party.prev, ['KeyA']);
  assert.deepEqual(KEYBINDINGS_CATALOG.party.next, ['KeyS']);
});

test('LIV-27 cycle: next walks party order and wraps', () => {
  const player = partyOf('magician', ['fighter', 'archer']);
  assert.equal(player.activeMemberId, 'member_magician');

  const first = cycleActiveMember(player, 1);
  assert.equal(first.vocation, 'fighter');
  assert.equal(player.activeMemberId, 'member_fighter');

  const second = cycleActiveMember(player, 1);
  assert.equal(second.vocation, 'archer');
  assert.equal(player.activeMemberId, 'member_archer');

  const wrapped = cycleActiveMember(player, 1);
  assert.equal(wrapped.vocation, 'magician', 'cycling past the end wraps to the first member');
  assert.equal(player.activeMemberId, 'member_magician');
});

test('LIV-27 cycle: previous walks backward and wraps', () => {
  const player = partyOf('magician', ['fighter', 'archer']);

  const back = cycleActiveMember(player, -1);
  assert.equal(back.vocation, 'archer', 'previous from the first member wraps to the last');
  assert.equal(player.activeMemberId, 'member_archer');

  const backAgain = cycleActiveMember(player, -1);
  assert.equal(backAgain.vocation, 'fighter');
  assert.equal(player.activeMemberId, 'member_fighter');
});

test('LIV-27 cycle: direction 0 / undefined defaults to next', () => {
  const player = partyOf('magician', ['fighter']);
  assert.equal(cycleActiveMember(player, 0).vocation, 'fighter');
  assert.equal(cycleActiveMember(player, undefined).vocation, 'magician');
});

test('LIV-27 cycle: skips downed members', () => {
  const player = partyOf('magician', ['fighter', 'archer']);
  player.party[1].hp = 0; // fighter is down

  const next = cycleActiveMember(player, 1);
  assert.equal(next.vocation, 'archer', 'the downed fighter is skipped');
  assert.equal(player.activeMemberId, 'member_archer');
});

test('LIV-27 cycle: returns null when no other member is alive', () => {
  const player = partyOf('magician', ['fighter']);
  player.party[1].hp = 0;

  assert.equal(cycleActiveMember(player, 1), null);
  assert.equal(cycleActiveMember(player, -1), null);
  assert.equal(player.activeMemberId, 'member_magician', 'control stays put');
});

test('LIV-27 cycle: a single-member party is a no-op', () => {
  const player = createPartyPlayer('magician');
  assert.equal(cycleActiveMember(player, 1), null);
  assert.equal(cycleActiveMember(player, -1), null);
  assert.equal(player.activeMemberId, 'member_magician');
});

test('LIV-27 cycle: outgoing member state is captured and restored', () => {
  const player = partyOf('magician', ['fighter']);
  player.hp = 7;
  player.x = 5;
  player.y = 6;

  cycleActiveMember(player, 1);
  const magicianEntry = player.party.find((m) => m.memberId === 'member_magician');
  assert.equal(magicianEntry.hp, 7, 'outgoing HP is captured before the handover');
  assert.deepEqual({ x: magicianEntry.x, y: magicianEntry.y }, { x: 5, y: 6 });

  const back = cycleActiveMember(player, -1);
  assert.equal(back.vocation, 'magician');
  assert.equal(player.hp, 7, 'returning restores the captured HP');
  assert.deepEqual({ x: player.x, y: player.y }, { x: 5, y: 6 });
});

test('LIV-27 AI default: non-controlled members stay on auto-AI', () => {
  const player = partyOf('magician', ['fighter', 'archer']);
  assert.equal(getActiveMember(player).vocation, 'magician');

  cycleActiveMember(player, 1); // now controlling the fighter
  assert.equal(getActiveMember(player).vocation, 'fighter');

  const inactive = PartyAI.inactiveMembers(player);
  const inactiveVocations = inactive.map((m) => m.vocation).sort();
  assert.deepEqual(inactiveVocations, ['archer', 'magician'], 'the two non-controlled members are driven by auto-AI');
  for (const member of inactive) {
    assert.equal(member.aiMode, 'auto', `${member.vocation} defaults to auto mode`);
  }
  assert.ok(!inactive.some((m) => m.vocation === 'fighter'), 'the controlled member is not auto-driven');

  // The active-member mirror index tracks the swap.
  assert.equal(player.party[activeMemberIndex(player)].vocation, 'fighter');
});

test('LIV-44 handoff: a downed active member never leaves control on a corpse', () => {
  const player = partyOf('magician', ['fighter', 'archer']);
  player.party[1].hp = 0; // fighter is down
  player.party[1].lifeState = 'downed';
  player.hp = 0; // the active magician falls

  const res = evaluateParty(player, { elapsedSec: 1, floor: 1, monsters: [], combatIdleSec: 99 });

  assert.ok(res.handoff, 'control auto-hands off with no modal');
  assert.equal(player.activeMemberId, 'member_archer', 'the downed fighter is skipped');
  assert.equal(res.wiped, false, 'one living ally keeps the run alive');
  assert.equal(player.party[1].hp, 0, 'the downed member stays on the board');
});
