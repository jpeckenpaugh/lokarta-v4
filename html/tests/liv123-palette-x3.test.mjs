import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAKED_ALPHABET,
  BAKED_OPAQUE_BUDGET,
  BAKED_PALETTE_CAP,
  rampPalette,
  quantizeRamp,
  luma,
} from '../../tools/gltf-to-sprite.mjs';
import {
  paletteCapFor,
  isBaked3d,
  resolveRenderTier,
  validateSpriteDef,
  nativePerTile,
  BAKED_3D_PALETTE_CAP,
  NATIVE_TILE,
} from '../../tools/validate-sprite-def.mjs';
import { BUILDING_CATALOG, PROP_CATALOG, SPRITE_CATALOG } from '../assets/sprites/index.js';

// LIV-123 (Phase B of LIV-116) raised the 3D-baked palette 25 -> 75. LIV-125
// (Phase B of LIV-116 rev 4, art-direction.md §11) takes it the rest of the way
// to the full 8-bit palette: up to 255 opaque colours (256 slots) via direct
// quantization, replacing the retired 5x15 ramp-family model. This file keeps
// the "the 11 scoped defs ship the richer palette, 1:1 N64 + non-3D unchanged"
// regression; the concrete 256-code encoding is locked in
// `liv125-palette-256.test.mjs`.

const BUILDINGS = [
  'fishing_hut', 'fishing_hut_back', 'fishing_hut_large', 'fishing_hut_left',
  'fishing_hut_right', 'fishers_house', 'fishers_house_large', 'longhouse',
];
const PROPS = ['prop_fishers_net', 'prop_fishers_net_vertical'];

/** The 11 scoped defs -> their runtime catalog entry. */
const SCOPE = [
  ...BUILDINGS.map((id) => ['building', id]),
  ...PROPS.map((id) => ['prop', id]),
  ['actor', 'archer'],
];

function defFor(kind, id) {
  return kind === 'building' ? BUILDING_CATALOG[id] : kind === 'prop' ? PROP_CATALOG[id] : SPRITE_CATALOG[id];
}
function hexRGB(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function opaqueColors(def) { return Object.entries(def.palette).filter(([k, v]) => v && k !== '.'); }
function usedChars(def) {
  const used = new Set();
  for (const rows of Object.values(def.frames)) for (const row of rows) for (const ch of row) if (ch !== '.') used.add(ch);
  return used.size;
}

test('LIV-123/LIV-125 3D-baked palette capacity (75 -> 255 opaque)', async (t) => {
  await t.test('1. the fixed alphabet is single-code-unit, unique, and covers the full 8-bit budget', () => {
    assert.equal(BAKED_OPAQUE_BUDGET, 255);
    assert.equal(BAKED_ALPHABET.length, 255, '255 opaque codes');
    assert.equal(new Set(BAKED_ALPHABET).size, 255, 'codes are unique');
    assert.equal(BAKED_PALETTE_CAP, 256, '255 opaque + the transparent slot');
    assert.ok(!BAKED_ALPHABET.includes('.'), 'the transparent slot is separate');
    for (const ch of BAKED_ALPHABET) assert.equal(ch.length, 1, `code ${JSON.stringify(ch)} is one code unit`);
    assert.equal(BAKED_3D_PALETTE_CAP, 256, 'the 3D-baked ceiling is the full 8-bit palette');
  });

  await t.test('2. each of the 11 scoped defs ships ~255 opaque colours (far above the prior 75)', () => {
    for (const [kind, id] of SCOPE) {
      const def = defFor(kind, id);
      assert.ok(def, `${id} registered`);
      assert.equal(resolveRenderTier(def), 'baked', `${id} is Tier B`);
      assert.equal(isBaked3d(def), true, `${id} declares the 3D-baked source`);
      assert.equal(paletteCapFor(def), 256, `${id} uses the full 8-bit 3D-baked ceiling`);
      const entries = Object.keys(def.palette).length;
      assert.ok(entries <= 256, `${id} palette ${entries} <= 256`);
      const opaque = opaqueColors(def);
      assert.ok(opaque.length >= 250, `${id} ships ~255 opaque colours (got ${opaque.length})`);
      assert.ok(new Set(opaque.map(([, v]) => v)).size >= 250, `${id} has >=250 distinct colours`);
      // The visible used-colour count is far above the retired 75-colour cap.
      assert.ok(usedChars(def) >= 250, `${id} uses >=250 colours (got ${usedChars(def)})`);
      assert.deepEqual(validateSpriteDef(def, { label: id }).errors, [], id);
      assert.deepEqual(def.quantize, { method: 'median-cut', budget: 255 }, `${id} declares direct quantization`);
    }
  });

  await t.test('3. the 1:1 (N64) native render + geometry are unchanged', () => {
    for (const [kind, id] of SCOPE) {
      const def = defFor(kind, id);
      if (def.tiles) {
        assert.equal(nativePerTile(def), 64, `${id} stays N64 (1:1)`);
        assert.deepEqual(def.native, { w: def.tiles.w * 64, h: def.tiles.h * 64 }, `${id} native == tiles*64`);
      } else {
        assert.deepEqual(def.native, { w: 64, h: 64 }, `${id} single-tile canvas is 64x64`);
      }
      for (const rows of Object.values(def.frames)) {
        assert.equal(rows.length, def.native.h, `${id} frame rows`);
        assert.ok(rows.every((r) => r.length === def.native.w), `${id} frame width`);
      }
    }
  });

  await t.test('4. the palette is emitted in canonical ascending-luma order (deterministic re-bakes)', () => {
    for (const [kind, id] of SCOPE) {
      const def = defFor(kind, id);
      let prev = -1;
      for (const [, v] of opaqueColors(def)) {
        const L = luma(...hexRGB(v));
        assert.ok(L >= prev - 1e-6, `${id} palette not in ascending-luma order`);
        prev = L;
      }
    }
  });

  await t.test('5. non-3D art is untouched: 2D-derived baked stays <=32, Tier A stays N32', () => {
    // A 2D-derived Tier B def (no `baked3d` marker) keeps the base 32-entry cap.
    const derived = { renderTier: 'baked', palette: {} };
    assert.equal(isBaked3d(derived), false, 'a 2D-derived bake is not 3D-baked');
    assert.equal(paletteCapFor(derived), 32, '2D-derived baked cap stays 32');
    // Flat Tier A actors keep 16 / native 32.
    for (const id of ['shadow_cultist', 'giant_rat', 'magician']) {
      const def = SPRITE_CATALOG[id];
      assert.equal(resolveRenderTier(def), 'indexed', `${id} stays Tier A`);
      assert.equal(paletteCapFor(def), 16, `${id} indexed cap stays 16`);
      assert.equal(nativePerTile(def), NATIVE_TILE, `${id} stays N32`);
    }
    // The only 3D-baked runtime defs are the rigged archer (LIV-110) and the
    // LIV-134 3D-baked NPC actors; every other catalog actor stays non-3D.
    for (const [id, def] of Object.entries(SPRITE_CATALOG)) {
      if (isBaked3d(def)) {
        assert.ok(id === 'archer' || def.kind === 'npc', `${id} is an expected 3D-baked class`);
        continue;
      }
      assert.equal(resolveRenderTier(def), 'indexed', `${id} stays non-3D (indexed)`);
    }
  });

  await t.test('6. the legacy ramp helpers still work (used by the unchanged 2D-derived path)', () => {
    // A sparse single-material ramp: only two luma clusters present.
    const px = [];
    for (let i = 0; i < 40; i++) px.push([60, 30, 20]);
    for (let i = 0; i < 40; i++) px.push([220, 150, 110]);
    const ramp = rampPalette(px, { families: 1, steps: 15, keys: BAKED_ALPHABET });
    assert.equal(ramp.colors.length, 15, 'fills every empty step');
    assert.equal(ramp.keys.length, 15, 'one key per colour');
    assert.equal(ramp.keys[0], BAKED_ALPHABET[0], 'keys come from the baked alphabet');
    const lum = ramp.colors.map((c) => luma(...c));
    for (let i = 0; i < lum.length; i++) assert.ok(i === 0 || lum[i] > lum[i - 1], `step ${i} strictly increasing`);
    const sprite = { w: 4, h: 1, rgba: new Float32Array([220, 150, 110, 255, 60, 30, 20, 255, 0, 0, 0, 0, 220, 150, 110, 255]) };
    const rows = quantizeRamp(sprite, ramp);
    assert.equal(rows[0].length, 4, 'one char per pixel');
    assert.equal(rows[0][2], '.', 'transparent stays .');
    for (const ch of rows[0]) assert.ok(ch === '.' || BAKED_ALPHABET.includes(ch), `palette-safe char ${ch}`);
  });
});
