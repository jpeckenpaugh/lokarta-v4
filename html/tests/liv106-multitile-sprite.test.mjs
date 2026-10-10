import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  tileCanvasSize,
  chopToTileCanvas,
  tileSlices,
  footprintFor,
  cropToContent,
} from '../../tools/gltf-to-sprite.mjs';
import { nativePerTile } from '../../tools/validate-sprite-def.mjs';

// LIV-106: "32x32 is ONE tile". A large raster (e.g. 128x64) must be chopped
// into a whole-tile canvas that aligns to the 32px native grid, NOT squished
// into a single 32x32 sprite. These tests lock the scale/chopping math and the
// committed multi-tile PoC shape so it can never silently regress.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const POC = path.join(ROOT, 'docs', 'art', '3d-poc');

test('LIV-106 multi-tile scale & chopping', async (t) => {
  await t.test('32x32 is exactly one tile; native size is tiles * 32', () => {
    assert.deepEqual(tileCanvasSize({ w: 1, h: 1 }), { w: 32, h: 32 });
    assert.deepEqual(tileCanvasSize({ w: 4, h: 2 }), { w: 128, h: 64 });
    assert.deepEqual(tileCanvasSize({ w: 2, h: 3 }), { w: 64, h: 96 });
    assert.throws(() => tileCanvasSize({ w: 0, h: 1 }), /positive integers/);
    assert.throws(() => tileCanvasSize({ w: 1.5, h: 1 }), /positive integers/);
  });

  await t.test('footprint rect is inclusive of both corners (engine contract)', () => {
    // A 4x2 building at (3,5) spans tiles x3..x6 and y5..y6 -> [3,5,6,6].
    assert.deepEqual(footprintFor(3, 5, { w: 4, h: 2 }), [3, 5, 6, 6]);
    // A 1x1 prop occupies exactly one cell -> [x,y,x,y].
    assert.deepEqual(footprintFor(9, 9, { w: 1, h: 1 }), [9, 9, 9, 9]);
  });

  await t.test('chop aligns a portrait render to a whole-tile canvas, bottom-centre', () => {
    // A 100x200 (portrait) render chopped into a 2x3 (64x96) tile canvas fills
    // height (96) and is horizontally centred at the tile boundary.
    const src = rectSprite(100, 200);
    const out = chopToTileCanvas(src, { w: 2, h: 3 });
    assert.deepEqual({ w: out.w, h: out.h }, { w: 64, h: 96 });
    assert.equal(out.fit.h, 96, 'height binds and fills the canvas');
    assert.equal(out.offset.y, 0, 'fitted box is flush to the top of the pad');
    const content = bounds(out.rgba, out.w, out.h);
    assert.equal(content.maxY, 95, 'ground contact sits on the bottom tile edge');
    assert.equal(content.minY, 0, 'top of the sprite is in the top tile row');
  });

  await t.test('chop pads transparent margin instead of squishing to one tile', () => {
    // A 2:1 landscape render in a 4x2 (128x64) canvas: it must NOT be forced
    // into 32x32; it stays at 128x64 with transparent lateral margin.
    const wide = rectSprite(200, 100);
    const out = chopToTileCanvas(wide, { w: 4, h: 2 });
    assert.deepEqual({ w: out.w, h: out.h }, { w: 128, h: 64 });
    const content = bounds(out.rgba, out.w, out.h);
    assert.ok(content.maxX - content.minX + 1 > 32, 'content is wider than a single tile');
    assert.ok(content.maxX - content.minX + 1 <= 128, 'content stays within the multi-tile canvas');
  });

  await t.test('tileSlices decomposes a chopped bitmap into exact 32x32 tiles', () => {
    const src = rectSprite(128, 96);
    const chopped = chopToTileCanvas(src, { w: 2, h: 3 });
    const slices = tileSlices(chopped, { w: 2, h: 3 });
    assert.equal(slices.length, 6, 'rows*cols slices');
    for (const s of slices) {
      assert.equal(s.rgba.length, 32 * 32 * 4, 'each slice is exactly one 32x32 tile');
    }
    // Row-major order: the top-left slice is tile (0,0).
    assert.deepEqual({ tx: slices[0].tx, ty: slices[0].ty }, { tx: 0, ty: 0 });
    assert.deepEqual({ tx: slices[5].tx, ty: slices[5].ty }, { tx: 1, ty: 2 });
  });

  await t.test('cropToContent removes dead transparent border', () => {
    const padded = { w: 20, h: 20, rgba: new Float32Array(20 * 20 * 4) };
    for (let y = 5; y < 10; y++) for (let x = 3; x < 8; x++) padded.rgba[(y * 20 + x) * 4 + 3] = 255;
    const cropped = cropToContent(padded);
    assert.deepEqual({ w: cropped.w, h: cropped.h }, { w: 5, h: 5 });
  });

  await t.test('committed multi-tile PoC declares whole-tile native size and placement', (t2) => {
    const file = path.join(POC, 'fisherman_hut_2x3.sprite.json');
    if (!fs.existsSync(file)) { t2.skip('multi-tile PoC not committed in this checkout'); return; }
    const def = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(def.kind, 'building');
    assert.deepEqual(def.tiles, { w: 2, h: 3 });
    // LIV-121: the 3D-baked hut is N64, so native == tiles * 64 (per-def tier).
    assert.deepEqual(def.native, tileCanvasSize(def.tiles, nativePerTile(def)), 'native px == tiles * per-tile native');
    assert.equal(def.anchor.y, def.native.h - 2, 'anchor sits on the bottom tile edge');
    assert.equal(def.placement.mode, 'multi-tile-blit');
    assert.deepEqual(def.placement.footprint, footprintFor(0, 0, def.tiles));
    const rows = def.frames.view_0;
    assert.equal(rows.length, def.native.h, 'frame height matches native tiles');
    assert.ok(rows.every((r) => r.length === def.native.w), 'every row is native width wide');
  });

  await t.test('committed 32x32 actor PoC path is unchanged (one tile)', (t2) => {
    const file = path.join(POC, 'fisherman_hut_poc.sprite.json');
    if (!fs.existsSync(file)) { t2.skip('legacy PoC not committed in this checkout'); return; }
    const def = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(def.native, { w: 32, h: 32 }, 'single-tile sprite stays exactly one tile');
    assert.equal(def.tiles, undefined, 'no multi-tile metadata on a single-tile sprite');
  });
});

function rectSprite(w, h) {
  const rgba = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    rgba[i] = 180; rgba[i + 1] = 160; rgba[i + 2] = 120; rgba[i + 3] = 255;
  }
  return { w, h, rgba };
}

function bounds(rgba, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return { minX, minY, maxX, maxY };
}
