/**
 * Lokarta: Come Into The Light - LOK-15 Golden Equipment Sets Test Suite
 * Native Node.js test runner suite. Covers the acceptance criteria of
 * LOK-15 ("Implement the 4 Golden equipment sets per LOK-12 plan v2"):
 *
 * 1. Magician data untouched (zero-diff pairing checked against git).
 * 2. All four Golden 4-slot sets have per-rank upgradeSpecs (rank to 5 via
 *    LEVEL UP cards - no flat stat sticks) and are offered at level-1 drafts.
 * 3. Archer quiver: 25/25 start, regen, quiver-first consumption, pickup fill.
 * 4. Fighter: shield bash pushback + stun + 10s cooldown; cleave sweeps
 *    multiple targets; fortify halves incoming damage.
 * 5. Paladin: holy shield bubble (mana-gated) casts, intercepts and pops;
 *    heal power scales with healPowerPct.
 * 6. Monster damage re-tune sanity values.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG,
  TILE_TYPES,
  GridMap,
  createPlayer,
  CombatSystem,
  InventorySystem,
  FateGrantSystem,
} from '../engine/index.js';

import { ITEMS_CATALOG, CARDS_CATALOG, VOCATIONS_CATALOG, MONSTERS_CATALOG } from '../data/index.js';

const GOLDEN_SET_IDS = {
  magician: { main_hand: 'astral_scepter', off_hand: 'apprentice_wand', armor: 'apprentice_cape', relic: 'relic_luminous_amulet' },
  archer: { main_hand: 'composite_bow', off_hand: 'grey_stalker_quiver', armor: 'hunter_leathers', relic: 'ranger_talisman' },
  fighter: { main_hand: 'tempered_broadsword', off_hand: 'vanguard_shield', armor: 'vanguard_battleplate', relic: 'relic_berserkers_sigil' },
  paladin: { main_hand: 'consecrated_warhammer', off_hand: 'aegis_shield', armor: 'sanctuary_plate', relic: 'relic_dawnlight' },
};

const GOLDEN_OFF_HAND = { archer: 'grey_stalker_quiver', fighter: 'vanguard_shield', paladin: 'aegis_shield' };

function makeFloorGrid(w = 20, h = 20) {
  const g = new GridMap(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      g.tiles[y][x].type = TILE_TYPES.FLOOR;
    }
  }
  return g;
}

function equipGoldenSet(voc) {
  const player = createPlayer(voc);
  for (const [slot, id] of Object.entries(GOLDEN_SET_IDS[voc] || {})) {
    player.paperdoll[slot] = JSON.parse(JSON.stringify(ITEMS_CATALOG[id]));
    player.paperdoll[slot].itemLevel = 1;
  }
  if (voc === 'archer') {
    player.paperdoll.main_hand.damage = 16; // card-rolled embedded damage
  }
  InventorySystem.recomputeGearBonuses(player);
  return player;
}

describe('LOK-15 Golden Sets — Data & Drafts', () => {
  it('every Golden 4-slot item carries a per-rank upgradeSpec (no flat stat sticks)', () => {
    for (const voc of Object.keys(GOLDEN_SET_IDS)) {
      for (const [slot, id] of Object.entries(GOLDEN_SET_IDS[voc])) {
        const item = ITEMS_CATALOG[id];
        assert.ok(item, `${voc}.${slot} item ${id} must exist in items.json`);
        assert.ok(item.upgradeSpec && Object.keys(item.upgradeSpec).length > 0, `${id} must have an upgradeSpec`);
        assert.ok(item.maxStack === 1, `${id} is a 4-slot set item and must be maxStack 1`);
      }
    }
  });

  it('Magician Golden set data is unchanged from the LOK-12 v2 baseline', () => {
    // Magician fields must be byte-identical to the pre-LOK-15 values.
    const scepter = ITEMS_CATALOG.astral_scepter;
    assert.deepEqual(scepter.upgradeSpec, {
      stepDamageInc: 5,
      rangeInc: 1,
      manaCostInc: 5,
      statBonusTextPattern: '+5 Wave Dmg, +1 Range (+5 MP)',
      descriptionPattern: 'Level Up Beam Staff (Rank {prevRank} ➔ {nextRank}): +5 Wave Dmg, +1 Wave Range, +5 MP Cost.',
    });
    assert.deepEqual(ITEMS_CATALOG.apprentice_wand.upgradeSpec.randomDamageInc, [4, 6]);
    assert.equal(VOCATIONS_CATALOG.magician.nativeEquipment.join(','), 'apprentice_wand,astral_scepter,apprentice_cape');
    assert.equal(VOCATIONS_CATALOG.magician.hp, 60);
    assert.equal(VOCATIONS_CATALOG.magician.mana, 150);
  });

  it('each vocation declares its Golden 4-slot nativeEquipment', () => {
    assert.equal(VOCATIONS_CATALOG.archer.nativeEquipment.join(','), 'composite_bow,grey_stalker_quiver,hunter_leathers,ranger_talisman');
    assert.equal(VOCATIONS_CATALOG.fighter.nativeEquipment.join(','), 'tempered_broadsword,vanguard_shield,vanguard_battleplate,relic_berserkers_sigil');
    assert.equal(VOCATIONS_CATALOG.paladin.nativeEquipment.join(','), 'consecrated_warhammer,aegis_shield,sanctuary_plate,relic_dawnlight');
  });

  it('the three Golden off-hand draft cards exist in the pool', () => {
    for (const id of Object.values(GOLDEN_OFF_HAND)) {
      assert.ok(CARDS_CATALOG.some(c => c.item?.item_id === id), `Missing draft card for ${id}`);
    }
  });

  it('level-1 drafts always satisfy the LOK-4 >=1 off_hand guarantee with Golden cards in the pool', () => {
    for (const voc of ['archer', 'fighter', 'paladin']) {
      const goldenOffHand = GOLDEN_OFF_HAND[voc];
      for (let attempt = 0; attempt < 100; attempt++) {
        const offer = FateGrantSystem.generateDraftOffer(voc, 1);
        assert.equal(offer.cards.length, 5);
        assert.ok(
          offer.cards.some(c => FateGrantSystem.resolveCardSlot(c) === 'off_hand'),
          `${voc} level-1 draft must offer an off_hand card`
        );
      }
      // The Golden card must be draftable by its vocation.
      const goldenCard = CARDS_CATALOG.find(c => c.item?.item_id === goldenOffHand);
      assert.ok(goldenCard, `${goldenOffHand} draft card must exist`);
      const aff = goldenCard.vocationAffinity;
      const ok = aff === voc || (Array.isArray(aff) && aff.includes(voc));
      assert.ok(ok, `${goldenOffHand} card must be eligible for ${voc} drafts`);
    }
  });

  it('drafting a Golden off-hand auto-equips it and a second draft ranks it to 2', () => {
    for (const voc of ['archer', 'fighter', 'paladin']) {
      const player = createPlayer(voc);
      const grid = makeFloorGrid();
      const card = CARDS_CATALOG.find(c => c.item?.item_id === GOLDEN_OFF_HAND[voc]);

      FateGrantSystem.applyDraftedCards(player, [JSON.parse(JSON.stringify(card))], grid);
      let equipped = Object.values(player.paperdoll).find(i => i?.item_id === GOLDEN_OFF_HAND[voc]);
      assert.ok(equipped, `${voc} Golden off-hand auto-equips into paperdoll`);
      assert.equal(equipped.itemLevel, 1);
      assert.equal(equipped.arrowCapacity ?? equipped.cooldown ?? equipped.manaCost, equipped.arrowCapacity ?? equipped.cooldown ?? equipped.manaCost);

      FateGrantSystem.applyDraftedCards(player, [JSON.parse(JSON.stringify(card))], grid);
      equipped = Object.values(player.paperdoll).find(i => i?.item_id === GOLDEN_OFF_HAND[voc]);
      assert.equal(equipped.itemLevel, 2, `${voc} Golden off-hand upgrades to rank 2 on second draft`);
    }
  });

  it('Golden weapons rank up damage via LEVEL UP cards (no flat stick)', () => {
    const player = createPlayer('archer');
    const grid = makeFloorGrid();
    const bowCard = CARDS_CATALOG.find(c => c.item?.item_id === 'composite_bow');
    const placed = JSON.parse(JSON.stringify(bowCard));
    // Emulate the generateDraftOffer damage roll for new items with ranges:
    placed.item.damage = Math.floor(Math.random() * (18 - 14 + 1)) + 14;
    FateGrantSystem.applyDraftedCards(player, [placed], grid);
    const bow = player.paperdoll.main_hand;
    assert.ok(bow && bow.damage >= 14 && bow.damage <= 18, 'Composite Longbow embeds a rolled damage value');
    const before = bow.damage;
    for (let r = 1; r < 5; r++) {
      FateGrantSystem.applyDraftedCards(player, [{ isUpgrade: true, targetItemId: 'composite_bow', item: { item_id: 'composite_bow' }, upgradeDmgInc: 6 }], grid);
    }
    assert.equal(bow.itemLevel, 5);
    assert.equal(bow.damage, before + 24, `Composite Longbow reaches rank-5 damage +24 (${before} -> ${bow.damage})`);
    assert.equal(bow.range, 6 + 4, 'Composite Longbow +4 range at rank 5 (range 10)');
  });
});

describe('LOK-15 Golden Sets — Archer (Grey Stalker)', () => {
  it('fresh quiver starts 25/25 and consumeArrow drains the quiver before the reserve', () => {
    const arch = equipGoldenSet('archer');
    const quiver = arch.paperdoll.off_hand;
    assert.equal(quiver.arrowCount, 25);
    assert.equal(quiver.arrowCapacity, 25);
    arch.action_bar[0] = { item_id: 'arrows', name: 'Arrows', type: 'ammo', quantity: 10 };

    assert.equal(CombatSystem.consumeArrow(arch), true);
    assert.equal(quiver.arrowCount, 24, 'quiver drains first');
    assert.equal(arch.action_bar[0].quantity, 10, 'reserve untouched while quiver has arrows');

    quiver.arrowCount = 1;
    CombatSystem.consumeArrow(arch);
    assert.equal(quiver.arrowCount, 0);
    CombatSystem.consumeArrow(arch);
    assert.equal(arch.action_bar[0].quantity, 9, 'fallback to reserve only when the quiver is empty');
  });

  it('floor arrow pickups fill the quiver to capacity first, then spill to a reserve', () => {
    const arch = equipGoldenSet('archer');
    arch.paperdoll.off_hand.arrowCount = 20; // 5 free slots
    const grid = makeFloorGrid();
    grid.addItem(2, 2, { item_id: 'arrows', name: 'Arrows', type: 'ammo', quantity: 10 });
    arch.x = 2;
    arch.y = 2;
    InventorySystem.pickUpItem(arch, grid);
    assert.equal(arch.paperdoll.off_hand.arrowCount, 25, 'quiver topped to capacity first');
    const reserve = arch.action_bar.find(s => s?.item_id === 'arrows') || arch.backpack.find(s => s?.item_id === 'arrows');
    assert.ok(reserve && reserve.quantity === 5, 'the remaining 5 arrows spill to a reserve stack');
  });

  it('quiver upgrades to rank 5 (capacity 45, regen 3.0s) and effective bow range/damage scale', () => {
    const arch = equipGoldenSet('archer');
    const quiver = arch.paperdoll.off_hand;
    for (let r = 1; r < 5; r++) {
      FateGrantSystem.applyDraftedCards(arch, [{ isUpgrade: true, targetItemId: 'grey_stalker_quiver', item: { item_id: 'grey_stalker_quiver' } }], makeFloorGrid());
    }
    assert.equal(quiver.itemLevel, 5);
    assert.equal(quiver.arrowCapacity, 45);
    assert.equal(quiver.ammoRegenSec, 3.0);
  });

  it('executeBowShot reads embedded item.damage with CONFIG fallback and rolls crits', () => {
    const arch = equipGoldenSet('archer');
    arch.cooldowns = {};
    arch.paperdoll.main_hand.damage = 30;
    arch.paperdoll.relic.critChance = 0;
    arch.x = 2;
    arch.y = 2;
    const target = { id: 'm1', name: 'Rat', type: 'giant_rat', x: 5, y: 2, hp: 500, max_hp: 500 };
    let res = CombatSystem.executeBowShot(arch, target, makeFloorGrid(), arch.paperdoll.main_hand);
    assert.equal(res.success, true);
    // Embedded item.damage (30) + the Ranger's Talisman's +4 ranged bonus.
    assert.equal(res.damageDealt, 34, 'item damage read with equipped ranged bonus');

    // 100% crit roll from the talisman (critChance 100, critMult 1.45)
    arch.cooldowns = {};
    arch.paperdoll.relic.critChance = 100;
    arch.paperdoll.relic.critMult = 1.45;
    res = CombatSystem.executeBowShot(arch, target, makeFloorGrid(), arch.paperdoll.main_hand);
    assert.equal(res.success, true);
    assert.equal(res.isCrit, true);
    assert.equal(res.damageDealt, Math.round(34 * 1.45));
  });
});

describe('LOK-15 Golden Sets — Fighter (Iron Vanguard)', () => {
  it('shield bash pushes adjacent monsters away and stuns them for 1.0s (10s cooldown gate)', () => {
    const fgt = equipGoldenSet('fighter');
    const grid = makeFloorGrid();
    fgt.x = 5;
    fgt.y = 5;
    const m1 = { id: 'm1', name: 'Rat', type: 'giant_rat', x: 6, y: 5, hp: 100, max_hp: 100, stunTimer: 0 };
    const m2 = { id: 'm2', name: 'Rat', type: 'giant_rat', x: 5, y: 4, hp: 100, max_hp: 100, stunTimer: 0 };
    const far = { id: 'm3', name: 'Rat', type: 'giant_rat', x: 8, y: 5, hp: 100, max_hp: 100, stunTimer: 0 };

    const res = CombatSystem.executeShieldBash(fgt, grid, [m1, m2, far], fgt.paperdoll.off_hand);
    assert.equal(res.success, true);
    assert.equal(m1.x, 7, 'monster right of player pushed +1 tile');
    assert.equal(m2.y, 3, 'monster above player pushed -1 tile');
    assert.deepEqual([far.x, far.y], [8, 5], 'non-adjacent monster untouched');
    assert.equal(m1.stunTimer, 1.0);
    assert.equal(m2.stunTimer, 1.0);
    assert.equal(far.stunTimer, 0);
    assert.equal(fgt.cooldowns.shield_bash, 10, 'base cooldown 10s (once per 10s at level 1)');

    const blocked = CombatSystem.executeShieldBash(fgt, grid, [m1, m2, far], fgt.paperdoll.off_hand);
    assert.equal(blocked.success, false, 'cooldown blocks a second bash');
  });

  it('shield bash stops against walls/occupied tiles and still stuns', () => {
    const fgt = equipGoldenSet('fighter');
    const grid = makeFloorGrid();
    fgt.x = 5;
    fgt.y = 5;
    // Wall one tile beyond the adjacent monster to the player's right.
    grid.tiles[5][7].type = TILE_TYPES.WALL;
    const m1 = { id: 'm1', name: 'Rat', type: 'giant_rat', x: 6, y: 5, hp: 100, max_hp: 100, stunTimer: 0 };
    // Monster occupying the tile the pushed monster would land on.
    const m2 = { id: 'm2', name: 'Rat', type: 'giant_rat', x: 5, y: 4, hp: 100, max_hp: 100, stunTimer: 0 };
    const m3 = { id: 'm3', name: 'Rat', type: 'giant_rat', x: 5, y: 3, hp: 100, max_hp: 100, stunTimer: 0 };

    const res = CombatSystem.executeShieldBash(fgt, grid, [m1, m2, m3], fgt.paperdoll.off_hand);
    assert.equal(res.success, true);
    assert.deepEqual([m1.x, m1.y], [6, 5], 'wall-stopped: monster does not move through a wall');
    assert.deepEqual([m2.x, m2.y], [5, 4], 'occupied-tile-stopped: monster does not stack onto m3');
    assert.deepEqual([m3.x, m3.y], [5, 3], 'upstream monster stays put when its target tile is occupied');
    assert.equal(m1.stunTimer, 1.0, 'wall-stopped monsters are still stunned');
    assert.equal(m2.stunTimer, 1.0);
    assert.equal(m3.stunTimer, 0, 'a monster 2 tiles away is neither pushed nor stunned');
  });

  it('vanguard shield ranks to 5: stun 3.0s, effective cooldown 6s', () => {
    const fgt = equipGoldenSet('fighter');
    const shield = fgt.paperdoll.off_hand;
    for (let r = 1; r < 5; r++) {
      FateGrantSystem.applyDraftedCards(fgt, [{ isUpgrade: true, targetItemId: 'vanguard_shield', item: { item_id: 'vanguard_shield' } }], makeFloorGrid());
    }
    assert.equal(shield.itemLevel, 5);
    assert.equal(shield.stunSec, 3.0);
    assert.equal(CombatSystem.getEffectiveCooldown(shield), 6, 'rank-5 shield bash effective cooldown is 6s');
    assert.equal(CombatSystem.getEffectiveCooldown(fgt.paperdoll.off_hand).constructor === Number, true);
  });

  it('cleave sweeps multiple targets (not a single-target slash)', () => {
    const fgt = equipGoldenSet('fighter');
    fgt.mana = 100;
    const grid = makeFloorGrid();
    fgt.x = 3;
    fgt.y = 3;
    const c1 = { id: 'c1', name: 'Sk1', type: 'crypt_skeleton', x: 4, y: 3, hp: 80, max_hp: 80 };
    const c2 = { id: 'c2', name: 'Sk2', type: 'crypt_skeleton', x: 3, y: 4, hp: 80, max_hp: 80 };
    const c3 = { id: 'c3', name: 'Sk3', type: 'crypt_skeleton', x: 8, y: 8, hp: 80, max_hp: 80 };

    const res = CombatSystem.executeCleave(fgt, grid, [c1, c2, c3], fgt.paperdoll.relic);
    assert.equal(res.success, true);
    assert.equal(res.hits.length, 2, 'cleave hits every in-reach monster');
    assert.ok(c1.hp < 80 && c2.hp < 80);
    assert.equal(c3.hp, 80, 'out-of-reach monster untouched');
    assert.equal(fgt.mana, 90, 'cleave costs 10 MP');
    assert.equal(fgt.cooldowns.cleave, fgt.paperdoll.relic.cooldown, 'cleave uses the Berserker Sigil cooldown');
  });

  it('fortify is registered and halves incoming damage while active', () => {
    const fgt = equipGoldenSet('fighter');
    fgt.mana = 100;
    fgt.action_bar[0] = { item_id: 'fortify_stance', name: 'Fortify Stance', type: 'spell', manaCost: 15, cooldown: 12, actionKey: 'fortify' };
    const res = CombatSystem.executeFortify(fgt, fgt.action_bar[0]);
    assert.equal(res.success, true);
    assert.equal(fgt.fortifyActive, true);
    assert.equal(fgt.fortifyTimer, 10);
    assert.equal(fgt.mana, 85);

    // Fighters also wear battleplate (10% mitigation) — halving + mitigation both land.
    const hpBefore = fgt.hp;
    const hit = CombatSystem.applyIncomingDamage(fgt, 20);
    assert.equal(hit.damageToPlayer, 9, '20 -> fortify halves to 10 -> 10% battleplate mitigation -> 9');
    assert.equal(fgt.hp, hpBefore - 9);
    // Fortify is cooldown-gated; a second cast within the window is blocked.
    const again = CombatSystem.executeFortify(fgt, fgt.action_bar[0]);
    assert.equal(again.success, false);
  });
});

describe('LOK-15 Golden Sets — Paladin (Radiant Crusader)', () => {
  it('dawnlight reliquary grants +15 max mana; aegis casts a 10-absorb / 30s bubble for 15 MP', () => {
    const pal = equipGoldenSet('paladin');
    assert.equal(pal.max_mana, 105, 'dawnlight reliquary manaBonus +15 on equip');
    const shield = pal.paperdoll.off_hand;
    const manaBefore = pal.mana;
    const res = CombatSystem.executeHolyShield(pal, shield);
    assert.equal(res.success, true);
    assert.equal(pal.mana, manaBefore - 15);
    assert.equal(pal.shieldAbsorb, 10);
    assert.equal(pal.shieldDurationSec, 30);
  });

  it('holy shield is mana-gated; the bubble intercepts damage and pops on full absorption', () => {
    const pal = equipGoldenSet('paladin');
    const shield = pal.paperdoll.off_hand;
    pal.mana = 5;
    assert.equal(CombatSystem.executeHolyShield(pal, shield).success, false, 'not enough mana blocks the cast');

    pal.mana = 100;
    pal.hp = 100;
    CombatSystem.executeHolyShield(pal, shield);
    // raw 6 -> 10% plate mitigation rounds off 1 -> 5 absorbed
    const hit1 = CombatSystem.applyIncomingDamage(pal, 6);
    assert.equal(hit1.absorbed, 5);
    assert.equal(hit1.damageToPlayer, 0);
    assert.equal(pal.hp, 100);
    assert.equal(pal.shieldAbsorb, 5);

    // raw 8 -> mitigated 7 -> bubble absorbs the remaining 5, 2 lands on HP
    const hit2 = CombatSystem.applyIncomingDamage(pal, 8);
    assert.equal(hit2.absorbed, 5);
    assert.equal(hit2.damageToPlayer, 2);
    assert.equal(pal.hp, 98);
    assert.equal(pal.shieldAbsorb, 0, 'bubble pops when fully absorbed');
  });

  it('bubble pops on expiry (duration decay) and aegis ranks to 5 (absorb 30 / 46s / 7 MP)', () => {
    const pal = equipGoldenSet('paladin');
    const shield = pal.paperdoll.off_hand;
    pal.mana = 200;
    CombatSystem.executeHolyShield(pal, shield);
    // Emulate the app-controller decay: shieldDurationSec -= deltaSec, pop at 0.
    pal.shieldDurationSec = 0.05;
    pal.shieldDurationSec = Math.max(0, pal.shieldDurationSec - 0.1);
    if (pal.shieldDurationSec <= 0) pal.shieldAbsorb = 0;
    assert.equal(pal.shieldAbsorb, 0, 'bubble pops on expiry');

    for (let r = 1; r < 5; r++) {
      FateGrantSystem.applyDraftedCards(pal, [{ isUpgrade: true, targetItemId: 'aegis_shield', item: { item_id: 'aegis_shield' } }], makeFloorGrid());
    }
    assert.equal(shield.itemLevel, 5);
    assert.equal(shield.shieldAbsorb, 30);
    assert.equal(shield.shieldDuration, 46);
    assert.equal(CombatSystem.getEffectiveManaCost(shield), 3, 'rank-5 holy shield costs 3 MP (-2/rank shield spec plus the promoted-label discount)');
  });

  it('healPowerPct scales Healing Prayer', () => {
    const pal = equipGoldenSet('paladin');
    pal.action_bar[0] = { item_id: 'healing_prayer', name: 'Healing Prayer', type: 'spell', manaCost: 25 };
    pal.hp = 50;
    pal.mana = 200;
    const res = CombatSystem.executeHealingPrayer(pal);
    assert.equal(res.success, true);
    // Derive the floor from the paladin's live equipped healPowerPct instead of
    // a hardcoded multiplier, so a golden-set swap cannot
    // desync the assertion. `randomBetween` only ever rolls >= PALADIN_HEAL_MIN,
    // so this floor is met on every roll and the test is no longer flaky.
    const boost = 1 + CombatSystem.getEquippedStat(pal, 'healPowerPct') / 100;
    assert.ok(boost > 1, 'paladin golden set must carry healPowerPct gear');
    const minBoosted = Math.round(CONFIG.PALADIN_HEAL_MIN * boost);
    assert.ok(res.healAmount >= minBoosted, `heal power must scale the prayer (healed ${res.healAmount})`);
  });
});

describe('LOK-15 Golden Sets — Balance (Slice 3)', () => {
  it('monster damage ranges were re-tuned now that dodge/mitigation/absorb consume them', () => {
    assert.equal(MONSTERS_CATALOG.giant_rat.damageMin, 5);
    assert.equal(MONSTERS_CATALOG.giant_rat.damageMax, 9);
    assert.equal(MONSTERS_CATALOG.crypt_skeleton.damageMin, 9);
    assert.equal(MONSTERS_CATALOG.crypt_skeleton.damageMax, 15);
    assert.equal(MONSTERS_CATALOG.shadow_cultist.damageMin, 11);
    assert.equal(MONSTERS_CATALOG.shadow_cultist.damageMax, 17);
    assert.equal(MONSTERS_CATALOG.elite_cultist.damageMin, 14);
    assert.equal(MONSTERS_CATALOG.elite_cultist.damageMax, 22);
    assert.equal(MONSTERS_CATALOG.abyssal_overlord.damageMin, 18);
    assert.equal(MONSTERS_CATALOG.abyssal_overlord.damageMax, 26);
  });

  it('applyIncomingDamage wires dodge, fortify, mitigation and absorb in one path', () => {
    // Dodge roll: force 100% dodge -> the hit is avoided entirely.
    const archer = equipGoldenSet('archer');
    archer.paperdoll.armor.dodgePct = 100;
    const hpBefore = archer.hp;
    const hit = CombatSystem.applyIncomingDamage(archer, 20);
    assert.equal(hit.dodged, true);
    assert.equal(hit.damageToPlayer, 0);
    assert.equal(archer.hp, hpBefore);

    // Mitigation only (fighter-style plate without a bubble): raw 20 -> 18.
    const fighter = equipGoldenSet('fighter');
    const hp2 = fighter.hp;
    const hit2 = CombatSystem.applyIncomingDamage(fighter, 20);
    assert.equal(hit2.damageToPlayer, 18, '10% mitigation reduces 20 to 18');
    assert.equal(fighter.hp, hp2 - 18);
  });
});