import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { UI_CATALOG, SOUNDS_CATALOG } from '../data/index.js';
import {
  slotId,
  slotFloorKey,
  deriveSlotMeta,
  summarizeSlot,
  formatPlaytime,
  normalizeOptions,
  resolveReducedMotion,
  planLegacyMigration,
  emptySlotRecord,
  classifySlot,
  isSlotRecordValid,
  slotSummary,
  firstNewGameSlotIndex,
  newGameActionLabel,
  SAVE_SLOT_COUNT,
} from '../services/save-slots.js';
import { ModalManager } from '../app/modal-manager.js';
import { InputController } from '../app/input-controller.js';

test('Lokarta Packaging (splash, title, options, save slots, transitions)', async (t) => {
  await t.test('ui.json catalog is complete and well-formed', () => {
    assert.ok(UI_CATALOG.splash, 'ui.json must define splash timings');
    assert.ok(UI_CATALOG.transitions, 'ui.json must define transitions');
    assert.ok(UI_CATALOG.titleAmbient, 'ui.json must define titleAmbient');
    assert.ok(UI_CATALOG.saveSlots, 'ui.json must define saveSlots');
    assert.ok(UI_CATALOG.options, 'ui.json must define options');
    assert.equal(UI_CATALOG.saveSlots.count, 5);
    assert.equal(SAVE_SLOT_COUNT, 5);

    for (const kind of ['splashToTitle', 'titleToSelect', 'selectToGame', 'floorAdvance', 'gameOverToRetry', 'toTitle']) {
      assert.ok(UI_CATALOG.transitions[kind], `Missing transition ${kind}`);
      assert.ok(UI_CATALOG.transitions[kind].ms > 0, `Transition ${kind} must have a positive duration`);
    }

    assert.deepEqual(UI_CATALOG.options.defaults, {
      soundEffects: true,
      sfxVolume: 70,
      reduceMotion: 'system',
      uiScale: 'normal',
      pixelScale: 'auto',
      fullscreen: false,
      damageNumbers: true,
      showFps: false,
      colorBlindMode: 'none',
      dialogueTextScale: 'normal',
      walkThruWalls: false,
      testerStrength: false,
    });
  });

  await t.test('sounds.json has 40 entries including uiMove, uiBack and ambient beds', () => {
    const soundsPath = resolve(process.cwd(), 'html/data/sounds.json');
    const soundsJson = JSON.parse(readFileSync(soundsPath, 'utf8'));

    assert.equal(Object.keys(soundsJson).length, 40);
    assert.equal(Object.keys(SOUNDS_CATALOG).length, 40);
    for (const key of ['uiMove', 'uiBack', 'keyJangle', 'coins', 'koHandoff', 'controlSwap']) {
      assert.ok(soundsJson[key], `Missing sound definition for ${key}`);
      assert.ok(['sweep', 'sequence', 'composite'].includes(soundsJson[key].type), `Invalid sound type for ${key}`);
    }
    for (const key of ['amb_island_surf', 'amb_town_day', 'amb_dungeon']) {
      assert.equal(soundsJson[key].kind, 'ambient', `${key} must be an ambient bed`);
    }
  });

  await t.test('pure save-slot helpers', () => {
    assert.equal(slotId(3), 'slot_3');
    assert.deepEqual(slotFloorKey(3, 7), [3, 7]);

    const player = {
      id: 'char_slot_3',
      vocation: 'magician',
      level: 4,
      current_floor: 3,
      hp: 30,
      max_hp: 60,
      mana: 40,
      max_mana: 150,
      x: 5,
      y: 6,
      xp: 120,
      playtimeMs: 5_040_000,
    };
    const meta = deriveSlotMeta(player, 3);
    assert.equal(meta.id, 'slot_3');
    assert.equal(meta.slotIndex, 3);
    assert.equal(meta.status, 'occupied');
    assert.equal(meta.characterId, 'char_slot_3');
    assert.equal(summarizeSlot(meta), 'MAGICIAN — Level 4, Floor 3');
    assert.equal(meta.floorEntry.hp, 30);

    assert.equal(formatPlaytime(0), 'New');
    assert.equal(formatPlaytime(59_000), 'New');
    assert.equal(formatPlaytime(5_040_000), '1h 24m');
  });

  await t.test('normalizeOptions clamps, drops unknowns, and fills defaults', () => {
    const normalized = normalizeOptions({ sfxVolume: 999, reduceMotion: 'wat', bogus: 1 });
    assert.equal(normalized.sfxVolume, 100);
    assert.equal(normalized.reduceMotion, 'system');
    assert.equal(normalized.bogus, undefined);
    assert.deepEqual(normalized, { ...UI_CATALOG.options.defaults, sfxVolume: 100 });

    const negative = normalizeOptions({ sfxVolume: -50, uiScale: 'gigantic', pixelScale: '3x' });
    assert.equal(negative.sfxVolume, 0);
    assert.equal(negative.uiScale, 'normal');
    assert.equal(negative.pixelScale, '3x');
  });

  await t.test('resolveReducedMotion honors on/off/system', () => {
    assert.equal(resolveReducedMotion('on', false), true);
    assert.equal(resolveReducedMotion('off', true), false);
    assert.equal(resolveReducedMotion('system', true), true);
    assert.equal(resolveReducedMotion('system', false), false);
  });

  await t.test('planLegacyMigration is non-destructive and idempotent', () => {
    const characters = [
      { id: 'char_old', vocation: 'archer', level: 2, current_floor: 4, updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2025-12-31T00:00:00.000Z' },
      { id: 'char_new', vocation: 'fighter', level: 5, current_floor: 8, updatedAt: '2026-02-01T00:00:00.000Z', createdAt: '2026-01-15T00:00:00.000Z' },
    ];
    const floors = [
      { floor_number: 7, template_version: 2 },
      { floor_number: 8, template_version: 2 },
    ];

    const plan = planLegacyMigration(characters, floors, null);
    assert.equal(plan.alreadyDone, false);
    assert.ok(plan.guard && plan.guard.done);
    assert.equal(plan.guard.fromCharacterId, 'char_new');
    assert.equal(plan.slot.id, 'slot_1');
    assert.equal(plan.slot.slotIndex, 1);
    assert.equal(plan.character.slotId, 'slot_1');
    assert.equal(plan.character.slotIndex, 1);
    assert.equal(plan.character.id, 'char_new');
    // E6: pre-tower floor caches are dropped, not copied — they are stale and
    // may point past level 5.
    assert.deepEqual(plan.floors, []);
    // E6: the migrated character is clamped onto the 5-level tower.
    assert.equal(plan.character.current_floor, 5);
    assert.equal(plan.slot.currentFloor, 5);

    // Empty legacy data writes only the guard.
    const emptyPlan = planLegacyMigration([], [], null);
    assert.equal(emptyPlan.character, null);
    assert.equal(emptyPlan.slot, null);
    assert.deepEqual(emptyPlan.floors, []);
    assert.ok(emptyPlan.guard && emptyPlan.guard.done);

    // A present guard makes reruns a no-op.
    const rerun = planLegacyMigration(characters, floors, { done: true });
    assert.equal(rerun.alreadyDone, true);
    assert.equal(rerun.guard, null);
    assert.equal(rerun.slot, null);
    assert.equal(rerun.character, null);
    assert.deepEqual(rerun.floors, []);
  });

  await t.test('classifySlot flags corrupt/unknown records as unavailable (D4)', () => {
    const occupied = deriveSlotMeta(
      {
        id: 'char_slot_2',
        vocation: 'archer',
        level: 3,
        current_floor: 4,
        hp: 10,
        max_hp: 40,
        mana: 5,
        max_mana: 40,
        x: 1,
        y: 1,
        xp: 0,
        action_bar: [],
        backpack: [],
        paperdoll: {},
        skillBoosts: {},
      },
      2
    );

    assert.equal(classifySlot(emptySlotRecord(2)), 'empty');
    assert.equal(classifySlot(occupied), 'occupied');
    assert.equal(classifySlot(null), 'unavailable');

    // Malformed/unknown records must not masquerade as empty or UNKNOWN slots.
    assert.equal(classifySlot({ ...occupied, vocation: null }), 'unavailable');
    assert.equal(classifySlot({ ...occupied, level: undefined }), 'unavailable');
    assert.equal(classifySlot({ ...occupied, currentFloor: 'nope' }), 'unavailable');
    assert.equal(classifySlot({ ...occupied, characterId: null }), 'unavailable');
    assert.equal(classifySlot({ ...occupied, floorEntry: null }), 'unavailable');
    assert.equal(classifySlot({ ...occupied, status: 'weird' }), 'unavailable');
    assert.equal(classifySlot({ ...occupied, slotIndex: 0 }), 'unavailable');

    assert.equal(isSlotRecordValid(occupied), true);
    assert.equal(isSlotRecordValid({ ...occupied, characterId: null }), false);
    assert.equal(slotSummary(occupied), 'ARCHER — Level 3, Floor 4');
    assert.equal(slotSummary({ ...occupied, vocation: null }), 'DATA UNAVAILABLE');
  });

  await t.test('firstNewGameSlotIndex defaults New Game to the first loadable empty slot', () => {
    const occupiedAt = (slotIndex, overrides = {}) =>
      deriveSlotMeta(
        {
          id: `char_slot_${slotIndex}`,
          vocation: 'magician',
          level: 1,
          current_floor: 1,
          hp: 60,
          max_hp: 60,
          mana: 150,
          max_mana: 150,
          x: 2,
          y: 2,
          xp: 0,
          ...overrides,
        },
        slotIndex
      );

    // Fresh profile: Slot 1 wins.
    assert.equal(firstNewGameSlotIndex([1, 2, 3, 4, 5].map(emptySlotRecord)), 1);

    // Slot 1 occupied: the first *empty* slot is the default, not the occupied one.
    assert.equal(
      firstNewGameSlotIndex([occupiedAt(1), emptySlotRecord(2), emptySlotRecord(3)]),
      2
    );

    // A corrupt record is never defaulted into; skip it for the next empty slot.
    const corrupt = { ...occupiedAt(3), id: 'slot_2', slotIndex: 2, vocation: null };
    assert.equal(
      firstNewGameSlotIndex([occupiedAt(1), corrupt, emptySlotRecord(3)]),
      3
    );

    // Every slot occupied: fall back to the first occupied slot so the player
    // can still reach the one-step OVERWRITE path.
    assert.equal(firstNewGameSlotIndex([occupiedAt(1), occupiedAt(2)]), 1);

    // Nothing selectable (all corrupt/unknown) is a real dead end; the UI must
    // not fabricate a default.
    assert.equal(firstNewGameSlotIndex([corrupt]), null);
    assert.equal(firstNewGameSlotIndex([]), null);
    assert.equal(firstNewGameSlotIndex(null), null);

    assert.equal(newGameActionLabel(1), 'SLOT 1 — NEW GAME');
    assert.equal(newGameActionLabel(4), 'SLOT 4 — NEW GAME');
    assert.equal(newGameActionLabel(null), 'NEW GAME');
  });

  await t.test('create-mode slot screen marks the default New Game action and focuses it', () => {
    const listeners = new Set();
    const originalWindow = globalThis.window;
    globalThis.window = {
      addEventListener: (type, fn) => {
        if (type === 'keydown') listeners.add(fn);
      },
      removeEventListener: (type, fn) => {
        if (type === 'keydown') listeners.delete(fn);
      },
    };
    try {
      let html = '';
      const focused = [];
      // Minimal element stub: buttons carry a dataset + focus() recorder.
      const makeElement = (dataset) => ({
        dataset: dataset || {},
        disabled: false,
        focus() { focused.push(dataset); },
        addEventListener() {},
      });
      const slotButtons = [
        makeElement({ action: 'new', slot: '1', defaultNew: 'true' }),
        makeElement({ action: 'new', slot: '2' }),
        makeElement({ action: 'new', slot: '3' }),
      ];
      const buttonByAction = new Map(slotButtons.map(b => [b.dataset.slot, b]));
      const makeOverlay = () => ({
        _keyHandler: null,
        classList: { add() {}, remove() {}, contains() { return false; } },
        get innerHTML() { return html; },
        set innerHTML(value) { html = value; },
        ownerDocument: { activeElement: slotButtons[0] },
        querySelector: selector => (selector === '[data-default-new="true"]' ? slotButtons[0] : makeElement()),
        querySelectorAll: selector => {
          if (selector === '[data-action]') return slotButtons;
          if (selector.startsWith('.slot-card.empty')) return slotButtons;
          return [];
        },
      });

      ModalManager.showSlotSelectModal(
        makeOverlay(),
        { slots: [emptySlotRecord(1), emptySlotRecord(2), emptySlotRecord(3)], mode: 'create' },
        {}
      );

      // The default card + button are marked, and only the default gets the
      // primary/autofocus treatment; the label names the concrete slot.
      assert.ok(
        html.includes('slot-card empty selected" data-slot="1" data-default-new="true"'),
        'first empty card is selected and marked as the New Game default'
      );
      assert.equal((html.match(/data-default-new="true"/g) || []).length, 2, 'card + button carry the default marker');
      assert.ok(html.includes('slot-new-btn primary'), 'default New Game button uses the primary style');
      assert.ok(html.includes('autofocus'), 'default New Game button is the autofocus target');
      assert.ok(html.includes('SLOT 1 — NEW GAME'), 'default button names the concrete slot');
      assert.equal((html.match(/EMPTY — NEW GAME/g) || []).length, 2, 'non-default empty slots keep the generic label');
      assert.deepEqual(focused, [{ action: 'new', slot: '1', defaultNew: 'true' }], 'focus lands on the default action');

      // Load mode must not invent a default; empty slots stay disabled.
      ModalManager.showSlotSelectModal(
        makeOverlay(),
        { slots: [emptySlotRecord(1), emptySlotRecord(2)], mode: 'load' },
        {}
      );
      assert.equal((html.match(/data-default-new="true"/g) || []).length, 0, 'load mode has no New Game default');
      assert.equal((html.match(/disabled/g) || []).length, 2, 'load-mode empty slots remain disabled');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  await t.test('corrupt slot row renders DATA UNAVAILABLE composition with DELETE only (D4)', () => {
    let html = '';
    // The slot renderer now installs a modal-scoped keydown handler,
    // so the overlay stub supplies a minimal window the same way the other
    // modal tests do.
    const listeners = new Set();
    const originalWindow = globalThis.window;
    globalThis.window = {
      addEventListener: (type, fn) => {
        if (type === 'keydown') listeners.add(fn);
      },
      removeEventListener: (type, fn) => {
        if (type === 'keydown') listeners.delete(fn);
      },
    };
    const makeOverlay = () => ({
      _keyHandler: null,
      classList: { add() {}, remove() {}, contains() { return false; } },
      get innerHTML() { return html; },
      set innerHTML(value) { html = value; },
      querySelector: () => ({ addEventListener() {}, focus() {} }),
      querySelectorAll: () => [],
    });

    const occupied = deriveSlotMeta(
      {
        id: 'char_slot_1',
        vocation: 'archer',
        level: 3,
        current_floor: 4,
        hp: 10,
        max_hp: 40,
        mana: 5,
        max_mana: 40,
        x: 1,
        y: 1,
        xp: 0,
        action_bar: [],
        backpack: [],
        paperdoll: {},
        skillBoosts: {},
      },
      1
    );
    // Malformed occupied record (missing vocation) and an unknown status value
    // must both render as DATA UNAVAILABLE, never as a fake slot.
    const malformed = { ...occupied, id: 'slot_2', slotIndex: 2, characterId: 'char_slot_2', vocation: null };
    const unknownStatus = { ...emptySlotRecord(3), status: 'mystery' };
    const empty = emptySlotRecord(4);

    ModalManager.showSlotSelectModal(
      makeOverlay(),
      { slots: [occupied, malformed, unknownStatus, empty], mode: 'manage' },
      {}
    );

    assert.equal((html.match(/slot-card corrupt/g) || []).length, 2, 'malformed + unknown status rows are corrupt');
    assert.equal((html.match(/slot-card occupied/g) || []).length, 1, 'valid occupied row still renders');
    assert.equal((html.match(/slot-card empty/g) || []).length, 1, 'unused slot still renders empty');

    const segments = html.split('<div class="slot-card').slice(1);
    const corrupt = segments.filter(s => s.startsWith(' corrupt"'));
    assert.equal(corrupt.length, 2);

    for (const [segment, slotIndex] of [[corrupt[0], 2], [corrupt[1], 3]]) {
      assert.ok(
        segment.includes(`<div class="slot-badge">SLOT ${slotIndex}</div>`),
        `SLOT ${slotIndex} badge is its own mono element like every other row`
      );
      assert.ok(
        segment.includes('<div class="slot-title"><strong>DATA UNAVAILABLE</strong></div>'),
        'title reads DATA UNAVAILABLE, never a fabricated vocation/level'
      );
      assert.ok(
        segment.includes('This save record is unreadable. Delete it to reuse the slot.'),
        'subcopy present'
      );
      assert.equal((segment.match(/data-action="delete"/g) || []).length, 1, 'exactly one DELETE action');
      assert.equal((segment.match(/data-action="load"/g) || []).length, 0, 'no LOAD action on a corrupt row');
      assert.equal((segment.match(/data-action="overwrite"/g) || []).length, 0, 'no OVERWRITE action on a corrupt row');
      assert.ok(!/UNKNOWN|Level \d|Floor \d/.test(segment), 'corrupt row fabricates no vocation/level/floor');
    }

    globalThis.window = originalWindow;
  });

  await t.test('every literal OpenMoji asset referenced by app code exists (D2)', () => {
    const appDir = resolve(process.cwd(), 'html', 'app');
    const missing = [];
    for (const file of readdirSync(appDir).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(resolve(appDir, file), 'utf8');
      for (const match of src.matchAll(/assets\/openmoji\/([0-9A-Fa-f]+)\.svg/g)) {
        const asset = resolve(process.cwd(), 'html', 'assets', 'openmoji', `${match[1]}.svg`);
        if (!existsSync(asset)) missing.push(`${file}: ${match[1]}.svg`);
      }
    }
    assert.deepEqual(missing, [], `missing OpenMoji assets: ${missing.join(', ')}`);
    assert.ok(existsSync(resolve(process.cwd(), 'html', 'assets', 'openmoji', '2699.svg')), '2699.svg (OPTIONS gear) present');
  });

  await t.test('every svgCode referenced by data catalogs and the emoji map exists', () => {
    const openmojiDir = resolve(process.cwd(), 'html', 'assets', 'openmoji');
    const dataDir = resolve(process.cwd(), 'html', 'data');
    const referenced = new Map();
    for (const file of readdirSync(dataDir).filter((f) => f.endsWith('.json'))) {
      const src = readFileSync(resolve(dataDir, file), 'utf8');
      for (const match of src.matchAll(/"svgCode"\s*:\s*"([0-9A-Fa-f]+)"/g)) {
        referenced.set(match[1], `${file}: svgCode ${match[1]}`);
      }
    }
    const hud = readFileSync(resolve(process.cwd(), 'html', 'app', 'hud-manager.js'), 'utf8');
    for (const match of hud.matchAll(/'([0-9A-Fa-f]{3,})'\s*:\s*'[0-9A-Fa-f]{3,}'/g)) {
      referenced.set(match[1], `hud-manager.js EMOJI_TO_SVG_MAP ${match[1]}`);
    }
    const missing = [];
    for (const [code, origin] of referenced) {
      if (!existsSync(resolve(openmojiDir, `${code}.svg`))) missing.push(`${origin} -> ${code}.svg`);
    }
    assert.deepEqual(missing, [], `missing OpenMoji assets: ${missing.join(', ')}`);
    // The per-level gate keys must resolve to real icons.
    for (const code of ['1F511', '1F5DD']) {
      assert.ok(existsSync(resolve(openmojiDir, `${code}.svg`)), `key icon ${code}.svg present`);
    }
  });

  await t.test('every sprite manifest entry points at a committed asset file', () => {
    const spritesDir = resolve(process.cwd(), 'html', 'assets', 'sprites');
    const manifest = JSON.parse(readFileSync(resolve(spritesDir, 'manifest.json'), 'utf8'));
    const missing = [];
    for (const [group, entries] of Object.entries(manifest)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const [id, meta] of Object.entries(entries)) {
        if (!meta || typeof meta.file !== 'string') continue;
        if (!existsSync(resolve(spritesDir, meta.file))) missing.push(`${group}/${id} -> ${meta.file}`);
      }
    }
    assert.deepEqual(missing, [], `missing sprite assets: ${missing.join(', ')}`);
    // D4 furniture/decor entries ship a single static `idle` frame.
    for (const [id, meta] of Object.entries(manifest.props)) {
      if (meta.class === undefined) continue;
      assert.ok(Array.isArray(meta.frames) && meta.frames.includes('idle'), `${id} must declare an idle frame`);
    }
  });

  await t.test('pause modal keeps at most one window Escape handler (D1)', () => {
    const listeners = new Set();
    const fakeWindow = {
      addEventListener: (type, fn) => {
        if (type === 'keydown') listeners.add(fn);
      },
      removeEventListener: (type, fn) => {
        if (type === 'keydown') listeners.delete(fn);
      },
    };
    const makeOverlay = () => ({
      _keyHandler: null,
      classList: { add() {}, remove() {}, contains() { return false; } },
      innerHTML: '',
      querySelector: () => ({ addEventListener() {} }),
      querySelectorAll: () => [],
    });
    const dispatchEscape = () => {
      const event = { key: 'Escape', preventDefault() {} };
      for (const fn of [...listeners]) fn(event);
    };

    const originalWindow = globalThis.window;
    globalThis.window = fakeWindow;
    try {
      const overlay = makeOverlay();
      let resumes = 0;

      ModalManager.showPauseModal(overlay, { onResume: () => { resumes += 1; } });
      assert.equal(listeners.size, 1, 'pause modal registers exactly one keydown handler');

      // A re-render must replace, never stack, handlers.
      ModalManager.showPauseModal(overlay, { onResume: () => {} });
      assert.equal(listeners.size, 1, 're-render replaces the stale pause handler');

      // Navigating away via the mouse (RETURN TO TITLE -> title render) must
      // clear the pause handler so a later Escape cannot resume/close it.
      ModalManager.showTitleScreen(overlay, { slots: [], hasSaves: false }, {});
      assert.equal(listeners.size, 1, 'title render replaced the pause handler');
      dispatchEscape();
      assert.equal(resumes, 0, 'title Escape is a no-op (no stale pause resume)');

      // Escape while paused resumes exactly once and removes its own handler.
      ModalManager.showPauseModal(overlay, { onResume: () => { resumes += 1; } });
      dispatchEscape();
      assert.equal(resumes, 1, 'pause Escape resumes exactly once');
      assert.equal(listeners.size, 0, 'pause handler removed itself after Escape');
      dispatchEscape();
      assert.equal(resumes, 1, 'no lingering handler after resume');

      // Programmatic close must also clear the handler.
      ModalManager.showPauseModal(overlay, { onResume: () => { resumes += 1; } });
      ModalManager._close(overlay);
      assert.equal(listeners.size, 0, 'closing the modal clears its handler');
      dispatchEscape();
      assert.equal(resumes, 1, 'closed modal leaves no stale resume');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  await t.test('destructive confirm focuses CANCEL, load-error keeps OK (O1)', () => {
    const listeners = new Set();
    const originalWindow = globalThis.window;
    globalThis.window = {
      addEventListener: (type, fn) => {
        if (type === 'keydown') listeners.add(fn);
      },
      removeEventListener: (type, fn) => {
        if (type === 'keydown') listeners.delete(fn);
      },
    };

    const focused = [];
    const makeOverlay = () => ({
      _keyHandler: null,
      classList: { add() {}, remove() {}, contains() { return false; } },
      innerHTML: '',
      querySelector: selector => ({
        addEventListener() {},
        focus() { focused.push(selector); },
      }),
      querySelectorAll: () => [],
    });

    try {
      // DELETE SLOT / OVERWRITE SLOT pass danger: true.
      focused.length = 0;
      ModalManager.showConfirmModal(makeOverlay(), {
        title: 'DELETE SLOT 1?',
        body: 'This permanently deletes MAGICIAN — Level 4, Floor 3. This cannot be undone.',
        confirmLabel: 'DELETE',
        danger: true,
        onConfirm() {},
        onCancel() {},
      });
      assert.deepEqual(focused, ['#confirm-cancel'], 'danger confirm defaults focus to CANCEL');

      // RESET OPTIONS is destructive to saved preferences too (spec §3.2).
      focused.length = 0;
      ModalManager.showConfirmModal(makeOverlay(), {
        title: 'RESET OPTIONS?',
        body: 'All options return to their default values. Save slots are not affected.',
        confirmLabel: 'RESET',
        danger: true,
        onConfirm() {},
        onCancel() {},
      });
      assert.deepEqual(focused, ['#confirm-cancel'], 'RESET OPTIONS focuses CANCEL');

      // The non-destructive load-error OK/BACK dialog keeps its primary focus.
      focused.length = 0;
      ModalManager.showConfirmModal(makeOverlay(), {
        title: 'COULD NOT LOAD SLOT 1',
        body: 'Could not load Slot 1. Try again.',
        confirmLabel: 'OK',
        cancelLabel: 'BACK',
        onConfirm() {},
        onCancel() {},
      });
      assert.deepEqual(focused, ['#confirm-ok'], 'non-destructive dialog keeps OK focus');

      // Escape cancels the destructive confirm and never confirms it.
      let confirmed = 0;
      let cancelled = 0;
      ModalManager.showConfirmModal(makeOverlay(), {
        title: 'DELETE SLOT 1?',
        danger: true,
        onConfirm: () => { confirmed += 1; },
        onCancel: () => { cancelled += 1; },
      });
      const escape = { key: 'Escape', preventDefault() {} };
      for (const fn of [...listeners]) fn(escape);
      assert.equal(confirmed, 0, 'Escape never confirms a destructive dialog');
      assert.equal(cancelled, 1, 'Escape cancels the destructive dialog exactly once');
      assert.equal(listeners.size, 0, 'Escape removes its own handler');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  await t.test('InputController only opens pause from unpaused gameplay (D1)', () => {
    const listeners = new Set();
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    globalThis.window = {
      addEventListener: (type, fn) => {
        if (type === 'keydown') listeners.add(fn);
      },
      removeEventListener: (type, fn) => {
        if (type === 'keydown') listeners.delete(fn);
      },
    };
    globalThis.document = { querySelectorAll: () => [] };
    try {
      let opens = 0;
      const app = {
        isInGameplay: true,
        isGameOver: false,
        isPaused: false,
        transition: null,
        keysDown: new Set(),
        canvas: null,
        openPauseMenu: () => { opens += 1; },
      };
      new InputController(app).bindInputs();
      const dispatchEscape = () => {
        const event = { code: 'Escape', key: 'Escape', preventDefault() {} };
        for (const fn of [...listeners]) fn(event);
      };

      dispatchEscape();
      assert.equal(opens, 1, 'Escape opens pause from gameplay');

      app.isPaused = true;
      dispatchEscape();
      assert.equal(opens, 1, 'Escape does not re-open the pause menu while paused');

      app.isPaused = false;
      app.isInGameplay = false;
      dispatchEscape();
      assert.equal(opens, 1, 'Escape on the title screen is a no-op');
    } finally {
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
    }
  });

  await t.test('global :focus-visible ring is token-only', () => {
    const css = readFileSync(resolve(process.cwd(), 'html/styles/base.css'), 'utf8');
    for (const token of ['--focus-ring-color', '--focus-ring-width', '--focus-ring-offset']) {
      assert.match(css, new RegExp(`${token}\\s*:`), `${token} defined in the token layer`);
    }
    const rule = css.match(/:focus-visible[^{]*\{[^}]*\}/);
    assert.ok(rule, 'a :focus-visible rule exists');
    assert.match(rule[0], /var\(--focus-ring-color\)/);
    assert.match(rule[0], /var\(--focus-ring-width\)/);
    assert.match(rule[0], /var\(--focus-ring-offset\)/);
    assert.doesNotMatch(rule[0], /#[0-9a-fA-F]{3,8}\b/, 'component rule uses no raw hex');
  });
});
