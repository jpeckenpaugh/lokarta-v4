/**
 * Regression suite.
 *
 * Covers:
 *  1. Shock Shield silver barrier VFX and Luminous Prayer healing-orb VFX.
 *  2. Fate Grant: no Confirm button, auto-confirm on exactly 2 cards, fade
 *     in/out, and the superseded up/down keyboard path removed.
 *
 * The Fate Grant interaction is exercised against a minimal overlay/card stub
 * (matching the packaging suite's approach) with auto-confirm forced
 * synchronous so the test stays deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { UI_CATALOG } from '../data/index.js';
import { FateGrantSystem } from '../engine/index.js';
import { createPlayer } from '../engine/config.js';
import { ModalManager } from '../app/modal-manager.js';
import { CanvasRenderer } from '../app/canvas-renderer.js';
import { readControllerSources } from './helpers/app-source.mjs';

const APP_DIR = resolve(process.cwd(), 'html', 'app');

const source = name => readFileSync(resolve(APP_DIR, name), 'utf8');

test('Player VFX data + renderer wiring', async t => {
  await t.test('ui.json exposes shockShield and luminousPrayer VFX tokens', () => {
    assert.ok(UI_CATALOG.playerVfx, 'playerVfx block exists');
    assert.equal(typeof UI_CATALOG.playerVfx.shockShield.color, 'string');
    assert.ok(UI_CATALOG.playerVfx.shockShield.radiusScale > 0);
    assert.ok(UI_CATALOG.playerVfx.shockShield.pulseHz > 0);
    assert.ok(UI_CATALOG.playerVfx.luminousPrayer.orbCount >= 2);
    assert.ok(UI_CATALOG.playerVfx.luminousPrayer.durationSec > 0);
  });

  await t.test('canvas renderer draws the silver shield while a charge is armed', () => {
    const calls = makeCtxSpy();
    const renderer = new CanvasRenderer(null);

    renderer.renderPlayerVfx(calls.ctx, { shockShieldCharges: 1, luminousPrayerVfxSec: 0 }, 0, 0);
    assert.ok(calls.strokes > 0, 'an armed shield strokes a barrier ring');
    assert.ok(calls.fills > 0, 'the barrier fills a translucent field');

    const idle = makeCtxSpy();
    renderer.renderPlayerVfx(idle.ctx, { shockShieldCharges: 0, luminousPrayerVfxSec: 0 }, 0, 0);
    assert.equal(idle.strokes, 0, 'no shield ring once the charge is spent');
    assert.equal(idle.total, 0, 'nothing is drawn when no effect is active');
  });

  await t.test('canvas renderer draws the glowing orbs while the prayer VFX timer runs', () => {
    const active = makeCtxSpy();
    const renderer = new CanvasRenderer(null);

    renderer.renderPlayerVfx(active.ctx, { shockShieldCharges: 0, luminousPrayerVfxSec: 1.2 }, 0, 0);
    assert.ok(active.fills >= UI_CATALOG.playerVfx.luminousPrayer.orbCount, 'one glow + core per orb');
    assert.equal(active.strokes, 0, 'orbs never stroke');

    const expired = makeCtxSpy();
    renderer.renderPlayerVfx(expired.ctx, { shockShieldCharges: 0, luminousPrayerVfxSec: 0 }, 0, 0);
    assert.equal(expired.total, 0, 'orbs clear when the timer expires');
  });

  await t.test('renderer exposes renderPlayerVfx and app-controller drives its timer', () => {
    assert.equal(typeof CanvasRenderer.prototype.renderPlayerVfx, 'function');
    const controller = readControllerSources();
    assert.match(controller, /luminousPrayerVfxSec/, 'prayer VFX timer is set/decayed in the controller');
    assert.match(controller, /playerVfx\?\.luminousPrayer/, 'the timer duration is read from ui.json');
  });
});

test('Fate Grant removes the Confirm button and auto-confirms at 2', async t => {
  await t.test('no Confirm button or dead selector remains in source or styles', () => {
    const modal = source('modal-manager.js');
    assert.doesNotMatch(modal, /btn-confirm-draft/, 'Confirm button id is gone');
    assert.doesNotMatch(modal, /Confirm Selections/, 'Confirm label is gone');
    assert.doesNotMatch(modal, /fate-modal-actions/, 'Confirm action row is gone');
    assert.match(modal, /maybeAutoConfirm/, 'auto-confirm path is present');

    // The Fate Grant function itself must not retain the up/down-to-Confirm path.
    const fateSrc = modal.slice(modal.indexOf('static showFateGrantModal'), modal.indexOf('static showVictoryModal'));
    assert.ok(fateSrc.length > 0, 'Fate Grant source located');
    assert.doesNotMatch(fateSrc, /ArrowDown|ArrowUp/, 'up/down-to-Confirm keyboard path is gone');

    const css = readFileSync(resolve(process.cwd(), 'html', 'styles', 'modals.css'), 'utf8');
    assert.doesNotMatch(css, /\.confirm-draft-btn/, 'Confirm button styles are removed');
    assert.doesNotMatch(css, /\.fate-modal-actions/, 'Confirm action-row styles are removed');
    assert.match(css, /fate-modal-in/, 'fade-in animation is present');
    assert.match(css, /fate-modal-out/, 'fade-out animation is present');
  });

  await t.test('subtitle no longer tells the player to Confirm', () => {
    const modal = source('modal-manager.js');
    const subtitle = modal.match(/<div class="subtitle">([^<]*)<\/div>/);
    assert.ok(subtitle, 'subtitle rendered');
    assert.match(subtitle[1], /automatically/i);
    assert.doesNotMatch(subtitle[1], /then Confirm|Confirm Selections/i);
  });

  await t.test('checking exactly 2 cards auto-applies the draft and closes', async () => {
    const originalDelay = ModalManager.FATE_AUTO_CONFIRM_DELAY_MS;
    const originalApply = FateGrantSystem.applyDraftedCards;
    ModalManager.FATE_AUTO_CONFIRM_DELAY_MS = 0;

    const applied = [];
    FateGrantSystem.applyDraftedCards = (_player, chosen) => {
      applied.push(chosen.map(c => c.id));
      return { addedToHotbar: [], addedToBackpack: [], droppedOnFloor: [] };
    };

    try {
      const player = createPlayer('magician');
      const offer = FateGrantSystem.generateDraftOffer(player, 1);
      const { overlay, cards, statusEl } = makeFateOverlay(offer.cards.map(c => c.id));
      const savedWindow = globalThis.window;
      globalThis.window = makeWindowStub();

      const app = makeAppStub(player);

      try {
        ModalManager.showFateGrantModal(overlay, app, 1);

        cards[0]._click();
        assert.equal(applied.length, 0, 'one card does not apply the draft');
        assert.equal(statusEl.textContent, '1 of 2 selected');

        cards[1]._click();
        assert.equal(applied.length, 1, 'the 2nd card auto-applies the draft exactly once');
        assert.equal(applied[0].length, 2, 'exactly two cards are applied');
        assert.equal(statusEl.textContent, '2 of 2 selected — applying draft');

        // closeDraft runs sync under reduced motion up to the async persist.
        assert.ok(overlay.classList.contains('hidden'), 'the screen is hidden after auto-confirm');
        assert.equal(app.isPaused, false, 'the game unpauses');

        // A stray click after resolution must not double-apply.
        cards[2]._click();
        assert.equal(applied.length, 1, 'no second apply after resolution');
      } finally {
        globalThis.window = savedWindow;
      }
    } finally {
      FateGrantSystem.applyDraftedCards = originalApply;
      ModalManager.FATE_AUTO_CONFIRM_DELAY_MS = originalDelay;
    }
  });

  await t.test('a 3rd card is rejected and de-selection cancels a pending auto-confirm', async () => {
    const originalApply = FateGrantSystem.applyDraftedCards;
    const originalDelay = ModalManager.FATE_AUTO_CONFIRM_DELAY_MS;
    ModalManager.FATE_AUTO_CONFIRM_DELAY_MS = 25;

    const applied = [];
    FateGrantSystem.applyDraftedCards = () => {
      applied.push(true);
      return { addedToHotbar: [], addedToBackpack: [], droppedOnFloor: [] };
    };

    try {
      const player = createPlayer('magician');
      const offer = FateGrantSystem.generateDraftOffer(player, 1);
      const { overlay, cards } = makeFateOverlay(offer.cards.map(c => c.id));
      const savedWindow = globalThis.window;
      globalThis.window = makeWindowStub();

      try {
        ModalManager.showFateGrantModal(overlay, makeAppStub(player, { reduceMotionResolved: false }), 1);

        cards[0]._click();
        cards[1]._click();
        cards[2]._click(); // 3rd selection is rejected, does not evict
        assert.equal(applied.length, 0, '3rd click does not apply');
        assert.equal(cards[2].getAttribute('aria-checked'), 'false');

        // Deselect before the auto-confirm delay elapses.
        cards[1]._click();
        await new Promise(r => setTimeout(r, 60));
        assert.equal(applied.length, 0, 'de-selection cancels the pending auto-confirm');
      } finally {
        globalThis.window = savedWindow;
      }
    } finally {
      FateGrantSystem.applyDraftedCards = originalApply;
      ModalManager.FATE_AUTO_CONFIRM_DELAY_MS = originalDelay;
    }
  });
});

function makeCtxSpy() {
  const state = { strokes: 0, fills: 0, total: 0 };
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    arc() { state.total += 1; },
    fill() { state.fills += 1; state.total += 1; },
    stroke() { state.strokes += 1; state.total += 1; },
  };
  return { ctx, get strokes() { return state.strokes; }, get fills() { return state.fills; }, get total() { return state.total; } };
}

function makeWindowStub() {
  const listeners = new Set();
  return {
    addEventListener: (type, fn) => { if (type === 'keydown') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'keydown') listeners.delete(fn); },
  };
}

function makeCardElement(cardId) {
  const classes = new Set();
  const attrs = { 'data-card-id': cardId, 'aria-checked': 'false' };
  let clickHandler = null;
  return {
    tabIndex: -1,
    offsetWidth: 100,
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, force) => { if (force === undefined ? !classes.has(c) : force) classes.add(c); else classes.delete(c); },
    },
    getAttribute: k => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; },
    focus() {},
    _click() { if (clickHandler) clickHandler(); },
    _classes: classes,
  };
}

function makeFateOverlay(cardIds) {
  const cards = cardIds.map(id => makeCardElement(id));
  let html = '';
  const classes = new Set();
  const statusEl = { textContent: '' };
  const modalEl = {
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
    },
  };
  const overlay = {
    _keyHandler: null,
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
    },
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v;
      // Rebuild the card stubs from the markup the modal actually rendered so
      // the stubs always mirror the offer the modal generated internally
      // (generateDraftOffer is randomized, so pre-building from a separate
      // offer made this suite flaky).
      const ids = [...String(v).matchAll(/data-card-id="([^"]+)"/g)].map(m => m[1]);
      if (ids.length) {
        cards.length = 0;
        for (const id of ids) cards.push(makeCardElement(id));
      }
    },
    querySelector(sel) {
      if (sel === '.fate-grant-modal') return modalEl;
      if (sel === '#fate-selection-status') return statusEl;
      return null;
    },
    querySelectorAll: sel => (sel === '.fate-card' ? cards : []),
  };
  return { overlay, cards, statusEl, modalEl };
}

function makeAppStub(player, overrides = {}) {
  return {
    player,
    gridMap: {},
    isPaused: true,
    reduceMotionResolved: true,
    logs: [],
    logCombat(msg) { this.logs.push(msg); },
    updateHUD() {},
    async persistSave() {},
    ...overrides,
  };
}
