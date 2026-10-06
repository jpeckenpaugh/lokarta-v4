/**
 * Regression suite.
 *
 * Covers the four board items:
 *  1. Grey Stalker Quiver levels 1->5 and its "Poison Tip" active applies a
 *     rank-scaled poison DoT to arrows.
 *  2. Hunter's Leathers is renamed "Vampiric Cloak" and gains "Life Siphon"
 *     (drain + heal in a 2-tile radius).
 *  3. Archer's Hood is replaced by the "Ranger's Talisman" relic with
 *     "Hunter's Mark" (arrows deal bonus damage to marked foes).
 *  4. All four archer primaries author `actionKey` + `cooldown` so the loadout
 *     recharge overlay paints when they are used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ITEMS_CATALOG, CARDS_CATALOG, VOCATIONS_CATALOG } from '../data/index.js';
import { GridMap, TILE_TYPES, CombatSystem, FateGrantSystem, applyItemRankUp, canUpgradeItem, createPlayer } from '../engine/index.js';
import { HUDManager } from '../app/hud-manager.js';
import { readControllerSources } from './helpers/app-source.mjs';

function makeFloorGrid(w = 30, h = 30) {
  const g = new GridMap(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      g.tiles[y][x].type = TILE_TYPES.FLOOR;
    }
  }
  return g;
}

function clone(id) {
  return JSON.parse(JSON.stringify(ITEMS_CATALOG[id]));
}

function giveArrows(player, quantity = 20) {
  player.backpack[0] = { item_id: 'arrows', name: 'Arrows', type: 'ammo', quantity, stat_bonus: 0, icon: '🏹' };
}

// ---------------------------------------------------------------------------
// 1. Catalog wiring + rename
// ---------------------------------------------------------------------------

test('Archer primary catalog wiring', async t => {
  await t.test("Grey Stalker Quiver levels and carries the Poison Tip active", () => {
    const quiver = ITEMS_CATALOG.grey_stalker_quiver;
    assert.ok(quiver.upgradeSpec, 'quiver must expose an upgradeSpec (no longer a no-op)');
    assert.equal(quiver.actionKey, 'poison_tip');
    assert.equal(quiver.cooldown, 8);
    assert.equal(quiver.manaCost, 2);
    assert.equal(quiver.poisonDps, 2);
    assert.equal(quiver.poisonDurationSec, 3);
    assert.equal(quiver.poisonArrows, 5);
    assert.equal(quiver.poisonBuffSec, 10);
    assert.equal(quiver.upgradeSpec.poisonDpsInc, 1);
    assert.match(quiver.upgradeSpec.descriptionPattern, /Poison Tip/);
  });

  await t.test("Hunter's Leathers is renamed Vampiric Cloak with Life Siphon", () => {
    const cloak = ITEMS_CATALOG.hunter_leathers;
    assert.equal(cloak.name, 'Vampiric Cloak');
    assert.equal(cloak.actionKey, 'life_siphon');
    assert.equal(cloak.cooldown, 8);
    assert.equal(cloak.manaCost, 1);
    assert.equal(cloak.siphonHp, 5);
    assert.equal(cloak.siphonRadius, 2);
    assert.equal(cloak.upgradeSpec.siphonHpInc, 1);

    const card = CARDS_CATALOG.find(c => c.id === 'card_hunter_leathers');
    assert.ok(card, 'card_hunter_leathers must exist');
    assert.equal(card.name, 'Vampiric Cloak');
    assert.equal(card.item.name, 'Vampiric Cloak');
    assert.ok(!/Hunter's Leathers/i.test(JSON.stringify(CARDS_CATALOG)), 'old name must be gone from cards');
  });

  await t.test("Archer's Hood is replaced by the Ranger's Talisman", () => {
    assert.equal(ITEMS_CATALOG.archer_hood, undefined, 'old hood item must be removed');
    assert.ok(
      !Object.values(ITEMS_CATALOG).some(i => /archer's hood/i.test(i.name || '')),
      'no item may keep the Archer\'s Hood name'
    );
    assert.ok(
      !CARDS_CATALOG.some(c => c.id === 'card_archer_hood' || c.item?.item_id === 'archer_hood' || /archer's hood/i.test(c.name)),
      'old hood card must be gone'
    );

    const talisman = ITEMS_CATALOG.ranger_talisman;
    assert.ok(talisman, 'ranger_talisman item must exist');
    assert.equal(talisman.type, 'relic');
    assert.equal(talisman.slot, 'relic');
    assert.equal(talisman.actionKey, 'hunters_mark');
    assert.equal(talisman.cooldown, 15);
    assert.equal(talisman.manaCost, 3);
    assert.equal(talisman.markDurationSec, 6);
    assert.equal(talisman.markDamageMult, 1.5);
    assert.ok(talisman.critChance > 0, 'talisman keeps the hood crit feel');
    assert.ok(talisman.rangedDamageBonus > 0, 'talisman grants ranged damage');

    const card = CARDS_CATALOG.find(c => c.id === 'card_ranger_talisman');
    assert.ok(card, 'card_ranger_talisman must exist');
    assert.equal(card.item.item_id, 'ranger_talisman');
  });

  await t.test('archer vocation loadout points at the talisman', () => {
    assert.equal(VOCATIONS_CATALOG.archer.solidEquipment.relic, 'ranger_talisman');
    assert.ok(VOCATIONS_CATALOG.archer.nativeEquipment.includes('ranger_talisman'));
    assert.ok(!VOCATIONS_CATALOG.archer.nativeEquipment.includes('archer_hood'));
  });
});

// ---------------------------------------------------------------------------
// 2. Quiver leveling
// ---------------------------------------------------------------------------

test("Grey Stalker Quiver levels 1 -> 5", async t => {
  await t.test('ranks to 5 with a visible Poison dps increase', () => {
    const player = createPlayer('archer');
    const quiver = clone('grey_stalker_quiver');
    assert.equal(canUpgradeItem(quiver), true, 'quiver can rank up');

    const notes = [];
    for (let i = 0; i < 4; i++) {
      const res = applyItemRankUp(player, quiver);
      assert.ok(res, `rank-up ${i + 1} applies`);
      notes.push(...res.notes);
    }
    assert.equal(quiver.itemLevel, 5);
    assert.equal(quiver.poisonDps, 6, '2 base + 1 per rank gained');
    assert.equal(canUpgradeItem(quiver), false, 'capped at rank 5');
    assert.ok(notes.some(n => /Poison/.test(n)), 'rank notes describe the poison increase');
  });

  await t.test('the Fate Grant offers the quiver as a LEVEL UP card with the poison pattern', () => {
    const originalDb = FateGrantSystem.CARD_DATABASE;
    const originalShuffle = FateGrantSystem.shuffle;
    try {
      FateGrantSystem.CARD_DATABASE = [CARDS_CATALOG.find(c => c.id === 'card_grey_stalker_quiver')];
      FateGrantSystem.shuffle = () => {};

      const player = createPlayer('archer');
      player.paperdoll.off_hand = { ...clone('grey_stalker_quiver'), itemLevel: 1 };
      const offer = FateGrantSystem.generateDraftOffer(player, 2);
      assert.equal(offer.cards.length, 1);
      const card = offer.cards[0];
      assert.equal(card.isUpgrade, true);
      assert.match(card.name, /LEVEL UP: Grey Stalker Quiver \(Rank 2\)/);
      assert.match(card.description, /Poison Tip deals \+1 poison damage/);
      assert.match(card.statBonusText, /Poison \+1 Dmg\/s/);
    } finally {
      FateGrantSystem.CARD_DATABASE = originalDb;
      FateGrantSystem.shuffle = originalShuffle;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Poison Tip
// ---------------------------------------------------------------------------

test('Poison Tip (quiver, W key)', async t => {
  await t.test('arms for 2 MP, 5 arrows / 10s, with an 8s cooldown', () => {
    const player = createPlayer('archer');
    const quiver = clone('grey_stalker_quiver');

    const res = CombatSystem.executePoisonTip(player, quiver);
    assert.equal(res.success, true);
    assert.equal(player.mana, player.max_mana - 2);
    assert.equal(player.cooldowns.poison_tip, 8);
    assert.equal(player.poisonTipArrows, 5);
    assert.equal(player.poisonTipTimer, 10);

    const again = CombatSystem.executePoisonTip(player, quiver);
    assert.equal(again.success, false);
    assert.match(again.message, /cooldown/i);
  });

  await t.test('arrows apply a 3s / 2 dmg-per-sec poison to a living enemy', () => {
    const player = createPlayer('archer');
    player.paperdoll.off_hand = { ...clone('grey_stalker_quiver'), itemLevel: 1 };
    player.paperdoll.main_hand = { ...clone('composite_bow'), itemLevel: 1, damage: 16 };
    giveArrows(player);

    assert.equal(CombatSystem.executePoisonTip(player, player.paperdoll.off_hand).success, true);

    const target = { id: 'm1', name: 'Rat', type: 'giant_rat', x: 5, y: 2, hp: 100, max_hp: 100 };
    const shot = CombatSystem.executeBowShot(player, target, makeFloorGrid(), player.paperdoll.main_hand);
    assert.equal(shot.success, true);
    assert.equal(shot.poisoned, true);
    assert.equal(target.poisonTimer, 3);
    assert.equal(target.poisonDps, 2);
    assert.equal(player.poisonTipArrows, 4, 'one charged arrow spent');

    // The arrow itself dealt 16; then a 1s tick adds 2 poison damage.
    assert.equal(CombatSystem.tickStatusEffects([target], 1).length, 0);
    assert.equal(target.hp, 82, 'arrow damage then 1s of poison');
    assert.equal(target.poisonTimer, 2);

    // The remaining 2s ticks out and clears the DoT.
    CombatSystem.tickStatusEffects([target], 2);
    assert.equal(target.poisonTimer, 0);
    assert.equal(target.poisonDps, 0);
    assert.equal(target.hp, 78, '3s of 2 dps = 6 poison damage after the 16 arrow hit');
  });

  await t.test('poison can slay a low-HP enemy and reports it as defeated', () => {
    const player = createPlayer('archer');
    const quiver = { ...clone('grey_stalker_quiver'), itemLevel: 1 };
    player.paperdoll.off_hand = quiver;
    CombatSystem.executePoisonTip(player, quiver);

    const target = { id: 'm2', name: 'Rat', type: 'giant_rat', x: 5, y: 2, hp: 1, max_hp: 10 };
    CombatSystem.applyArrowPoison(player, target);
    const defeated = CombatSystem.tickStatusEffects([target], 1);
    assert.equal(defeated.length, 1);
    assert.equal(defeated[0], target);
    assert.equal(target.hp, 0);
  });

  await t.test('poison dps scales with rank', () => {
    const player = createPlayer('archer');
    const quiver = clone('grey_stalker_quiver');
    applyItemRankUp(player, quiver);
    applyItemRankUp(player, quiver);
    assert.equal(quiver.itemLevel, 3);
    assert.equal(quiver.poisonDps, 4, '2 base + 2 ranks');

    const res = CombatSystem.executePoisonTip(player, quiver);
    assert.equal(res.success, true);
    assert.equal(res.poisonDps, 4);
  });
});

// ---------------------------------------------------------------------------
// 4. Vampiric Cloak — Life Siphon
// ---------------------------------------------------------------------------

test('Life Siphon (Vampiric Cloak, E key)', async t => {
  await t.test('drains 5 HP from each enemy within 2 tiles, heals, costs 1 MP', () => {
    const player = createPlayer('archer');
    player.hp = 50;
    player.x = 5;
    player.y = 5;
    player.paperdoll.armor = { ...clone('hunter_leathers'), itemLevel: 1 };

    const near1 = { id: 'm1', name: 'Rat', x: 6, y: 5, hp: 30, max_hp: 30 };
    const near2 = { id: 'm2', name: 'Rat', x: 5, y: 3, hp: 30, max_hp: 30 };
    const far = { id: 'm3', name: 'Rat', x: 9, y: 5, hp: 30, max_hp: 30 };

    const res = CombatSystem.executeLifeSiphon(player, makeFloorGrid(), [near1, near2, far], player.paperdoll.armor);
    assert.equal(res.success, true);
    assert.equal(near1.hp, 25);
    assert.equal(near2.hp, 25);
    assert.equal(far.hp, 30, 'a foe 4 tiles away is untouched');
    assert.equal(res.drained, 10);
    assert.equal(player.hp, 60, 'keeps the drained health');
    assert.equal(player.mana, player.max_mana - 1, 'costs 1 MP');
    assert.equal(player.cooldowns.life_siphon, 8);

    const again = CombatSystem.executeLifeSiphon(player, makeFloorGrid(), [near1], player.paperdoll.armor);
    assert.equal(again.success, false);
    assert.match(again.message, /cooldown/i);
  });

  await t.test('refuses to cast with no enemy in range (no MP spent, no cooldown)', () => {
    const player = createPlayer('archer');
    const manaBefore = player.mana;
    const res = CombatSystem.executeLifeSiphon(player, makeFloorGrid(), [], clone('hunter_leathers'));
    assert.equal(res.success, false);
    assert.equal(player.mana, manaBefore);
    assert.equal(player.cooldowns.life_siphon, undefined);
  });

  await t.test('siphon amount scales with rank', () => {
    const player = createPlayer('archer');
    const cloak = clone('hunter_leathers');
    applyItemRankUp(player, cloak);
    applyItemRankUp(player, cloak);
    assert.equal(cloak.itemLevel, 3);
    assert.equal(cloak.siphonHp, 7, '5 base + 1 per rank');
  });
});

// ---------------------------------------------------------------------------
// 5. Ranger's Talisman — Hunter's Mark
// ---------------------------------------------------------------------------

test("Hunter's Mark (Ranger's Talisman, R key)", async t => {
  await t.test('marks in-LOS enemies for 6s and grants arrows bonus damage', () => {
    const player = createPlayer('archer');
    player.x = 5;
    player.y = 5;
    player.paperdoll.relic = { ...clone('ranger_talisman'), itemLevel: 1, critChance: 0, critMult: 1, rangedDamageBonus: 0 };
    player.paperdoll.main_hand = { ...clone('composite_bow'), itemLevel: 1, damage: 20 };
    giveArrows(player);
    const grid = makeFloorGrid();

    const marked = { id: 'm1', name: 'Rat', x: 7, y: 5, hp: 500, max_hp: 500, visible: true };
    const outOfRange = { id: 'm2', name: 'Rat', x: 25, y: 25, hp: 500, max_hp: 500, visible: true };

    const res = CombatSystem.executeHuntersMark(player, grid, [marked, outOfRange], player.paperdoll.relic);
    assert.equal(res.success, true);
    assert.equal(marked.hunterMarkTimer, 6);
    assert.equal(outOfRange.hunterMarkTimer, undefined);
    assert.equal(player.mana, player.max_mana - 3, 'costs 3 MP');
    assert.equal(player.cooldowns.hunters_mark, 15);

    const shot = CombatSystem.executeBowShot(player, marked, grid, player.paperdoll.main_hand);
    assert.equal(shot.success, true);
    assert.equal(shot.marked, true);
    assert.equal(shot.damageDealt, Math.round(20 * 1.5), 'arrows deal 1.5x to marked targets');

    const again = CombatSystem.executeHuntersMark(player, grid, [marked], player.paperdoll.relic);
    assert.equal(again.success, false);
    assert.match(again.message, /cooldown/i);
  });

  await t.test('refuses when no enemy is in line of sight', () => {
    const player = createPlayer('archer');
    const manaBefore = player.mana;
    const res = CombatSystem.executeHuntersMark(player, makeFloorGrid(), [], clone('ranger_talisman'));
    assert.equal(res.success, false);
    assert.equal(player.mana, manaBefore);
    assert.equal(player.cooldowns.hunters_mark, undefined);
  });

  await t.test('mark duration scales with rank', () => {
    const player = createPlayer('archer');
    const talisman = clone('ranger_talisman');
    applyItemRankUp(player, talisman);
    applyItemRankUp(player, talisman);
    assert.equal(talisman.itemLevel, 3);
    assert.equal(talisman.markDurationSec, 8, '6 base + 1s per rank');
    assert.equal(talisman.rangedDamageBonus, 8, '4 base + 2 per rank');
  });
});

// ---------------------------------------------------------------------------
// 6. Loadout recharge overlay + app wiring
// ---------------------------------------------------------------------------

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

test('All four archer primaries paint the recharge overlay', async t => {
  const cases = [
    ['main_hand', 'composite_bow', 'bow_shot', 'Main hand, key Q'],
    ['off_hand', 'grey_stalker_quiver', 'poison_tip', 'Off hand, key W'],
    ['armor', 'hunter_leathers', 'life_siphon', 'Armor, key E'],
    ['relic', 'ranger_talisman', 'hunters_mark', 'Relic, key R'],
  ];

  for (const [, itemId, actionKey, label] of cases) {
    await t.test(`${itemId} (${actionKey}) shows the wipe`, () => {
      const slot = makeFakeSlot(label);
      const item = { ...clone(itemId), itemLevel: 1 };
      const app = { player: { cooldowns: { [actionKey]: 1 } } };
      HUDManager._paintCooldown(slot, item, app);
      assert.ok(slot._state.classes.has('on-cooldown'), `${itemId} is flagged on cooldown`);
      assert.equal(slot._state.overlay.style.display, 'block');
      assert.match(slot._state.attrs['aria-label'], /recharging$/);
    });
  }

  await t.test('controller dispatches every new archer action key', () => {
    const controller = readControllerSources();
    for (const key of ['poison_tip', 'life_siphon', 'hunters_mark']) {
      assert.match(controller, new RegExp(`${key}:`), `${key} handler must be wired`);
    }
    assert.match(controller, /tickStatusEffects/, 'poison/mark timers must tick in the game loop');
  });
});
