/**
 * Persistent per-slot auto-fire (armed/toggle) state machine.
 *
 * Long-press on an equipment slot (`q/w/e/r`) toggles auto-fire ON and it
 * persists after release; a second long-press, an item change, or the end of
 * the gameplay context disarms it. These tests drive the AbilityBar state
 * machine directly (no browser) and cover:
 *  - arm on threshold, persist through release, disarm on second long-press
 *  - taps stay single-cast and never arm
 *  - active slots 1-4 never arm
 *  - independent per-slot armed state; tapping another slot never disarms
 *  - disarm on unequip / item change
 *  - disarm on pause / modal / death / floor transition / game over / cleared
 *  - waiting-without-spending across guard gaps, then automatic resume
 *  - the persistent AUTO badge + `auto-fire on` aria state
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createPlayer } from '../engine/config.js';
import { ITEMS_CATALOG } from '../data/index.js';
import { resolveAbilityRef } from '../app/autofire.js';
import { AbilityBar } from '../app/ability-bar.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_CSS = readFileSync(resolve(HERE, '../styles/base.css'), 'utf8');

function makeApp(vocation = 'magician') {
  return {
    player: createPlayer(vocation),
    monsters: [],
    gridMap: null,
    isInGameplay: true,
    isPaused: false,
    isGameOver: false,
    isFloorCleared: false,
    transition: { isLocked: () => false },
    casts: 0,
    executeHandCombat() { this.casts += 1; },
    handleGestureEvent() { this.casts += 1; },
    gestureEngine: {
      handleInputDown() { this.casts = (this.casts || 0) + 0.5; },
      handleInputUp() { this.casts = (this.casts || 0) + 0.5; },
    },
  };
}

function equip(app, slot, itemId, overrides = {}) {
  const item = { ...JSON.parse(JSON.stringify(ITEMS_CATALOG[itemId])), ...overrides };
  app.player.paperdoll[slot] = item;
  return item;
}

function monsterNear(app, dx = 2, dy = 0) {
  app.monsters = [{ id: 'm1', name: 'Rat', x: app.player.x + dx, y: app.player.y + dy, hp: 10, max_hp: 10, visible: true }];
  return app.monsters[0];
}

function fakeClassList(initial = ['ability-btn']) {
  const set = new Set(initial);
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : Boolean(force);
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    contains: c => set.has(c),
    _set: set,
  };
}

/** Minimal button stub; `querySelector` returns null so optional DOM is skipped. */
function fakeButton(dataset) {
  const attrs = new Map();
  return {
    dataset,
    classList: fakeClassList(),
    style: { setProperty() {}, removeProperty() {} },
    querySelector: () => null,
    getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, v),
    setPointerCapture() {},
    _attrs: attrs,
  };
}

function equipButton(dataset = { slotKind: 'equipment', slot: 'off_hand', index: '0', baseLabel: 'Off hand, key W' }) {
  return fakeButton({ ...dataset });
}

/** Arm a slot without going through the pointer timer (deterministic). */
function arm(bar, app, btn, slot = 'off_hand') {
  const ref = { kind: 'equipment', slot };
  const ctx = resolveAbilityRef(app, ref);
  bar._toggleArmed(ref, btn, ctx);
  return ref;
}

describe('Arm/toggle via long-press', () => {
  it('arms on threshold, survives release, and disarms on the next long-press', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    monsterNear(app);
    const bar = new AbilityBar(app);
    const btn = equipButton();

    bar._startSession(btn, 1, { pointerId: 1 });
    bar._onThreshold(bar.sessions.get(1));
    assert.equal(bar.armed.has('off_hand'), true, 'armed at threshold');
    assert.equal(btn.classList.contains('ability-btn--active-fire'), true);
    assert.equal(app.casts, 1, 'fires once on arming');

    bar._endSession(bar.sessions.get(1), true);
    assert.equal(bar.armed.has('off_hand'), true, 'release does not disarm');
    assert.equal(btn.classList.contains('ability-btn--active-fire'), true);

    bar._startSession(btn, 2, { pointerId: 2 });
    bar._onThreshold(bar.sessions.get(2));
    assert.equal(bar.armed.has('off_hand'), false, 'second long-press disarms');
    assert.equal(btn.classList.contains('ability-btn--active-fire'), false);
    assert.equal(app.casts, 1, 'disarming does not cast');

    bar._endSession(bar.sessions.get(2), true);
    bar.destroy();
  });

  it('keeps a short tap as a single cast and never arms', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    monsterNear(app);
    const bar = new AbilityBar(app);
    const btn = equipButton();

    bar._startSession(btn, 3, { pointerId: 3 });
    bar._endSession(bar.sessions.get(3), true);
    assert.equal(app.casts, 1, 'tap casts once');
    assert.equal(bar.armed.size, 0, 'tap never arms');
    assert.equal(btn.classList.contains('ability-btn--active-fire'), false);
    bar.destroy();
  });

  it('never arms active slots 1-4 (single use only)', () => {
    const app = makeApp('magician');
    app.player.action_bar[0] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable' };
    const bar = new AbilityBar(app);
    const btn = fakeButton({ slotKind: 'active', index: '0', slot: undefined, baseLabel: 'Active slot 1, key 1' });

    bar._startSession(btn, 4, { pointerId: 4 });
    bar._onThreshold(bar.sessions.get(4));
    assert.equal(bar.armed.size, 0, 'active slot never arms');
    assert.equal(btn.classList.contains('ability-btn--single-locked'), true);
    assert.equal(app.casts, 1);
    bar._endSession(bar.sessions.get(4), false);
    bar.destroy();
  });
});

describe('Independent per-slot state', () => {
  it('arms multiple slots at once without cross-talk', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    app.player.paperdoll.relic = { item_id: 'synthetic_light', name: 'Light', actionKey: 'light_spell', manaCost: 15 };
    monsterNear(app);
    const bar = new AbilityBar(app);

    const wandBtn = equipButton({ slotKind: 'equipment', slot: 'off_hand', index: '0', baseLabel: 'Off hand, key W' });
    const relicBtn = equipButton({ slotKind: 'equipment', slot: 'relic', index: '0', baseLabel: 'Relic, key R' });
    arm(bar, app, wandBtn, 'off_hand');
    arm(bar, app, relicBtn, 'relic');
    assert.equal(bar.armed.has('off_hand'), true);
    assert.equal(bar.armed.has('relic'), true);

    bar._disarm('off_hand');
    assert.equal(bar.armed.has('off_hand'), false, 'only the targeted slot disarms');
    assert.equal(bar.armed.has('relic'), true);
    assert.equal(relicBtn.classList.contains('ability-btn--active-fire'), true);
    assert.equal(wandBtn.classList.contains('ability-btn--active-fire'), false);
    bar.destroy();
  });

  it('does not disarm an armed slot when another slot is tapped', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    app.player.paperdoll.relic = { item_id: 'synthetic_light', name: 'Light', actionKey: 'light_spell', manaCost: 15 };
    monsterNear(app);
    const bar = new AbilityBar(app);

    const wandBtn = equipButton();
    arm(bar, app, wandBtn, 'off_hand');
    assert.equal(bar.armed.has('off_hand'), true);

    const relicBtn = equipButton({ slotKind: 'equipment', slot: 'relic', index: '0', baseLabel: 'Relic, key R' });
    bar._startSession(relicBtn, 8, { pointerId: 8 });
    bar._endSession(bar.sessions.get(8), true);
    assert.equal(bar.armed.has('off_hand'), true, 'tapping another slot leaves auto-fire on');
    bar.destroy();
  });
});

describe('Disarm on item change', () => {
  it('disarms when the armed item is unequipped', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    monsterNear(app);
    const bar = new AbilityBar(app);
    const btn = equipButton();
    arm(bar, app, btn, 'off_hand');
    assert.equal(bar.armed.has('off_hand'), true);

    app.player.paperdoll.off_hand = null;
    bar._autoTick();
    assert.equal(bar.armed.has('off_hand'), false, 'unequip disarms');
    assert.equal(btn.classList.contains('ability-btn--active-fire'), false);
    bar.destroy();
  });

  it('disarms when the armed item is replaced', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    monsterNear(app);
    const bar = new AbilityBar(app);
    const btn = equipButton();
    arm(bar, app, btn, 'off_hand');

    equip(app, 'off_hand', 'apprentice_wand'); // fresh object identity
    bar._autoTick();
    assert.equal(bar.armed.has('off_hand'), false, 'item swap disarms');
    bar.destroy();
  });
});

describe('Disarm when the gameplay context ends', () => {
  const ENDERS = [
    ['pause', app => { app.isPaused = true; }],
    ['game over', app => { app.isGameOver = true; }],
    ['tower cleared', app => { app.isFloorCleared = true; }],
    ['leaving gameplay', app => { app.isInGameplay = false; }],
    ['a locked transition', app => { app.transition = { isLocked: () => true }; }],
    ['death', app => { app.player.hp = 0; }],
    ['an open modal', app => { app.modalOverlayEl = { classList: { contains: c => c !== 'hidden' } }; }],
  ];

  for (const [name, apply] of ENDERS) {
    it(`disarms on ${name} and does not silently re-arm on resume`, () => {
      const app = makeApp('magician');
      equip(app, 'off_hand', 'apprentice_wand');
      monsterNear(app);
      const bar = new AbilityBar(app);
      const btn = equipButton();
      arm(bar, app, btn, 'off_hand');
      assert.equal(bar.armed.has('off_hand'), true, 'armed before context end');

      apply(app);
      bar._autoTick();
      assert.equal(bar.armed.has('off_hand'), false, `disarmed on ${name}`);
      assert.equal(btn.classList.contains('ability-btn--active-fire'), false);

      // Resume: the player must re-arm explicitly.
      app.isPaused = false;
      app.isGameOver = false;
      app.isFloorCleared = false;
      app.isInGameplay = true;
      app.player.hp = app.player.max_hp;
      app.transition = { isLocked: () => false };
      bar._autoTick();
      assert.equal(bar.armed.has('off_hand'), false, 'no silent re-arm after resume');
      bar.destroy();
    });
  }
});

describe('Guarded waiting and resume', () => {
  it('waits without spending when the guard fails, then resumes automatically', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    const bar = new AbilityBar(app);
    const btn = equipButton();
    arm(bar, app, btn, 'off_hand');

    assert.equal(btn.classList.contains('ability-btn--active-fire'), true, 'stays armed');
    assert.equal(btn.classList.contains('ability-btn--waiting'), true, 'waiting with no target');
    assert.equal(app.casts, 0, 'no cast and no MP spent with no target');

    monsterNear(app);
    bar._evaluateArmed('off_hand');
    assert.equal(btn.classList.contains('ability-btn--waiting'), false, 'fires once a target appears');
    assert.equal(app.casts, 1);

    app.player.mana = 0;
    bar._evaluateArmed('off_hand');
    assert.equal(btn.classList.contains('ability-btn--waiting'), true, 'waiting out of mana');
    assert.equal(btn.classList.contains('ability-btn--active-fire'), true);
    const castsWhileDry = app.casts;

    app.player.mana = app.player.max_mana;
    bar._evaluateArmed('off_hand');
    assert.equal(btn.classList.contains('ability-btn--waiting'), false);
    assert.equal(app.casts, castsWhileDry + 1, 'resumes when mana returns');
    bar.destroy();
  });
});

describe('Visual and accessible armed state', () => {
  it('emits exactly one AUTO badge per equipment slot, and none for active slots', () => {
    const bar = new AbilityBar(makeApp());
    bar.container = { innerHTML: '' };
    bar._build();
    const html = bar.container.innerHTML;
    const parts = html.split('data-slot-kind="equipment"');
    const activeBlock = parts[0];
    const equipmentBlock = parts.slice(1).join('');
    assert.doesNotMatch(activeBlock, /ability-auto-badge/, 'active slots carry no AUTO badge');
    assert.equal((equipmentBlock.match(/ability-auto-badge/g) || []).length, 4);
  });

  it('reveals the AUTO badge only while the slot is armed (CSS)', () => {
    assert.match(BASE_CSS, /\.ability-btn--active-fire \.ability-auto-badge\s*\{[\s\S]*?display:\s*inline-block/);
    assert.match(BASE_CSS, /\.ability-btn \.ability-auto-badge\s*\{[\s\S]*?display:\s*none/);
  });

  it('sets aria-label to include "auto-fire on" while armed and clears it on disarm', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    monsterNear(app);
    const bar = new AbilityBar(app);
    const btn = equipButton();

    arm(bar, app, btn, 'off_hand');
    bar._paintButton(btn);
    assert.match(btn.getAttribute('aria-label'), /auto-fire on/, 'aria advertises armed state');

    bar._disarm('off_hand');
    bar._paintButton(btn);
    assert.doesNotMatch(btn.getAttribute('aria-label'), /auto-fire on/, 'aria clears on disarm');
    bar.destroy();
  });
});
