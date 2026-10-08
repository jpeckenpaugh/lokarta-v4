import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES } from '../engine/config.js';
import { LightingSystem } from '../engine/lighting-system.js';
import { GridMap } from '../engine/grid-map.js';
import { CanvasRenderer } from '../app/canvas-renderer.js';
import { SpriteRenderer, sceneTheme } from '../app/sprite-renderer.js';
import { TILE_THEMES_CATALOG, DEFAULT_ISLAND_ID, getIslandDefinition } from '../data/index.js';
import { composeSceneById } from '../services/scene-composer.js';

// LIV-65 regression: the Dawnreach Isle north section rendered black because the
// GATED_DOOR tile renderer dereferenced `theme.door.*`, which scene themes do not
// author. When the Tide Gate (row 10) entered the viewport the render threw after
// the black background clear and the rAF loop stopped rescheduling; this suite
// locks the scene-theme door path so a partial theme can never black the screen.

const WIDTH = 480;
const HEIGHT = 480;

/** Minimal render-surface spy with every primitive the scene render path uses. */
function makeFakeCtx() {
  const calls = [];
  const noop = (name) => (...args) => { calls.push({ name, args }); };
  const ctx = {
    calls,
    canvas: { width: WIDTH, height: HEIGHT },
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save: noop('save'),
    restore: noop('restore'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    arc: noop('arc'),
    ellipse: noop('ellipse'),
    rect: noop('rect'),
    clip: noop('clip'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    fillRect: noop('fillRect'),
    strokeRect: noop('strokeRect'),
    drawImage: noop('drawImage'),
    fillText: noop('fillText'),
    strokeText: noop('strokeText'),
    measureText: () => ({ width: 24 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  for (const prop of ['fillStyle', 'strokeStyle', 'font', 'textAlign', 'textBaseline', 'globalCompositeOperation', 'lineCap']) {
    Object.defineProperty(ctx, prop, { get() { return ''; }, set() {} });
  }
  Object.defineProperty(ctx, 'lineWidth', { get() { return 1; }, set() {} });
  return ctx;
}

function islandContext() {
  const scene = composeSceneById(DEFAULT_ISLAND_ID);
  assert.ok(scene, 'Dawnreach Isle must compose');
  const grid = new GridMap();
  grid.loadFromMatrix(scene.tiles);
  LightingSystem.applyAmbient(grid);
  return { scene, grid };
}

function renderIslandAt(playerY) {
  const { scene, grid } = islandContext();
  const ctx = makeFakeCtx();
  const renderer = new CanvasRenderer(null);
  renderer.ctx = ctx;
  renderer.canvas = ctx.canvas;
  renderer.scene = scene;
  const player = { x: 48, y: playerY, current_floor: 1, hp: 10, max_hp: 10, paperdoll: {}, action_bar: [] };
  renderer.render(grid, player, [], [], [], [], null, [], [], [], [], []);
  return ctx;
}

test('LIV-65 north Dawnreach Isle renders (regression)', async (t) => {
  await t.test('composed island authors the Tide Gate as GATED_DOOR', () => {
    const { grid } = islandContext();
    for (const x of [47, 48, 49]) {
      assert.equal(grid.tiles[20][x].type, TILE_TYPES.GATED_DOOR, `Tide Gate tile (${x},20)`);
    }
    // The Spire base north of the gate stays reachable in the tile data.
    assert.equal(grid.tiles[8][48].type, TILE_TYPES.TOWER_ENTRANCE);
  });

  await t.test('scene theme omits the tower `door` block but the gate still draws', () => {
    const theme = sceneTheme(getIslandDefinition(DEFAULT_ISLAND_ID).theme);
    const islandHasDoorBlock = Boolean(theme.door);
    assert.equal(islandHasDoorBlock, false, 'scene themes must not require a root `door` block');
    for (const type of [TILE_TYPES.DOOR, TILE_TYPES.GATED_DOOR]) {
      const ctx = makeFakeCtx();
      assert.doesNotThrow(
        () => SpriteRenderer.drawTile(ctx, type, 0, 0, 32, { theme, x: 24, y: 10, open: false }),
        `tile ${type} must render without a root door palette`
      );
      const fills = ctx.calls.filter((c) => c.name === 'fillRect' || c.name === 'fill');
      assert.ok(fills.length > 0, `tile ${type} must draw something`);
    }
  });

  await t.test('a totally stripped scene theme falls back instead of throwing', () => {
    const bare = { tiles: {} };
    for (const type of [TILE_TYPES.DOOR, TILE_TYPES.GATED_DOOR]) {
      const ctx = makeFakeCtx();
      assert.doesNotThrow(() => SpriteRenderer.drawTile(ctx, type, 0, 0, 32, { theme: bare, x: 1, y: 1 }));
    }
  });

  await t.test('every frame from the Tide Gate into the north renders without a throw', () => {
    // Player y = 21..7 walks the gate (row 20) into the Spire base (row 8);
    // the gate tiles are inside the viewport across this whole band.
    for (let y = 21; y >= 7; y--) {
      const ctx = renderIslandAt(y);
      const tileFills = ctx.calls.filter((c) => c.name === 'fillRect').length;
      assert.ok(tileFills > 0, `frame at y=${y} must draw tiles (not just the black clear)`);
    }
  });

  await t.test('the root tower theme still uses its authored door palette', () => {
    const ctx = makeFakeCtx();
    assert.doesNotThrow(() => SpriteRenderer.drawTile(ctx, TILE_TYPES.GATED_DOOR, 0, 0, 32, {
      theme: TILE_THEMES_CATALOG,
      x: 0,
      y: 0,
    }));
  });
});
