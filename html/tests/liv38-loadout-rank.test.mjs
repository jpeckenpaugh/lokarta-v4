/**
 * LIV-38 — Loadout square sizing + item rank progression past Rank 5.
 *
 * Two player-reported bugs:
 *
 *  1. The 8 Loadout squares grew with their content: a long item name (e.g.
 *     "Consecrated Warhammer") stretched its grid column because `1fr` is
 *     `minmax(auto, 1fr)` and the auto floor is the item name's min-content
 *     width. The grid must stay a fixed 4×2 layout with every square equal and
 *     names truncated inside the square.
 *
 *  2. Fate Grants stopped offering an upgrade once an item hit Rank 5, because
 *     `generateDraftOffer` hardcoded `if (currentLevel >= 5) continue`. The
 *     live cap is catalog-driven (`economy.json` → `shop.maxRankByParty`,
 *     resolved by `EconomySystem.maxRankForParty`), so a full party must climb
 *     to Rank 20 while a solo save still caps at 5.
 *
 * The layout proof is the generated grid markup + the CSS shrink contract
 * (there is no layout engine in `node --test`); the rank proof drives the real
 * `FateGrantSystem` offer/apply path and the auto-ally path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createPlayer, createPartyMember } from '../engine/index.js';
import { FateGrantSystem } from '../engine/fate-grant-system.js';
import { applyAutoFateGrant } from '../engine/party-progression.js';
import { ITEMS_CATALOG } from '../data/index.js';
import { HUDManager } from '../app/hud-manager.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUD_CSS = readFileSync(resolve(HERE, '../styles/hud.css'), 'utf8');

const WAND = 'apprentice_wand';

/** A four-vocation party, which unlocks the authored Rank 20 cap. */
function fullParty() {
  const player = createPlayer('magician');
  const party = ['magician', 'archer', 'fighter', 'paladin'].map(vocation => createPartyMember(vocation));
  player.party = party;
  player.activeMemberId = party[0].memberId;
  return player;
}

/** An owned wand instance at the given rank (carries the catalog upgradeSpec). */
function wandInstance(itemLevel) {
  return { ...ITEMS_CATALOG[WAND], item_id: WAND, itemLevel };
}

/** The single neutral card the draft tests use, for a deterministic pool. */
const TEST_CARD = Object.freeze({
  id: 'liv38_test_card_apprentice_wand',
  name: 'Spark Wand',
  rarity: 'common',
  vocationAffinity: 'neutral',
  item: { item_id: WAND, name: 'Spark Wand', type: 'weapon', quantity: 1 },
});

/** Runs `fn` with the draft pool narrowed to one deterministic card. */
function withOnlyCard(fn) {
  const original = FateGrantSystem.CARD_DATABASE;
  FateGrantSystem.CARD_DATABASE = [TEST_CARD];
  try {
    return fn();
  } finally {
    FateGrantSystem.CARD_DATABASE = original;
  }
}

/** Minimal loadout element stub: captures the generated grid markup. */
function makeFakeLoadoutEl() {
  let html = '';
  let built = false;
  const grid = { querySelectorAll: () => [] };
  return {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; built = true; },
    querySelector: selector => (selector === '.loadout-grid' && built ? grid : null),
  };
}

describe('LIV-38 Bug 1 — fixed-width loadout squares', () => {
  it('renders 8 squares in a 4-column minmax(0, 1fr) grid', () => {
    const el = makeFakeLoadoutEl();
    HUDManager.renderLoadout(el, { player: { paperdoll: {}, action_bar: [] } });

    assert.match(
      el.innerHTML,
      /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
      'the grid must use minmax(0, 1fr) so long names cannot widen a column',
    );
    const squares = el.innerHTML.match(/class="loadout-slot/g) || [];
    assert.equal(squares.length, 8, 'exactly 8 keyed loadout squares (4 active + 4 equipment)');
  });

  it('pins the CSS shrink + ellipsis contract that keeps squares static', () => {
    const slotRule = HUD_CSS.match(/\.loadout-slot\s*\{[^}]*\}/)[0];
    assert.match(slotRule, /min-width:\s*0/, '.loadout-slot needs min-width:0 to shrink inside its track');

    const nameRule = HUD_CSS.match(/\.loadout-slot \.slot-name\s*\{[^}]*\}/)[0];
    assert.match(nameRule, /min-width:\s*0/);
    assert.match(nameRule, /overflow:\s*hidden/);
    assert.match(nameRule, /text-overflow:\s*ellipsis/, 'long names truncate rather than overflow');
    assert.match(nameRule, /white-space:\s*nowrap/);
  });
});

describe('LIV-38 Bug 2 — Fate Grants advance past Rank 5', () => {
  it('offers a Rank 6 upgrade at Rank 5 for a full party', () => {
    const player = fullParty();
    const wand = wandInstance(5);
    player.paperdoll.off_hand = wand;

    const offer = withOnlyCard(() => FateGrantSystem.generateDraftOffer(player, 10));
    const upgrade = offer.cards.find(card => card.isUpgrade);

    assert.ok(upgrade, 'a party-scaled cap must still offer an upgrade at Rank 5');
    assert.equal(upgrade.targetItemId, WAND);
    assert.equal(upgrade.targetItemLevel, 5);
    assert.match(upgrade.name, /Rank 6/);
  });

  it('still caps a solo draft at Rank 5', () => {
    const solo = createPlayer('magician');
    solo.paperdoll.off_hand = wandInstance(5);

    const offer = withOnlyCard(() => FateGrantSystem.generateDraftOffer(solo, 10));
    assert.equal(
      offer.cards.some(card => card.isUpgrade),
      false,
      'the solo/legacy Rank 5 cap is preserved',
    );
  });

  it('applies the Rank 5 -> 6 upgrade through the draft', () => {
    const player = fullParty();
    const wand = wandInstance(5);
    player.paperdoll.off_hand = wand;

    const offer = withOnlyCard(() => FateGrantSystem.generateDraftOffer(player, 10));
    FateGrantSystem.applyDraftedCards(player, offer.cards, null);

    assert.equal(wand.itemLevel, 6, 'the drafted upgrade advances the owned instance');
  });

  it('climbs an item from Rank 5 to the authored cap of 20 across repeated drafts', () => {
    const player = fullParty();
    const wand = wandInstance(5);
    player.paperdoll.off_hand = wand;

    let guard = 0;
    while (guard++ < 50) {
      const offer = withOnlyCard(() => FateGrantSystem.generateDraftOffer(player, 10));
      const upgrade = offer.cards.find(card => card.isUpgrade);
      if (!upgrade) break;
      FateGrantSystem.applyDraftedCards(player, [upgrade], null);
    }

    assert.equal(wand.itemLevel, 20, 'a full party reaches exactly the authored cap');
  });

  it('advances an auto ally past Rank 5 using the shared party cap', () => {
    const stash = fullParty();
    const ally = createPartyMember('archer');
    ally.paperdoll = { main_hand: null, off_hand: wandInstance(5), armor: null, relic: null };

    withOnlyCard(() => applyAutoFateGrant(ally, 10, null, stash));

    assert.equal(ally.paperdoll.off_hand.itemLevel, 6, 'ally drafts honor the shared party cap');
  });
});
