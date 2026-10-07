/**
 * LIV-40 — Fate Grants must show equipment upgrades whenever the item can still
 * advance to its party-scaled cap (5/10/15/20), matching the Merchant's Stall.
 *
 * Regression (reopen of LIV-37): LIV-38 fixed the hardcoded `>= 5` rank gate in
 * `generateDraftOffer`, but the offer is a 5-card sample of the shuffled pool.
 * A card whose owned item is still below the cap (e.g. Rank 5 with a 4-member
 * cap of 20) is only offered when its card happens to land in the first 5 of the
 * shuffle, so "LEVEL UP" cards are silently crowded out by new-item filler.
 *
 * The interactive modal (`modal-manager.js`) calls
 * `FateGrantSystem.generateDraftOffer(app.player, level)` with no `rankCapOwner`,
 * exactly like the auto path except it relies on the party-bearing top-level
 * player. These tests drive that call shape: a party whose cap is > 5 must always
 * include an upgrade card for an equipped item at Rank 5, and the drafted card
 * must advance the owned instance past Rank 5.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPlayer, createPartyMember } from '../engine/index.js';
import { FateGrantSystem } from '../engine/fate-grant-system.js';
import { ITEMS_CATALOG, CARDS_CATALOG } from '../data/index.js';

const WAND = 'apprentice_wand';

/** A party of `size` members, which resolves to the authored cap for that size. */
function partyPlayer(size) {
  const vocations = ['magician', 'archer', 'fighter', 'paladin'].slice(0, size);
  const player = createPlayer('magician');
  const party = vocations.map(v => createPartyMember(v));
  player.party = party;
  player.activeMemberId = party[0].memberId;
  return player;
}

function wandInstance(itemLevel) {
  return { ...ITEMS_CATALOG[WAND], item_id: WAND, name: 'Spark Wand', itemLevel };
}

function cardFor(itemId) {
  const card = CARDS_CATALOG.find(c => c.item?.item_id === itemId);
  assert.ok(card, `expected a draft card for ${itemId}`);
  return card;
}

/**
 * A realistic magician-eligible pool with the upgradable wand card deliberately
 * placed last, and the shuffle disabled. The first five cards are all new-item
 * filler for gear the player does not own; only the sixth is an upgrade. This is
 * the exact crowding condition the 5-card offer cap creates under real play.
 */
function lastPlaceUpgradePool() {
  return [
    cardFor('astral_scepter'),
    cardFor('apprentice_cape'),
    cardFor('health_potion'),
    cardFor('mana_potion'),
    cardFor('relic_luminous_amulet'),
    cardFor(WAND),
  ];
}

/** Runs `fn` with the draft pool + shuffle pinned to the crowding condition. */
function withCrowdingPool(fn) {
  const originalDb = FateGrantSystem.CARD_DATABASE;
  const originalShuffle = FateGrantSystem.shuffle;
  FateGrantSystem.CARD_DATABASE = lastPlaceUpgradePool();
  FateGrantSystem.shuffle = () => {};
  try {
    return fn();
  } finally {
    FateGrantSystem.CARD_DATABASE = originalDb;
    FateGrantSystem.shuffle = originalShuffle;
  }
}

describe('LIV-40 — Fate Grant offers equipment upgrades when available', () => {
  it('always offers the Rank 6 upgrade card for a Rank 5 equipped item (party cap 10)', () => {
    const player = partyPlayer(2); // duo party -> cap 10
    player.paperdoll.off_hand = wandInstance(5);

    const offer = withCrowdingPool(() => FateGrantSystem.generateDraftOffer(player, 10));

    const upgrade = offer.cards.find(c => c.isUpgrade && c.targetItemId === WAND);
    assert.ok(upgrade, 'a below-cap equipped upgrade must never be crowded out of the offer');
    assert.equal(upgrade.targetItemLevel, 5);
    assert.match(upgrade.name, /Rank 6/);
  });

  it('applies the offered Rank 5 -> 6 upgrade past the solo cap', () => {
    const player = partyPlayer(2);
    const wand = wandInstance(5);
    player.paperdoll.off_hand = wand;

    const offer = withCrowdingPool(() => FateGrantSystem.generateDraftOffer(player, 10));
    const upgrade = offer.cards.find(c => c.isUpgrade && c.targetItemId === WAND);
    assert.ok(upgrade, 'the upgrade card must be present to apply');

    FateGrantSystem.applyDraftedCards(player, [upgrade], null);
    assert.equal(wand.itemLevel, 6, 'the drafted upgrade advances the owned instance past Rank 5');
  });

  it('still withholds an upgrade once the item reaches the solo cap (no party)', () => {
    const solo = createPlayer('magician');
    solo.paperdoll.off_hand = wandInstance(5);

    const offer = withCrowdingPool(() => FateGrantSystem.generateDraftOffer(solo, 10));
    assert.equal(
      offer.cards.some(c => c.isUpgrade && c.targetItemId === WAND),
      false,
      'the legacy solo Rank 5 cap is preserved',
    );
  });
});
