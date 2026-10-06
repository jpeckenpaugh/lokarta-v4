/**
 * Android long-press on an ability button must not open the native
 * image/context menu; the hold must reach the existing autofire state machine.
 *
 * These tests cover the wiring that is unit-testable without a browser:
 *  - `HUDManager.renderItemIcon` emits a non-draggable <img>
 *  - the ability bar's scoped `contextmenu` guard calls `preventDefault()` only
 *    when the event target is inside a `.ability-btn`
 *  - the ability-bar stylesheet scopes pointer/touch-callout suppression to the
 *    button and its icon, leaving global context menus untouched
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { HUDManager } from '../app/hud-manager.js';
import { AbilityBar } from '../app/ability-bar.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_CSS = readFileSync(resolve(HERE, '../styles/base.css'), 'utf8');

describe('Non-draggable item icons', () => {
  it('marks the emitted openmoji <img> draggable="false"', () => {
    const html = HUDManager.renderItemIcon({ item_id: 'health_potion', name: 'Health Potion' });
    assert.match(html, /<img class="openmoji-icon"[^>]* draggable="false"/);
  });

  it('keeps draggable="false" for catalog svgCode and fallback icons', () => {
    assert.match(HUDManager.renderItemIcon({ svgCode: '2694', name: 'Swords' }), /draggable="false"/);
    assert.match(HUDManager.renderItemIcon({ name: 'Mystery' }), /draggable="false"/);
  });
});

// Minimal event-target shim: only `closest` is read by the guard.
function fakeTarget(btn) {
  return { closest: selector => (selector === '.ability-btn' ? btn : null) };
}

function fakeButton() {
  return { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
}

function fakeContainer() {
  const listeners = new Map();
  return {
    innerHTML: '',
    style: { setProperty() {} },
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    dispatch(type, event) { (listeners.get(type) || []).forEach(fn => fn(event)); },
    listeners,
  };
}

function makeApp() {
  return {
    player: { action_bar: [], paperdoll: {}, cooldowns: {} },
    monsters: [],
    gridMap: null,
    isInGameplay: true,
    isPaused: false,
    isGameOver: false,
    isFloorCleared: false,
    transition: { isLocked: () => false },
  };
}

describe('Scoped contextmenu guard', () => {
  it('prevents the context menu for events inside an ability button', () => {
    const bar = new AbilityBar(makeApp());
    bar.container = fakeContainer();
    bar._bind();
    const event = { target: fakeTarget(fakeButton()), preventDefaultCalls: 0, preventDefault() { this.preventDefaultCalls += 1; } };
    bar.container.dispatch('contextmenu', event);
    assert.equal(event.preventDefaultCalls, 1);
  });

  it('does not swallow context menus outside the ability bar', () => {
    const bar = new AbilityBar(makeApp());
    bar.container = fakeContainer();
    bar._bind();
    const event = { target: fakeTarget(null), preventDefaultCalls: 0, preventDefault() { this.preventDefaultCalls += 1; } };
    bar.container.dispatch('contextmenu', event);
    assert.equal(event.preventDefaultCalls, 0);
  });

  it('tolerates a target without closest()', () => {
    const bar = new AbilityBar(makeApp());
    bar.container = fakeContainer();
    bar._bind();
    const event = { target: {}, preventDefaultCalls: 0, preventDefault() { this.preventDefaultCalls += 1; } };
    assert.doesNotThrow(() => bar.container.dispatch('contextmenu', event));
    assert.equal(event.preventDefaultCalls, 0);
  });
});

describe('Ability-bar style scoping', () => {
  it('suppresses pointer targeting on the button icon and descendants', () => {
    assert.match(BASE_CSS, /\.ability-btn \.ability-icon[\s\S]*?pointer-events: none/);
    assert.match(BASE_CSS, /\.ability-btn \.openmoji-icon[\s\S]*?pointer-events: none/);
  });

  it('applies -webkit-touch-callout: none to the button and its descendants', () => {
    assert.match(BASE_CSS, /\.ability-btn \{[\s\S]*?-webkit-touch-callout: none/);
    assert.match(BASE_CSS, /\.ability-btn \.ability-icon[\s\S]*?-webkit-touch-callout: none/);
  });
});
