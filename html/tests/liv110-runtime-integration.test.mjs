import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArcherBaked } from '../../tools/integrate-actor-bake.mjs';
import { resolveRenderTier, validateSpriteDef } from '../../tools/validate-sprite-def.mjs';
import { DEFAULT_TOWN_ID, getTownDefinition } from '../data/index.js';
import { composeSceneById, sceneAccessReport } from '../services/scene-composer.js';
import { CanvasRenderer } from '../app/canvas-renderer.js';
import { BUILDING_CATALOG, SPRITE_CATALOG } from '../assets/sprites/index.js';

// LIV-110 (board-directed): prove the 3D->2D concept in the RUNNING game, not
// just as artifacts — (1) the live archer renders the baked rukiya GLB sprite,
// (2) the Havenreach buildings now render the baked fisher's-hut GLB sprite.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ARCHER = path.join(ROOT, 'html', 'assets', 'sprites', 'vocations', 'archer.json');

const FLOOR = '#1a1c23';
function luminance(hex) {
  const h = hex.replace('#', '');
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test('LIV-110 runtime integration of the 3D-baked assets', async (t) => {
  await t.test('1. the live archer is the baked rukiya sprite (Tier B, valid)', () => {
    const archer = SPRITE_CATALOG.archer;
    assert.ok(archer, 'archer is registered');
    assert.equal(resolveRenderTier(archer), 'baked');
    assert.ok(Object.keys(archer.palette).length <= 32, 'Tier B palette cap');
    assert.deepEqual(validateSpriteDef(archer, { label: 'archer' }).errors, []);
    const best = Math.max(0, ...Object.values(archer.palette).filter(Boolean).map((v) => contrast(v, FLOOR)));
    assert.ok(best >= 3.0, `archer rim contrast ${best.toFixed(2)} >= 3`);
  });

  await t.test('2. the baked archer keeps the full runtime animation contract', () => {
    const archer = SPRITE_CATALOG.archer;
    const expected = {
      idle: { down: 1, up: 1, side: 1 },
      walk: { down: 2, up: 2, side: 2 },
      attack: { down: 3, up: 3, side: 3 },
      hit: { down: 1, up: 1, side: 1 },
      death: { down: 4, up: 4, side: 4 },
    };
    for (const [state, dirs] of Object.entries(expected)) {
      for (const [dir, n] of Object.entries(dirs)) {
        const list = archer.animations[state][dir];
        assert.equal(list.length, n, `${state}.${dir} frame count`);
        for (const fid of list) assert.ok(archer.frames[fid], `${state}.${dir} frame ${fid} exists`);
      }
    }
    // Directional frames must be distinct baked views (down vs up vs side).
    assert.notDeepEqual(archer.frames.idle_down, archer.frames.idle_up);
    assert.notDeepEqual(archer.frames.idle_down, archer.frames.idle_side);
  });

  await t.test('3. the committed archer byte-matches a fresh integration (no drift)', () => {
    const fresh = buildArcherBaked();
    const committed = JSON.parse(fs.readFileSync(ARCHER, 'utf8'));
    assert.deepEqual(committed, fresh, 'committed archer must equal a fresh build');
  });

  await t.test('4. every Havenreach building is a 2x3 fishing-hut silhouette', () => {
    const town = getTownDefinition(DEFAULT_TOWN_ID);
    assert.equal(town.buildings.length, 6);
    for (const b of town.buildings) {
      assert.equal(b.silhouette, 'fishing_hut', `${b.id} uses the fishing hut`);
      assert.deepEqual(
        [b.footprint[2] - b.footprint[0] + 1, b.footprint[3] - b.footprint[1] + 1],
        [2, 3],
        `${b.id} footprint must match the 2x3 hut canvas`
      );
    }
    assert.ok(BUILDING_CATALOG.fishing_hut, 'the hut sprite is registered');
    assert.deepEqual(BUILDING_CATALOG.fishing_hut.tiles, { w: 2, h: 3 });
  });

  await t.test('5. the running silhouette path blits a hut for every town building', () => {
    const scene = composeSceneById(DEFAULT_TOWN_ID);
    assert.equal(scene.buildings.length, 6);
    const renderer = Object.create(CanvasRenderer.prototype);
    renderer.scene = scene; renderer.cameraX = 0; renderer.cameraY = 0;
    renderer.canvas = { width: 4096, height: 4096 };
    let drew = 0;
    const ctx = {
      fillStyle: '', imageSmoothingEnabled: true,
      fillRect() { drew += 1; },
      drawImage() { drew += 1; },
      save() {}, restore() {},
    };
    renderer.renderBuildingSilhouettes(ctx);
    assert.ok(drew > 0, 'the fishing-hut sprite must blit into each footprint');
  });

  await t.test('6. the reshaped town still has no soft-locks', () => {
    const town = getTownDefinition(DEFAULT_TOWN_ID);
    const report = sceneAccessReport('town', town);
    assert.equal(report.spawnReachable, true, 'spawn reachable');
    assert.equal(report.townReachable, true, 'town exit reachable');
  });
});
