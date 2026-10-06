/**
 * Lokarta: "Upgrade Gear no-op" regression coverage.
 *
 * Pins the fix for the board bug where Upgrade Gear did nothing for a
 * Magician's Luminous Amulet at Rank 4. Root cause: the rendered upgrade ref
 * `equipment:<paperdoll-slot>` was decoded with `Number(index)`, so the slot
 * name `relic` became `NaN` and the controller's lookup failed, silently
 * re-opening the shop.
 *
 * These tests drive the real DOM click path (`renderTownShop` /
 * `showShopModal` -> `upgradeShopItem`) rather than the engine helper alone, so
 * the string/number ref round-trip is actually exercised.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPlayer } from '../engine/index.js';
import { ITEMS_CATALOG } from '../data/index.js';
import { LokartaApp } from '../app/app-controller.js';
import { ModalManager } from '../app/modal-manager.js';

/**
 * Minimal shop-element stub that records the rendered upgrade buttons and lets
 * a test fire their click listener. `data-upgrade-slot` values are parsed back
 * out of the generated markup, so a broken encoder/decoder is still caught.
 */
function makeFakeShopEl() {
  const buttons = [];
  let html = '';
  const el = {
    hidden: false,
    onkeydown: null,
    classList: { add() {}, remove() {}, contains() { return false; } },
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      buttons.length = 0;
      const re = /data-upgrade-slot="([^"]*)"/g;
      let match;
      while ((match = re.exec(value)) !== null) {
        const encoded = match[1];
        const listeners = {};
        buttons.push({
          encoded,
          getAttribute: name => (name === 'data-upgrade-slot' ? encoded : null),
          addEventListener: (type, fn) => { listeners[type] = fn; },
          click: () => listeners.click?.(),
        });
      }
    },
    querySelector: () => null,
    querySelectorAll: selector =>
      (selector === '.shop-entry[data-upgrade-slot]' ? buttons : []),
  };
  return { el, buttons };
}

function makeApp(vocation) {
  const app = Object.create(LokartaApp.prototype);
  app.player = createPlayer(vocation);
  app.logs = [];
  app.logCombat = (message, tone) => { app.logs.push({ message, tone }); };
  app.updateHUD = () => {};
  app.persistSave = () => {};
  app.openShop = () => {};
  return app;
}

function renderShop(app, renderer) {
  const { el, buttons } = makeFakeShopEl();
  const state = {
    player: app.player,
    shopStock: [],
    pawnItems: [],
    ownedUpgradableItems: app.collectUpgradableItems(),
    gold: Number(app.player.gold) || 0,
    townConfig: { shopName: "Merchant's Stall" },
  };
  const callbacks = { onUpgrade: (source, index) => app.upgradeShopItem(source, index) };
  if (renderer === 'modal') {
    ModalManager.showShopModal(el, state, callbacks);
  } else {
    ModalManager.renderTownShop(el, state, callbacks);
  }
  return { el, buttons };
}

function upgradeButton(buttons, encoded) {
  return buttons.find(button => button.encoded === encoded);
}

describe('Upgrade Gear round-trip', () => {
  it('ranks the Luminous Amulet from 4 to 5 through the Town shop', () => {
    const app = makeApp('magician');
    app.player.paperdoll.relic = {
      ...ITEMS_CATALOG.relic_luminous_amulet,
      item_id: 'relic_luminous_amulet',
      itemLevel: 4,
    };
    app.player.gold = 500; // cost = 40 + 35 * 3 = 145

    const { el, buttons } = renderShop(app, 'town');
    const amulet = upgradeButton(buttons, 'equipment:relic');
    assert.ok(amulet, 'the amulet must be offered as equipment:relic');
    assert.match(el.innerHTML, /Luminous Amulet <em>Rank 4<\/em>/);

    amulet.click();

    assert.equal(app.player.paperdoll.relic.itemLevel, 5, 'amulet reaches rank 5');
    assert.equal(app.player.gold, 355, 'the 145 gold cost is spent');
    assert.ok(
      app.logs.some(entry => /Upgraded Luminous Amulet/.test(entry.message)),
      'a success message is logged'
    );
  });

  it('ranks all four equipped slots (2 hands, armor, neck/relic)', () => {
    const app = makeApp('fighter');
    app.player.paperdoll = {
      main_hand: { ...ITEMS_CATALOG.tempered_broadsword, item_id: 'tempered_broadsword', itemLevel: 1 },
      off_hand: { ...ITEMS_CATALOG.vanguard_shield, item_id: 'vanguard_shield', itemLevel: 1 },
      armor: { ...ITEMS_CATALOG.plate_armor, item_id: 'plate_armor', itemLevel: 1 },
      relic: { ...ITEMS_CATALOG.iron_helm, item_id: 'iron_helm', itemLevel: 1 },
    };
    app.player.gold = 2000;

    const { buttons } = renderShop(app, 'town');
    for (const slot of ['main_hand', 'off_hand', 'armor', 'relic']) {
      const button = upgradeButton(buttons, `equipment:${slot}`);
      assert.ok(button, `${slot} must render an upgrade control`);
      button.click();
    }

    for (const slot of ['main_hand', 'off_hand', 'armor', 'relic']) {
      assert.equal(app.player.paperdoll[slot].itemLevel, 2, `${slot} ranks up`);
    }
  });

  it('still ranks a backpack item through its numeric index ref', () => {
    const app = makeApp('magician');
    app.player.backpack[0] = {
      ...ITEMS_CATALOG.astral_scepter,
      item_id: 'astral_scepter',
      itemLevel: 1,
    };
    app.player.gold = 500;

    const { buttons } = renderShop(app, 'town');
    const button = upgradeButton(buttons, 'backpack:0');
    assert.ok(button, 'backpack:0 must render an upgrade control');
    button.click();

    assert.equal(app.player.backpack[0].itemLevel, 2);
  });

  it('ranks the amulet through the legacy showShopModal path too', () => {
    const app = makeApp('magician');
    app.player.paperdoll.relic = {
      ...ITEMS_CATALOG.relic_luminous_amulet,
      item_id: 'relic_luminous_amulet',
      itemLevel: 4,
    };
    app.player.gold = 500;

    const { buttons } = renderShop(app, 'modal');
    const amulet = upgradeButton(buttons, 'equipment:relic');
    assert.ok(amulet);
    amulet.click();

    assert.equal(app.player.paperdoll.relic.itemLevel, 5);
  });
});

describe('Upgrade Gear never silently no-ops', () => {
  it('marks an unaffordable upgrade and explains the shortfall on click', () => {
    const app = makeApp('magician');
    app.player.paperdoll.relic = {
      ...ITEMS_CATALOG.relic_luminous_amulet,
      item_id: 'relic_luminous_amulet',
      itemLevel: 4,
    };
    app.player.gold = 0;

    const { el, buttons } = renderShop(app, 'town');
    const amulet = upgradeButton(buttons, 'equipment:relic');
    assert.ok(amulet);
    assert.match(el.innerHTML, /is-unaffordable/, 'unaffordable entry is dimmed');
    assert.match(el.innerHTML, /aria-disabled="true"/);
    assert.match(el.innerHTML, /Need 145 gold — you have 0/);

    amulet.click();

    assert.equal(app.player.paperdoll.relic.itemLevel, 4, 'no rank-up without gold');
    assert.equal(app.player.gold, 0, 'no gold spent');
    assert.ok(
      app.logs.some(entry => /You need 145 gold/.test(entry.message)),
      'a clear not-enough-gold message is logged'
    );
  });

  it('keeps max-rank gear out of the list and explains a stale click', () => {
    const app = makeApp('magician');
    app.player.paperdoll.relic = {
      ...ITEMS_CATALOG.relic_luminous_amulet,
      item_id: 'relic_luminous_amulet',
      itemLevel: 5,
    };
    app.player.gold = 9999;

    const { el } = renderShop(app, 'town');
    assert.match(el.innerHTML, /No upgradable gear in your pack\./);
    assert.doesNotMatch(el.innerHTML, /data-upgrade-slot="equipment:relic"/);

    app.upgradeShopItem('equipment', 'relic');
    assert.ok(
      app.logs.some(entry => /cannot be upgraded further/.test(entry.message)),
      'a stale max-rank click is explained, not silent'
    );
  });

  it('does not list an item with no upgradeSpec', () => {
    const app = makeApp('fighter');
    app.player.paperdoll.relic = {
      ...ITEMS_CATALOG.relic_champions_crest,
      item_id: 'relic_champions_crest',
      itemLevel: 1,
    };

    const list = app.collectUpgradableItems();
    assert.equal(
      list.some(entry => entry.source === 'equipment' && entry.index === 'relic'),
      false,
      'non-upgradeable gear is never offered'
    );

    app.upgradeShopItem('equipment', 'relic');
    assert.ok(app.logs.some(entry => /cannot be upgraded further/.test(entry.message)));
  });
});
