import test from 'node:test';
import assert from 'node:assert/strict';

import { render, chopToTileCanvas, tileCanvasSize } from '../../tools/gltf-to-sprite.mjs';
import { BUILDING_CATALOG } from '../assets/sprites/index.js';
import { getTownDefinition, DEFAULT_TOWN_ID } from '../data/index.js';

// LIV-114 (board round 2.1): (A) the multi-tile bake must fit the TRUE projected
// bounding box — the `rise` camera tilt adds a depth*sin(rise) term, so a long/
// low building overran the render canvas and clipped at the base. (B) the
// side-facing fisher huts are stretched horizontally to 4 tiles wide. These lock
// the pipeline fix + the widened side huts without needing the private GLBs in CI.

/**
 * Builds a minimal in-memory GLB (single non-indexed box primitive) so the
 * renderer can be exercised in T0 with no .paperclip-repositories checkout.
 */
function boxGlb(sx, sy, sz) {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const v = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  const data = new Float32Array(faces.length * 9);
  let o = 0;
  for (const f of faces) for (const vi of f) { data[o++] = v[vi][0]; data[o++] = v[vi][1]; data[o++] = v[vi][2]; }
  const bin = Buffer.from(data.buffer);
  const json = {
    asset: { generator: 'liv114-test' },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: data.length / 3, type: 'VEC3' }],
    bufferViews: [{ byteOffset: 0, byteLength: bin.length }],
  };
  return { json, bin };
}

/** True when any edge pixel of the render is opaque (i.e. the artwork clipped). */
function touchesBorder(sprite) {
  const { w, h, rgba } = sprite;
  const on = (x, y) => rgba[(y * w + x) * 4 + 3] > 0;
  for (let x = 0; x < w; x++) if (on(x, 0) || on(x, h - 1)) return true;
  for (let y = 0; y < h; y++) if (on(0, y) || on(w - 1, y)) return true;
  return false;
}

test('LIV-114 render fit — projected-bbox framing removes base clipping', async (t) => {
  // A long, low, deep box mirrors the longhouse proportions (wide X, shallow Y,
  // deep Z) whose depth term overruns the default Y-only framing.
  const glb = boxGlb(1.90, 0.65, 1.06);

  await t.test('1. the default Y-only framing clips the base (regression fixture)', () => {
    const clipped = render(glb, null, { azimuth: 0, rise: 10 });
    assert.equal(touchesBorder(clipped), true, 'default framing is expected to touch the canvas edge');
  });

  await t.test('2. fitProjected keeps the whole projected model inside the canvas', () => {
    const fitted = render(glb, null, { azimuth: 0, rise: 10, fitProjected: true });
    assert.equal(touchesBorder(fitted), false, 'fitProjected leaves a transparent margin on every edge');
  });

  await t.test('3. fitProjected holds at every baked azimuth used by the town', () => {
    for (const az of [0, 90, 180, 270]) {
      const fitted = render(glb, null, { azimuth: az * Math.PI / 180, rise: 10, fitProjected: true });
      assert.equal(touchesBorder(fitted), false, `az ${az} must not clip`);
    }
  });

  await t.test('4. single-tile actor framing is unchanged (fitProjected is opt-in)', () => {
    // The default path must stay byte-for-byte the old behaviour: a square-ish
    // box (as tall as wide) is framed by its Y-extent exactly as before.
    const box = boxGlb(1, 1, 1);
    const a = render(box, null, { azimuth: 0, rise: 10 });
    const b = render(box, null, { azimuth: 0, rise: 10, fitProjected: false });
    assert.deepEqual(Array.from(a.rgba), Array.from(b.rgba));
  });
});

test('LIV-114 stretch — side-view fisher huts fill a 4-tile-wide canvas', async (t) => {
  await t.test('1. chopToTileCanvas stretchX fills canvas width, keeps contain height', () => {
    // A portrait sprite (aspect 0.5) in a 4x3 (128x96) canvas: without stretch it
    // is centred with wide side margins; with stretchX it spans the full width.
    const sw = 40, sh = 80;
    const rgba = new Float32Array(sw * sh * 4);
    for (let i = 0; i < sw * sh; i++) { rgba[i * 4] = 200; rgba[i * 4 + 1] = 120; rgba[i * 4 + 2] = 60; rgba[i * 4 + 3] = 255; }
    const sprite = { w: sw, h: sh, rgba };
    const tiles = { w: 4, h: 3 };
    const { w: cw, h: ch } = tileCanvasSize(tiles);

    const contained = chopToTileCanvas(sprite, tiles);
    const stretched = chopToTileCanvas(sprite, tiles, { stretchX: true });

    const opaqueAt = (out, x, y) => out.rgba[(y * out.w + x) * 4 + 3] > 0;
    assert.equal(opaqueAt(stretched, 0, ch - 1), true, 'stretchX reaches the left edge');
    assert.equal(opaqueAt(stretched, cw - 1, ch - 1), true, 'stretchX reaches the right edge');
    assert.equal(opaqueAt(contained, 0, ch - 1), false, 'contain-fit leaves a left margin');
    assert.equal(stretched.w, cw);
    assert.equal(stretched.h, ch);
    // Bottom-aligned in both cases (ground contact on the footprint edge).
    assert.equal(opaqueAt(stretched, Math.floor(cw / 2), ch - 1), true);
  });

  await t.test('2. the side-facing hut defs are 4 tiles wide (128x96), annotated stretchX', () => {
    for (const id of ['fishing_hut_left', 'fishing_hut_right']) {
      const def = BUILDING_CATALOG[id];
      assert.ok(def, `${id} registered`);
      assert.deepEqual(def.tiles, { w: 4, h: 3 }, `${id} is 4x3 tiles`);
      assert.deepEqual(def.native, { w: 128, h: 96 }, `${id} native is 4x3 * 32`);
      assert.match(def.method, /stretchX/, `${id} records the horizontal stretch`);
      assert.deepEqual(tileCanvasSize(def.tiles), def.native);
    }
  });

  await t.test('3. side huts stay placed in Havenreach with a matching footprint span', () => {
    const town = getTownDefinition(DEFAULT_TOWN_ID);
    const left = town.buildings.find((b) => b.silhouette === 'fishing_hut_right');
    const right = town.buildings.find((b) => b.silhouette === 'fishing_hut_left');
    assert.ok(left && right, 'both side huts placed');
    for (const b of [left, right]) {
      const def = BUILDING_CATALOG[b.silhouette];
      const span = [b.footprint[2] - b.footprint[0] + 1, b.footprint[3] - b.footprint[1] + 1];
      assert.deepEqual(span, [def.tiles.w, def.tiles.h], `${b.id} footprint matches its 4x3 canvas`);
    }
  });
});
