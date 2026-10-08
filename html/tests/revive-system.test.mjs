/**
 * LIV-44 — Party knockout & revive engine (Phases 0-3, 6).
 *
 * Locks the single `markDowned` seam, the simultaneous full-party wipe
 * predicate, control handoff off a downed active member, the interruptible
 * revive channel, the self-stabilize safety net, and the between-floor mercy
 * valve. Everything is catalog-driven; no per-vocation code branches.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ReviveSystem,
  DEFAULT_REVIVE_CONFIG,
  resolveReviveConfig,
  isDowned,
  markDowned,
  markPartyDowned,
  applyRevive,
  evaluateWipe,
  hasLivingMember,
  canStartRevive,
  orthogonalAdjacent,
  hasLivingHostileWithin,
  hasReviveSource,
  beginRevive,
  tickReviveChannel,
  evaluateParty,
  reviverChannelDamageReduction,
} from '../engine/revive-system.js';
import { CombatSystem } from '../engine/combat-system.js';
import { createPartyPlayer, createPartyMember } from '../engine/party.js';
import { awardPartyXp } from '../engine/party-progression.js';
import {
  PARTY_AI_CATALOG,
  ABILITIES_CATALOG,
  ITEMS_CATALOG,
  ECONOMY_CATALOG,
  UI_CATALOG,
} from '../data/index.js';

/** A party with the active member plus appended members. */
function partyOf(activeVocation, members = []) {
  const player = createPartyPlayer(activeVocation);
  for (const member of members) player.party.push(member);
  return player;
}

function monster(x, y, overrides = {}) {
  return { id: `m_${x}_${y}`, x, y, hp: 30, max_hp: 30, faction: 'monsters', ...overrides };
}

test('LIV-44 catalog schema: revive keys, revive sources, wipe + copy blocks', () => {
  const revive = PARTY_AI_CATALOG.revive;
  assert.ok(revive, 'party_ai.json declares the top-level revive block');
  for (const key of [
    'enabled', 'channelSec', 'cooldownSec', 'manaCost', 'hpPct', 'manaPct',
    'graceSec', 'idleSec', 'safetyRadius', 'interruptOnDamage', 'interruptOnMove',
    'channelDecayMult', 'reviveOnFloorTransition', 'selfReviveSec',
    'selfReviveHpPct', 'bleedOutSec', 'boss', 'potion',
  ]) {
    assert.ok(key in revive, `revive.${key} is part of the schema`);
  }
  assert.equal(revive.bleedOutSec, 0, 'no hard death timer at launch');
  assert.equal(revive.safetyRadius, 8);
  assert.equal(revive.idleSec, 3.0);
  assert.equal(revive.reviveOnFloorTransition, true);

  assert.equal(ABILITIES_CATALOG.paladin_heal.canRevive, true, 'paladin_heal is a revive source');
  assert.equal(ITEMS_CATALOG.health_potion.effect.canRevive, true, 'health_potion is a revive source');

  assert.ok(ECONOMY_CATALOG.wipe, 'economy.json declares the wipe block');
  assert.equal(ECONOMY_CATALOG.wipe.goldPenaltyPct, 0);

  assert.ok(UI_CATALOG.knockout, 'ui.json declares knockout copy');
  assert.equal(typeof UI_CATALOG.knockout.partyWipeTitle, 'string');
});

test('LIV-44 config: baseline resolves and per-vocation overrides win', () => {
  // Baseline (no profile): the top-level `revive` block plus defaults.
  const base = resolveReviveConfig('not_a_vocation');
  assert.equal(base.channelSec, 2.0);
  assert.equal(base.safetyRadius, 8);
  assert.equal(base.hpPct, 0.3);
  assert.equal(base.manaPct, 0.25);
  assert.equal(base.graceSec, 1.0);
  assert.equal(base.selfReviveSec, DEFAULT_REVIVE_CONFIG.selfReviveSec);

  // LIV-45 E3 "Vigils": a vocation's partial override wins and untouched keys
  // still inherit the baseline (no per-class branches).
  const paladin = resolveReviveConfig('paladin');
  assert.equal(paladin.hpPct, 0.35, 'Paladin Holy Prayer restores more HP');
  assert.equal(paladin.channelSec, 2.0, 'Paladin keeps the standard channel');
  const magician = resolveReviveConfig('magician');
  assert.equal(magician.channelSec, 1.4, 'Magician Arcane Suture is the fastest channel');
  assert.equal(magician.manaCost, 40, 'Magician pays more mana');
  assert.equal(magician.hpPct, 0.3, 'Magician inherits the baseline restore');
  const archer = resolveReviveConfig('archer');
  assert.equal(archer.channelSec, 1.6);
  assert.equal(archer.hpPct, 0.2);
});

test('LIV-44 markDowned: one idempotent seam, entity kept, tile not nulled', () => {
  const member = createPartyMember('magician', { x: 3, y: 4 });
  member.hp = 0;
  member.aiTargetId = 'rat';
  member._reviveTargetId = 'someone';
  const changed = markDowned(member, { elapsedSec: 12, floor: 2 });
  assert.equal(changed, true);
  assert.equal(member.lifeState, 'downed');
  assert.equal(member.combatState, 'downed', 'the approved-plan combatState field is set');
  assert.equal(member.hp, 0);
  assert.equal(member.downedAtSec, 12);
  assert.equal(member.downedFloor, 2);
  assert.equal(member.aiTargetId, null, 'stale AI target cleared');
  assert.equal(member._reviveTargetId, null, 'stale channel cleared');
  assert.equal(isDowned(member), true);
  assert.equal(markDowned(member, { elapsedSec: 20 }), false, 'idempotent');
  assert.equal(member.downedAtSec, 12, 'a second call does not restamp');

  const alive = createPartyMember('fighter');
  assert.equal(markDowned(alive), false, 'an alive member is untouched');
  assert.equal(alive.lifeState, 'alive');
});

test('LIV-44 markPartyDowned syncs the active mirror without removing members', () => {
  const player = partyOf('magician', [createPartyMember('fighter', { x: 5, y: 5 })]);
  player.hp = 0;
  markPartyDowned(player, { elapsedSec: 1, floor: 1 });
  assert.equal(player.lifeState, 'downed');
  assert.equal(player.party[0].lifeState, 'downed', 'the active party entry mirrors the downed state');
  assert.equal(player.party.length, 2, 'no member is removed');
});

test('LIV-44 evaluateWipe: true only when every member is down at once', () => {
  const solo = createPartyPlayer('magician');
  assert.equal(evaluateWipe(solo), false);
  solo.hp = 0;
  assert.equal(evaluateWipe(solo), true, 'a solo party wipes on its first down');

  const player = partyOf('magician', [
    createPartyMember('fighter', { hp: 0 }),
    createPartyMember('archer', { hp: 0 }),
  ]);
  player.hp = 0;
  assert.equal(evaluateWipe(player), true, 'all members down -> wipe');
  player.party[1].hp = 5;
  assert.equal(evaluateWipe(player), false, 'one living ally prevents a wipe');
  assert.equal(hasLivingMember(player), true);

  // The active mirror is authoritative even if its party entry is stale.
  const stale = partyOf('magician', [createPartyMember('fighter', { hp: 0 })]);
  stale.hp = 0;
  assert.equal(stale.party[0].hp > 0, true, 'active party entry is stale-high');
  assert.equal(evaluateWipe(stale), true, 'the top-level active hp decides');
});

test('LIV-44 handoff: a downed active member passes control to a living ally', () => {
  const ally = createPartyMember('fighter', { x: 2, y: 2 });
  const player = partyOf('magician', [ally]);
  player.party[0].hp = 1;
  player.hp = 0; // the active magician falls

  const res = evaluateParty(player, { elapsedSec: 1, floor: 1, monsters: [], combatIdleSec: 99 });
  assert.equal(res.wiped, false, 'the fight continues while an ally lives');
  assert.ok(res.handoff, 'control auto-hands off with no modal');
  assert.equal(player.activeMemberId, ally.memberId, 'the living ally is now active');
  assert.equal(isDowned(player.party[0]), true, 'the fallen member stays downed, not removed');
  assert.ok(player.hp > 0, 'the mirror now reflects the living ally');

  const solo = createPartyPlayer('magician');
  solo.hp = 0;
  const wipe = evaluateParty(solo, { elapsedSec: 1, floor: 1, monsters: [], combatIdleSec: 99 });
  assert.equal(wipe.wiped, true, 'a solo down is an immediate wipe');
  assert.equal(wipe.handoff, null);
});

test('LIV-44 solo wipe is immediate: a lone hero never self-stabilizes', () => {
  const solo = createPartyPlayer('magician');
  solo.hp = 0;
  solo.downedAtSec = 0;
  const res = evaluateParty(solo, { elapsedSec: 999, floor: 1, monsters: [], combatIdleSec: 0 });
  assert.equal(res.wiped, true);
  assert.equal(res.events.some((e) => e.type === 'selfRevive'), false);
});

test('LIV-44 revive start gate: safety radius AND damage idle', () => {
  const target = createPartyMember('magician', { x: 5, y: 5, hp: 0 });
  const cfg = resolveReviveConfig('paladin');

  assert.equal(canStartRevive(target, { monsters: [], combatIdleSec: 0 }, cfg), false, 'not idle yet');
  assert.equal(canStartRevive(target, { monsters: [], combatIdleSec: 3 }, cfg), true, 'idle reached');
  assert.equal(
    canStartRevive(target, { monsters: [monster(5, 8)], combatIdleSec: 99 }, cfg),
    false,
    'a hostile inside safetyRadius blocks the start'
  );
  assert.equal(
    canStartRevive(target, { monsters: [monster(5, 20)], combatIdleSec: 99 }, cfg),
    true,
    'a distant hostile does not block'
  );
});

test('LIV-44 channel: completes after channelSec and restores hpPct/manaPct + grace', () => {
  const player = partyOf('magician');
  const reviver = createPartyMember('paladin', { x: 5, y: 5, mana: 100, hp: 120 });
  const target = createPartyMember('fighter', { x: 5, y: 6, hp: 0 });
  player.party.push(reviver, target);
  const cfg = resolveReviveConfig('paladin');

  assert.equal(hasReviveSource(reviver, cfg, { active: player }), true, 'the paladin has a revive source');
  assert.equal(orthogonalAdjacent(reviver, target), true);

  beginRevive(reviver, target, cfg);
  const mid = tickReviveChannel(reviver, player, { deltaSec: 1.0, monsters: [] }, cfg);
  assert.equal(mid, null, 'still channeling at 1s of a 2s channel');
  const done = tickReviveChannel(reviver, player, { deltaSec: 1.0, monsters: [] }, cfg);

  assert.ok(done && done.type === 'revived', 'the channel completes');
  assert.equal(target.lifeState, 'alive');
  assert.equal(target.combatState, 'active', 'combatState returns to active');
  assert.equal(target.hp, Math.ceil(target.max_hp * cfg.hpPct));
  assert.equal(target.mana, Math.ceil(target.max_mana * cfg.manaPct));
  assert.ok(target.reviveGraceSec > 0, 'the stand-up grace window opens');
  assert.ok(reviver.mana < 100, 'the ability mana was spent');
  assert.ok(reviver.cooldowns.healing_prayer > 0, 'the ability cooldown was armed');
  assert.equal(reviver._reviveTargetId, null, 'the channel is cleared on completion');
});

test('LIV-44 channel: damage / move / hostile re-entry interrupt and decay at 2x', () => {
  const player = partyOf('magician');
  const reviver = createPartyMember('paladin', { x: 5, y: 5, mana: 100, hp: 120 });
  const target = createPartyMember('fighter', { x: 5, y: 6, hp: 0 });
  player.party.push(reviver, target);
  const cfg = resolveReviveConfig('paladin');
  beginRevive(reviver, target, cfg);
  tickReviveChannel(reviver, player, { deltaSec: 1.0, monsters: [] }, cfg);
  assert.equal(reviver._reviveProgressSec, 1.0);

  // Damage the reviver: the channel breaks and progress decays by 2x.
  reviver.hp = 60;
  const hurt = tickReviveChannel(reviver, player, { deltaSec: 1.0, monsters: [] }, cfg);
  assert.ok(hurt && hurt.type === 'reviveInterrupted');
  assert.equal(reviver._reviveBlocked, true);
  assert.ok(reviver._reviveProgressSec <= 0, 'progress decayed toward zero');
  assert.equal(target.lifeState, 'downed', 'the target stays downed');

  // Hostile re-entering safetyRadius also breaks a fresh channel.
  const reviver2 = createPartyMember('paladin', { x: 5, y: 5, mana: 100, hp: 120 });
  const target2 = createPartyMember('fighter', { x: 5, y: 6, hp: 0 });
  const player2 = partyOf('magician', [reviver2, target2]);
  beginRevive(reviver2, target2, cfg);
  tickReviveChannel(reviver2, player2, { deltaSec: 0.5, monsters: [] }, cfg);
  const broken = tickReviveChannel(reviver2, player2, { deltaSec: 0.5, monsters: [monster(5, 9)] }, cfg);
  assert.ok(broken && broken.type === 'reviveInterrupted', 'a re-entering hostile breaks the channel');
});

test('LIV-44 self-stabilize: a resourceless member steadies at selfReviveSec', () => {
  const downed = createPartyMember('archer', { x: 1, y: 1, hp: 0 });
  downed.lifeState = 'downed';
  downed.downedAtSec = 0;
  const player = partyOf('magician', [downed]);
  const cfg = resolveReviveConfig('archer');

  const early = evaluateParty(player, { elapsedSec: cfg.selfReviveSec - 1, floor: 1, monsters: [], combatIdleSec: 0 });
  assert.equal(downed.lifeState, 'downed', 'not yet steady');
  assert.equal(early.events.some((e) => e.type === 'selfRevive'), false);

  const late = evaluateParty(player, { elapsedSec: cfg.selfReviveSec, floor: 1, monsters: [], combatIdleSec: 0 });
  assert.equal(downed.lifeState, 'alive', 'self-stabilize revives the member');
  assert.equal(downed.hp, Math.max(1, Math.ceil(downed.max_hp * cfg.selfReviveHpPct)));
  assert.ok(late.events.some((e) => e.type === 'selfRevive'));
});

test('LIV-44 regression: shared XP level-up never revives a downed member', () => {
  const player = createPartyPlayer('magician');
  const downed = createPartyMember('fighter', { x: 3, y: 3, hp: 0 });
  downed.lifeState = 'downed';
  downed.xp = 90;
  downed.level = 1;
  player.party.push(downed);

  awardPartyXp(player, 1000);

  assert.equal(downed.hp, 0, 'awardXP would have set full HP; the downed skip holds');
  assert.equal(downed.lifeState, 'downed');
  assert.equal(downed.level, 1);
});

test('LIV-44 helpers: broadphase radius + adjacency', () => {
  assert.equal(hasLivingHostileWithin([monster(0, 0)], 0, 0, 1), true);
  assert.equal(hasLivingHostileWithin([monster(0, 0, { hp: 0 })], 0, 0, 1), false, 'dead hostiles ignored');
  assert.equal(hasLivingHostileWithin([monster(10, 0)], 0, 0, 8), false);
  assert.equal(orthogonalAdjacent({ x: 0, y: 0 }, { x: 1, y: 0 }), true);
  assert.equal(orthogonalAdjacent({ x: 0, y: 0 }, { x: 1, y: 1 }), false, 'diagonal is not orthogonal');
  assert.equal(applyRevive(createPartyMember('magician', { hp: 0 }), resolveReviveConfig('magician')).lifeState, 'alive');
});

/** Minimal walkability stub for the LIV-47 drag tests. */
function stubGrid(isWalkable = () => true) {
  return {
    width: 20,
    height: 20,
    isInBounds: (x, y) => x >= 0 && y >= 0 && x < 20 && y < 20,
    isWalkable,
  };
}

/** A party whose active mirror and one ally sit at (0,0) so they never block. */
function dragParty(reviver, target, extra = []) {
  const player = partyOf('magician', [reviver, target, ...extra]);
  player.x = 0;
  player.y = 0;
  player.party[0].x = 0;
  player.party[0].y = 0;
  return player;
}

test('LIV-47 config: Fighter drag + reduction levers resolve; other vocations are 0', () => {
  const fighter = resolveReviveConfig('fighter');
  assert.equal(fighter.dragTiles, 1, 'Fighter Drag to Safety pulls the body one tile');
  assert.equal(fighter.damageReductionPct, 0.25, 'Fighter takes 25% less while channeling');
  for (const vocation of ['paladin', 'magician', 'archer', 'not_a_vocation']) {
    const cfg = resolveReviveConfig(vocation);
    assert.equal(cfg.dragTiles, 0, `${vocation} dragTiles defaults to 0`);
    assert.equal(cfg.damageReductionPct, 0, `${vocation} damageReductionPct defaults to 0`);
  }
  assert.equal(DEFAULT_REVIVE_CONFIG.dragTiles, 0);
  assert.equal(DEFAULT_REVIVE_CONFIG.damageReductionPct, 0);
});

test('LIV-47 drag: a Fighter reviver pulls the downed body one tile toward itself', () => {
  const reviver = createPartyMember('fighter', { x: 5, y: 5, hp: 140, max_hp: 140, mana: 100 });
  const target = createPartyMember('archer', { x: 5, y: 7, hp: 0 });
  const player = dragParty(reviver, target);
  const cfg = resolveReviveConfig('fighter');
  beginRevive(reviver, target, cfg);

  tickReviveChannel(reviver, player, { deltaSec: 0.5, monsters: [], gridMap: stubGrid() }, cfg);
  assert.equal(target.y, 6, 'the body is dragged one tile toward the reviver');
  assert.equal(target.x, 5, 'the drag stays orthogonal');
  assert.equal(reviver._reviveDraggedTiles, 1);
  assert.equal(orthogonalAdjacent(reviver, target), true, 'the pull closes to adjacency');
  assert.equal(reviver._reviveBlocked, false, 'the channel is live after the pull');

  // The pull is bounded by dragTiles: a second tick must not move the body again.
  tickReviveChannel(reviver, player, { deltaSec: 0.5, monsters: [], gridMap: stubGrid() }, cfg);
  assert.equal(target.y, 6, 'drag is bounded by dragTiles');

  // The channel completes normally on the dragged body.
  tickReviveChannel(reviver, player, { deltaSec: 1.5, monsters: [], gridMap: stubGrid() }, cfg);
  assert.equal(target.lifeState, 'alive', 'the dragged body is revived');
});

test('LIV-47 drag: dragTiles 0 never moves the body (other vocations inert)', () => {
  const reviver = createPartyMember('paladin', { x: 5, y: 5, hp: 120, max_hp: 120, mana: 100 });
  const target = createPartyMember('fighter', { x: 5, y: 7, hp: 0 });
  const player = dragParty(reviver, target);
  const cfg = resolveReviveConfig('paladin');
  beginRevive(reviver, target, cfg);

  tickReviveChannel(reviver, player, { deltaSec: 0.5, monsters: [], gridMap: stubGrid() }, cfg);
  assert.equal(target.x, 5, 'no horizontal drag');
  assert.equal(target.y, 7, 'a non-Fighter reviver never drags the body');
});

test('LIV-47 drag: the body is never dragged into a wall', () => {
  const reviver = createPartyMember('fighter', { x: 5, y: 5, hp: 140, max_hp: 140, mana: 100 });
  const target = createPartyMember('archer', { x: 5, y: 7, hp: 0 });
  const player = dragParty(reviver, target);
  const cfg = resolveReviveConfig('fighter');
  beginRevive(reviver, target, cfg);

  const wallAt = (x, y) => !(x === 5 && y === 6);
  tickReviveChannel(reviver, player, { deltaSec: 0.5, monsters: [], gridMap: stubGrid(wallAt) }, cfg);
  assert.equal(target.y, 7, 'a walled pull tile blocks the drag');
  assert.equal(reviver._reviveDraggedTiles, 0);
});

test('LIV-47 drag: the body is never dragged onto another actor', () => {
  const reviver = createPartyMember('fighter', { x: 5, y: 5, hp: 140, max_hp: 140, mana: 100 });
  const target = createPartyMember('archer', { x: 5, y: 7, hp: 0 });
  const blocker = createPartyMember('archer', { x: 5, y: 6, hp: 90, max_hp: 90 });
  const player = dragParty(reviver, target, [blocker]);
  const cfg = resolveReviveConfig('fighter');
  beginRevive(reviver, target, cfg);

  tickReviveChannel(reviver, player, { deltaSec: 0.5, monsters: [], gridMap: stubGrid() }, cfg);
  assert.equal(target.y, 7, 'an occupied pull tile blocks the drag');
  assert.equal(reviver._reviveDraggedTiles, 0);
});

test('LIV-47 damage reduction: a channeling Fighter takes 25% less; inert otherwise', () => {
  const channeling = { hp: 100, max_hp: 100, vocation: 'fighter', _reviveTargetId: 'downed_ally' };
  assert.equal(reviverChannelDamageReduction(channeling), 0.25);
  const reduced = CombatSystem.applyIncomingDamage(channeling, 40);
  assert.equal(reduced.damageToPlayer, 30, '25% reduction applies to incoming damage');
  assert.equal(channeling.hp, 70);

  const idle = { hp: 100, max_hp: 100, vocation: 'fighter' };
  assert.equal(reviverChannelDamageReduction(idle), 0);
  const plain = CombatSystem.applyIncomingDamage(idle, 40);
  assert.equal(plain.damageToPlayer, 40, 'no channel -> no reduction');
  assert.equal(idle.hp, 60);

  const otherVocation = { hp: 100, max_hp: 100, vocation: 'paladin', _reviveTargetId: 'x' };
  assert.equal(reviverChannelDamageReduction(otherVocation), 0);
  const pHit = CombatSystem.applyIncomingDamage(otherVocation, 40);
  assert.equal(pHit.damageToPlayer, 40, 'only the Fighter Vigil reduces damage');
});
