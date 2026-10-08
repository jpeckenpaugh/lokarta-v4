import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneControllerMethods } from '../app/scene-controller.js';
import { SpriteRenderer, sceneTheme } from '../app/sprite-renderer.js';
import { CanvasRenderer } from '../app/canvas-renderer.js';
import { GridMap } from '../engine/grid-map.js';
import { LightingSystem } from '../engine/lighting-system.js';
import { createPartyPlayer } from '../engine/party.js';
import { acceptQuest } from '../engine/quest-system.js';
import { TILE_TYPES } from '../engine/config.js';
import { planSceneMonsters } from '../services/scene-spawner.js';
import { composeScene, composeSceneById, isCodeWalkable } from '../services/scene-composer.js';
import {
  DEFAULT_ISLAND_ID,
  DEFAULT_TOWN_ID,
  getIslandDefinition,
  getTownDefinition,
} from '../data/index.js';

// LIV-68: engine-side island feedback — roamers respawn only on re-entry, the
// island's out-of-bounds backdrop reads as water, and the scene pipeline runs at
// 96x96 with no hard-coded dimensions.

function fakeApp() {
  const player = createPartyPlayer('magician');
  return Object.assign({}, sceneControllerMethods, {
    player,
    npcs: [],
    monsters: [],
    scene: null,
    gridMap: new GridMap(),
    updateHUD: () => {},
    persistSave: () => Promise.resolve(),
    logCombat: () => {},
    addFloatingText: () => {},
  });
}

/* ---------- respawn on re-entry only ---------- */

test('LIV-68 scene respawn', async (t) => {
  await t.test('killed roamers stay dead for the visit; re-entry reloads the deterministic pool', () => {
    const island = composeSceneById(DEFAULT_ISLAND_ID);
    const app = fakeApp();
    app.applySceneData(island);

    const pool = app.monsters.map((m) => [m.type, m.x, m.y]);
    assert.ok(pool.length > 0, 'island plans a deterministic roamer pool');
    assert.ok(app.monsters.every((m) => m.spawnZoneId), 'default pool is all roamers (no quest active)');

    // Kill every roamer.
    for (const m of app.monsters) m.hp = 0;
    const idsAfterKill = app.monsters.map((m) => m.id);

    // Advance many cadences: no roamer is topped back up mid-visit.
    for (let i = 0; i < 200; i++) app.updateSceneMonsters(1);
    assert.equal(app.monsters.filter((m) => m.hp > 0).length, 0, 'no roamer came back');
    assert.deepEqual(app.monsters.map((m) => m.id), idsAfterKill, 'monster set is unchanged mid-visit');

    // Leaving and re-entering repopulates the same deterministic pool.
    app.applySceneData(island);
    const reloaded = app.monsters.map((m) => [m.type, m.x, m.y]);
    assert.equal(reloaded.length, pool.length, 'pool size restored on re-entry');
    assert.deepEqual(reloaded, pool, 're-entry restores identical deterministic placements');
    assert.ok(app.monsters.every((m) => m.hp > 0), 'reloaded pool is alive');
  });

  await t.test('quest elites flagged respawnUntilTurnedIn still re-place while the quest is active', () => {
    const island = composeSceneById(DEFAULT_ISLAND_ID);
    const app = fakeApp();
    acceptQuest(app.player.questState, app.player, 'rats_in_the_gutter');
    app.applySceneData(island);

    const findKing = () => app.monsters.filter((m) => m.questSpawnId === 'q1_gutter_king' && m.hp > 0);
    assert.equal(findKing().length, 1, 'elite present on load while its quest is active');

    // While it is alive the tick never duplicates it.
    for (let i = 0; i < 60; i++) app.updateSceneMonsters(1);
    assert.equal(findKing().length, 1, 'living elite is not duplicated');

    // If it is removed without satisfying its kill objective, it is re-placed on
    // the catalog cadence (the old respawn-until-turned-in behavior).
    for (const m of app.monsters) if (m.questSpawnId === 'q1_gutter_king') m.hp = 0;
    const roamersAlive = app.monsters.filter((m) => m.hp > 0).length;
    for (let i = 0; i < 60; i++) app.updateSceneMonsters(1);
    assert.equal(findKing().length, 1, 'elite re-placed while quest active');
    assert.equal(app.monsters.filter((m) => m.hp > 0).length, roamersAlive + 1, 'only the quest elite returned');
  });

  await t.test('planSceneMonsters includeSpawnZones:false plans only quest elites', () => {
    const island = composeSceneById(DEFAULT_ISLAND_ID);
    const player = createPartyPlayer('magician');
    acceptQuest(player.questState, player, 'rats_in_the_gutter');
    const onlyElites = planSceneMonsters(island, player.questState, {
      includeSpawnZones: false,
      idPrefix: 'sm',
    });
    assert.ok(onlyElites.length > 0, 'quest elites still planned');
    assert.ok(onlyElites.every((s) => s.questSpawnId), 'no spawn-zone roamers planned');
  });
});

/* ---------- island surroundings read as water ---------- */

function makePaintCtx() {
  const fills = [];
  let fillStyle = '#000';
  const ctx = {
    fills,
    get fillStyle() { return fillStyle; },
    set fillStyle(v) { fillStyle = v; },
    fillRect: (x, y, w, h) => { fills.push({ style: String(fillStyle).toLowerCase(), x, y, w, h }); },
  };
  return ctx;
}

test('LIV-68 island water surroundings', async (t) => {
  await t.test('island theme declares water; town keeps grass', () => {
    const island = sceneTheme(getIslandDefinition(DEFAULT_ISLAND_ID).theme);
    assert.equal(island.outside.mode, 'water');
    assert.ok(island.outside.water && island.outside.water.fill, 'island authors a water palette');
    const town = sceneTheme(getTownDefinition(DEFAULT_TOWN_ID).theme);
    assert.notEqual(town.outside.mode, 'water', 'town backdrop stays grass');
  });

  await t.test('off-map island tiles paint water and never the island grass palette', () => {
    const theme = sceneTheme(getIslandDefinition(DEFAULT_ISLAND_ID).theme);
    const ctx = makePaintCtx();
    // A tile well outside the authored map.
    SpriteRenderer.drawOutside(ctx, 0, 0, 32, -5, -7, theme);
    assert.ok(ctx.fills.length > 0, 'backdrop draws');
    const styles = new Set(ctx.fills.map((f) => f.style));
    assert.ok(styles.has(theme.outside.water.deep.toLowerCase()), 'deep water painted');
    assert.ok(styles.has(theme.outside.water.fill.toLowerCase()), 'water swell painted');
    for (const g of theme.outside.grass) {
      assert.ok(!styles.has(g.toLowerCase()), `island grass ${g} must not render beyond the shore`);
    }
  });

  await t.test('town off-map tiles still paint grass (no regression)', () => {
    const theme = sceneTheme(getTownDefinition(DEFAULT_TOWN_ID).theme);
    const ctx = makePaintCtx();
    SpriteRenderer.drawOutside(ctx, 0, 0, 32, -3, -3, theme);
    const styles = new Set(ctx.fills.map((f) => f.style));
    assert.ok(theme.outside.grass.some((g) => styles.has(g.toLowerCase())), 'town grass painted');
  });

  await t.test('a full island camera frame draws off-map water beyond the border', () => {
    const scene = composeSceneById(DEFAULT_ISLAND_ID);
    const grid = new GridMap();
    grid.loadFromMatrix(scene.tiles);
    LightingSystem.applyAmbient(grid);
    const ctx = makeRenderCtx();
    const renderer = new CanvasRenderer(null);
    renderer.ctx = ctx;
    renderer.canvas = ctx.canvas;
    renderer.scene = scene;
    // Player at the map corner: the camera shows negative (out-of-bounds) tiles.
    const player = { x: 0, y: 0, current_floor: 1, hp: 10, max_hp: 10, paperdoll: {}, action_bar: [] };
    assert.doesNotThrow(() => renderer.render(grid, player, [], [], [], [], null, [], [], [], [], []));
    const water = sceneTheme(scene.theme).outside.water;
    const styles = new Set(ctx.fills.map((f) => f.style));
    assert.ok(
      styles.has(water.deep.toLowerCase()) || styles.has(water.fill.toLowerCase()),
      'off-map water is painted in a real frame'
    );
  });
});

/* ---------- 96x96 pipeline readiness ---------- */

function bigIslandDef(size = 96) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    let row = '';
    for (let x = 0; x < size; x++) {
      const border = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      row += border ? '~' : '.';
    }
    rows.push(row);
  }
  return {
    id: 'island_test_big',
    name: 'Test Big Isle',
    order: 99,
    towerId: 'spire_of_light',
    townId: 'town_havenreach',
    theme: 'island_dawnreach',
    biome: 'dawnreach_isle',
    lighting: 'ambient',
    width: size,
    height: size,
    legend: { '.': 'GRASS', '~': 'WATER' },
    map: rows,
    spawn: { x: 48, y: 48 },
    portals: [],
    spawnZones: [
      { id: 'z', x0: 2, y0: 2, x1: size - 3, y1: size - 3, pool: ['drowned_crawler'], maxAlive: 12, respawn: 'deterministic' },
    ],
    safeZones: [],
    questSpawns: [],
    groundItems: [],
    interactables: [],
    landmarks: [],
  };
}

function makeRenderCtx() {
  const fills = [];
  let fillStyle = '#000';
  const noop = () => {};
  const ctx = {
    fills,
    canvas: { width: 480, height: 480 },
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
    rect: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    drawImage: noop,
    fillText: noop,
    strokeText: noop,
    measureText: () => ({ width: 24 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    get fillStyle() { return fillStyle; },
    set fillStyle(v) { fillStyle = v; },
    fillRect: (x, y, w, h) => { fills.push({ style: String(fillStyle).toLowerCase(), x, y, w, h }); },
  };
  for (const prop of ['strokeStyle', 'font', 'textAlign', 'textBaseline', 'globalCompositeOperation', 'lineCap']) {
    Object.defineProperty(ctx, prop, { get() { return ''; }, set() {} });
  }
  Object.defineProperty(ctx, 'lineWidth', { get() { return 1; }, set() {} });
  return ctx;
}

test('LIV-68 96x96 island pipeline', async (t) => {
  await t.test('a 96x96 island composes with catalog-driven dimensions', () => {
    const def = bigIslandDef(96);
    const scene = composeScene('island', def);
    assert.equal(scene.width, 96);
    assert.equal(scene.height, 96);
    assert.equal(scene.tiles.length, 96);
    assert.equal(scene.tiles[0].length, 96);
    assert.equal(scene.tiles[0][0], TILE_TYPES.WATER);
    assert.equal(scene.tiles[48][48], TILE_TYPES.GRASS);
  });

  await t.test('GridMap adopts the 96x96 matrix instead of a hard-coded size', () => {
    const scene = composeScene('island', bigIslandDef(96));
    const grid = new GridMap();
    grid.loadFromMatrix(scene.tiles);
    assert.equal(grid.width, 96);
    assert.equal(grid.height, 96);
    assert.equal(grid.isInBounds(95, 95), true);
    assert.equal(grid.isInBounds(96, 96), false);
    assert.equal(grid.isWalkable(0, 0), false, 'water border blocks');
    assert.equal(grid.isWalkable(48, 48), true, 'interior grass walks');
  });

  await t.test('the spawner scales to 96x96 and fills the whole zone', () => {
    const scene = composeScene('island', bigIslandDef(96));
    const plan = planSceneMonsters(scene, { version: 1, quests: {} }, { idPrefix: 'big' });
    assert.equal(plan.length, 12, 'fills maxAlive across the larger map');
    for (const spawn of plan) {
      assert.ok(isCodeWalkable(scene.tiles[spawn.y][spawn.x]), `spawn walkable (${spawn.x},${spawn.y})`);
      assert.ok(spawn.x >= 2 && spawn.x <= 93 && spawn.y >= 2 && spawn.y <= 93, 'spawn inside the authored zone');
    }
    // Deterministic for the bigger scene id too.
    const again = planSceneMonsters(scene, { version: 1, quests: {} }, { idPrefix: 'big' });
    assert.deepEqual(
      plan.map((s) => [s.type, s.x, s.y]),
      again.map((s) => [s.type, s.x, s.y])
    );
  });

  await t.test('a 96x96 island renders without size-related breakage', () => {
    const scene = composeScene('island', bigIslandDef(96));
    const grid = new GridMap();
    grid.loadFromMatrix(scene.tiles);
    LightingSystem.applyAmbient(grid);
    for (const [px, py] of [[48, 48], [1, 1], [94, 94], [48, 1]]) {
      const ctx = makeRenderCtx();
      const renderer = new CanvasRenderer(null);
      renderer.ctx = ctx;
      renderer.canvas = ctx.canvas;
      renderer.scene = scene;
      const player = { x: px, y: py, current_floor: 1, hp: 10, max_hp: 10, paperdoll: {}, action_bar: [] };
      assert.doesNotThrow(
        () => renderer.render(grid, player, [], [], [], [], null, [], [], [], [], []),
        `96x96 frame at (${px},${py}) renders`
      );
      assert.ok(ctx.fills.length > 0, `96x96 frame at (${px},${py}) draws tiles`);
    }
  });
});
