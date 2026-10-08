import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteRenderer, sceneTheme, themeForFloor, grassShadeIndex } from '../app/sprite-renderer.js';
import { EconomySystem, createPlayer } from '../engine/index.js';
import { LokartaApp } from '../app/app-controller.js';
import { ECONOMY_CATALOG, getTownDefinition, DEFAULT_TOWN_ID } from '../data/index.js';

// LIV-74: (1) natural low-frequency grass variation for the town/tower
// exterior, matching the island; (2) healing fountains that ramp while the
// player stands in them.

function makeFillCapturingCtx() {
  const fills = [];
  const ctx = {
    fills,
    _fill: '#000',
    canvas: { width: 256, height: 256 },
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {},
    fill() {}, stroke() {}, strokeRect() {}, drawImage() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect(x, y, w, h) { fills.push({ style: this._fill, x, y, w, h }); },
  };
  Object.defineProperty(ctx, 'fillStyle', { get() { return ctx._fill; }, set(v) { ctx._fill = v; } });
  Object.defineProperty(ctx, 'strokeStyle', { get() { return '#000'; }, set() {} });
  Object.defineProperty(ctx, 'lineWidth', { get() { return 1; }, set() {} });
  return ctx;
}

/** The backdrop's full-tile ground fill for a tile, or null. */
function groundFill(theme, x, y) {
  const ctx = makeFillCapturingCtx();
  SpriteRenderer.drawOutside(ctx, 0, 0, 32, x, y, theme);
  const g = ctx.fills.find((f) => f.w === 32 && f.h === 32);
  return g ? g.style : null;
}

/** Grid of ground fills for a theme. */
function groundGrid(theme, w, h, originX = 0, originY = 0) {
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out.push(groundFill(theme, originX + x, originY + y));
  }
  return out;
}

function assertNoCheckerboard(styles, w, h) {
  assert.ok(styles.every(Boolean), 'every off-map tile paints a ground fill');
  let equal = 0;
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const a = styles[y * w + x];
      const b = styles[y * w + x + 1];
      total++;
      if (a === b) equal++;
    }
  }
  assert.ok(equal / total > 0.5, `expected rolling shades, got ${(equal / total).toFixed(3)} equal neighbours`);

  // A parity checkerboard would make every even-parity tile share one shade.
  const even = new Set();
  const odd = new Set();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ((x + y) % 2 === 0 ? even : odd).add(styles[y * w + x]);
    }
  }
  assert.ok(even.size >= 2, 'even-parity tiles must not share one shade');
  assert.ok(odd.size >= 2, 'odd-parity tiles must not share one shade');
}

test('LIV-74 town/tower exterior grass uses the low-frequency field', async (t) => {
  const town = sceneTheme(getTownDefinition(DEFAULT_TOWN_ID).theme);
  const tower = themeForFloor(1);

  await t.test('town authors a distinct >=4 grass ramp', () => {
    const ramp = town.outside && town.outside.grass;
    assert.ok(Array.isArray(ramp) && ramp.length >= 4, 'town outside.grass must be a >=4 ramp');
    assert.equal(new Set(ramp).size, ramp.length, 'town grass shades must be distinct');
  });

  await t.test('town ground fill is picked by grassShadeIndex, not the tile hash', () => {
    const ramp = town.outside.grass;
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        assert.equal(
          groundFill(town, x, y),
          ramp[grassShadeIndex(x, y, ramp.length)],
          `town fill at ${x},${y} must come from the noise field`
        );
      }
    }
  });

  await t.test('town exterior is low-frequency and free of a parity checkerboard', () => {
    assertNoCheckerboard(groundGrid(town, 30, 30), 30, 30);
  });

  await t.test('tower exterior is low-frequency and free of a parity checkerboard', () => {
    assertNoCheckerboard(groundGrid(tower, 30, 30, -4, -4), 30, 30);
  });

  await t.test('the field is deterministic, including at negative coordinates', () => {
    assert.equal(groundFill(tower, -3, -5), groundFill(tower, -3, -5));
    assert.equal(grassShadeIndex(-3, -5, 4), grassShadeIndex(-3, -5, 4));
  });
});

test('LIV-74 healing fountains ramp on a sustained stay', async (t) => {
  await t.test('catalog authors the ramp factor and the system reads it', () => {
    assert.equal(ECONOMY_CATALOG.springs.rampFactor, 1, 'economy.json must declare springs.rampFactor');
    assert.equal(EconomySystem.springRegen().rampFactor, 1);
    assert.equal(EconomySystem.springRegen().hpPerSec, 5);
    assert.equal(EconomySystem.springRegen().mpPerSec, 5);
  });

  await t.test('consecutive seconds restore base x count (5, 10, 15)', () => {
    const p = { hp: 0, max_hp: 1000, mana: 0, max_mana: 1000 };
    assert.deepEqual(EconomySystem.applySpringRegen(p, 1), { hp: 5, mp: 5 });
    assert.deepEqual(EconomySystem.applySpringRegen(p, 2), { hp: 10, mp: 10 });
    assert.deepEqual(EconomySystem.applySpringRegen(p, 3), { hp: 15, mp: 15 });
    assert.equal(p.hp, 30);
    assert.equal(p.mana, 30);
  });

  await t.test('a single call (legacy path) stays flat at the base rate', () => {
    const p = { hp: 10, max_hp: 100, mana: 10, max_mana: 100 };
    assert.deepEqual(EconomySystem.applySpringRegen(p), { hp: 5, mp: 5 });
    assert.equal(p.hp, 15);
    assert.equal(p.mana, 15);
  });

  await t.test('the ramped amount is still clamped at max HP/MP', () => {
    const p = { hp: 96, max_hp: 100, mana: 92, max_mana: 100 };
    const res = EconomySystem.applySpringRegen(p, 3); // wants +15/+15
    assert.deepEqual(res, { hp: 4, mp: 8 });
    assert.equal(p.hp, 100);
    assert.equal(p.mana, 100);
  });

  await t.test('the streak ramps in-loop and resets when the player leaves', () => {
    const app = Object.create(LokartaApp.prototype);
    const player = createPlayer('fighter');
    player.party = [];
    player.hp = 100;
    player.max_hp = 1000;
    player.mana = 100;
    player.max_mana = 1000;
    app.player = player;
    app.springRegenAccumulator = 0;
    app.springRegenStreak = 0;
    app.addFloatingText = () => {};
    app.updateHUD = () => {};
    let adjacent = true;
    app.findAdjacentSpring = () => (adjacent ? { id: 'spring' } : null);

    app.updateSpringRegen(1);
    assert.equal(player.hp, 105, '1st second: +5');
    app.updateSpringRegen(1);
    assert.equal(player.hp, 115, '2nd second: +10');
    app.updateSpringRegen(1);
    assert.equal(player.hp, 130, '3rd second: +15');
    assert.equal(app.springRegenStreak, 3);

    adjacent = false; // step away
    app.updateSpringRegen(1);
    assert.equal(app.springRegenStreak, 0, 'streak resets on leaving');
    assert.equal(app.springRegenAccumulator, 0, 'accumulator resets on leaving');
    assert.equal(player.hp, 130, 'no heal while away');

    adjacent = true; // return
    app.updateSpringRegen(1);
    assert.equal(player.hp, 135, 're-entry restarts at +5, not +20');
    assert.equal(app.springRegenStreak, 1);
  });
});
