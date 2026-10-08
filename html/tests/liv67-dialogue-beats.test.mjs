import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DIALOGUE_ADVANCE_KEYS,
  resolveDialogueAdvanceKeys,
  isDialogueAdvanceKey,
  nextDialogueBeat,
  computeDialogueBubblePosition,
} from '../app/dialogue-bubble.js';
import { sceneControllerMethods } from '../app/scene-controller.js';
import { ModalManager } from '../app/modal-manager.js';
import { DIALOGUES_CATALOG } from '../data/index.js';

// LIV-67: NPC dialogue beats advance by keyboard or click/tap, and the panel
// renders as a speech bubble anchored above the speaker (flipping below at the
// top edge) without covering the NPC or hiding the field.

// --- Minimal fake DOM ------------------------------------------------------

class FakeEl {
  constructor() {
    this.innerHTML = '';
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this._listeners = {};
    this._q = new Map();
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
    };
  }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type, ev = {}) { (this._listeners[type] || []).forEach((fn) => fn(ev)); }
  getBoundingClientRect() { return { width: 360, height: 160, top: 0, left: 0 }; }

  querySelector(sel) {
    if (!this._q.has(sel)) this._q.set(sel, new FakeEl());
    return this._q.get(sel);
  }

  querySelectorAll() { return []; }
}

function installWindow() {
  const listeners = {};
  const win = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
  globalThis.window = win;
  return {
    fire: (type, ev) => (listeners[type] || []).slice().forEach((fn) => fn(ev)),
    restore: () => { delete globalThis.window; },
  };
}

function keyEvent(key, code = '') {
  return { key, code, preventDefault() {} };
}

// --- Pure geometry + beat math --------------------------------------------

test('LIV-67 dialogue beats', async (t) => {
  await t.test('advance keys are catalog-driven with a sane default', () => {
    const defaults = resolveDialogueAdvanceKeys();
    assert.ok(defaults.length > 0);
    assert.ok(defaults.includes('Enter'));
    assert.ok(defaults.includes(' '));
    assert.deepEqual(defaults, DEFAULT_DIALOGUE_ADVANCE_KEYS.slice());

    const catalog = DIALOGUES_CATALOG?.ui || {};
    const configured = resolveDialogueAdvanceKeys(catalog);
    assert.ok(configured.includes('Enter'), 'catalog lists Enter');
    assert.ok(configured.includes(' '), 'catalog lists Space');

    assert.deepEqual(resolveDialogueAdvanceKeys({ advanceKeys: [] }), DEFAULT_DIALOGUE_ADVANCE_KEYS.slice());
    assert.deepEqual(resolveDialogueAdvanceKeys({ advanceKeys: ['KeyZ'] }), ['KeyZ']);
  });

  await t.test('advance-key matching accepts event key or code, rejects others', () => {
    assert.equal(isDialogueAdvanceKey('Enter', DEFAULT_DIALOGUE_ADVANCE_KEYS), true);
    assert.equal(isDialogueAdvanceKey(' ', DEFAULT_DIALOGUE_ADVANCE_KEYS), true);
    assert.equal(isDialogueAdvanceKey('e', DEFAULT_DIALOGUE_ADVANCE_KEYS, 'KeyE'), true);
    assert.equal(isDialogueAdvanceKey('ArrowDown', DEFAULT_DIALOGUE_ADVANCE_KEYS), true);
    assert.equal(isDialogueAdvanceKey('z', DEFAULT_DIALOGUE_ADVANCE_KEYS, 'KeyZ'), false);
    assert.equal(isDialogueAdvanceKey(null, DEFAULT_DIALOGUE_ADVANCE_KEYS), false);
  });

  await t.test('nextDialogueBeat steps then clamps at the final beat', () => {
    assert.deepEqual(nextDialogueBeat(0, 3), { index: 1, advanced: true, atEnd: false });
    assert.deepEqual(nextDialogueBeat(1, 3), { index: 2, advanced: true, atEnd: false });
    assert.deepEqual(nextDialogueBeat(2, 3), { index: 2, advanced: false, atEnd: true });
    assert.deepEqual(nextDialogueBeat(9, 3), { index: 2, advanced: false, atEnd: true });
    assert.deepEqual(nextDialogueBeat(0, 1), { index: 0, advanced: false, atEnd: true });
    assert.deepEqual(nextDialogueBeat(0, 0), { index: 0, advanced: false, atEnd: true });
  });

  await t.test('bubble anchors above the speaker when there is room', () => {
    const pos = computeDialogueBubblePosition(
      { x: 600, top: 300, bottom: 364 },
      { width: 1200, height: 800 },
      { width: 360, height: 160 }
    );
    assert.equal(pos.placement, 'above');
    assert.equal(pos.top, 126);
    assert.equal(pos.left, 420);
    assert.equal(pos.width, 360);
    assert.equal(pos.arrowX, 180);
  });

  await t.test('bubble flips below a speaker near the top edge', () => {
    const pos = computeDialogueBubblePosition(
      { x: 600, top: 20, bottom: 84 },
      { width: 1200, height: 800 },
      { width: 360, height: 160 }
    );
    assert.equal(pos.placement, 'below');
    assert.equal(pos.top, 98);
  });

  await t.test('bubble clamps on-screen and keeps the arrow on the speaker', () => {
    const right = computeDialogueBubblePosition(
      { x: 1195, top: 300, bottom: 364 },
      { width: 1200, height: 800 },
      { width: 360, height: 160 }
    );
    assert.equal(right.left, 832);
    assert.equal(right.arrowX, 342);

    const left = computeDialogueBubblePosition(
      { x: 10, top: 300, bottom: 364 },
      { width: 1200, height: 800 },
      { width: 400, height: 160 }
    );
    assert.equal(left.left, 8);
    assert.equal(left.arrowX, 18);

    const narrow = computeDialogueBubblePosition(
      { x: 150, top: 300, bottom: 364 },
      { width: 300, height: 800 },
      { width: 400, height: 160 }
    );
    assert.equal(narrow.maxWidth, 284);
    assert.equal(narrow.width, 284);
  });

  await t.test('scene anchor maps the NPC tile through the camera and canvas', () => {
    const app = Object.assign({}, sceneControllerMethods, {
      npcs: [{ npcId: 'halden', x: 3, y: 4 }],
      renderer: { tileSize: 32, cameraX: 100, cameraY: 50 },
      canvas: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
    });
    assert.deepEqual(app.dialogueAnchorFor({ targetId: 'halden' }), {
      x: 22, top: 98, bottom: 130, height: 32,
    });
    assert.equal(app.dialogueAnchorFor({ targetId: 'ghost' }), null);
    assert.equal(app.dialogueAnchorFor({}), null);

    const headless = Object.assign({}, sceneControllerMethods, {
      npcs: [{ npcId: 'halden', x: 3, y: 4 }],
    });
    assert.equal(headless.dialogueAnchorFor({ targetId: 'halden' }), null);
  });

  await t.test('showDialogueModal anchors, advances by keyboard, and closes on the last beat', () => {
    const win = installWindow();
    try {
      const overlay = new FakeEl();
      const panel = overlay.querySelector('.dialogue-modal');
      const linesEl = overlay.querySelector('#dialogue-lines');
      const actionsEl = overlay.querySelector('#dialogue-actions');
      let closed = 0;

      ModalManager.showDialogueModal(overlay, {
        speaker: 'Captain Halden',
        lines: ['First beat.', 'Second beat.'],
        actions: [],
        labels: DIALOGUES_CATALOG.ui,
        anchor: { x: 600, top: 300, bottom: 364 },
        viewport: { width: 1200, height: 800 },
        onClose: () => { closed += 1; },
      });

      assert.ok(panel.classList.contains('dialogue-bubble'), 'bubble class applied');
      assert.ok(overlay.classList.contains('dialogue-active'), 'backdrop cleared');
      assert.equal(panel.dataset.placement, 'above');
      assert.equal(panel.style.top, '126px');
      assert.match(linesEl.innerHTML, /First beat\./);

      win.fire('keydown', keyEvent('Enter'));
      assert.match(linesEl.innerHTML, /Second beat\./, 'Enter advanced the beat');
      assert.equal(actionsEl.hidden, false, 'actions shown on the final beat');

      win.fire('keydown', keyEvent('Enter'));
      assert.equal(closed, 1, 'Enter on the final beat closes');
      assert.ok(overlay.classList.contains('hidden'), 'overlay hidden after close');
    } finally {
      win.restore();
    }
  });

  await t.test('showDialogueModal advances on click/tap but not past the final beat', () => {
    const win = installWindow();
    try {
      const overlay = new FakeEl();
      const panel = overlay.querySelector('.dialogue-modal');
      const linesEl = overlay.querySelector('#dialogue-lines');
      let closed = 0;

      ModalManager.showDialogueModal(overlay, {
        lines: ['one', 'two', 'three'],
        anchor: { x: 600, top: 300, bottom: 364 },
        viewport: { width: 1200, height: 800 },
        onClose: () => { closed += 1; },
      });

      const tap = () => panel.dispatch('click', { target: { closest: () => null } });
      tap();
      assert.match(linesEl.innerHTML, /two/);
      tap();
      assert.match(linesEl.innerHTML, /three/);
      tap();
      assert.match(linesEl.innerHTML, /three/, 'click is a no-op on the final beat');
      assert.equal(closed, 0, 'pointer does not auto-resolve the stage');
    } finally {
      win.restore();
    }
  });

  await t.test('an unanchored dialogue still renders a centered panel', () => {
    const win = installWindow();
    try {
      const overlay = new FakeEl();
      const panel = overlay.querySelector('.dialogue-modal');
      ModalManager.showDialogueModal(overlay, {
        lines: ['Tide Gate speaks.'],
        labels: DIALOGUES_CATALOG.ui,
      });
      assert.equal(panel.classList.contains('dialogue-bubble'), false);
      assert.equal(overlay.classList.contains('dialogue-active'), false);
    } finally {
      win.restore();
    }
  });
});
