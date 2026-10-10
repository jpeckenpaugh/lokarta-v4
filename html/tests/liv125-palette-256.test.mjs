import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAKED_ALPHABET,
  BAKED_OPAQUE_BUDGET,
  BAKED_PALETTE_CAP,
  BAKED_TRANSPARENT_KEY,
  canonicalPaletteOrder,
  quantize,
  luma,
} from '../../tools/gltf-to-sprite.mjs';
import {
  paletteCapFor,
  isBaked3d,
  validateSpriteDef,
  BAKED_3D_PALETTE_CAP,
} from '../../tools/validate-sprite-def.mjs';
import { BUILDING_CATALOG, PROP_CATALOG, SPRITE_CATALOG } from '../assets/sprites/index.js';

// LIV-125 (§11.3): lock the concrete 256-code frame encoding + the 255-opaque
// budget. The 3D-baked per-pixel key must be ONE code unit per pixel (no
// multi-character key spill), one code = one opaque palette colour, and exactly
// one code reserved for transparent. The alphabet is deterministic and shared
// across all 11 scoped defs.

const SCOPE = [
  ...['fishing_hut', 'fishing_hut_back', 'fishing_hut_large', 'fishing_hut_left', 'fishing_hut_right', 'fishers_house', 'fishers_house_large', 'longhouse'].map((id) => BUILDING_CATALOG[id]),
  ...[PROP_CATALOG.prop_fishers_net, PROP_CATALOG.prop_fishers_net_vertical],
  SPRITE_CATALOG.archer,
];

function hexRGB(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

test('LIV-125 256-code 3D-baked frame encoding + budget', async (t) => {
  await t.test('1. budget is 255 opaque / 256 slots and the alphabet is one code per colour', () => {
    assert.equal(BAKED_OPAQUE_BUDGET, 255, '255 opaque colours');
    assert.equal(BAKED_PALETTE_CAP, 256, '255 opaque + transparent');
    assert.equal(BAKED_TRANSPARENT_KEY, '.', 'transparent stays the conventional .');
    assert.equal(BAKED_ALPHABET.length, 255, 'one code per opaque colour');
    assert.equal(BAKED_3D_PALETTE_CAP, 256, 'paletteCapFor 3D-baked ceiling');
  });

  await t.test('2. every code is exactly one code unit and never spills into a multi-char key', () => {
    const seen = new Set();
    for (const ch of BAKED_ALPHABET) {
      // One UTF-16 code unit: BMP, never an astral surrogate pair.
      assert.equal(ch.length, 1, `code ${JSON.stringify(ch)} is one code unit`);
      assert.ok(ch.charCodeAt(0) <= 0xffff, `code ${JSON.stringify(ch)} is BMP`);
      // JSON-escaped glyphs would cost 6 bytes/px; require none of them.
      assert.equal(JSON.stringify(ch).length, 3, `code ${JSON.stringify(ch)} must not be JSON-escaped`);
      assert.notEqual(ch, BAKED_TRANSPARENT_KEY, 'no opaque code collides with the transparent slot');
      assert.ok(!seen.has(ch), `code ${JSON.stringify(ch)} repeated`);
      seen.add(ch);
    }
  });

  await t.test('3. the alphabet is a compact mix of 1-byte ASCII and 2-byte BMP codes', () => {
    const ascii = BAKED_ALPHABET.filter((c) => c.charCodeAt(0) < 0x80);
    const bmp = BAKED_ALPHABET.filter((c) => c.charCodeAt(0) >= 0x80);
    assert.ok(ascii.length > 0, 'ASCII codes (1 byte/px) lead the alphabet');
    assert.equal(ascii.length + bmp.length, 255);
    // The cheap ASCII codes come first so canonical darkest entries are smallest.
    assert.ok(ascii.every((c) => c.charCodeAt(0) < 0x80));
    assert.ok(bmp.every((c) => c.charCodeAt(0) >= 0x100), 'BMP codes avoid the escaped C1 range');
    assert.deepEqual(BAKED_ALPHABET, [...ascii, ...bmp], 'ASCII tier precedes the BMP tier');
  });

  await t.test('4. a full-width frame of every code round-trips as native.w code units', () => {
    const row = BAKED_ALPHABET.join('') + BAKED_TRANSPARENT_KEY;
    assert.equal(row.length, 256, 'one code unit per pixel');
    const palette = { [BAKED_TRANSPARENT_KEY]: null };
    BAKED_ALPHABET.forEach((ch, i) => { palette[ch] = `#${i.toString(16).padStart(2, '0')}0000`; });
    const def = { id: 'probe', renderTier: 'baked', baked3d: true, palette, native: { w: row.length, h: 1 }, frames: { only: [row] } };
    assert.deepEqual(validateSpriteDef(def, { label: 'probe' }).errors, [], 'a 256-slot def validates');
    assert.equal(paletteCapFor(def), 256);
    // Every pixel is addressable as row[x] with a single code-unit index.
    for (let x = 0; x < row.length; x++) assert.equal(row[x].length, 1);
  });

  await t.test('5. quantize(keys) emits alphabet codes, transparent stays .', () => {
    const palette = canonicalPaletteOrder([[10, 10, 10], [200, 200, 200], [120, 60, 30]]);
    const sprite = { w: 3, h: 1, rgba: new Float32Array([10, 10, 10, 255, 200, 200, 200, 255, 0, 0, 0, 0]) };
    const rows = quantize(sprite, palette, BAKED_ALPHABET);
    assert.equal(rows[0].length, 3);
    assert.equal(rows[0][2], '.', 'transparent');
    for (const ch of rows[0]) assert.ok(ch === '.' || BAKED_ALPHABET.includes(ch), `alphabet-safe ${JSON.stringify(ch)}`);
  });

  await t.test('6. canonicalPaletteOrder dedupes + sorts by ascending luma deterministically', () => {
    const out = canonicalPaletteOrder([[200, 200, 200], [10, 10, 10], [10, 10, 10], [120, 60, 30]]);
    assert.equal(out.length, 3, 'duplicates removed');
    const ls = out.map((c) => luma(...c));
    for (let i = 1; i < ls.length; i++) assert.ok(ls[i] >= ls[i - 1], 'ascending luma');
    assert.deepEqual(canonicalPaletteOrder([[120, 60, 30], [10, 10, 10], [200, 200, 200]]), out, 'order-independent');
  });

  await t.test('7. every scoped def decodes to native.w code units with a 1-unit key per entry', () => {
    for (const def of SCOPE) {
      assert.ok(isBaked3d(def), `${def.id} is 3D-baked`);
      assert.ok(Object.keys(def.palette).length <= 256, `${def.id} <= 256 slots`);
      for (const k of Object.keys(def.palette)) assert.equal(k.length, 1, `${def.id} key ${JSON.stringify(k)} is one code unit`);
      for (const rows of Object.values(def.frames)) {
        assert.equal(rows.length, def.native.h, `${def.id} rows`);
        for (const row of rows) assert.equal(row.length, def.native.w, `${def.id} row width in code units`);
      }
      assert.deepEqual(validateSpriteDef(def, { label: def.id }).errors, [], def.id);
    }
  });
});
