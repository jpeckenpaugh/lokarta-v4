import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAKED_ALPHABET,
  BAKED_OPAQUE_BUDGET,
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

// LIV-123 (Phase B of LIV-116 rev 3): triple the 3D-baked palette capacity
// (25 -> 75 opaque) and regenerate the 11 scoped defs, preserving the 1:1 (N64)
// native render and the silhouette ground shadow. Tier A (indexed) and
// 2D-derived Tier B stay untouched. Art contract: art-direction.md §10 (LIV-122).

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

/** Adjacent relative-luma deltas across each family ramp of a 3D-baked def. */
function adjacentDeltas(def) {
  const steps = def.ramp.steps, families = def.ramp.families;
  const deltas = [];
  for (let f = 0; f < families; f++) {
    for (let s = 1; s < steps; s++) {
      const a = def.palette[BAKED_ALPHABET[f * steps + s - 1]];
      const b = def.palette[BAKED_ALPHABET[f * steps + s]];
      if (!a || !b) continue;
      const la = luma(...hexRGB(a)), lb = luma(...hexRGB(b));
      deltas.push(Math.abs(lb - la) / Math.max(1, la));
    }
  }
  return deltas;
}

test('LIV-123 3D-baked palette capacity ×3', async (t) => {
  await t.test('1. the fixed 76-slot key alphabet is single-char and >= the 75-opaque budget', () => {
    assert.equal(BAKED_OPAQUE_BUDGET, 75);
    assert.equal(BAKED_ALPHABET.length, 75, '75 opaque keys');
    assert.equal(new Set(BAKED_ALPHABET).size, 75, 'keys are unique');
    assert.ok(!BAKED_ALPHABET.includes('.'), 'the transparent slot is separate');
    for (const ch of BAKED_ALPHABET) assert.equal(ch.length, 1, `key "${ch}" is one char`);
    assert.equal(BAKED_3D_PALETTE_CAP, 96, 'the 3D-baked ceiling is 96');
  });

  await t.test('2. each of the 11 scoped defs ships ~75 opaque colours (3x the prior 25)', () => {
    for (const [kind, id] of SCOPE) {
      const def = defFor(kind, id);
      assert.ok(def, `${id} registered`);
      assert.equal(resolveRenderTier(def), 'baked', `${id} is Tier B`);
      assert.equal(isBaked3d(def), true, `${id} declares the 3D-baked source`);
      assert.equal(paletteCapFor(def), 96, `${id} uses the 3D-baked ceiling`);
      const entries = Object.keys(def.palette).length;
      assert.ok(entries <= 96, `${id} palette ${entries} <= 96`);
      const opaque = opaqueColors(def);
      assert.ok(opaque.length >= 75, `${id} ships ~75 opaque colours (got ${opaque.length})`);
      assert.ok(new Set(opaque.map(([, v]) => v)).size >= 75, `${id} has >=75 distinct colours`);
      // The visible used-colour count is measurably higher than the old 25.
      assert.ok(usedChars(def) > 25, `${id} uses more than the prior 24/25 colours (got ${usedChars(def)})`);
      assert.deepEqual(validateSpriteDef(def, { label: id }).errors, [], id);
      assert.deepEqual(def.ramp, { families: 5, steps: 15 }, `${id} default 5x15 ramp`);
    }
  });

  await t.test('3. the 1:1 (N64) native render + geometry are unchanged; the ramp is finer not coarser', () => {
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
      assert.ok(def.ramp.steps >= 12, `${id} has >= 12 steps/family (was 4)`);
      assert.ok(def.ramp.families >= 5, `${id} has >= 5 families`);
    }
  });

  await t.test('4. banding improved: adjacent-step luma deltas are far smaller than the old 4-step ramps', () => {
    for (const [kind, id] of SCOPE) {
      const def = defFor(kind, id);
      const d = adjacentDeltas(def).sort((a, b) => a - b);
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      const p90 = d[Math.floor(d.length * 0.9)];
      // The old 4-step ramps averaged 33-60% adjacent jumps (and peaked 70-115%).
      assert.ok(mean <= 0.15, `${id} mean adjacent luma delta ${(mean * 100).toFixed(1)}% <= 15%`);
      assert.ok(p90 <= 0.30, `${id} p90 adjacent luma delta ${(p90 * 100).toFixed(1)}% <= 30%`);
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
    // Every catalog actor except the one 3D-baked runtime def (archer) is untouched.
    for (const [id, def] of Object.entries(SPRITE_CATALOG)) {
      if (id === 'archer') continue;
      assert.equal(isBaked3d(def), false, `${id} is not 3D-baked`);
    }
  });

  await t.test('6. rampPalette keys drive quantizeRamp; a sparse family still fills a strict ramp', () => {
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
    // quantizeRamp emits the alphabet keys (indices >= 36 never spill to 2 chars).
    const sprite = { w: 4, h: 1, rgba: new Float32Array([220, 150, 110, 255, 60, 30, 20, 255, 0, 0, 0, 0, 220, 150, 110, 255]) };
    const rows = quantizeRamp(sprite, ramp);
    assert.equal(rows[0].length, 4, 'one char per pixel');
    assert.equal(rows[0][2], '.', 'transparent stays .');
    for (const ch of rows[0]) assert.ok(ch === '.' || BAKED_ALPHABET.includes(ch), `palette-safe char ${ch}`);
  });
});
