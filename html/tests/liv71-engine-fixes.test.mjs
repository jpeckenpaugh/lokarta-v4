import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneControllerMethods } from '../app/scene-controller.js';
import { SpriteRenderer, sceneTheme, grassShadeIndex, applyTintToHex, monsterVisualFor } from '../app/sprite-renderer.js';
import { TILE_TYPES } from '../engine/config.js';
import { MONSTERS_CATALOG, getIslandDefinition, getTownDefinition, DEFAULT_ISLAND_ID, DEFAULT_TOWN_ID } from '../data/index.js';

// LIV-71: shrine auto-trigger on approach, natural grass variation, distinct
// Gutter King.

function makeApp(interactables, stubs = {}) {
  const opened = [];
  return Object.assign({}, sceneControllerMethods, {
    scene: { interactables },
    player: { x: 0, y: 0 },
    opened,
    partyHasItem: () => false,
    interactWithSceneObject(entry) { opened.push(entry.id); return true; },
    ...stubs,
  });
}

const SHRINE = {
  id: 'drowned_shrine_rite',
  name: 'Drowned Shrine',
  kind: 'object',
  x: 2,
  y: 2,
  autoTrigger: true,
  requiresItem: 'dawn_lantern',
  promptKey: 'drowned_shrine_rite',
};

test('LIV-71 Drowned Shrine auto-trigger on approach', async (t) => {
  await t.test('locked shrine prompts but never opens the beat, and does not latch', () => {
    const app = makeApp([SHRINE]);
    app.player.x = 1; // adjacent (Manhattan radius 1)
    app.player.y = 2;
    assert.equal(app.tryAutoTriggerSceneObjects(), false, 'locked shrine must not fire');
    assert.deepEqual(app.opened, [], 'no beat opened while item is missing');
    assert.equal(app._autoTriggeredObjectIds.size, 0, 'locked object must not consume the latch');
  });

  await t.test('walk-up fires once per approach once the item is held', () => {
    const app = makeApp([SHRINE], { partyHasItem: () => true });
    app.player.x = 5; // out of reach
    app.player.y = 2;
    assert.equal(app.tryAutoTriggerSceneObjects(), false, 'far away: no trigger');
    assert.deepEqual(app.opened, []);

    app.player.x = 1; // step adjacent
    assert.equal(app.tryAutoTriggerSceneObjects(), true, 'approach fires the beat');
    assert.deepEqual(app.opened, ['drowned_shrine_rite']);

    assert.equal(app.tryAutoTriggerSceneObjects(), false, 'lingering never re-opens');
    assert.equal(app.opened.length, 1, 'still exactly one fire');
  });

  await t.test('leaving and re-approaching re-arms the trigger', () => {
    const app = makeApp([SHRINE], { partyHasItem: () => true });
    app.player.x = 1; app.player.y = 2;
    assert.equal(app.tryAutoTriggerSceneObjects(), true);
    app.player.x = 9; // step away
    assert.equal(app.tryAutoTriggerSceneObjects(), false);
    assert.equal(app._autoTriggeredObjectIds.size, 0, 'latch released on leaving');
    app.player.x = 1; // return
    assert.equal(app.tryAutoTriggerSceneObjects(), true, 'second approach re-fires');
    assert.equal(app.opened.length, 2);
  });

  await t.test('only autoTrigger-flagged objects participate', () => {
    const plain = { ...SHRINE, id: 'plain', autoTrigger: false };
    const app = makeApp([plain], { partyHasItem: () => true });
    app.player.x = 1; app.player.y = 2;
    assert.equal(app.tryAutoTriggerSceneObjects(), false);
    assert.deepEqual(app.opened, []);
  });

  await t.test('explicit interact prompt path still finds world objects', () => {
    const app = makeApp([SHRINE], { partyHasItem: () => true });
    app.player.x = 2; app.player.y = 3; // adjacent
    assert.equal(app.sceneObjectInReach()?.id, 'drowned_shrine_rite', 'explicit examine target unchanged');
  });
});

test('LIV-71 natural grass variation (no checkerboard)', async (t) => {
  await t.test('grass shade field is deterministic and in range', () => {
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const i = grassShadeIndex(x, y, 6);
        assert.equal(i, grassShadeIndex(x, y, 6), 'same tile -> same index');
        assert.ok(i >= 0 && i < 6, `index in range at ${x},${y}`);
      }
    }
    assert.equal(grassShadeIndex(3, 4, 1), 0, 'single shade ramp is index 0');
  });

  await t.test('neighbours mostly share a shade and the field is low-frequency', () => {
    const W = 48;
    const H = 48;
    let neighborEqual = 0;
    let neighborTotal = 0;
    let rowTransitions = 0;
    const used = new Set();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        used.add(grassShadeIndex(x, y, 6));
        if (x + 1 < W) {
          neighborTotal++;
          if (grassShadeIndex(x, y, 6) === grassShadeIndex(x + 1, y, 6)) neighborEqual++;
          else rowTransitions++;
        }
      }
    }
    // A parity checkerboard would have zero equal neighbours and ~100% transitions.
    assert.ok(neighborEqual / neighborTotal > 0.5, `expected rolling shades, got ${(neighborEqual / neighborTotal).toFixed(3)} equal`);
    assert.ok(rowTransitions / H < 18, `low-frequency: ${(rowTransitions / H).toFixed(1)} transitions/row`);
    assert.ok(used.size >= 3, 'the ramp is actually used (not a flat fill)');
  });

  await t.test('the field contains no parity/checkerboard term', () => {
    // A checkerboard is a function of (x+y)%2 alone, so every even-parity tile
    // would share one shade. Confirm each parity class spans multiple shades.
    const even = new Set();
    const odd = new Set();
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        ((x + y) % 2 === 0 ? even : odd).add(grassShadeIndex(x, y, 6));
      }
    }
    assert.ok(even.size >= 2, 'even-parity tiles must not all share one shade');
    assert.ok(odd.size >= 2, 'odd-parity tiles must not all share one shade');
  });

  await t.test('themes author a grass shades ramp and the renderer consumes it', () => {
    for (const [label, def] of [['island', getIslandDefinition(DEFAULT_ISLAND_ID)], ['town', getTownDefinition(DEFAULT_TOWN_ID)]]) {
      const theme = sceneTheme(def.theme);
      const shades = theme.tiles.GRASS.shades;
      assert.ok(Array.isArray(shades) && shades.length >= 4, `${label}: GRASS.shades must be a >=4 ramp`);
      assert.equal(new Set(shades).size, shades.length, `${label}: shades must be distinct`);

      const ctx = makeFillCapturingCtx();
      SpriteRenderer.drawTile(ctx, TILE_TYPES.GRASS, 0, 0, 32, { theme, x: 5, y: 9 });
      const ground = ctx.fills.find((f) => f.w === 32 && f.h === 32);
      assert.ok(ground, `${label}: grass draws a full-tile ground fill`);
      assert.equal(ground.style, shades[grassShadeIndex(5, 9, shades.length)], `${label}: fill uses the noise shade`);
    }
  });
});

function makeFillCapturingCtx() {
  const fills = [];
  const ctx = {
    fills,
    _fill: '#000',
    canvas: { width: 256, height: 256 },
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {},
    fill() { fills.push({ style: this._fill, kind: 'fill' }); }, stroke() {}, strokeRect() {}, drawImage() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect(x, y, w, h) { fills.push({ style: this._fill, x, y, w, h }); },
  };
  Object.defineProperty(ctx, 'fillStyle', { get() { return ctx._fill; }, set(v) { ctx._fill = v; } });
  Object.defineProperty(ctx, 'strokeStyle', { get() { return '#000'; }, set() {} });
  Object.defineProperty(ctx, 'lineWidth', { get() { return 1; }, set() {} });
  return ctx;
}

test('LIV-71 Gutter King is visually distinct from the Drowned Crawler', async (t) => {
  await t.test('catalog declares a crown + fur tint only for the Gutter King', () => {
    const king = MONSTERS_CATALOG.gutter_king;
    assert.ok(king.visual, 'gutter_king must declare visual overrides');
    assert.ok(king.visual.crown && king.visual.crown.color, 'gutter_king must declare a crown');
    assert.ok(king.visual.furTint && king.visual.furTint.hex, 'gutter_king must declare a fur tint');

    assert.equal(MONSTERS_CATALOG.drowned_crawler.visual, undefined, 'crawler look must be unchanged');
    assert.equal(monsterVisualFor({ type: 'drowned_crawler' }), null);
    assert.equal(monsterVisualFor({ type: 'gutter_king' }).crown.color, king.visual.crown.color);
  });

  await t.test('runtime monster visual overrides the catalog', () => {
    const custom = { type: 'gutter_king', visual: { crown: { color: '#00ff00' } } };
    assert.equal(monsterVisualFor(custom).crown.color, '#00ff00');
  });

  await t.test('the fur tint actually shifts the shared rat fur colour', () => {
    const tint = MONSTERS_CATALOG.gutter_king.visual.furTint;
    const base = '#5a3d28';
    const shaded = applyTintToHex(base, tint);
    assert.notEqual(shaded, base, 'fur tint must change the fur colour');
    assert.match(shaded, /^#[0-9a-f]{6}$/i);
  });

  await t.test('rendering the Gutter King draws gold, the Crawler does not', () => {
    const gold = MONSTERS_CATALOG.gutter_king.visual.crown.color;

    const kingCtx = makeFillCapturingCtx();
    SpriteRenderer.drawMonster(kingCtx, { type: 'gutter_king', id: 'k1', name: 'The Gutter King', x: 0, y: 0, hp: 10, max_hp: 10, facing: 'down' }, 0, 0, 32);
    assert.ok(kingCtx.fills.some((f) => f.style === gold), 'crown gold must be painted');

    const crawlerCtx = makeFillCapturingCtx();
    SpriteRenderer.drawMonster(crawlerCtx, { type: 'drowned_crawler', id: 'c1', name: 'Drowned Crawler', x: 0, y: 0, hp: 10, max_hp: 10, facing: 'down' }, 0, 0, 32);
    assert.equal(crawlerCtx.fills.some((f) => f.style === gold), false, 'crawler must not gain a crown');
  });
});
