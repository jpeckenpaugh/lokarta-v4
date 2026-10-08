import test from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TYPES } from '../engine/config.js';
import { LightingSystem } from '../engine/lighting-system.js';
import { GridMap } from '../engine/grid-map.js';
import { SpriteRenderer, sceneTheme, themeForFloor } from '../app/sprite-renderer.js';
import { TILE_THEMES_CATALOG, DEFAULT_ISLAND_ID, DEFAULT_TOWN_ID, getIslandDefinition, getTownDefinition } from '../data/index.js';

// LIV-59 P1: overworld scene rendering + ambient lighting.

function makeFakeCtx() {
  const calls = [];
  const noop = name => (...args) => { calls.push({ name, args }); };
  const ctx = {
    calls,
    canvas: { width: 256, height: 256 },
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save: noop('save'),
    restore: noop('restore'),
    fillRect: noop('fillRect'),
    strokeRect: noop('strokeRect'),
    beginPath: noop('beginPath'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    arc: noop('arc'),
    ellipse: noop('ellipse'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    drawImage: noop('drawImage'),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  Object.defineProperty(ctx, 'fillStyle', { get() { return '#000'; }, set() {} });
  Object.defineProperty(ctx, 'strokeStyle', { get() { return '#000'; }, set() {} });
  Object.defineProperty(ctx, 'lineWidth', { get() { return 1; }, set() {} });
  return ctx;
}

const NEW_TILE_TYPES = [
  TILE_TYPES.WATER, TILE_TYPES.GRASS, TILE_TYPES.SAND, TILE_TYPES.PATH,
  TILE_TYPES.TREE, TILE_TYPES.BRIDGE, TILE_TYPES.BUILDING_WALL,
  TILE_TYPES.DOORWAY, TILE_TYPES.TOWER_ENTRANCE,
];

test('LIV-59 scene rendering & ambient lighting', async (t) => {
  await t.test('sceneTheme resolves the catalog scene palettes', () => {
    const island = sceneTheme(getIslandDefinition(DEFAULT_ISLAND_ID).theme);
    assert.equal(island.lighting, 'ambient');
    assert.ok(island.tiles && island.tiles.WATER, 'island theme carries scene tile palettes');
    const town = sceneTheme(getTownDefinition(DEFAULT_TOWN_ID).theme);
    assert.ok(town.tiles && town.tiles.DOORWAY, 'town theme carries scene tile palettes');
    // Tower floors still resolve through the level theme.
    assert.ok(themeForFloor(1, 'spire_of_light').wall, 'tower theme unchanged');
    // Unknown ids fall back to the root theme rather than throwing.
    assert.equal(sceneTheme('nope'), TILE_THEMES_CATALOG);
  });

  await t.test('every new tile type renders deterministically with a real palette', () => {
    const theme = sceneTheme(getIslandDefinition(DEFAULT_ISLAND_ID).theme);
    for (const type of NEW_TILE_TYPES) {
      const ctx = makeFakeCtx();
      SpriteRenderer.drawTile(ctx, type, 0, 0, 32, { theme, x: 4, y: 7 });
      const fills = ctx.calls.filter(c => c.name === 'fillRect' || c.name === 'fill');
      assert.ok(fills.length > 0, `tile type ${type} must draw something`);
      // Deterministic: the same tile produces the same call sequence.
      const ctx2 = makeFakeCtx();
      SpriteRenderer.drawTile(ctx2, type, 0, 0, 32, { theme, x: 4, y: 7 });
      assert.deepEqual(ctx2.calls, ctx.calls, `tile type ${type} must be deterministic`);
    }
  });

  await t.test('unknown tile types fall back to the default renderer (no throw)', () => {
    const ctx = makeFakeCtx();
    assert.doesNotThrow(() => SpriteRenderer.drawTile(ctx, 999, 0, 0, 32, { theme: TILE_THEMES_CATALOG, x: 0, y: 0 }));
  });

  await t.test('applyAmbient lights every tile and leaves cave flow untouched', () => {
    const grid = new GridMap(3, 2);
    LightingSystem.applyAmbient(grid);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 3; x++) {
        assert.equal(grid.tiles[y][x].isLit, true, `tile ${x},${y} lit`);
        assert.equal(grid.tiles[y][x].lightIntensity, 1);
      }
    }
    // updateLighting still darkens beyond the FOV for tower floors.
    const cave = new GridMap(40, 40);
    LightingSystem.updateLighting(cave, { x: 0, y: 0 }, [], []);
    assert.equal(cave.tiles[0][0].isLit, true);
    assert.equal(cave.tiles[39][39].isLit, false, 'distant cave tile stays dark');
  });
});
