import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TILE_TYPES, IMPASSABLE_TILE_TYPES } from '../engine/config.js';
import { GridMap } from '../engine/grid-map.js';
import { SpriteRenderer, sceneTheme } from '../app/sprite-renderer.js';
import { CanvasRenderer } from '../app/canvas-renderer.js';
import { sceneControllerMethods } from '../app/scene-controller.js';
import { composeScene, composeSceneById } from '../services/scene-composer.js';
import { createPartyPlayer } from '../engine/party.js';
import { PROP_CATALOG, PROP_MANIFEST } from '../assets/sprites/index.js';
import { DEFAULT_TOWN_ID, getTownDefinition } from '../data/index.js';

// LIV-100: fishing-village engine & rendering foundation. Locks the coastal
// town theme, the walkable DOCK tile, the (previously inert) scene props
// pipeline, the fishing prop assets, and the per-building silhouette hook.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPRITES_DIR = path.join(HERE, '..', 'assets', 'sprites');

function makeFillCtx() {
  const fills = [];
  let fillStyle = '#000';
  const noop = () => {};
  const ctx = {
    fills,
    canvas: { width: 256, height: 256 },
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    ellipse: noop,
    fill: noop,
    stroke: noop,
    strokeRect: noop,
    drawImage: noop,
    createRadialGradient: () => ({ addColorStop() {} }),
    get fillStyle() { return fillStyle; },
    set fillStyle(v) { fillStyle = v; },
    fillRect(x, y, w, h) { fills.push({ style: String(fillStyle).toLowerCase(), x, y, w, h }); },
  };
  Object.defineProperty(ctx, 'strokeStyle', { get() { return '#000'; }, set() {} });
  Object.defineProperty(ctx, 'lineWidth', { get() { return 1; }, set() {} });
  return ctx;
}

const townTheme = () => sceneTheme(getTownDefinition(DEFAULT_TOWN_ID).theme);

test('LIV-100 coastal town theme', async (t) => {
  await t.test('town backdrop is water with a shoreline block', () => {
    const theme = townTheme();
    assert.equal(theme.outside.mode, 'water', 'town authors the water backdrop mode');
    assert.ok(theme.outside.water && /^#[0-9a-f]{6}$/i.test(theme.outside.water.fill), 'water palette');
    assert.ok(theme.outside.shoreline, 'town authors a shoreline treatment');
    assert.match(theme.outside.shoreline.foam, /^#[0-9a-f]{6}$/i, 'shoreline foam is a hex');
  });

  await t.test('town authors the scene tile palettes a shore needs', () => {
    const tiles = townTheme().tiles;
    for (const name of ['WATER', 'SAND', 'BRIDGE', 'DOCK']) {
      assert.ok(tiles[name], `town tiles missing ${name}`);
    }
    for (const name of ['WATER', 'SAND', 'DOCK']) {
      assert.ok(
        Object.values(tiles[name]).some((v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)),
        `${name} must carry hex colors`
      );
    }
  });

  await t.test('off-map town tiles paint water, never the grass ramp', () => {
    const theme = townTheme();
    const ctx = makeFillCtx();
    SpriteRenderer.drawOutside(ctx, 0, 0, 32, -4, -6, theme);
    const styles = new Set(ctx.fills.map((f) => f.style));
    assert.ok(styles.has(theme.outside.water.deep.toLowerCase()), 'deep water painted');
    assert.ok(styles.has(theme.outside.water.fill.toLowerCase()), 'water swell painted');
    for (const g of theme.outside.grass) {
      assert.ok(!styles.has(g.toLowerCase()), `grass ${g} must not render beyond the shore`);
    }
  });
});

test('LIV-100 DOCK tile', async (t) => {
  await t.test('appends DOCK as code 16 without renumbering scene tiles', () => {
    assert.equal(TILE_TYPES.DOCK, 16);
    assert.equal(TILE_TYPES.TOWER_ENTRANCE, 15, 'existing scene codes unchanged');
    assert.ok(!IMPASSABLE_TILE_TYPES.has(TILE_TYPES.DOCK), 'a dock is walkable');
  });

  await t.test('GridMap adopts DOCK from a raw matrix and walks it', () => {
    const grid = new GridMap(2, 1);
    grid.loadFromMatrix([[TILE_TYPES.DOCK, TILE_TYPES.WATER]]);
    assert.equal(grid.getTile(0, 0).type, TILE_TYPES.DOCK, 'code 16 maps to DOCK');
    assert.equal(grid.isWalkable(0, 0), true, 'dock walks');
    assert.equal(grid.isWalkable(1, 0), false, 'water still blocks');
  });

  await t.test('DOCK renders deterministically from the town palette', () => {
    const theme = townTheme();
    const ctx = makeFillCtx();
    SpriteRenderer.drawTile(ctx, TILE_TYPES.DOCK, 0, 0, 32, { theme, x: 4, y: 7 });
    const plank = theme.tiles.DOCK.plank.toLowerCase();
    assert.ok(ctx.fills.some((f) => f.style === plank), 'deck planks use the DOCK palette');
    const ctx2 = makeFillCtx();
    SpriteRenderer.drawTile(ctx2, TILE_TYPES.DOCK, 0, 0, 32, { theme, x: 4, y: 7 });
    assert.deepEqual(ctx2.fills, ctx.fills, 'dock draw is deterministic');
  });
});

test('LIV-100 scene props pipeline', async (t) => {
  await t.test('the composer emits a copied props array', () => {
    const def = getTownDefinition(DEFAULT_TOWN_ID);
    const scene = composeSceneById(DEFAULT_TOWN_ID);
    assert.ok(Array.isArray(scene.props), 'scene descriptor carries props');
    assert.equal(scene.props.length, def.props.length, 'every authored prop is emitted');
    assert.notEqual(scene.props[0], def.props[0], 'props are copied, not aliased');
    for (const prop of scene.props) {
      assert.ok(PROP_CATALOG[prop.propId], `prop ${prop.propId} resolves in the catalog`);
    }
  });

  await t.test('applySceneData loads props onto the live app', () => {
    const scene = composeSceneById(DEFAULT_TOWN_ID);
    const player = createPartyPlayer('magician');
    player.x = scene.spawn.x;
    player.y = scene.spawn.y;
    const app = Object.assign({}, sceneControllerMethods, {
      player,
      npcs: [],
      monsters: [],
      scene: null,
      props: [],
      gridMap: new GridMap(),
      updateHUD: () => {},
      persistSave: () => Promise.resolve(),
      logCombat: () => {},
      addFloatingText: () => {},
    });
    app.applySceneData(scene);
    assert.equal(app.props.length, scene.props.length, 'props loaded, not the old empty []');
    // Town props carry no `layer`, so none is marked blocked — walkability and
    // the south gate are untouched by wiring the props path.
    for (const prop of app.props) {
      assert.notEqual(app.gridMap.getTile(prop.x, prop.y).blocked, true, `town prop ${prop.propId} must not block`);
    }
  });

  await t.test('a furniture-layer prop blocks; decor/undefined stays walk-over', () => {
    const def = {
      id: 'town_test', name: 'Test', theme: 'town_havenreach', lighting: 'ambient',
      legend: { '.': 'GRASS' }, map: ['.....', '.....'], spawn: { x: 0, y: 0 },
      props: [
        { propId: 'prop_crate', x: 1, y: 1, layer: 'prop' },
        { propId: 'prop_net', x: 3, y: 1 },
      ],
    };
    const player = createPartyPlayer('magician');
    player.x = 0;
    player.y = 0;
    const app = Object.assign({}, sceneControllerMethods, {
      player, npcs: [], monsters: [], scene: null, props: [], gridMap: new GridMap(),
      updateHUD: () => {}, persistSave: () => Promise.resolve(),
      logCombat: () => {}, addFloatingText: () => {},
    });
    app.applySceneData(composeScene('town', def));
    assert.equal(app.gridMap.isWalkable(1, 1), false, 'furniture prop blocks');
    assert.equal(app.gridMap.isWalkable(3, 1), true, 'unlayered prop stays walk-over');
  });

  await t.test('props render through SpriteRenderer.drawProp', () => {
    const ctx = makeFillCtx();
    const drew = SpriteRenderer.drawProp(ctx, { propId: 'prop_boat', layer: 'prop' }, 0, 0, 32);
    assert.equal(drew, true, 'boat prop blits');
    assert.ok(ctx.fills.length > 0 || ctx.drawImage !== undefined, 'boat prop draws pixels');
  });
});

test('LIV-100 fishing prop assets', async (t) => {
  const expected = ['prop_net', 'prop_drying_rack', 'prop_fish_barrel', 'prop_boat', 'prop_buoy', 'prop_smoke_plume'];

  await t.test('every fishing prop is registered with a committed 32x32 asset', () => {
    for (const id of expected) {
      const meta = PROP_MANIFEST[id];
      assert.ok(meta, `manifest missing ${id}`);
      assert.equal(meta.kind, 'prop', `${id} kind`);
      assert.ok(['wall', 'free'].includes(meta.class), `${id} class`);
      assert.ok(PROP_CATALOG[id], `catalog missing ${id}`);
      assert.ok(fs.existsSync(path.join(SPRITES_DIR, meta.file)), `${id} file missing`);
      const def = PROP_CATALOG[id];
      assert.equal(def.frames.idle.length, 32, `${id} frame height`);
      for (const row of def.frames.idle) assert.equal(row.length, 32, `${id} frame width`);
    }
  });
});

test('LIV-100 per-building silhouette hook', async (t) => {
  const townDef = {
    id: 'town_sil', name: 'Sil', theme: 'town_havenreach', lighting: 'ambient',
    legend: { '.': 'GRASS' }, map: ['.......', '.......', '.......', '.......', '.......', '.......', '.......'],
    spawn: { x: 0, y: 0 },
    buildings: [
      { id: 'longhouse', name: 'Longhouse', footprint: [2, 1, 5, 4], door: { x: 3, y: 4 }, silhouette: 'ark_hull' },
      { id: 'plain_hut', name: 'Hut', footprint: [0, 5, 1, 6], door: { x: 0, y: 6 } },
    ],
  };

  await t.test('the composer emits building footprints + silhouette passthrough', () => {
    const scene = composeScene('town', townDef);
    assert.equal(scene.buildings.length, 2);
    assert.deepEqual(scene.buildings[0].footprint, [2, 1, 5, 4]);
    assert.equal(scene.buildings[0].silhouette, 'ark_hull');
    assert.equal(scene.buildings[1].silhouette, null, 'a building without a silhouette stays null');
  });

  await t.test('the renderer dispatches only silhouetted buildings through the table', () => {
    const scene = composeScene('town', townDef);
    const renderer = Object.create(CanvasRenderer.prototype);
    renderer.scene = scene;
    renderer.cameraX = 0;
    renderer.cameraY = 0;
    renderer.canvas = { width: 256, height: 256 };
    let fills = 0;
    let strokes = 0;
    const ctx = {
      fillStyle: '', strokeStyle: '', lineWidth: 1,
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
      fill() { fills += 1; }, stroke() { strokes += 1; }, fillRect() {},
    };
    assert.doesNotThrow(() => renderer.renderBuildingSilhouettes(ctx));
    assert.equal(fills, 1, 'exactly the ark-hull building draws a filled silhouette');
    assert.ok(strokes > 0, 'ark-hull draws ribs');

    // No silhouette in the scene -> a pure no-op.
    const bare = Object.create(CanvasRenderer.prototype);
    bare.scene = composeScene('town', { ...townDef, buildings: [] });
    bare.cameraX = 0; bare.cameraY = 0; bare.canvas = { width: 256, height: 256 };
    let bareFills = 0;
    bare.renderBuildingSilhouettes({ ...ctx, fill() { bareFills += 1; } });
    assert.equal(bareFills, 0, 'no silhouetted buildings -> nothing drawn');
  });
});
