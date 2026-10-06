/**
 * LIV-11 WS3 — Combat actor generalization + friendly fire + ally healing.
 *
 * Locks the multi-actor combat contract layered on the LIV-9 party model:
 *   - every `executeX` method acts on any party-member-shaped actor, with
 *     per-actor cooldowns (no global-player reads);
 *   - faction is declared on party members and monsters and a single
 *     `isFriendly`/`isHostile` guard blocks same-faction damage at the damage
 *     seam, target selection, projectile collision and status application;
 *   - healing abilities restore the most-injured friendly actor within the
 *     catalog `healRadius`, falling back to self;
 *   - one-member calls behave exactly as before.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, TILE_TYPES, createPlayer } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { CombatSystem } from '../engine/combat-system.js';
import {
  PARTY_FACTION,
  MONSTER_FACTION,
  factionOf,
  isFriendly,
  isHostile,
  sameActor,
  createPartyMember,
} from '../engine/party.js';
import { firstMonsterOnSegment, monstersCaughtByBeam } from '../engine/projectile-collision.js';
import { MONSTERS_CATALOG, ITEMS_CATALOG } from '../data/index.js';

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
    ...overrides,
  };
}

test('LIV-11 faction helpers: declared, missing, and same-actor classification', () => {
  const party = createPartyMember('fighter');
  const monster = { faction: MONSTER_FACTION };
  assert.equal(PARTY_FACTION, 'party');
  assert.equal(MONSTER_FACTION, 'monsters');
  assert.equal(factionOf(party), PARTY_FACTION);
  assert.equal(factionOf({}), null, 'factionless entities declare nothing');
  assert.equal(isFriendly(party, createPartyMember('archer')), true);
  assert.equal(isFriendly(party, monster), false);
  assert.equal(isHostile(party, monster), true);
  // Missing faction is never friendly -> damage still applies (backward compat).
  assert.equal(isFriendly(party, {}), false);
  assert.equal(isHostile(party, {}), true);
  // The active mirror is never double-counted.
  const active = createPartyMember('magician');
  assert.equal(sameActor(active, active), true);
  assert.equal(sameActor(active, createPartyMember('magician')), true, 'same memberId');
  assert.equal(sameActor({ activeMemberId: 'member_magician' }, active), true);
  assert.equal(sameActor(active, createPartyMember('archer')), false);
});

test('LIV-11 catalog: every monster declares the monsters faction', () => {
  for (const [id, monster] of Object.entries(MONSTERS_CATALOG)) {
    assert.equal(monster.faction, MONSTER_FACTION, `${id} must declare faction`);
  }
});

test('LIV-11 actors: createPlayer carries the party faction', () => {
  assert.equal(createPlayer('fighter').faction, PARTY_FACTION);
});

test('LIV-11 actor contract: abilities act on a member actor with per-actor cooldowns', () => {
  const mage = createPartyMember('magician', { x: 2, y: 2, mana: 50, level: 1 });
  const other = createPartyMember('magician', { x: 8, y: 8, mana: 50, level: 1 });
  const target = enemy(5, 2);

  const res = CombatSystem.executeWandSpark(mage, target, floorGrid());
  assert.equal(res.success, true);
  assert.ok(mage.mana < 50, 'mana is spent on the actor');
  assert.ok(mage.cooldowns.wand_spark > 0, 'cooldown lands on the actor');
  assert.equal(other.cooldowns.wand_spark, undefined, 'no global cooldown leak');

  CombatSystem.tickActorTimers(mage, 0.25);
  assert.ok(mage.cooldowns.wand_spark < CONFIG.MAGICIAN_SPARK_COOLDOWN_SEC);
  assert.equal(other.cooldowns.wand_spark, undefined);
});

test('LIV-11 friendly fire: the damage seam blocks same-faction attackers', () => {
  const ally = createPartyMember('fighter', { x: 5, y: 5, hp: 50, max_hp: 100 });
  const caster = createPartyMember('magician', { x: 4, y: 5 });

  const friendly = CombatSystem.applyIncomingDamage(ally, 40, caster);
  assert.equal(friendly.friendlyFire, true);
  assert.equal(friendly.damageToPlayer, 0);
  assert.equal(ally.hp, 50, 'ally took no friendly damage');

  const hostile = CombatSystem.applyIncomingDamage(ally, 40, enemy(4, 5));
  assert.notEqual(hostile.friendlyFire, true);
  assert.ok(hostile.damageToPlayer > 0);
  assert.ok(ally.hp < 50, 'a real enemy still lands damage');
});

test('LIV-11 friendly fire: melee, cleave and melee-area search ignore allies', () => {
  const grid = floorGrid();
  const fighter = createPartyMember('fighter', { x: 2, y: 2, hp: 100, max_hp: 100 });
  const ally = createPartyMember('archer', { x: 3, y: 2, hp: 80, max_hp: 80 });
  const monster = enemy(3, 2);

  assert.equal(
    CombatSystem.findMonsterInMeleeArea(fighter, [ally], 2.5, 'right', grid),
    null,
    'an adjacent ally is never a melee target'
  );

  const cleave = CombatSystem.executeCleave(fighter, grid, [ally, monster]);
  assert.equal(cleave.success, true);
  assert.equal(ally.hp, 80, 'cleave did not touch the ally');
  assert.ok(monster.hp < 100, 'the enemy was cleaved');
  assert.equal(cleave.hits.length, 1);

  const slash = CombatSystem.executeSlash(fighter, ally, grid, { monsters: [ally] });
  assert.equal(slash.success, true);
  assert.equal(ally.hp, 80, 'slash refused the friendly target');
});

test('LIV-11 friendly fire: AoE/status/utility resolvers skip allies', () => {
  const grid = floorGrid();
  const paladin = createPartyMember('paladin', { x: 2, y: 2, hp: 60, max_hp: 100, mana: 200 });
  const ally = createPartyMember('archer', { x: 3, y: 2, hp: 40, max_hp: 100 });
  const monster = enemy(3, 3);

  const siphon = CombatSystem.executeLifeSiphon(paladin, grid, [ally, monster], {
    item_id: 'vampiric_cloak', manaCost: 1, siphonRadius: 2, siphonHp: 5, cooldown: 8,
  });
  assert.equal(siphon.success, true);
  assert.equal(ally.hp, 40, 'life siphon never drains an ally');
  assert.ok(monster.hp <= 95);

  const mark = CombatSystem.executeHuntersMark(paladin, grid, [ally, monster], {
    item_id: 'ranger_talisman', manaCost: 3, markRange: 8, markDurationSec: 6, cooldown: 15,
  });
  assert.equal(mark.success, true);
  assert.ok(!mark.marked.includes(ally), 'ally is not marked');
  assert.ok(mark.marked.includes(monster));

  const bash = CombatSystem.executeShieldBash(paladin, grid, [ally, monster], {
    item_id: 'aegis_shield', cooldown: 10, pushbackRange: 1, stunSec: 1,
  });
  assert.equal(bash.success, true);
  assert.ok(!bash.affected.some((entry) => entry.monster === ally), 'ally is never shoved/stunned');

  // Hostile statuses cannot be applied to a party member by a party member.
  assert.equal(
    CombatSystem.applyPlayerStatus(ally, { status: 'burn', durationSec: 2, dps: 5 }, paladin),
    false
  );
  assert.equal(ally.burnTimer, undefined);
});

test('LIV-11 projectiles: hostile predicate keeps party projectiles off allies', () => {
  const fighter = createPartyMember('fighter');
  const ally = { id: 'ally', faction: PARTY_FACTION, hp: 60, max_hp: 60, x: 2, y: 2 };
  const monster = { id: 'monster', faction: MONSTER_FACTION, hp: 60, max_hp: 60, x: 4, y: 2 };
  const hostile = (m) => CombatSystem.isHostile(fighter, m);

  const sweep = firstMonsterOnSegment([ally, monster], 1, 2, 5, 2, () => false, hostile);
  assert.equal(sweep.monster, monster, 'sweep skips the ally in the lane');
  assert.equal(
    firstMonsterOnSegment([ally], 1, 2, 5, 2, () => false, hostile),
    null,
    'an ally-only lane is a clean miss'
  );

  const caught = monstersCaughtByBeam(
    [ally, monster],
    [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 }],
    { originX: 1, originY: 2, fX: 1, fY: 0, frontIndex: 4 },
    [],
    hostile
  );
  assert.deepEqual(caught.map((m) => m.id), ['monster']);
});

test('LIV-11 heal targeting: most-injured friendly actor wins, self is the fallback', () => {
  const paladin = createPartyMember('paladin', { x: 5, y: 5, hp: 100, max_hp: 100, mana: 200 });
  const hurt = createPartyMember('fighter', { x: 6, y: 5, hp: 50, max_hp: 100 });
  const hurtMore = createPartyMember('archer', { x: 7, y: 5, hp: 20, max_hp: 100 });
  assert.equal(CombatSystem.selectHealTarget(paladin, [hurt, hurtMore], 6), hurtMore);

  // An out-of-radius ally is ignored; an injured self is healed instead.
  const paladin2 = createPartyMember('paladin', { x: 5, y: 5, hp: 90, max_hp: 100, mana: 200 });
  const far = createPartyMember('fighter', { x: 30, y: 30, hp: 10, max_hp: 100 });
  assert.equal(CombatSystem.selectHealTarget(paladin2, [far], 6), paladin2);
  // Nobody hurt -> null (cast refused).
  const healthy = createPartyMember('paladin', { x: 5, y: 5, hp: 100, max_hp: 100, mana: 200 });
  assert.equal(CombatSystem.selectHealTarget(healthy, [createPartyMember('fighter', { hp: 100, max_hp: 100 })], 6), null);
});

test('LIV-11 healing prayer: restores the hurt ally and keeps one-member behavior', () => {
  const paladin = createPartyMember('paladin', { x: 5, y: 5, hp: 60, max_hp: 100, mana: 200 });
  const hurt = createPartyMember('fighter', { x: 6, y: 5, hp: 20, max_hp: 100 });
  const full = createPartyMember('archer', { x: 5, y: 6, hp: 90, max_hp: 90 });

  const res = CombatSystem.executeHealingPrayer(paladin, [hurt, full]);
  assert.equal(res.success, true);
  assert.equal(res.healedAlly, true);
  assert.ok(hurt.hp > 20, 'the most-injured ally was healed');
  assert.equal(paladin.hp, 60, 'self was untouched while an ally needed it');
  assert.equal(full.hp, 90);
  assert.equal(paladin.mana, 200 - CONFIG.PALADIN_HEAL_MANA_COST);
  assert.equal(paladin.cooldowns.healing_prayer, CONFIG.PALADIN_HEAL_COOLDOWN_SEC);

  // Out-of-range ally -> fall back to self, unchanged legacy message.
  const paladin2 = createPartyMember('paladin', { x: 5, y: 5, hp: 50, max_hp: 100, mana: 200 });
  const far = createPartyMember('fighter', { x: 30, y: 30, hp: 10, max_hp: 100 });
  const selfRes = CombatSystem.executeHealingPrayer(paladin2, [far]);
  assert.equal(selfRes.success, true);
  assert.equal(selfRes.healedAlly, false);
  assert.ok(paladin2.hp > 50);
  assert.equal(far.hp, 10);
  assert.match(selfRes.message, /Healing Prayer channeled! Restored \+\d+ HP \(\d+\/\d+\)\./);

  // Everyone full -> refused.
  const paladin3 = createPartyMember('paladin', { hp: 100, max_hp: 100, mana: 200 });
  const allyFull = createPartyMember('fighter', { hp: 100, max_hp: 100 });
  assert.equal(CombatSystem.executeHealingPrayer(paladin3, [allyFull]).success, false);
});

test('LIV-11 benediction: ally-aware HP heal with self MP restore', () => {
  const relic = JSON.parse(JSON.stringify(ITEMS_CATALOG.relic_dawnlight));
  assert.equal(relic.healRadius, 6, 'catalog declares the ally heal radius');
  assert.equal(relic.targetsAllies, true);

  const paladin = createPartyMember('paladin', { x: 5, y: 5, hp: 50, max_hp: 100, mana: 50 });
  const hurt = createPartyMember('fighter', { x: 6, y: 5, hp: 30, max_hp: 100 });
  const beforeMana = paladin.mana;

  const res = CombatSystem.executeBenediction(paladin, relic, [hurt]);
  assert.equal(res.success, true);
  assert.equal(res.healedAlly, true);
  assert.ok(hurt.hp > 30, 'benediction healed the ally');
  assert.equal(paladin.hp, 50, 'caster HP untouched');
  assert.ok(paladin.mana > beforeMana - 30 && paladin.mana <= beforeMana, 'MP restored to the caster');
  assert.equal(res.mpRestored, 15);

  // One-member call still heals self (regression).
  const solo = createPartyMember('paladin', { x: 5, y: 5, hp: 40, max_hp: 100, mana: 120 });
  const soloRes = CombatSystem.executeBenediction(solo, relic);
  assert.equal(soloRes.success, true);
  assert.equal(soloRes.healedAlly, false);
  assert.ok(solo.hp > 40);
});
