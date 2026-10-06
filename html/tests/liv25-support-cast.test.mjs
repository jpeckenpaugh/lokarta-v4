/**
 * LIV-25 FIX-10 — allies cast support abilities on the party (shields/heals,
 * no spam).
 *
 * Locks the v2 `party_ai.json` `support` contract onto the engine:
 *   - the Paladin's `holy_shield` ("Aegis Holy Shield") is a first-class
 *     `abilities.json` shield, dispatched by the declared `actionKey`
 *     `force_shield`;
 *   - auto allies shield the lowest-HP living ally below `shieldPct` while mana
 *     stays above `minManaFrac`, and heal the most-injured ally below `healPct`;
 *   - anti-spam gates: per-ability cooldown, the shared `support.cooldownSec`
 *     cadence, a never-ward-an-already-warded-ally rule, and the mana floor;
 *   - the shield reuses the existing `shieldAbsorb`/`shieldDurationSec` bubble
 *     seam in `CombatSystem.applyIncomingDamage`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { CombatSystem } from '../engine/combat-system.js';
import { PartyAI, profileForVocation, DEFAULT_AI_SUPPORT } from '../engine/party-ai.js';
import { createPartyMember, createPartyPlayer, PARTY_FACTION, MONSTER_FACTION } from '../engine/party.js';
import { ABILITIES_CATALOG, PARTY_AI_CATALOG } from '../data/index.js';

function floorGrid(width = 20, height = 20) {
  const grid = new GridMap(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) grid.tiles[y][x].type = TILE_TYPES.FLOOR;
  }
  return grid;
}

/** A player with the active member plus `members` appended to the party. */
function partyOf(activeVocation, members = []) {
  const player = createPartyPlayer(activeVocation);
  player.x = 0;
  player.y = 0;
  for (const member of members) player.party.push(member);
  return player;
}

function actor(vocation, x, y, overrides = {}) {
  return createPartyMember(vocation, { x, y, ...overrides });
}

test('LIV-25 catalog: holy_shield is a data-driven ally shield', () => {
  const spec = ABILITIES_CATALOG.holy_shield;
  assert.ok(spec, 'abilities.json must carry the support shield');
  assert.equal(spec.type, 'shield');
  assert.equal(spec.actionKey, 'force_shield', 'dispatch is on the declared actionKey');
  assert.equal(spec.targetsAllies, true);
  assert.ok(spec.shieldAbsorb > 0);
  assert.ok(spec.shieldDurationSec > 0);
  assert.ok(spec.manaCost > 0);
  assert.ok(spec.cooldownSec > 0);
});

test('LIV-25 profile: paladin enables support and lists the shield', () => {
  const support = profileForVocation('paladin').support;
  assert.ok(support, 'resolved profile exposes the support block');
  assert.equal(support.enabled, true);
  assert.ok(support.abilities.includes('paladin_heal'));
  assert.ok(support.abilities.includes('holy_shield'));
  assert.deepEqual(support.order, ['heal', 'shield']);
  assert.ok(support.healPct > 0 && support.healPct <= 1);
  assert.ok(support.shieldPct > 0 && support.shieldPct <= 1);
  assert.ok(support.minManaFrac >= 0 && support.minManaFrac < 1);
  // Every authored support id resolves to a real ability.
  for (const id of support.abilities) assert.ok(ABILITIES_CATALOG[id], `unknown support ability ${id}`);
  // Non-support vocations stay disabled and reuse the engine baseline.
  assert.equal(profileForVocation('fighter').support.enabled, false);
  assert.equal(profileForVocation('not_a_vocation').support.enabled, DEFAULT_AI_SUPPORT.enabled);
});

test('LIV-25 selectShieldTarget: lowest-HP friendly below the threshold, never a warded one', () => {
  const paladin = actor('paladin', 0, 0);
  const healthy = actor('fighter', 1, 0, { hp: 80, max_hp: 100 });
  const hurt = actor('archer', 2, 0, { hp: 30, max_hp: 100 });
  const enemy = { x: 0, y: 1, hp: 10, max_hp: 100, faction: MONSTER_FACTION };

  const pick = CombatSystem.selectShieldTarget(paladin, [healthy, hurt, enemy], 6, 0.9);
  assert.equal(pick, hurt, 'lowest-HP (most-injured) friendly wins, enemies are ignored');

  // Below-threshold actors only.
  assert.equal(CombatSystem.selectShieldTarget(paladin, [healthy, hurt], 6, 0.2), null);

  // Already warded allies are skipped (anti-spam).
  hurt.shieldAbsorb = 10;
  hurt.shieldDurationSec = 5;
  assert.equal(CombatSystem.selectShieldTarget(paladin, [healthy, hurt], 6, 0.9), healthy);

  // Radius gate.
  hurt.shieldAbsorb = 0;
  hurt.shieldDurationSec = 0;
  assert.equal(CombatSystem.selectShieldTarget(paladin, [healthy, hurt], 1, 0.9), healthy);
});

test('LIV-25 executeForceShield: arms the bubble shared with incoming damage', () => {
  const paladin = actor('paladin', 0, 0);
  const fighter = actor('fighter', 1, 0, { hp: 100, max_hp: 140 });
  const spec = ABILITIES_CATALOG.holy_shield;

  const res = CombatSystem.executeForceShield(paladin, fighter, spec);
  assert.equal(res.success, true);
  assert.equal(fighter.shieldAbsorb, spec.shieldAbsorb);
  assert.equal(fighter.shieldDurationSec, spec.shieldDurationSec);
  assert.equal(paladin.mana, 90 - spec.manaCost);
  assert.equal(paladin.cooldowns.force_shield, spec.cooldownSec);

  // The ward absorbs damage through the exact same seam as the item shields.
  const hit = CombatSystem.applyIncomingDamage(fighter, spec.shieldAbsorb + 5);
  assert.equal(hit.absorbed, spec.shieldAbsorb);
  assert.equal(hit.damageToPlayer, 5);
  assert.equal(fighter.hp, 95);

  // Only friendly actors can be warded; a missing spec/ward is a safe no-op.
  const enemy = { x: 2, y: 0, hp: 10, max_hp: 10, faction: MONSTER_FACTION };
  assert.equal(CombatSystem.executeForceShield(paladin, enemy, spec).success, false);
  assert.equal(CombatSystem.executeForceShield(paladin, null, spec).success, false);
  assert.equal(CombatSystem.executeForceShield(paladin, fighter, {}).success, false);
});

test('LIV-25 auto-AI: the paladin shields the lowest ally without spamming', () => {
  const grid = floorGrid();
  const paladin = actor('paladin', 5, 5);
  const fighter = actor('fighter', 6, 5, { hp: 70, max_hp: 140 }); // 0.5 <= shieldPct
  const player = partyOf('magician', [paladin, fighter]);

  // Heal already cooling down so the shield is the next support in order.
  paladin.cooldowns.healing_prayer = 5;

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1 });
  const cast = events.find((ev) => ev.abilityId === 'holy_shield');
  assert.ok(cast, 'paladin raised the shield');
  assert.equal(cast.actionKey, 'force_shield');
  assert.equal(cast.target, fighter, 'the lowest-HP ally was warded');
  assert.equal(fighter.shieldAbsorb, ABILITIES_CATALOG.holy_shield.shieldAbsorb);
  assert.ok(paladin._supportTimer > 0, 'the shared support cadence was armed');

  // Second tick: the ally is already warded and the caster is on cadence, so the
  // paladin must NOT re-cast the shield (no spam).
  const absorbedBefore = fighter.shieldAbsorb;
  const again = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1 });
  assert.ok(!again.some((ev) => ev.abilityId === 'holy_shield'), 'no shield recast while warded');
  assert.equal(fighter.shieldAbsorb, absorbedBefore);
  assert.ok(paladin.mana <= 90 - ABILITIES_CATALOG.holy_shield.manaCost, 'no extra mana spent');
});

test('LIV-25 auto-AI: the mana floor suppresses support casting', () => {
  const grid = floorGrid();
  const paladin = actor('paladin', 5, 5, { mana: 10 }); // 10/90 <= minManaFrac 0.2
  const fighter = actor('fighter', 6, 5, { hp: 60, max_hp: 140 });
  const player = partyOf('magician', [paladin, fighter]);
  paladin.cooldowns.healing_prayer = 5;

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1 });
  assert.ok(!events.some((ev) => ev.type === 'ability'), 'no support cast below the mana floor');
  assert.equal(fighter.shieldAbsorb || 0, 0);
  assert.equal(paladin.mana, 10);
});

test('LIV-25 auto-AI: heals respect healPct (no topping off a healthy party)', () => {
  const grid = floorGrid();
  const paladin = actor('paladin', 5, 5);
  const fighter = actor('fighter', 6, 5, { hp: 110, max_hp: 140 }); // 0.79 > healPct 0.65
  const player = partyOf('magician', [paladin, fighter]);

  const events = PartyAI.updateAllies(player, { gridMap: grid, monsters: [], deltaSec: 0.1 });
  assert.ok(!events.some((ev) => ev.abilityId === 'paladin_heal'), 'a lightly-scratched party is not healed');
  assert.equal(fighter.hp, 110);
});

test('LIV-25 integration: support kinds are wired through the party loop', () => {
  const support = PARTY_AI_CATALOG.default.support;
  assert.ok(support, 'party_ai.json default exposes the support schema');
  assert.equal(typeof support.enabled, 'boolean');
  assert.ok(Array.isArray(support.order));
  assert.ok(Array.isArray(support.abilities));
  assert.ok(PARTY_FACTION);
});
