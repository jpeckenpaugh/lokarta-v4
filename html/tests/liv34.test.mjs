/**
 * E1 / Regression suite.
 *
 * Covers the four board items:
 *  1. Fate Grant keyboard flow + exact-2 selection contract.
 *  2. Magician item updates: Radian Light Spell removed, Shock Shield and
 *     Luminous Prayer actives added.
 *  3. Loadout cooldown "recharge" overlay (D1 §2.5).
 *  4. Wooden Torch removed from every catalog, drop table, shop and cache.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ITEMS_CATALOG,
  CARDS_CATALOG,
  CHESTS_CATALOG,
  MONSTERS_CATALOG,
  ECONOMY_CATALOG,
  TOWER_LEVELS_CATALOG,
} from '../data/index.js';
import { CombatSystem, EntityAI, FateGrantSystem, applyItemRankUp } from '../engine/index.js';
import { createPlayer } from '../engine/config.js';
import { HUDManager } from '../app/hud-manager.js';

const ITEM_KEYS = Object.keys(ITEMS_CATALOG);

test('Item removals', async t => {
  await t.test('Wooden Torch is absent from catalog, drops, chests, shop and caches', () => {
    assert.equal(ITEMS_CATALOG.torch, undefined, 'torch item must be gone');
    assert.ok(
      !ITEM_KEYS.some(id => /torch/i.test(id) || /wooden torch/i.test(ITEMS_CATALOG[id]?.name || '')),
      'no torch item may remain in items.json'
    );

    for (const [tier, table] of Object.entries(CHESTS_CATALOG.chests)) {
      assert.ok(!table.entries.some(e => e.itemId === 'torch'), `${tier} chest table still drops a torch`);
    }
    for (const monster of Object.values(MONSTERS_CATALOG)) {
      assert.ok(!(monster.lootTable || []).some(e => e.item_id === 'torch'), `${monster.type} still drops a torch`);
    }
    assert.ok(!ECONOMY_CATALOG.stock.some(s => s.itemId === 'torch'), 'torch must not be in the shop');
    for (const [level, cache] of Object.entries(TOWER_LEVELS_CATALOG.starterCache)) {
      assert.ok(!cache.some(e => e.item_id === 'torch'), `level ${level} starter cache still grants a torch`);
    }
  });

  await t.test('Radiant Light Spell is absent from the item and draft card catalogs', () => {
    assert.equal(ITEMS_CATALOG.spell_light, undefined, 'spell_light item must be gone');
    assert.ok(
      !CARDS_CATALOG.some(
        c => c.id === 'card_light_spell' || c.item?.item_id === 'spell_light' || /radiant light/i.test(c.name)
      ),
      'the Radiant Light Spell draft card must be gone'
    );
  });
});

test('Fate Grant exact-2 selection contract', async t => {
  await t.test('generateDraftOffer requires exactly 2 cards for every vocation', () => {
    for (const vocation of ['magician', 'archer', 'fighter', 'paladin']) {
      const offer = FateGrantSystem.generateDraftOffer(vocation, 1);
      assert.equal(offer.cards.length, 5);
      assert.deepEqual(offer.requiredSelections, { min: 2, max: 2 }, `${vocation} must require exactly 2`);
    }
  });

  await t.test('degrades to "require all" when fewer than 2 cards are offered', () => {
    const originalDb = FateGrantSystem.CARD_DATABASE;
    const originalShuffle = FateGrantSystem.shuffle;
    try {
      FateGrantSystem.CARD_DATABASE = [
        { id: 'only', name: 'Solo', rarity: 'common', icon: 'x', item: { item_id: 'health_potion' } },
      ];
      FateGrantSystem.shuffle = () => {};
      const offer = FateGrantSystem.generateDraftOffer('magician', 2);
      assert.equal(offer.cards.length, 1);
      assert.deepEqual(offer.requiredSelections, { min: 1, max: 1 });
    } finally {
      FateGrantSystem.CARD_DATABASE = originalDb;
      FateGrantSystem.shuffle = originalShuffle;
    }
  });
});

test("Shock Shield (Apprentice's Cape, E key)", async t => {
  await t.test('catalog wiring: 2 MP, 10s cooldown, 5s stun, +1s/-1s per rank', () => {
    const cape = ITEMS_CATALOG.apprentice_cape;
    assert.equal(cape.actionKey, 'shock_shield');
    assert.equal(cape.manaCost, 2);
    assert.equal(cape.cooldown, 10);
    assert.equal(cape.stunSec, 5);
    assert.equal(cape.upgradeSpec.stunInc, 1);
    assert.equal(cape.upgradeSpec.cooldownReductionSec, 1);

    assert.equal(CombatSystem.getEffectiveCooldown({ ...cape, itemLevel: 1 }), 10);
    assert.equal(CombatSystem.getEffectiveCooldown({ ...cape, itemLevel: 5 }), 6);
  });

  await t.test('casts for 2 MP, arms one charge and is cooldown-gated', () => {
    const player = createPlayer('magician');
    const cape = { ...ITEMS_CATALOG.apprentice_cape };

    const res = CombatSystem.executeShockShield(player, cape);
    assert.equal(res.success, true);
    assert.equal(player.mana, player.max_mana - 2, '2 MP consumed');
    assert.equal(player.cooldowns.shock_shield, 10);
    assert.equal(player.shockShieldCharges, 1);
    assert.equal(player.shockShieldStunSec, 5);

    const again = CombatSystem.executeShockShield(player, cape);
    assert.equal(again.success, false);
    assert.match(again.message, /cooldown/i);
  });

  await t.test('refuses to cast without enough mana and does not arm a charge', () => {
    const player = createPlayer('magician');
    player.mana = 1;
    const res = CombatSystem.executeShockShield(player, { ...ITEMS_CATALOG.apprentice_cape });
    assert.equal(res.success, false);
    assert.equal(player.shockShieldCharges, undefined);
    assert.equal(player.mana, 1);
  });

  await t.test('deflects exactly one enemy attack and stuns the attacker for 5s', () => {
    const player = createPlayer('magician');
    player.shockShieldCharges = 1;
    player.shockShieldStunSec = 5;
    const attacker = { x: 3, y: 2, name: 'Giant Rat', stunTimer: 0 };

    const first = CombatSystem.applyIncomingDamage(player, 12, attacker);
    assert.equal(first.deflected, true);
    assert.equal(first.damageToPlayer, 0);
    assert.equal(player.hp, player.max_hp, 'deflected hit deals no damage');
    assert.equal(attacker.stunTimer, 5, 'attacker is stunned 5s');
    assert.equal(player.shockShieldCharges, 0, 'charge is consumed');

    const second = CombatSystem.applyIncomingDamage(player, 12, attacker);
    assert.equal(second.deflected, false);
    assert.equal(second.damageToPlayer, 12);
    assert.equal(player.hp, player.max_hp - 12);
  });

  await t.test('an armed shield deflects a real EntityAI melee attack and stuns the monster', () => {
    const player = createPlayer('magician');
    player.shockShieldCharges = 1;
    player.shockShieldStunSec = 5;
    const monster = {
      id: 'm1',
      type: 'giant_rat',
      name: 'Giant Rat',
      x: player.x + 1,
      y: player.y,
      hp: 30,
      max_hp: 30,
      attackCooldown: 0,
      moveCooldown: 0,
      attackCadence: 1.2,
      isAggroed: true,
      facing: 'left',
    };
    const grid = {
      width: 10,
      height: 10,
      isWalkable: () => true,
      isInBounds: () => true,
      isWall: () => false,
    };

    const results = EntityAI.updateMonsters([monster], player, grid, 0.1);
    const hit = results.find(r => r.sourceMonster === monster);
    assert.ok(hit, 'the adjacent monster must attack');
    assert.equal(hit.deflected, true);
    assert.equal(hit.damageToPlayer, 0);
    assert.equal(monster.stunTimer, 5);
    assert.equal(player.hp, player.max_hp);
  });

  await t.test('rank scaling reaches 9s stun / 6s cooldown at Rank 5', () => {
    const player = createPlayer('magician');
    const cape = JSON.parse(JSON.stringify(ITEMS_CATALOG.apprentice_cape));
    for (let i = 0; i < 4; i++) applyItemRankUp(player, cape);

    assert.equal(cape.itemLevel, 5);
    assert.equal(cape.stunSec, 9, '+1s stun per rank');
    assert.equal(CombatSystem.getEffectiveCooldown(cape), 6, '-1s cooldown per rank');
  });
});

test('Luminous Amulet — Luminous Prayer active (R key)', async t => {
  await t.test('catalog wiring: 20s base cooldown, -2s per rank (0 MP)', () => {
    const amulet = ITEMS_CATALOG.relic_luminous_amulet;
    assert.equal(amulet.actionKey, 'luminous_prayer');
    assert.equal(amulet.cooldown, 20);
    assert.equal(amulet.manaCost, 0);
    assert.equal(amulet.upgradeSpec.cooldownReductionSec, 2);

    assert.equal(CombatSystem.getEffectiveCooldown({ ...amulet, itemLevel: 1 }), 20);
    assert.equal(CombatSystem.getEffectiveCooldown({ ...amulet, itemLevel: 5 }), 12);
  });

  await t.test('restores HP/MP scaled by rank and sets the cooldown', () => {
    const player = createPlayer('magician');
    player.hp = 10;
    player.mana = 10;
    const amulet = { ...ITEMS_CATALOG.relic_luminous_amulet, itemLevel: 3 };

    const res = CombatSystem.executeLuminousPrayer(player, amulet);
    assert.equal(res.success, true);
    assert.equal(res.hpRestored, 15);
    assert.equal(res.mpRestored, 15);
    assert.equal(player.hp, 25);
    assert.equal(player.mana, 25);
    assert.equal(player.cooldowns.luminous_prayer, 16, 'rank 3: 20 - 2x2 = 16s');

    const again = CombatSystem.executeLuminousPrayer(player, amulet);
    assert.equal(again.success, false);
    assert.match(again.message, /cooldown/i);
  });

  await t.test('no-ops when both HP and MP are already full', () => {
    const player = createPlayer('magician');
    const res = CombatSystem.executeLuminousPrayer(player, { ...ITEMS_CATALOG.relic_luminous_amulet });
    assert.equal(res.success, false);
    assert.equal(player.cooldowns.luminous_prayer, undefined);
  });
});

function makeFakeSlot(label) {
  const classes = new Set();
  const attrs = { 'aria-label': label };
  const styleProps = {};
  const overlay = { style: {} };
  return {
    dataset: {},
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, force) => { if (force) classes.add(c); else classes.delete(c); },
    },
    style: {
      setProperty: (k, v) => { styleProps[k] = v; },
      removeProperty: k => { delete styleProps[k]; },
    },
    querySelector: sel => (sel === '.cooldown-overlay' ? overlay : null),
    getAttribute: k => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    _state: { classes, attrs, styleProps, overlay },
  };
}

test('Loadout cooldown overlay (D1 §2.5)', async t => {
  await t.test('paints a top-to-bottom wipe from remaining / effective cooldown', () => {
    const slot = makeFakeSlot('Armor, key E');
    const cape = { ...ITEMS_CATALOG.apprentice_cape, itemLevel: 1 };
    const app = { player: { cooldowns: { shock_shield: 5 } } };

    HUDManager._paintCooldown(slot, cape, app);

    assert.ok(slot._state.classes.has('on-cooldown'), 'slot is flagged on cooldown');
    assert.equal(slot._state.overlay.style.display, 'block');
    assert.equal(slot._state.styleProps['--cd-inset'], '50.0%');
    assert.match(slot._state.attrs['aria-label'], /recharging$/);
  });

  await t.test('clears the overlay when the ability is ready', () => {
    const slot = makeFakeSlot('Armor, key E');
    const cape = { ...ITEMS_CATALOG.apprentice_cape };
    const app = { player: { cooldowns: { shock_shield: 0 } } };

    HUDManager._paintCooldown(slot, cape, app);

    assert.equal(slot._state.classes.has('on-cooldown'), false);
    assert.equal(slot._state.overlay.style.display, 'none');
    assert.equal(slot._state.attrs['aria-label'], 'Armor, key E');
  });

  await t.test('ignores items without a cooldown (e.g. consumables)', () => {
    const slot = makeFakeSlot('Active slot 1');
    const app = { player: { cooldowns: {} } };

    HUDManager._paintCooldown(slot, { ...ITEMS_CATALOG.health_potion }, app);

    assert.equal(slot._state.classes.has('on-cooldown'), false);
    assert.equal(slot._state.overlay.style.display, 'none');
  });
});
