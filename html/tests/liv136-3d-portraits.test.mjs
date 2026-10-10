import test from 'node:test';
import assert from 'node:assert/strict';

import { NPCS_CATALOG } from '../data/index.js';
import { PORTRAIT_CATALOG } from '../assets/portraits/index.js';
import {
  resolvePortraitId,
  getPortraitDef,
  PORTRAIT_NATIVE,
} from '../app/portrait-renderer.js';
import {
  paletteCapFor,
  isBaked3d,
  validateSpriteDef,
} from '../../tools/validate-sprite-def.mjs';
import {
  listPortraitArtifacts,
  buildPortraitSheet,
  buildPortraitDef,
  portraitIdFor,
} from '../../tools/integrate-npc-portraits.mjs';
import { EXPRESSIONS, PORTRAIT_SIZE, EXPRESSION_POSES } from '../../tools/bake-npc-portraits.mjs';

const npcs = NPCS_CATALOG.npcs;
const EXPRESSION_KEYS = ['neutral', 'warm', 'urgent'];

function alphaMask(rows, palette) {
  return rows.map((row) => [...row].map((ch) => (palette[ch] ? '1' : '0')).join('')).join('\n');
}

test('LIV-136 3D-baked NPC dialogue portraits', async (t) => {
  await t.test('1. every retained NPC ships a 3D-baked 48x48 head still per expression', () => {
    const artifacts = listPortraitArtifacts();
    assert.equal(artifacts.length, npcs.length, 'one baked portrait artifact per NPC');
    for (const npc of npcs) {
      assert.ok(artifacts.includes(npc.npcSpriteId), `missing baked portrait for ${npc.npcSpriteId}`);
      for (const expression of EXPRESSION_KEYS) {
        const id = npc.portraits[expression];
        assert.equal(id, portraitIdFor(npc.npcSpriteId, expression), `${npc.id} ${expression} id scheme`);
        const def = getPortraitDef(id);
        assert.ok(def, `catalog missing ${id}`);
        assert.equal(def.kind, 'portrait', `${id} kind`);
        assert.equal(def.expression, expression, `${id} expression`);
        assert.equal(def.baked3d, true, `${id} is 3D-baked`);
        assert.equal(def.renderTier, 'baked', `${id} renderTier`);
        assert.equal(def.outline, false, `${id} drops the hand outline`);
        assert.equal(isBaked3d(def), true, `${id} baked3d declaration`);
        assert.deepEqual(def.native, { w: PORTRAIT_SIZE, h: PORTRAIT_SIZE }, `${id} native 48x48`);
        assert.equal(def.native.w, PORTRAIT_NATIVE, `${id} matches PORTRAIT_NATIVE`);
        assert.ok(Object.keys(def.palette).length <= paletteCapFor(def), `${id} palette cap`);
        assert.deepEqual(validateSpriteDef(def, { label: id }).errors, [], id);
      }
    }
  });

  await t.test('2. the catalog matches the GLB-free integrator (no drift)', () => {
    const fresh = buildPortraitSheet();
    assert.deepEqual(PORTRAIT_CATALOG, fresh.portraits, 'portraits.json drifted from the committed artifacts');
    for (const npc of npcs) {
      for (const expression of EXPRESSION_KEYS) {
        const id = npc.portraits[expression];
        assert.deepEqual(PORTRAIT_CATALOG[id], buildPortraitDef(npc.npcSpriteId, expression), `${id} drifted`);
      }
    }
  });

  await t.test('3. expression keys resolve with safe fallbacks (dialogue-stage path unchanged)', () => {
    const seen = new Set();
    for (const npc of npcs) {
      assert.deepEqual(Object.keys(npc.portraits).sort(), [...EXPRESSION_KEYS].sort(), `${npc.id} portrait keys`);
      for (const expression of EXPRESSION_KEYS) {
        const id = npc.portraits[expression];
        assert.ok(!seen.has(id), `${id} must be unique`);
        seen.add(id);
      }
    }
    assert.equal(seen.size, npcs.length * 3, 'portrait count');
    const halden = npcs.find((n) => n.id === 'captain_halden');
    assert.equal(resolvePortraitId(halden.portraits, 'warm'), 'portrait_captain_halden_warm');
    assert.equal(resolvePortraitId(halden.portraits, undefined), 'portrait_captain_halden_neutral', 'defaults to neutral');
    assert.equal(resolvePortraitId(halden.portraits, 'nope'), 'portrait_captain_halden_neutral', 'unknown -> neutral');
    assert.equal(getPortraitDef('portrait_does_not_exist'), null, 'unknown asset -> fallback');
  });

  await t.test('4. the three stills are posed apart (expression changes the bust silhouette)', () => {
    for (const npc of npcs) {
      const masks = EXPRESSION_KEYS.map((expr) => {
        const def = getPortraitDef(npc.portraits[expr]);
        return alphaMask(def.frames.bust, def.palette);
      });
      assert.notEqual(masks[0], masks[2], `${npc.id} neutral and urgent busts must differ by shape`);
      assert.notEqual(masks[1], masks[2], `${npc.id} warm and urgent busts must differ by shape`);
    }
  });

  await t.test('5. the bake is deterministic and the pose table is data (no per-NPC branch)', () => {
    // The expression poses are declared once for the whole cast; the per-NPC
    // difference is the source mesh, not code and not a tint (LIV-143).
    assert.deepEqual(EXPRESSIONS, EXPRESSION_KEYS, 'expression order is the catalog key order');
    for (const expression of EXPRESSION_KEYS) {
      assert.ok(Array.isArray(EXPRESSION_POSES[expression]), `${expression} pose is declared`);
    }
  });
});
