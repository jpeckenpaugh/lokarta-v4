import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCameraBaseline,
  isBaked3d,
  isActorDef,
  CAMERA_BASELINE,
} from '../../tools/validate-sprite-def.mjs';
import { BUILDING_CATALOG, PROP_CATALOG, SPRITE_CATALOG } from '../assets/sprites/index.js';

// LIV-129 (parent LIV-126 plan rev 1): the board-accepted 3D→2D perspective
// baseline. Every **3D-baked** def (keyed on `baked3d`, NOT `renderTier`) must
// record a `camera` block matching art-direction.md §12 — a Top-Down Oblique
// "3/4" orthographic camera at 60° from the horizon for buildings/props. The
// rigged-actor class is the documented exception (§12.1): it stays shallower
// than 60°, so it is exempt from the rise-60 assertion by design.

/** The 10 conforming buildings/props re-baked at the baseline (LIV-129). */
const BASELINE_DEFS = [
  ...['fishing_hut', 'fishing_hut_back', 'fishing_hut_large', 'fishing_hut_left', 'fishing_hut_right',
    'fishers_house', 'fishers_house_large', 'longhouse'].map((id) => [id, BUILDING_CATALOG[id]]),
  ...['prop_fishers_net', 'prop_fishers_net_vertical'].map((id) => [id, PROP_CATALOG[id]]),
];

test('LIV-129 3D camera baseline — conformance', async (t) => {
  await t.test('1. every building/prop re-baked at the 60° baseline emits an orthographic camera', () => {
    for (const [id, def] of BASELINE_DEFS) {
      assert.ok(def, `${id} is registered`);
      assert.equal(isBaked3d(def), true, `${id} is a 3D-baked def (baked3d)`);
      assert.equal(isActorDef(def), false, `${id} is a building/prop, not the actor exception`);
      assert.deepEqual(validateCameraBaseline(def, { label: id }).errors, [], `${id} conforms to the camera baseline`);
      assert.ok(def.camera, `${id} records a camera block`);
      assert.equal(def.camera.projection, 'orthographic', `${id} is orthographic (parallel)`);
      assert.equal(def.camera.rise, CAMERA_BASELINE.rise, `${id} is at the 60°-from-horizon baseline`);
      assert.equal(def.camera.yaw, 0, `${id} documents a yaw (0 for this pass)`);
      // The recorded views must match the emitted `view_<az>` frames exactly, so
      // the camera metadata can never drift from the bake.
      const frameAz = Object.keys(def.frames).filter((k) => /^view_\d+$/.test(k)).map((k) => Number(k.slice(5))).sort((a, b) => a - b);
      assert.deepEqual([...def.camera.views].sort((a, b) => a - b), frameAz, `${id} camera.views match the view frames`);
    }
  });

  await t.test('2. the rigged actor is the documented exception (shallower than 60°), not a camera miss', () => {
    const archer = SPRITE_CATALOG.archer;
    assert.ok(archer, 'archer is registered');
    assert.equal(isBaked3d(archer), true, 'the archer is a 3D-baked def');
    assert.equal(isActorDef(archer), true, 'the archer is the actor class');
    // Per §12.1 the actor stays shallower than the 60° baseline pending a
    // separate actor look, so it is explicitly exempt rather than non-conforming
    // by omission. If it later carries a camera it must be < 60°.
    if (archer.camera) {
      assert.equal(archer.camera.projection, 'orthographic');
      assert.ok(archer.camera.rise < CAMERA_BASELINE.rise, `actor rise ${archer.camera.rise} < 60`);
    }
    assert.deepEqual(validateCameraBaseline(archer, { label: 'archer' }).errors, [], 'actor is exempt from the rise-60 assertion');
  });

  await t.test('3. a deliberately non-conforming fixture FAILS the assertion', () => {
    const base = { id: 'fixture', kind: 'building', renderTier: 'baked', baked3d: true, native: { w: 2, h: 2 }, palette: { '.': null }, frames: { view_0: ['.', '.'] } };
    // Wrong pitch (the pre-baseline side view).
    const side = { ...base, camera: { projection: 'orthographic', rise: 10, yaw: 0, views: [0] } };
    assert.ok(validateCameraBaseline(side, { label: 'side' }).errors.length > 0, 'rise 10 must fail');
    // Missing camera metadata entirely.
    assert.ok(validateCameraBaseline(base, { label: 'missing' }).errors.length > 0, 'missing camera must fail');
    // Wrong projection.
    const persp = { ...base, camera: { projection: 'perspective', rise: 60, yaw: 0, views: [0] } };
    assert.ok(validateCameraBaseline(persp, { label: 'persp' }).errors.some((e) => /orthographic/.test(e)), 'perspective must fail');
    // Camera view with no matching frame.
    const orphan = { ...base, camera: { projection: 'orthographic', rise: 60, yaw: 0, views: [45] } };
    assert.ok(validateCameraBaseline(orphan, { label: 'orphan' }).errors.some((e) => /view_45/.test(e)), 'orphan view must fail');
    // A grandfathered (non-baked3d) def is never flagged.
    assert.deepEqual(validateCameraBaseline({ id: 'grandfathered', renderTier: 'indexed', native: { w: 32, h: 32 } }, { label: 'g' }).errors, []);
  });
});
