/**
 * LIV-28 / FIX-13: equipment max rank scales with party size (5/10/15/20).
 *
 * The Board's T2 round-3 feedback asks that a piece of equipment can be ranked
 * further once the party grows: one vocation caps at Rank 5, a full four-member
 * team at Rank 20. The authored source of truth is `economy.json`
 * `shop.maxRankByParty`, resolved by `EconomySystem.maxRankForParty` and applied
 * to both the town shop and every loot/duplicate rank-up path.
 *
 * These tests pin:
 *  - the catalog table (5/10/15/20 keyed by 1..4) is the only source,
 *  - party size 1 is a no-op vs the legacy Rank 5 cap,
 *  - `canUpgrade` / `upgradeCost` / `canUpgradeItem` / `applyItemRankUp` are
 *    all party-aware,
 *  - the shop controller offers a rank-10 item only to a 2+ member party,
 *  - the HUD tooltip prints the live cap.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EconomySystem,
  createPlayer,
  createPartyMember,
  canUpgradeItem,
  applyItemRankUp,
} from '../engine/index.js';
import { ITEMS_CATALOG, ECONOMY_CATALOG } from '../data/index.js';
import { LokartaApp } from '../app/app-controller.js';
import { HUDManager } from '../app/hud-manager.js';

const AMULET = () => ({
  ...ITEMS_CATALOG.relic_luminous_amulet,
  item_id: 'relic_luminous_amulet',
});

/** A player carrying exactly `vocations.length` party members. */
function playerWithParty(vocations) {
  const player = createPlayer(vocations[0]);
  const party = vocations.map(vocation => createPartyMember(vocation));
  player.party = party;
  player.activeMemberId = party[0].memberId;
  return player;
}

describe('LIV-28 authored party-scaled rank table', () => {
  it('resolves 5/10/15/20 for party sizes 1..4 straight from economy.json', () => {
    const table = ECONOMY_CATALOG.shop.maxRankByParty;
    assert.deepEqual(table, { '1': 5, '2': 10, '3': 15, '4': 20 });
    for (let size = 1; size <= 4; size++) {
      assert.equal(EconomySystem.maxRankForParty(size), table[String(size)], `party size ${size}`);
    }
  });

  it('clamps oversized parties to the largest authored cap and legacy saves to 5', () => {
    assert.equal(EconomySystem.maxRankForParty(99), 20, 'larger than authored clamps to the top entry');
    assert.equal(EconomySystem.maxRankForParty(0), 5, 'zero clamps up to solo');
    assert.equal(EconomySystem.maxRankForParty(NaN), 5, 'malformed size falls back to solo');
    assert.equal(EconomySystem.maxRankForParty({}), 5, 'party-less player is solo');
    assert.equal(EconomySystem.maxRankForParty({ party: [] }), 5, 'empty party is solo');
  });

  it('reads the live party length from a player object', () => {
    const solo = createPlayer('magician');
    const duo = playerWithParty(['magician', 'archer']);
    const full = playerWithParty(['magician', 'archer', 'fighter', 'paladin']);
    assert.equal(EconomySystem.maxRankForParty(solo), 5);
    assert.equal(EconomySystem.maxRankForParty(duo), 10);
    assert.equal(EconomySystem.maxRankForParty(full), 20);
  });
});

describe('LIV-28 shop upgrade gating and cost', () => {
  it('party size 1 keeps the legacy Rank 5 gate and 40-gold base cost', () => {
    const solo = createPlayer('magician');
    const at5 = { ...AMULET(), itemLevel: 5 };
    assert.equal(EconomySystem.canUpgrade(at5, solo), false, 'solo rank 5 is maxed');
    assert.equal(EconomySystem.canUpgrade({ ...AMULET(), itemLevel: 4 }, solo), true);
    assert.equal(EconomySystem.upgradeCost({ ...AMULET(), itemLevel: 1 }, solo), 40);
  });

  it('a 2-member party unlocks ranks 6..10', () => {
    const duo = playerWithParty(['magician', 'archer']);
    assert.equal(EconomySystem.canUpgrade({ ...AMULET(), itemLevel: 5 }, duo), true, 'rank 5 can rise');
    assert.equal(EconomySystem.canUpgrade({ ...AMULET(), itemLevel: 9 }, duo), true);
    assert.equal(EconomySystem.canUpgrade({ ...AMULET(), itemLevel: 10 }, duo), false, 'rank 10 is the duo cap');
  });

  it('a full party unlocks through rank 20', () => {
    const full = playerWithParty(['magician', 'archer', 'fighter', 'paladin']);
    assert.equal(EconomySystem.canUpgrade({ ...AMULET(), itemLevel: 10 }, full), true);
    assert.equal(EconomySystem.canUpgrade({ ...AMULET(), itemLevel: 19 }, full), true);
    assert.equal(EconomySystem.canUpgrade({ ...AMULET(), itemLevel: 20 }, full), false);
  });

  it('prices the next rank using the party-scaled cap', () => {
    const full = playerWithParty(['magician', 'archer', 'fighter', 'paladin']);
    // 40 + 35 * (rank - 1) at rank 20 -> 40 + 35 * 19 = 705.
    assert.equal(EconomySystem.upgradeCost({ ...AMULET(), itemLevel: 20 }, full), 705);
  });
});

describe('LIV-28 rank-up paths honor the party cap', () => {
  it('canUpgradeItem / applyItemRankUp allow rank 5 -> 6 with a 2-member party', () => {
    const duo = playerWithParty(['magician', 'archer']);
    const amulet = { ...AMULET(), itemLevel: 5 };
    assert.equal(canUpgradeItem(amulet, duo), true);
    const result = applyItemRankUp(duo, amulet, { rng: { randomInt: () => 5 } });
    assert.ok(result, 'the rank-up must apply');
    assert.equal(amulet.itemLevel, 6, 'party-scaled cap lets the item rise past the solo 5');
    assert.equal(result.rank, 6);
  });

  it('still caps a solo item at rank 5 through applyItemRankUp', () => {
    const solo = createPlayer('magician');
    const amulet = { ...AMULET(), itemLevel: 5 };
    assert.equal(canUpgradeItem(amulet, solo), false);
    assert.equal(applyItemRankUp(solo, amulet), null);
    assert.equal(amulet.itemLevel, 5);
  });

  it('a 4-member party can climb all the way to rank 20', () => {
    const full = playerWithParty(['magician', 'archer', 'fighter', 'paladin']);
    const amulet = { ...AMULET(), itemLevel: 1 };
    let guard = 0;
    while (canUpgradeItem(amulet, full) && guard++ < 100) {
      applyItemRankUp(full, amulet, { rng: { randomInt: () => 5 } });
    }
    assert.equal(amulet.itemLevel, 20, 'full party reaches exactly the authored cap');
    assert.equal(canUpgradeItem(amulet, full), false);
  });
});

describe('LIV-28 shop controller and HUD surface the live cap', () => {
  function makeApp(player) {
    const app = Object.create(LokartaApp.prototype);
    app.player = player;
    return app;
  }

  it('lists a rank-9 item for a 2-member party but not for a solo player', () => {
    const item = { ...AMULET(), itemLevel: 9 };
    const solo = createPlayer('magician');
    solo.paperdoll = { relic: { ...item } };
    const duo = playerWithParty(['magician', 'archer']);
    duo.paperdoll = { relic: { ...item } };

    assert.equal(makeApp(solo).collectUpgradableItems().length, 0, 'solo rank 9 is beyond the cap');
    const duoEntries = makeApp(duo).collectUpgradableItems();
    assert.equal(duoEntries.length, 1, 'duo rank 9 is offered');
    assert.equal(duoEntries[0].rank, 9);
  });

  it('prints Rank X/live-cap in the tooltip', () => {
    const solo = createPlayer('magician');
    const duo = playerWithParty(['magician', 'archer']);
    const item = { ...AMULET(), itemLevel: 6 };
    assert.match(HUDManager._tooltip(item, { player: solo }), /Rank 6\/5/);
    assert.match(HUDManager._tooltip(item, { player: duo }), /Rank 6\/10/);
  });
});
