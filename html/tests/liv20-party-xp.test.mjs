/**
 * LIV-20 FIX-5 — Allies bank shared XP, auto-pick Fate Grants, subtle level cue.
 *
 * Board T2 feedback round 2 item 2. Covers:
 *   - shared XP: the active member and every living ally bank the same amount;
 *   - allies level from shared XP and auto-apply a deterministic Fate Grant with
 *     no modal and no pause;
 *   - the auto-draft policy is catalog-overridable and deterministic;
 *   - a subtle in-world cue is used for allies (the interactive draft is never
 *     opened for a non-active member).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPartyPlayer, createPartyMember } from '../engine/party.js';
import { ProgressionSystem } from '../engine/progression-system.js';
import { FateGrantSystem } from '../engine/fate-grant-system.js';
import {
  awardPartyXp,
  applyAutoFateGrant,
  resolveAutoFateGrantPolicy,
  partyMemberName,
  DEFAULT_AUTO_FATE_GRANT_POLICY,
} from '../engine/party-progression.js';
import { PARTY_AI_CATALOG, VOCATIONS_CATALOG } from '../data/index.js';
import { readControllerSources } from './helpers/app-source.mjs';

const FIGHTER = 'fighter';

/** A party with the active member plus one living ally at (x, y). */
function playerWithAlly() {
  const player = createPartyPlayer('magician');
  const ally = createPartyMember(FIGHTER, { x: 3, y: 3 });
  player.party.push(ally);
  return { player, ally };
}

test('LIV-20 shared XP: active and living allies bank the same amount', () => {
  const { player, ally } = playerWithAlly();
  player.xp = 0;
  ally.xp = 0;
  const activeMirror = player.party.find((m) => m.memberId === player.activeMemberId);
  activeMirror.xp = 0;

  const res = awardPartyXp(player, 30);

  assert.equal(player.xp, 30, 'active member banks shared XP');
  assert.equal(ally.xp, 30, 'ally banks the same shared XP');
  assert.equal(res.allies.length, 0, 'no level-up at 30/100');
  assert.equal(res.active.leveledUp, false);
});

test('LIV-20 shared XP: the active mirror is not double-awarded', () => {
  const { player } = playerWithAlly();
  player.xp = 0;
  const activeMirror = player.party.find((m) => m.memberId === player.activeMemberId);
  activeMirror.xp = 0;

  awardPartyXp(player, 50);

  assert.equal(player.xp, 50);
  assert.equal(activeMirror.xp, 0, 'stale active mirror is skipped (top level is authoritative)');
});

test('LIV-20 shared XP: downed allies do not bank or spend XP', () => {
  const { player, ally } = playerWithAlly();
  ally.hp = 0;
  ally.lifeState = 'downed';
  ally.xp = 90;
  ally.level = 1;

  const res = awardPartyXp(player, 30);

  assert.equal(ally.level, 1, 'downed ally does not level (awardXP would revive it)');
  assert.equal(ally.xp, 90, 'downed ally XP is untouched');
  assert.equal(res.allies.length, 0);
  // LIV-44 regression: level-up must never flip a downed member back to alive.
  assert.equal(ally.hp, 0, 'the downed member is not revived by shared XP');
  assert.equal(ally.lifeState, 'downed', 'the downed state survives the XP award');
});

test('LIV-20 allies level from shared XP and report one entry each', () => {
  const { player, ally } = playerWithAlly();
  const second = createPartyMember('archer', { x: 4, y: 4 });
  player.party.push(second);
  for (const m of [ally, second]) {
    m.level = 1;
    m.xp = 99;
    m.xpToNextLevel = 100;
  }

  const res = awardPartyXp(player, 20);

  assert.equal(ally.level, 2, 'ally levels from shared XP');
  assert.equal(second.level, 2, 'second ally levels too');
  assert.equal(res.allies.length, 2, 'one level-up entry per ally');
  assert.deepEqual(res.allies.map((e) => e.member.vocation).sort(), ['archer', 'fighter']);
});

test('LIV-20 auto draft: policy ranks upgrades then primary hand deterministically', () => {
  const upgrade = { id: 'up', isUpgrade: true, item: { item_id: 'x', slot: 'main_hand' } };
  const mainHand = { id: 'mh', item: { item_id: 'y', slot: 'main_hand' }, vocationAffinity: FIGHTER };
  const offHand = { id: 'oh', item: { item_id: 'z', slot: 'off_hand' }, vocationAffinity: FIGHTER };
  const neutral = { id: 'nt', item: { item_id: 'w', slot: 'armor' }, vocationAffinity: 'neutral' };
  const offer = { cards: [mainHand, offHand, neutral, upgrade], requiredSelections: { min: 2, max: 2 } };

  const chosen = FateGrantSystem.selectAutoDraft(offer, { vocation: FIGHTER }, resolveAutoFateGrantPolicy());

  assert.deepEqual(chosen.map((c) => c.id), ['up', 'mh'], 'upgrade first, then main hand');
});

test('LIV-20 auto draft: unknown tokens fall through and offer order is the fallback', () => {
  const offer = {
    cards: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    requiredSelections: { min: 2, max: 2 },
  };

  const chosen = FateGrantSystem.selectAutoDraft(offer, { vocation: FIGHTER }, { picks: 9, priority: ['does_not_exist'] });

  assert.deepEqual(chosen.map((c) => c.id), ['a', 'b'], 'selection is clamped to the required count, in offer order');
});

test('LIV-20 policy: falls back safely and never exceeds the offer requirement', () => {
  const policy = resolveAutoFateGrantPolicy();
  assert.ok(Number.isFinite(policy.picks) && policy.picks >= 1);
  assert.ok(Array.isArray(policy.priority) && policy.priority.length >= 1);
  assert.ok(DEFAULT_AUTO_FATE_GRANT_POLICY.priority.includes('upgrade'));
  if (!PARTY_AI_CATALOG.autoFateGrant) {
    assert.deepEqual(policy.priority, [...DEFAULT_AUTO_FATE_GRANT_POLICY.priority]);
  }
});

test('LIV-20 auto grant: an ally gets exactly two cards applied with no DOM', () => {
  const ally = createPartyMember(FIGHTER, { x: 3, y: 3 });
  ally.level = 2;
  ally.xpToNextLevel = 200;

  const result = applyAutoFateGrant(ally, 2, null);

  assert.equal(result.chosen.length, 2, 'ally auto-drafts exactly two cards');
  assert.ok(result.offer.cards.length >= 2, 'offer is non-trivial');
  assert.ok(Array.isArray(result.applied.addedToHotbar) || Array.isArray(result.applied.addedToBackpack));
});

test('LIV-20 auto grant: overflow lands in the shared backpack, ally keeps no backpack', () => {
  // Simulate the LIV-22 shared-inventory model: the member carries no backpack;
  // the party stash lives on the top-level player.
  const player = createPartyPlayer('magician');
  player.backpack = new Array(36).fill(null);
  const ally = createPartyMember(FIGHTER, { x: 3, y: 3 });
  delete ally.backpack;
  const filler = { item_id: 'zzz_filler', name: 'Filler' };
  ally.paperdoll = { main_hand: { ...filler }, off_hand: { ...filler }, armor: { ...filler }, relic: { ...filler } };
  ally.action_bar = ally.action_bar.map(() => ({ ...filler }));

  const before = player.backpack.filter(Boolean).length;
  const result = applyAutoFateGrant(ally, 2, null, player);
  const after = player.backpack.filter(Boolean).length;

  assert.equal(result.chosen.length, 2, 'ally auto-drafts exactly two cards');
  assert.ok(after > before, 'drafted overflow landed in the shared backpack');
  assert.equal(
    Object.prototype.hasOwnProperty.call(ally, 'backpack'),
    false,
    'the ally never keeps a per-member backpack'
  );
});

test('LIV-20 name helper: catalog display name is used for the cue', () => {
  const ally = createPartyMember('paladin');
  assert.equal(partyMemberName(ally), VOCATIONS_CATALOG.paladin.name);
  assert.equal(partyMemberName({ name: 'Custom' }), 'Custom');
});

test('LIV-20 app wiring: shared XP and an ally-only auto grant, no ally modal', () => {
  const src = readControllerSources();

  assert.match(src, /awardPartyXp\(this\.player, xpEarned\)/, 'combat kill path awards shared party XP');
  assert.match(src, /this\.handleAllyLevelUps\(partyXp\.allies\)/, 'ally level-ups are routed to the auto handler');

  const allyBody = (src.match(/handleAllyLevelUps\(levelUps\)\s*\{([\s\S]*?)\n  \},/) || [])[1] || '';
  assert.ok(allyBody, 'handleAllyLevelUps method is present');
  assert.match(allyBody, /applyAutoFateGrant\(/, 'ally draft is applied automatically');
  assert.match(allyBody, /UI_CATALOG\.party\.allyLevelUpCue/, 'the level-up cue copy is catalog-driven (LIV-26)');
  assert.doesNotMatch(allyBody, /showFateGrantModal/, 'non-active allies never open the interactive draft');
  assert.match(allyBody, /persistSave\(\)/, 'auto-granted ally progression is persisted');
});
