import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { luma } from '../../tools/gltf-to-sprite.mjs';
import {
  validateSpriteDef,
  resolveRenderTier,
  paletteCapFor,
} from '../../tools/validate-sprite-def.mjs';
import {
  PHASE2_ASSETS,
  PHASE2_DIR,
  deriveTierB,
  exportPhase2,
  readSource,
  beforeDefFor,
} from '../../tools/derive-tierb-from-2d.mjs';

// LIV-110 (Phase 2): the 4 player vocations + 4 bosses move to the Tier B
// "baked" / SNES-plus read. With no 3D source and no meshy.ai access, the 3 new
// vocations and 4 bosses are DERIVED from the flat Tier A art through the same
// ramp/dither/135deg-key-light/rim stage (tools/derive-tierb-from-2d.mjs).
// archer's Tier B is the Phase 1 3D-baked artifact. Tier A defaults stay put.

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
function hexRGB(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function readDef(file) { return JSON.parse(fs.readFileSync(path.join(PHASE2_DIR, file), 'utf8')); }
/** Usable ramp chars in authored order: excludes the `.` transparent + `0` outline. */
function rampChars(def) { return Object.keys(def.palette).filter((c) => def.palette[c] && c !== '.' && c !== '0'); }
/** Material (non-outline) opaque mask of a frame, as a row string. */
function materialMask(rows, palette) {
  return rows.map((r) => [...r].map((ch) => (ch !== '.' && ch !== '0' && palette[ch] ? '#' : '.')).join(''));
}

const PHASE2_IDS = PHASE2_ASSETS.map((a) => a.id);
const BOSS_IDS = ['abyssal_overlord', 'tidebound_king', 'forgemaster_kol', 'frostbound_choirmaster'];
const VOCATION_IDS = ['magician', 'paladin', 'fighter'];

test('LIV-110 Tier B baked Phase 2', async (t) => {
  await t.test('1. all 7 derived defs validate as Tier B within the <=32 palette cap', () => {
    for (const id of PHASE2_IDS) {
      const def = readDef(`${id}_baked.sprite.json`);
      assert.equal(resolveRenderTier(def), 'baked', `${id} declares renderTier baked`);
      assert.equal(paletteCapFor(def), 32);
      const entries = Object.keys(def.palette).length;
      assert.ok(entries <= 32, `${id} palette ${entries} <= 32`);
      assert.deepEqual(validateSpriteDef(def, { label: id }).errors, [], id);
      assert.equal(def.palette['0'], '#0b0d12', `${id} keeps the 1px #0b0d12 outline`);
      assert.ok(def.frames.idle_down.some((r) => r.includes('0')), `${id} bakes the outline into frames`);
    }
  });

  await t.test('2. vocations are 32x32 actors, bosses are 48x48 entities', () => {
    for (const id of VOCATION_IDS) {
      const def = readDef(`${id}_baked.sprite.json`);
      assert.deepEqual(def.native, { w: 32, h: 32 }, `${id} is a 32x32 actor`);
      assert.equal(def.tiles, undefined);
    }
    for (const id of BOSS_IDS) {
      const def = readDef(`${id}_baked.sprite.json`);
      assert.deepEqual(def.native, { w: 48, h: 48 }, `${id} is a 48x48 boss`);
      assert.equal(def.tiles, undefined, 'boss stays a single-tile entity');
    }
  });

  await t.test('3. the remaining 3 vocations + archer all read as Tier B', () => {
    const archer = JSON.parse(fs.readFileSync(path.join(POC, 'rukiya_archer_baked.sprite.json'), 'utf8'));
    assert.equal(resolveRenderTier(archer), 'baked');
    assert.deepEqual(validateSpriteDef(archer, { label: 'archer' }).errors, []);
    assert.deepEqual(archer.native, { w: 32, h: 32 });
    for (const id of VOCATION_IDS) {
      assert.equal(resolveRenderTier(readDef(`${id}_baked.sprite.json`)), 'baked');
    }
  });

  await t.test('4. every baked family is a strictly-increasing >=4-step ramp with a rim clearing 3:1', () => {
    for (const id of PHASE2_IDS) {
      const def = readDef(`${id}_baked.sprite.json`);
      const chars = rampChars(def);
      assert.equal(chars.length % 4, 0, `${id} usable colours form whole 4-step ramps`);
      const best = Math.max(0, ...Object.values(def.palette).filter(Boolean).map((v) => contrast(v, FLOOR)));
      assert.ok(best >= 3.0, `${id} best rim contrast ${best.toFixed(2)} < 3.0`);
      let rimCarrier = false;
      for (let f = 0; f < chars.length / 4; f++) {
        const slice = chars.slice(f * 4, f * 4 + 4);
        const lum = slice.map((c) => luma(...hexRGB(def.palette[c])));
        for (let i = 0; i < lum.length; i++) assert.ok(i === 0 || lum[i] > lum[i - 1], `${id} family ${f} ramp step ${i} not lighter than ${i - 1}`);
        if (contrast(def.palette[slice[3]], FLOOR) >= 3.0) rimCarrier = true;
      }
      assert.ok(rimCarrier, `${id} rim (brightest ramp step) must carry the 3:1 read`);
    }
  });

  await t.test('5. the derived bake is a real ramp upgrade and never changes the silhouette', () => {
    for (const asset of PHASE2_ASSETS) {
      const before = beforeDefFor(asset);
      const after = readDef(`${asset.id}_baked.sprite.json`);
      assert.equal(resolveRenderTier(before), 'indexed', `${asset.id} before art stays Tier A`);
      assert.ok(
        rampChars(after).length > rampChars(before).length,
        `${asset.id} baked has more usable colours than its flat before`
      );
      // Shading only ever rewrites interior colours; the opaque material mask is
      // identical frame-for-frame, so gameplay collision/read is unchanged.
      for (const fid of Object.keys(before.frames)) {
        assert.deepEqual(
          materialMask(after.frames[fid], after.palette),
          materialMask(before.frames[fid], before.palette),
          `${asset.id} frame ${fid} silhouette drifted`
        );
      }
    }
  });

  await t.test('6. derivation is deterministic: a fresh export byte-matches the committed set', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liv110-phase2-'));
    try {
      exportPhase2(tmp);
      for (const f of fs.readdirSync(PHASE2_DIR).sort()) {
        assert.ok(fs.existsSync(path.join(tmp, f)), `${f} produced by export`);
        assert.ok(
          fs.readFileSync(path.join(PHASE2_DIR, f)).equals(fs.readFileSync(path.join(tmp, f))),
          `drift: ${f}`
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('7. committed before/after proof PNGs exist for every new Phase 2 asset', () => {
    for (const id of PHASE2_IDS) {
      for (const suffix of ['_before.png', '_after.png', '_before_after.png']) {
        assert.ok(fs.existsSync(path.join(PHASE2_DIR, `${id}${suffix}`)), `${id}${suffix} committed`);
      }
    }
    // Phase 1's archer proof stays valid/committed as the archer's Tier B.
    for (const suffix of ['_before.png', '_after.png', '_before_after.png']) {
      assert.ok(fs.existsSync(path.join(PHASE1, `archer${suffix}`)), `archer${suffix} (Phase 1) committed`);
    }
  });

  await t.test('8. Tier A defaults are untouched (archer is the one integrated Tier B actor)', () => {
    const runtime = [
      'html/assets/sprites/vocations/magician.json',
      'html/assets/sprites/vocations/paladin.json',
      'html/assets/sprites/vocations/fighter.json',
      'html/assets/sprites/monsters/abyssal_overlord.json',
    ];
    for (const rel of runtime) {
      const def = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      assert.equal(resolveRenderTier(def), 'indexed', `${rel} stays Tier A (no renderTier)`);
      assert.equal(paletteCapFor(def), 16);
      assert.ok(Object.keys(def.palette).length <= 16, `${rel} palette stays <= 16`);
      assert.deepEqual(validateSpriteDef(def, { label: rel }).errors, []);
    }
    // archer is the board-requested runtime integration: the live actor is the
    // baked rukiya sprite (Tier B, <=32 palette).
    const archer = JSON.parse(fs.readFileSync(path.join(ROOT, 'html/assets/sprites/vocations/archer.json'), 'utf8'));
    assert.equal(resolveRenderTier(archer), 'baked', 'live archer is the Tier B rukiya bake');
    assert.ok(Object.keys(archer.palette).length <= 32);
  });

  await t.test('9. deriveTierB keeps source geometry and is reusable for a new source', () => {
    const src = readSource('html/assets/sprites/vocations/magician.json');
    const def = deriveTierB(src, { id: 'magician_probe' });
    assert.deepEqual(def.native, src.native);
    assert.deepEqual(def.anchor, src.anchor);
    assert.deepEqual(Object.keys(def.frames), Object.keys(src.frames));
    assert.equal(resolveRenderTier(def), 'baked');
    assert.deepEqual(validateSpriteDef(def, { label: 'probe' }).errors, []);
  });
});
