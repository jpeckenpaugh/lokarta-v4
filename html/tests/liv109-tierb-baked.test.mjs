import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rampPalette,
  quantizeRamp,
  luma,
  tileCanvasSize,
  footprintFor,
} from '../../tools/gltf-to-sprite.mjs';
import {
  validateSpriteDef,
  paletteCapFor,
  resolveRenderTier,
  footprintSpan,
  NATIVE_TILE,
} from '../../tools/validate-sprite-def.mjs';
import { PROOF_PAIRS, exportProof } from '../../tools/render-tierb-proof.mjs';
import { BUILDING_CATALOG } from '../assets/sprites/index.js';
import { composeScene } from '../services/scene-composer.js';
import { CanvasRenderer } from '../app/canvas-renderer.js';

// LIV-109 (Phase 1): the Tier B "baked" re-author of the board's two named
// assets — archer (32x32 actor) + fishing hut (2x3 multi-tile building) — must
// stay a before/after proof with a visible SNES-plus read (4-step ramps, rim
// light, <=32 palette) that rides the existing footprint silhouette path.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const POC = path.join(ROOT, 'docs', 'art', '3d-poc');
const PHASE1 = path.join(POC, 'phase1');
const FLOOR = '#1a1c23';

function srgbToLin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
function readDef(file) { return JSON.parse(fs.readFileSync(path.join(POC, file), 'utf8')); }
/** Usable ramp chars in authored order: excludes the `.` transparent + `0` outline. */
function rampChars(def) { return Object.keys(def.palette).filter((c) => def.palette[c] && c !== '.' && c !== '0'); }
function hexRGB(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

const ARCHER_BAKED = 'rukiya_archer_baked.sprite.json';
const HUT_BAKED = 'fisherman_hut_2x3.sprite.json';
const HUT_INDEXED = 'fisherman_hut_2x3_indexed.sprite.json';

test('LIV-109 Tier B baked Phase 1', async (t) => {
  await t.test('1. baked defs validate as Tier B and stay within the <=32 palette cap', () => {
    for (const file of [ARCHER_BAKED, HUT_BAKED]) {
      const def = readDef(file);
      assert.equal(resolveRenderTier(def), 'baked', `${file} declares renderTier baked`);
      assert.equal(paletteCapFor(def), 32);
      const entries = Object.keys(def.palette).length;
      assert.ok(entries <= 32, `${file} palette ${entries} <= 32`);
      assert.deepEqual(validateSpriteDef(def, { label: file }).errors, [], file);
    }
    // The richer read is real: baked usable colours exceed the flat Tier A before.
    const before = readDef(HUT_INDEXED);
    assert.equal(resolveRenderTier(before), 'indexed', 'before art stays Tier A');
    assert.ok(rampChars(readDef(HUT_BAKED)).length > rampChars(before).length, 'baked hut has more usable colours than its Tier A before');
  });

  await t.test('2. every baked family is a strictly-increasing >=4-step ramp with a rim clearing 3:1', () => {
    for (const file of [ARCHER_BAKED, HUT_BAKED]) {
      const def = readDef(file);
      const chars = rampChars(def);
      assert.equal(chars.length % 4, 0, `${file} usable colours form whole 4-step ramps`);
      const best = Math.max(0, ...Object.values(def.palette).filter(Boolean).map((v) => contrast(v, FLOOR)));
      assert.ok(best >= 3.0, `${file} best rim contrast ${best.toFixed(2)} < 3.0`);
      let rimCarrier = false;
      for (let f = 0; f < chars.length / 4; f++) {
        const slice = chars.slice(f * 4, f * 4 + 4);
        const lum = slice.map((c) => luma(...hexRGB(def.palette[c])));
        for (let i = 0; i < lum.length; i++) assert.ok(i === 0 || lum[i] > lum[i - 1], `${file} family ${f} ramp step ${i} not lighter than ${i - 1} (${lum.map((v) => v.toFixed(0)).join('<')})`);
        if (contrast(def.palette[slice[3]], FLOOR) >= 3.0) rimCarrier = true;
      }
      assert.ok(rimCarrier, `${file} rim (brightest ramp step) must carry the 3:1 read`);
    }
  });

  await t.test('3. hut is a 2x3 (64x96) multi-tile building on the footprint contract', () => {
    const def = readDef(HUT_BAKED);
    assert.equal(def.kind, 'building');
    assert.deepEqual(def.tiles, { w: 2, h: 3 });
    assert.deepEqual(def.native, tileCanvasSize(def.tiles));
    assert.deepEqual(def.native, { w: 64, h: 96 });
    assert.equal(def.placement.mode, 'multi-tile-blit');
    assert.deepEqual(def.placement.footprint, footprintFor(0, 0, def.tiles));
    assert.deepEqual(footprintSpan(def.placement.footprint), [2, 3]);
    assert.equal(def.anchor.y, def.native.h - 2, 'anchor sits on the bottom tile edge');
    for (const rows of Object.values(def.frames)) {
      assert.equal(rows.length, def.native.h);
      assert.ok(rows.every((r) => r.length === def.native.w));
    }
    assert.equal(NATIVE_TILE, 32);
  });

  await t.test('4. archer is a single-tile 32x32 baked actor', () => {
    const def = readDef(ARCHER_BAKED);
    assert.equal(def.kind, 'actor');
    assert.deepEqual(def.native, { w: 32, h: 32 });
    assert.equal(def.tiles, undefined, 'actor stays one tile');
    for (const rows of Object.values(def.frames)) {
      assert.equal(rows.length, 32);
      assert.ok(rows.every((r) => r.length === 32));
    }
  });

  await t.test('5. the ramp palette guarantees 4 ordered steps per family + 2x2 ordered dither', () => {
    assert.deepEqual(tileCanvasSize({ w: 2, h: 3 }), { w: 64, h: 96 });
    // A full-range single material yields exactly families*steps colours whose
    // each family slice is strictly increasing in luma.
    const px = [];
    for (let i = 0; i < 256; i++) { const f = 0.35 + (i / 255) * 1.2; px.push([Math.min(255, 210 * f), Math.min(255, 120 * f), Math.min(255, 70 * f)]); }
    const ramp = rampPalette(px, { families: 2, steps: 4 });
    assert.equal(ramp.colors.length, 8, 'families * steps colours');
    for (let f = 0; f < 2; f++) {
      const lum = ramp.colors.slice(f * 4, f * 4 + 4).map((c) => luma(...c));
      for (let i = 0; i < lum.length; i++) assert.ok(i === 0 || lum[i] >= lum[i - 1], `family ${f} ramp ordered`);
    }
    // A uniform colour lands on a fractional ramp position, so the Bayer matrix
    // must split it across two adjacent steps (visible dither, not a flat fill).
    const flat = { w: 4, h: 4, rgba: new Float32Array(4 * 4 * 4) };
    for (let i = 0; i < 16; i++) { flat.rgba[i * 4] = 200; flat.rgba[i * 4 + 1] = 100; flat.rgba[i * 4 + 2] = 50; flat.rgba[i * 4 + 3] = 255; }
    const rows = quantizeRamp(flat, rampPalette([[200, 100, 50]], { families: 1, steps: 4 }));
    const used = new Set(rows.join(''));
    assert.ok(used.size >= 2, `ordered dither must use >=2 chars, got ${used.size}`);
    for (const ch of used) assert.ok(ch === '.' || /^[1-9a-z]$/.test(ch), `palette-safe char ${ch}`);
  });

  await t.test('6. the runtime building sprite matches the committed pipeline artifact (no drift)', () => {
    const runtime = BUILDING_CATALOG.fishing_hut;
    assert.ok(runtime, 'BUILDING_CATALOG.fishing_hut is registered');
    assert.equal(resolveRenderTier(runtime), 'baked');
    assert.deepEqual(runtime, readDef(HUT_BAKED), 'runtime asset must byte-match the docs artifact');
  });

  await t.test('7. sprite-backed silhouette blits via the footprint path; unknown silhouettes no-op', () => {
    const townDef = {
      id: 'town_liv109', name: 'Harbour', theme: 'town_havenreach', lighting: 'ambient',
      legend: { '.': 'GRASS' }, map: ['........', '........', '........', '........', '........'],
      spawn: { x: 0, y: 0 },
      buildings: [
        { id: 'fisherman_hut', name: 'Fisherman Hut', footprint: [2, 1, 3, 3], door: { x: 2, y: 4 }, silhouette: 'fishing_hut' },
        { id: 'plain', name: 'Plain', footprint: [5, 1, 6, 2], door: { x: 5, y: 3 } },
      ],
    };
    const scene = composeScene('town', townDef);
    const renderer = Object.create(CanvasRenderer.prototype);
    renderer.scene = scene; renderer.cameraX = 0; renderer.cameraY = 0;
    renderer.canvas = { width: 4096, height: 4096 };
    let fillRects = 0, drawImages = 0;
    const ctx = {
      fillStyle: '', imageSmoothingEnabled: true,
      fillRect() { fillRects += 1; },
      drawImage() { drawImages += 1; },
      save() {}, restore() {},
    };
    assert.doesNotThrow(() => renderer.renderBuildingSilhouettes(ctx));
    assert.ok(fillRects > 0 || drawImages > 0, 'the fishing-hut sprite must blit into its footprint');

    const bare = Object.create(CanvasRenderer.prototype);
    bare.scene = composeScene('town', { ...townDef, buildings: [townDef.buildings[1]] });
    bare.cameraX = 0; bare.cameraY = 0; bare.canvas = { width: 4096, height: 4096 };
    let plainFills = 0;
    bare.renderBuildingSilhouettes({ ...ctx, fillRect() { plainFills += 1; }, drawImage() { plainFills += 1; } });
    assert.equal(plainFills, 0, 'a building with no matching silhouette is a no-op');
  });

  await t.test('8. committed before/after proof PNGs match a fresh export (no drift)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liv109-proof-'));
    try {
      exportProof(tmp);
      for (const pair of PROOF_PAIRS) {
        for (const suffix of ['_before.png', '_after.png', '_before_after.png']) {
          const f = `${pair.id}${suffix}`;
          assert.ok(fs.existsSync(path.join(PHASE1, f)), `${f} committed`);
          assert.ok(
            fs.readFileSync(path.join(PHASE1, f)).equals(fs.readFileSync(path.join(tmp, f))),
            `after/before proof drift: ${f}`
          );
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
