/**
 * Mobile ability bar hold-to-autofire policy.
 *
 * Covers the acceptance criteria that are unit-testable without a browser:
 *  - autofire timings are catalog-driven (keybindings.json -> CONFIG)
 *  - hold classification at the 2s threshold
 *  - the "benefits the player" guard suppresses cooldown / mana / ammo /
 *    no-target / already-active repeats
 *  - active slots 1-4 are never auto-repeatable (no stack/MP drain)
 *  - the Light Spell cooldown-key override is honored
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, createPlayer } from '../engine/config.js';
import { ITEMS_CATALOG, KEYBINDINGS_CATALOG } from '../data/index.js';
import {
  autofireTimings,
  classifyHold,
  resolveAbilityRef,
  isRepeatable,
  evaluateGuard,
  canAutoFire,
  AUTOFIRE_DEFAULTS,
} from '../app/autofire.js';
import { AbilityBar } from '../app/ability-bar.js';

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

describe('Autofire timings', () => {
  it('resolves the catalog timings into CONFIG', () => {
    assert.equal(KEYBINDINGS_CATALOG.autofire.holdMs, 2000);
    assert.equal(KEYBINDINGS_CATALOG.autofire.repeatMs, 200);
    assert.equal(KEYBINDINGS_CATALOG.autofire.feedbackMs, 1200);
    assert.equal(CONFIG.AUTOFIRE_HOLD_MS, 2000);
    assert.equal(CONFIG.AUTOFIRE_REPEAT_MS, 200);
    assert.equal(CONFIG.AUTOFIRE_FEEDBACK_MS, 1200);
    assert.deepEqual(autofireTimings(), { holdMs: 2000, repeatMs: 200, feedbackMs: 1200 });
  });

  it('falls back safely when the catalog block is absent', () => {
    assert.deepEqual(AUTOFIRE_DEFAULTS, { holdMs: 2000, repeatMs: 200, feedbackMs: 1200 });
  });

  it('classifies a hold exactly at the threshold as autofire', () => {
    assert.equal(classifyHold(0), 'single');
    assert.equal(classifyHold(1999), 'single');
    assert.equal(classifyHold(2000), 'autofire');
    assert.equal(classifyHold(5000), 'autofire');
  });
});

describe('Ability refs and repeatability', () => {
  it('resolves an equipment ref to its catalog actionKey', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    const ctx = resolveAbilityRef(app, { kind: 'equipment', slot: 'off_hand' });
    assert.equal(ctx.actionKey, 'wand_spark');
    assert.equal(ctx.ability.actionKey, 'wand_spark');
    assert.equal(isRepeatable({ kind: 'equipment', slot: 'off_hand' }, ctx), true);
  });

  it('resolves an active ref from the action bar', () => {
    const app = makeApp('magician');
    app.player.action_bar[0] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable' };
    const ctx = resolveAbilityRef(app, { kind: 'active', index: 0 });
    assert.equal(ctx.item.item_id, 'health_potion');
    assert.equal(isRepeatable({ kind: 'active', index: 0 }, ctx), false);
  });

  it('never auto-fires active slots 1-4 even with a castable item', () => {
    const app = makeApp('magician');
    app.player.action_bar[0] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable' };
    assert.equal(canAutoFire(app, { kind: 'active', index: 0 }), false);
    assert.equal(evaluateGuard(app, { kind: 'active', index: 0 }).reason, 'nonrepeatable');
  });
});

describe('Benefit guard', () => {
  it('suppresses an offensive cast with no target and fires with one', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    const ref = { kind: 'equipment', slot: 'off_hand' };
    assert.equal(evaluateGuard(app, ref).reason, 'no-target');
    assert.equal(canAutoFire(app, ref), false);

    monsterNear(app);
    assert.equal(evaluateGuard(app, ref).reason, 'ok');
    assert.equal(canAutoFire(app, ref), true);
  });

  it('suppresses while on cooldown', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    monsterNear(app);
    app.player.cooldowns.wand_spark = 0.9;
    assert.equal(evaluateGuard(app, { kind: 'equipment', slot: 'off_hand' }).reason, 'cooldown');
    assert.equal(canAutoFire(app, { kind: 'equipment', slot: 'off_hand' }), false);
  });

  it('suppresses when out of mana', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    monsterNear(app);
    app.player.mana = 0;
    assert.equal(evaluateGuard(app, { kind: 'equipment', slot: 'off_hand' }).reason, 'mana');
  });

  it('suppresses a bow shot without arrows and fires once a quiver is loaded', () => {
    const app = makeApp('archer');
    equip(app, 'main_hand', 'wooden_bow');
    monsterNear(app);
    const ref = { kind: 'equipment', slot: 'main_hand' };
    assert.equal(evaluateGuard(app, ref).reason, 'ammo');

    equip(app, 'off_hand', 'grey_stalker_quiver', { arrowCount: 3 });
    assert.equal(evaluateGuard(app, ref).reason, 'ok');
    assert.equal(canAutoFire(app, ref), true);
  });

  it('suppresses re-arming an already-active shield', () => {
    const app = makeApp('magician');
    equip(app, 'armor', 'apprentice_cape');
    monsterNear(app);
    const ref = { kind: 'equipment', slot: 'armor' };
    assert.equal(evaluateGuard(app, ref).reason, 'ok');
    app.player.shockShieldCharges = 1;
    assert.equal(evaluateGuard(app, ref).reason, 'active');
    assert.equal(canAutoFire(app, ref), false);
  });

  it('stops a heal that has nothing to restore', () => {
    const app = makeApp('paladin');
    app.player.paperdoll.relic = { item_id: 'synthetic_heal', name: 'Heal', actionKey: 'healing_prayer', manaCost: 5 };
    const ref = { kind: 'equipment', slot: 'relic' };
    app.player.hp = app.player.max_hp;
    assert.equal(evaluateGuard(app, ref).reason, 'active');
    app.player.hp = Math.floor(app.player.max_hp / 2);
    assert.equal(evaluateGuard(app, ref).reason, 'ok');
  });

  it('resolves the Light Spell cooldown under its `light` key override', () => {
    const app = makeApp('magician');
    app.player.paperdoll.relic = { item_id: 'synthetic_light', name: 'Light', actionKey: 'light_spell', manaCost: 15 };
    app.player.cooldowns.light = 4;
    const ref = { kind: 'equipment', slot: 'relic' };
    assert.equal(evaluateGuard(app, ref).reason, 'cooldown');
    app.player.cooldowns.light = 0;
    app.player.lightSpellTimer = 0;
    assert.equal(evaluateGuard(app, ref).reason, 'ok');
  });

  it('suppresses an unknown actionKey instead of repeating blindly', () => {
    const app = makeApp('fighter');
    app.player.paperdoll.main_hand = { item_id: 'mystery', name: 'Mystery', actionKey: 'not_a_real_action' };
    monsterNear(app);
    assert.equal(evaluateGuard(app, { kind: 'equipment', slot: 'main_hand' }).reason, 'no-target');
  });

  it('blocks dispatch outside gameplay / while paused', () => {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    monsterNear(app);
    const ref = { kind: 'equipment', slot: 'off_hand' };
    app.isPaused = true;
    assert.equal(evaluateGuard(app, ref).reason, 'inactive');
    app.isPaused = false;
    app.transition = { isLocked: () => true };
    assert.equal(evaluateGuard(app, ref).reason, 'inactive');
  });
});

describe('AbilityBar module shape', () => {
  it('exposes the lifecycle + dispatch surface used by the app', () => {
    assert.equal(typeof AbilityBar, 'function');
    assert.equal(typeof AbilityBar.prototype.mount, 'function');
    assert.equal(typeof AbilityBar.prototype.paint, 'function');
    assert.equal(typeof AbilityBar.prototype.destroy, 'function');
    assert.equal(typeof AbilityBar.prototype._dispatch, 'function');
  });
});

// Minimal DOM shim so the press/autofire state machine can be driven without a
// browser. Only the members AbilityBar touches are implemented.
function fakeClassList() {
  const set = new Set(['ability-btn']);
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, force) => { if (force) set.add(c); else set.delete(c); },
    contains: c => set.has(c),
    _set: set,
  };
}

function fakeButton(dataset) {
  return {
    dataset,
    classList: fakeClassList(),
    style: { setProperty() {}, removeProperty() {} },
    querySelector: () => null,
    getAttribute: () => null,
    setAttribute() {},
    setPointerCapture() {},
  };
}

function fakeContainer() {
  return {
    innerHTML: '',
    style: { setProperty() {} },
    querySelectorAll: () => [],
    addEventListener() {},
  };
}

describe('Press/autofire state machine', () => {
  const originalHold = CONFIG.AUTOFIRE_HOLD_MS;
  const originalRepeat = CONFIG.AUTOFIRE_REPEAT_MS;

  function machineApp() {
    const app = makeApp('magician');
    equip(app, 'off_hand', 'apprentice_wand');
    monsterNear(app);
    app.casts = 0;
    app.executeHandCombat = () => { app.casts += 1; };
    app.handleGestureEvent = () => { app.casts += 1; };
    app.gestureEngine = { handleInputDown() { app.casts += 0.5; }, handleInputUp() { app.casts += 0.5; } };
    return app;
  }

  it('builds 8 catalog-driven buttons (4 active + 4 equipment)', () => {
    const app = makeApp('magician');
    const bar = new AbilityBar(app);
    bar.container = fakeContainer();
    bar._build();
    const html = bar.container.innerHTML;
    assert.equal((html.match(/class="ability-btn/g) || []).length, 8);
    assert.match(html, /data-slot-kind="active" data-index="0" data-key="1"/);
    assert.match(html, /data-slot-kind="equipment" data-slot="main_hand" data-key="Q"/);
    assert.match(html, /data-slot-kind="equipment" data-slot="relic" data-key="R"/);
  });

  it('fires exactly once on a sub-threshold release (equipment)', async () => {
    CONFIG.AUTOFIRE_HOLD_MS = 5000;
    const app = machineApp();
    const bar = new AbilityBar(app);
    const btn = fakeButton({ slotKind: 'equipment', slot: 'off_hand', index: '0', baseLabel: 'Off hand, key W' });
    bar._startSession(btn, 1, { pointerId: 1 });
    const session = bar.sessions.get(1);
    assert.equal(btn.classList.contains('ability-btn--charging'), true);
    bar._endSession(session, true);
    assert.equal(app.casts, 1);
    assert.equal(btn.classList.contains('ability-btn--active-fire'), false);
    bar.destroy();
  });

  it('crosses the threshold into a persistent armed state that survives release', async () => {
    CONFIG.AUTOFIRE_HOLD_MS = 30;
    CONFIG.AUTOFIRE_REPEAT_MS = 15;
    const app = machineApp();
    const bar = new AbilityBar(app);
    const btn = fakeButton({ slotKind: 'equipment', slot: 'off_hand', index: '0', baseLabel: 'Off hand, key W' });
    bar._startSession(btn, 2, { pointerId: 2 });
    await new Promise(r => setTimeout(r, 90));
    assert.ok(app.casts >= 2, `expected repeat casts, got ${app.casts}`);
    assert.equal(btn.classList.contains('ability-btn--active-fire'), true);
    assert.equal(bar.armed.has('off_hand'), true, 'slot armed at threshold');

    const castsAtRelease = app.casts;
    bar._endSession(bar.sessions.get(2), false);
    await new Promise(r => setTimeout(r, 60));
    assert.ok(app.casts > castsAtRelease, 'keeps firing after release');
    assert.equal(btn.classList.contains('ability-btn--active-fire'), true, 'ring persists after release');

    // Long-press the same slot again to disarm immediately.
    bar._startSession(btn, 6, { pointerId: 6 });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(bar.armed.has('off_hand'), false, 'second long-press disarms');
    assert.equal(btn.classList.contains('ability-btn--active-fire'), false);
    const castsAtDisarm = app.casts;
    bar._endSession(bar.sessions.get(6), false);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(app.casts, castsAtDisarm, 'no casts after disarm');
    bar.destroy();
  });

  it('routes a held active slot through handleGestureEvent once', async () => {
    CONFIG.AUTOFIRE_HOLD_MS = 25;
    const app = machineApp();
    app.player.action_bar[0] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable' };
    const bar = new AbilityBar(app);
    const btn = fakeButton({ slotKind: 'active', index: '0', slot: undefined, baseLabel: 'Active slot 1, key 1' });
    bar._startSession(btn, 3, { pointerId: 3 });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(app.casts, 1);
    assert.equal(btn.classList.contains('ability-btn--single-locked'), true);
    assert.equal(btn.classList.contains('ability-btn--active-fire'), false);
    bar._endSession(bar.sessions.get(3), false);
    bar.destroy();
  });

  it('routes a sub-threshold active tap through the GestureEngine path', () => {
    CONFIG.AUTOFIRE_HOLD_MS = 5000;
    const app = machineApp();
    app.player.action_bar[0] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable' };
    const bar = new AbilityBar(app);
    const btn = fakeButton({ slotKind: 'active', index: '0', slot: undefined, baseLabel: 'Active slot 1, key 1' });
    bar._startSession(btn, 4, { pointerId: 4 });
    bar._endSession(bar.sessions.get(4), true);
    assert.equal(app.casts, 1);
    bar.destroy();
  });

  it('forced stop disarms an armed slot when gameplay pauses', async () => {
    CONFIG.AUTOFIRE_HOLD_MS = 20;
    CONFIG.AUTOFIRE_REPEAT_MS = 10;
    const app = machineApp();
    const bar = new AbilityBar(app);
    const btn = fakeButton({ slotKind: 'equipment', slot: 'off_hand', index: '0', baseLabel: 'Off hand, key W' });
    bar._startSession(btn, 5, { pointerId: 5 });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(bar.armed.has('off_hand'), true, 'armed before pause');
    app.isPaused = true;
    await new Promise(r => setTimeout(r, 60));
    assert.equal(bar.armed.has('off_hand'), false, 'disarmed on pause');
    assert.equal(btn.classList.contains('ability-btn--active-fire'), false);
    bar._endSession(bar.sessions.get(5), false);
    bar.destroy();
    CONFIG.AUTOFIRE_HOLD_MS = originalHold;
    CONFIG.AUTOFIRE_REPEAT_MS = originalRepeat;
  });
});
