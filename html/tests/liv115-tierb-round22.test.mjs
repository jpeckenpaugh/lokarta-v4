import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tileCanvasSize } from '../../tools/gltf-to-sprite.mjs';
import { nativePerTile, paletteCapFor } from '../../tools/validate-sprite-def.mjs';
import { BUILDING_CATALOG, PROP_CATALOG, SPRITE_CATALOG } from '../assets/sprites/index.js';
import { getTownDefinition, DEFAULT_TOWN_ID } from '../data/index.js';
import { composeSceneById } from '../services/scene-composer.js';
import { SpriteRenderer } from '../app/sprite-renderer.js';

// LIV-115 (board round 2.2): the four approved Tier B fixes.
//  1. drop the 1px black outline on 3D-baked assets (buildings + archer),
//  2. brighten the archer bake into the flat Tier A tonal range,
//  3. fit side-varying huts to the tile canvas with margin on every edge,
//  4. nets render 2x1 (horizontal) / 1x2 (vertical) by orientation.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FLOOR = '#1a1c23';

function luminance(hex) {
  const h = hex.replace('#', '');
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Mean Rec.601 luma over the opaque, non-outline pixels of a def's frames. */
function meanLuma(def) {
  let s = 0, n = 0;
  for (const rows of Object.values(def.frames)) {
    for (const row of rows) for (const ch of row) {
      if (ch === '.' || ch === '0') continue;
      const p = def.palette[ch]; if (!p) continue;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.slice(i, i + 2), 16));
      s += 0.299 * r + 0.587 * g + 0.114 * b; n++;
    }
  }
  return n ? s / n : 0;
}

/** Content bbox (non-transparent, non-outline) of one frame. */
function bbox(rows) {
  let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
  rows.forEach((r, y) => [...r].forEach((ch, x) => {
    if (ch === '.' || ch === '0') return;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }));
  return { minx, maxx, miny, maxy };
}

test('LIV-115 fix 1 — Tier B outline opt-out (buildings + archer)', async (t) => {
  await t.test('1. every baked building declares outline:false and emits no outline chars', () => {
    const baked = ['longhouse', 'fishers_house', 'fishers_house_large', 'fishing_hut', 'fishing_hut_large', 'fishing_hut_back', 'fishing_hut_left', 'fishing_hut_right'];
    for (const id of baked) {
      const def = BUILDING_CATALOG[id];
      assert.ok(def, `${id} registered`);
      assert.equal(def.renderTier, 'baked', `${id} is Tier B`);
      assert.equal(def.outline, false, `${id} opts out of the outline pass`);
      // LIV-122: 3D-baked palettes now spend all 75 opaque slots including the
      // glyph '0', so "no outline" is proven by the absence of the outline
      // colour, not by the absence of the '0' glyph.
      assert.ok(!Object.values(def.palette).includes('#0b0d12'), `${id} carries no outline colour`);
    }
  });

  await t.test('2. the archer runtime propagates the outline opt-out', () => {
    const c = SPRITE_CATALOG.archer;
    assert.equal(c.renderTier, 'baked');
    assert.equal(c.outline, false, 'runtime archer carries outline:false so the renderer does not re-add it');
    assert.ok(!Object.values(c.palette).includes('#0b0d12'), 'archer carries no outline colour');
  });

  await t.test('3. Tier A flat sprites keep the outline (crafted art still carries "")', () => {
    // A flat vocation (Tier A) has no outline flag, so the runtime applies the
    // 1px outline. Its committed frames still carry outline pixels (or at least
    // the def does not opt out).
    for (const id of ['fighter', 'magician', 'paladin']) {
      const def = SPRITE_CATALOG[id];
      assert.notEqual(def.outline, false, `${id} keeps the outline`);
    }
  });
});

test('LIV-115 fix 2 — archer tonal range matches flat vocations', async (t) => {
  await t.test('1. archer mean luma sits inside the flat-vocation band', () => {
    const archer = meanLuma(SPRITE_CATALOG.archer);
    const flats = ['fighter', 'magician', 'paladin'].map((id) => meanLuma(SPRITE_CATALOG[id]));
    const lo = Math.min(...flats), hi = Math.max(...flats);
    assert.ok(archer >= lo - 3, `archer mean ${archer.toFixed(1)} not below the flats (${lo.toFixed(1)})`);
    assert.ok(archer <= hi + 3, `archer mean ${archer.toFixed(1)} not brighter than the flats (${hi.toFixed(1)})`);
  });

  await t.test('2. the archer rig bake records the brighter ambient/exposure and rim contrast holds', () => {
    const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/art/3d-poc/rukiya_archer_rigged.sprite.json'), 'utf8'));
    assert.equal(art.outline, false);
    // LIV-122: the rigged archer is 3D-baked -> <=96 entries (~75 opaque).
    assert.equal(paletteCapFor(art), 96);
    assert.ok(Object.keys(art.palette).length <= 96);
    const best = Math.max(0, ...Object.values(art.palette).filter(Boolean).map((v) => {
      const la = luminance(v), lb = luminance(FLOOR);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }));
    assert.ok(best >= 3.0, `rim contrast ${best.toFixed(2)} >= 3`);
  });
});

test('LIV-115 fix 3 — side huts frame the full model with margin on every edge', async (t) => {
  await t.test('1. side huts leave transparent margin on all four edges', () => {
    for (const id of ['fishing_hut_left', 'fishing_hut_right']) {
      const def = BUILDING_CATALOG[id];
      assert.deepEqual(def.tiles, { w: 4, h: 3 }, `${id} stays 4x3`);
      assert.match(def.method, /margin/, `${id} records the margin rule`);
      const rows = def.frames[def.placement.defaultFrame];
      const b = bbox(rows);
      assert.ok(b.minx >= 2, `${id} left margin (minx=${b.minx})`);
      assert.ok(rows[0].length - 1 - b.maxx >= 2, `${id} right margin`);
      assert.ok(b.miny >= 2, `${id} top margin (miny=${b.miny})`);
      assert.ok(rows.length - 1 - b.maxy >= 2, `${id} bottom margin`);
    }
  });

  await t.test('2. side huts keep stretchX + a matching footprint in Havenreach', () => {
    const town = getTownDefinition(DEFAULT_TOWN_ID);
    for (const silhouette of ['fishing_hut_left', 'fishing_hut_right']) {
      const def = BUILDING_CATALOG[silhouette];
      assert.match(def.method, /stretchX/, `${silhouette} still stretches width`);
      assert.deepEqual(tileCanvasSize(def.tiles, nativePerTile(def)), def.native);
      const b = town.buildings.find((x) => x.silhouette === silhouette);
      assert.ok(b, `${silhouette} placed`);
      assert.deepEqual([b.footprint[2] - b.footprint[0] + 1, b.footprint[3] - b.footprint[1] + 1], [4, 3]);
    }
  });
});

test('LIV-115 fix 4 — nets render 2x1 / 1x2 by orientation', async (t) => {
  await t.test('1. horizontal + vertical net defs are the right tile shapes', () => {
    const h = PROP_CATALOG.prop_fishers_net;
    const v = PROP_CATALOG.prop_fishers_net_vertical;
    assert.ok(h && v, 'both net orientations registered');
    assert.deepEqual(h.tiles, { w: 2, h: 1 }, 'horizontal net is 2x1');
    // LIV-121: the 3D-baked nets are N64, so 2x1 is 128x64 and 1x2 is 64x128.
    assert.deepEqual(h.native, { w: 128, h: 64 });
    assert.deepEqual(v.tiles, { w: 1, h: 2 }, 'vertical net is 1x2');
    assert.deepEqual(v.native, { w: 64, h: 128 });
    for (const def of [h, v]) {
      assert.equal(def.renderTier, 'baked');
      assert.equal(nativePerTile(def), 64, 'N64 net');
      assert.equal(def.outline, false, 'nets drop the outline too');
      assert.deepEqual(tileCanvasSize(def.tiles, nativePerTile(def)), def.native);
    }
    // Face-on views live in the horizontal def; edge-on views in the vertical.
    assert.ok(h.frames.view_0 && h.frames.view_180, 'horizontal net bakes face-on views');
    assert.ok(v.frames.view_90 && v.frames.view_270, 'vertical net bakes edge-on views');
  });

  await t.test('2. the runtime blits the full multi-tile net (scale from the atomic tile)', () => {
    const measure = (def, frameId) => {
      const ext = { x: 0, y: 0 };
      const ctx = {
        fillStyle: '', imageSmoothingEnabled: true,
        fillRect(x, y, w, h) { ext.x = Math.max(ext.x, x + w); ext.y = Math.max(ext.y, y + h); },
        drawImage() { throw new Error('no canvas in node'); },
      };
      SpriteRenderer.drawProp(ctx, { propId: def.id, frame: frameId }, 0, 0, 64);
      return ext;
    };
    const h = measure(PROP_CATALOG.prop_fishers_net, 'view_0');
    assert.ok(h.x >= 128, `horizontal net spans 2 display tiles (x=${h.x})`);
    const v = measure(PROP_CATALOG.prop_fishers_net_vertical, 'view_90');
    assert.ok(v.y >= 128, `vertical net spans 2 display tiles tall (y=${v.y})`);
  });

  await t.test('3. Havenreach places both net orientations and they stay walkable', () => {
    const scene = composeSceneById(DEFAULT_TOWN_ID);
    const nets = (scene.props || []).filter((p) => String(p.propId).startsWith('prop_fishers_net'));
    assert.ok(nets.length >= 2, `nets placed (${nets.length})`);
    const ids = new Set(nets.map((p) => p.propId));
    assert.ok(ids.has('prop_fishers_net') && ids.has('prop_fishers_net_vertical'), 'both orientations placed');
  });
});
