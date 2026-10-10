import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mat4Identity,
  mat4Multiply,
  mat4FromTRS,
  quatSlerp,
  quatNormalize,
  nodeLocalMatrix,
  worldMatrices,
  unionBounds,
  tileCanvasSize,
} from '../../tools/gltf-to-sprite.mjs';
import { nativePerTile, paletteCapFor } from '../../tools/validate-sprite-def.mjs';
import { buildArcherBaked, ARCHER_ANIMATIONS, RIGGED_ARTIFACT } from '../../tools/integrate-actor-bake.mjs';
import { archerPoses } from '../../tools/bake-rigged-archer.mjs';
import { getTownDefinition } from '../data/index.js';
import { BUILDING_CATALOG, SPRITE_CATALOG } from '../assets/sprites/index.js';

// LIV-111 (Phase 3): (A) the fisher's hut is re-baked at the board's four
// facings + three tile sizes and placed by orientation rule; (B) the rukiya
// archer is baked from the genuinely-rigged GLB by sampling its skeleton across
// the `Walking` clip — no longer a synthesized shear. These lock the new
// behavior so the rig bake and the town orientation cannot silently regress.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ARCHER = path.join(ROOT, 'html', 'assets', 'sprites', 'vocations', 'archer.json');
const FLOOR = '#1a1c23';

function luminance(hex) {
  const h = hex.replace('#', '');
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Facing frame the renderer will pick for a building variant. */
function facingFrame(def) {
  return (def.placement && def.placement.defaultFrame) || 'view_0';
}
function span(fp) { return [fp[2] - fp[0] + 1, fp[3] - fp[1] + 1]; }

test('LIV-111 rigged actor bake — skeleton sampling + animation helpers', async (t) => {
  await t.test('1. skin math: TRS composition, world matrices, union bounds', () => {
    // A parent translated (10,0,0) and a child translated (0,5,0) compose to (10,5,0).
    const parent = mat4FromTRS([10, 0, 0]);
    const child = mat4FromTRS([0, 5, 0]);
    const composed = mat4Multiply(parent, child);
    assert.equal(composed[12], 10);
    assert.equal(composed[13], 5);
    assert.deepEqual([...mat4Multiply(mat4Identity(), parent)], [...parent]);

    const nodes = [
      { translation: [10, 0, 0], children: [1] },
      { translation: [0, 5, 0] },
    ];
    const world = worldMatrices(nodes, [0]);
    assert.equal(world[1][12], 10);
    assert.equal(world[1][13], 5);
    // nodeLocalMatrix reads an explicit matrix when present.
    const m = [...mat4FromTRS([1, 2, 3])];
    assert.deepEqual([...nodeLocalMatrix({ matrix: m })], m);

    const b = unionBounds([
      { count: 1, pos: new Float32Array([0, 0, 0]) },
      { count: 1, pos: new Float32Array([4, 8, -2]) },
    ]);
    assert.deepEqual([b.mnx, b.mny, b.mnz, b.mxx, b.mxy, b.mxz], [0, 0, -2, 4, 8, 0]);
  });

  await t.test('2. quaternion slerp interpolates and normalizes; 180-degree path is safe', () => {
    const a = [0, 0, 0, 1];
    const b = quatNormalize([0, 1, 0, 0]);
    const half = quatSlerp(a, b, 0.5);
    assert.ok(Math.abs(Math.hypot(...half) - 1) < 1e-6, 'slerp stays unit-length');
    assert.ok(half[1] > 0 && half[1] < 1, 'slerp moved toward the target');
  });

  await t.test('3. the committed archer artifact is a real skinned bake of the Walking clip', () => {
    const art = JSON.parse(fs.readFileSync(RIGGED_ARTIFACT, 'utf8'));
    assert.equal(art.renderTier, 'baked');
    assert.equal(art.clip, 'Walking', 'baked from the rigged clip, not a static pose');
    assert.match(art.method, /skinned-skeleton-sample/);
    // LIV-121: the live rigged archer artifact is N64 (64 px per tile, 1:1).
    assert.deepEqual(art.native, { w: 64, h: 64 });
    assert.equal(art.tiles, undefined, 'actor stays one tile');
    // One frame per runtime id, and a palette inside the 3D-baked Tier B cap
    // (LIV-122: <=96 / ~75 opaque) with a rim clearing the 3:1 floor contrast.
    assert.equal(paletteCapFor(art), 96, 'Tier B 3D-baked palette ceiling');
    assert.ok(Object.keys(art.palette).length <= 96, 'Tier B palette cap');
    const best = Math.max(0, ...Object.values(art.palette).filter(Boolean).map((v) => contrast(v, FLOOR)));
    assert.ok(best >= 3.0, `archer rim contrast ${best.toFixed(2)} >= 3`);
    for (const rows of Object.values(art.frames)) {
      assert.equal(rows.length, 64);
      assert.ok(rows.every((r) => r.length === 64));
    }
  });

  await t.test('4. buildArcherBaked is GLB-free, deterministic, and matches the committed runtime', () => {
    // No .paperclip-repositories GLB is required here: the runtime def is built
    // purely from the committed artifact + the animation contract.
    const fresh = buildArcherBaked();
    const committed = JSON.parse(fs.readFileSync(ARCHER, 'utf8'));
    assert.deepEqual(committed, fresh, 'runtime archer must equal a fresh integration');
    assert.equal(committed.renderTier, 'baked');
    assert.equal(paletteCapFor(committed), 96, 'runtime archer is 3D-baked');
    assert.ok(Object.keys(committed.palette).length <= 96);
    assert.deepEqual(committed.animations, ARCHER_ANIMATIONS);
  });

  await t.test('5. directional walking animates + mirrors from the rig', () => {
    const art = JSON.parse(fs.readFileSync(RIGGED_ARTIFACT, 'utf8'));
    for (const dir of ['down', 'up', 'side']) {
      assert.notDeepEqual(art.frames[`walk_${dir}_0`], art.frames[`walk_${dir}_1`], `walk_${dir} steps`);
      assert.notDeepEqual(art.frames[`walk_${dir}_0`], art.frames[`idle_${dir}`], `walk_${dir} differs from idle`);
    }
    // The three facings are genuinely different baked views (the runtime mirrors
    // `side` for the opposite direction, so only one side needs baking).
    assert.notDeepEqual(art.frames.idle_down, art.frames.idle_up);
    assert.notDeepEqual(art.frames.idle_down, art.frames.idle_side);
    assert.notDeepEqual(art.frames.walk_side_0, art.frames.walk_up_0);
  });

  await t.test('6. idle + attack (draw/fire) poses are present and distinct from walking', () => {
    const art = JSON.parse(fs.readFileSync(RIGGED_ARTIFACT, 'utf8'));
    for (const dir of ['down', 'up', 'side']) {
      const idle = art.frames[`idle_${dir}`];
      const a0 = art.frames[`attack_${dir}_0`];
      const a1 = art.frames[`attack_${dir}_1`];
      const a2 = art.frames[`attack_${dir}_2`];
      assert.ok(idle && a0 && a1 && a2, `${dir}: idle + 3 attack frames present`);
      assert.notDeepEqual(a0, a1, `${dir} attack wind-up != release`);
      assert.notDeepEqual(a1, a2, `${dir} attack release != settle`);
      assert.notDeepEqual(a0, idle, `${dir} attack pose differs from idle`);
    }
  });

  await t.test('7. the runtime contract still holds (25 frame ids, same state table)', () => {
    const c = SPRITE_CATALOG.archer;
    const expected = {
      idle: { down: 1, up: 1, side: 1 },
      walk: { down: 2, up: 2, side: 2 },
      attack: { down: 3, up: 3, side: 3 },
      hit: { down: 1, up: 1, side: 1 },
      death: { down: 4, up: 4, side: 4 },
    };
    const ids = new Set();
    for (const [state, dirs] of Object.entries(expected)) {
      for (const [dir, n] of Object.entries(dirs)) {
        const list = c.animations[state][dir];
        assert.equal(list.length, n, `${state}.${dir}`);
        for (const fid of list) { assert.ok(c.frames[fid], `${state}.${dir} frame ${fid}`); ids.add(fid); }
      }
    }
    assert.equal(ids.size, Object.keys(c.frames).length, 'no orphan frames');
  });

  await t.test('8. LIV-112/121: upright N64 frames fill the tile; every frame stays grounded + inside', () => {
    // Regression: the rig bake normalized to the union pose bbox, which a
    // sunk death pose inflated, shrinking the drawn character inside the canvas.
    // The fix keeps the feet planted, so upright frames must read near full-tile
    // height with the head near the top and feet on the anchor. LIV-121 scales
    // the bounds with the def's own native size (N64 = 64 px, not 32).
    const c = SPRITE_CATALOG.archer;
    const N = c.native.w; // 64 (N64)
    const anchorY = c.anchor.y; // bottom-centre ground contact
    const bbox = (rows) => {
      let minx = N, maxx = -1, miny = N, maxy = -1;
      rows.forEach((r, y) => [...r].forEach((ch, x) => {
        if (ch === '.') return;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }));
      return { minx, maxx, miny, maxy, w: maxx - minx + 1, h: maxy - miny + 1 };
    };
    for (const state of ['idle', 'walk', 'attack', 'hit']) {
      for (const dir of ['down', 'up', 'side']) {
        for (const fid of c.animations[state][dir]) {
          const b = bbox(c.frames[fid]);
          assert.ok(b.h >= Math.round(N * 0.80), `${fid} fills the tile height (h=${b.h})`);
          assert.ok(b.miny <= Math.round(N * 0.12), `${fid} head nears the tile top (miny=${b.miny})`);
          assert.ok(b.maxy >= anchorY - 3 && b.maxy <= N - 1, `${fid} feet on the ground anchor (maxy=${b.maxy})`);
          assert.ok(b.minx >= 0 && b.maxx <= N - 1, `${fid} stays inside the tile`);
        }
      }
    }
    // Death frames collapse low, but must not clip or float above the ground.
    for (const dir of ['down', 'up', 'side']) {
      for (const fid of c.animations.death[dir]) {
        const b = bbox(c.frames[fid]);
        assert.ok(b.minx >= 0 && b.maxx <= N - 1 && b.miny >= 0 && b.maxy <= N - 1, `${fid} must not clip`);
        assert.ok(b.maxy >= anchorY - 3, `${fid} collapses onto the ground (maxy=${b.maxy})`);
      }
    }
  });

  await t.test('9. LIV-112: pose overrides are rotation-only so the rig stays planted', () => {
    // The `Walking` clip carries the Hips translation that plants the feet on
    // the ground. A pose override that set a Hips translation replaced it and
    // dropped the rig below the foot plane (the LIV-112 shrink). Guard it.
    const bones = {};
    for (const n of [
      'mixamorig:Spine1', 'mixamorig:Spine2', 'mixamorig:Hips',
      'mixamorig:LeftArm', 'mixamorig:RightArm', 'mixamorig:LeftForeArm', 'mixamorig:RightForeArm',
    ]) bones[n] = 0;
    const rest = () => [0, 0, 0, 1];
    const P = archerPoses(bones, rest);
    const all = [P.draw, P.fire, P.settle, P.recoil, ...P.death];
    for (const m of all) {
      for (const [, pose] of m) {
        assert.ok(!('translation' in pose), 'pose overrides must be rotation-only (no Hips translation clobber)');
      }
    }
  });
});

test('LIV-111 hut orientation — variants + Havenreach placement rules', async (t) => {
  await t.test('1. >=4 distinct hut variants are registered, sizes 2x3/3x4/4x3', () => {
    const town = getTownDefinition('town_havenreach');
    const silhouettes = new Set(town.buildings.map((b) => b.silhouette));
    assert.ok(silhouettes.size >= 4, `>=4 distinct variants, got ${[...silhouettes].join(', ')}`);
    const sizes = new Set();
    for (const s of silhouettes) {
      const def = BUILDING_CATALOG[s];
      assert.ok(def, `${s} registered`);
      sizes.add(`${def.tiles.w}x${def.tiles.h}`);
    }
    // LIV-114: the side-facing huts widened 3x3 -> 4x3 (stretched), so the
    // registered catalogue now spans 2x3 / 3x4 / 4x3 rather than 3x3.
    assert.ok(sizes.has('2x3') && sizes.has('4x3') && sizes.has('3x4'), `sizes must include 2x3/4x3/3x4, got ${[...sizes].join(', ')}`);
  });

  await t.test('2. orientation rules: top forward, left right-facing, right left-facing, bottom backward', () => {
    const town = getTownDefinition('town_havenreach');
    const MAP = { view_0: 'forward', view_90: 'right', view_270: 'left', view_180: 'back' };
    const rows = { top: [], left: [], right: [], bottom: [] };
    for (const b of town.buildings) {
      const def = BUILDING_CATALOG[b.silhouette];
      const facing = MAP[facingFrame(def)] || 'forward';
      const [x0, y0, x1, y1] = b.footprint;
      if (y1 <= 4) rows.top.push({ b, facing });
      else if (y0 >= 16) rows.bottom.push({ b, facing });
      else if (x0 <= 3) rows.left.push({ b, facing });
      else if (x1 >= 20) rows.right.push({ b, facing });
    }
    assert.equal(rows.top.length, 3, 'exactly 3 forward top-row huts');
    for (const { b, facing } of rows.top) assert.equal(facing, 'forward', `${b.id} must face forward`);
    assert.ok(rows.left.length >= 1, 'a left-side hut exists');
    for (const { b, facing } of rows.left) assert.equal(facing, 'right', `${b.id} on the left must be right-facing`);
    assert.ok(rows.right.length >= 1, 'a right-side hut exists');
    for (const { b, facing } of rows.right) assert.equal(facing, 'left', `${b.id} on the right must be left-facing`);
    assert.ok(rows.bottom.length >= 1 && rows.bottom.length <= 2, '1-2 bottom huts');
    for (const { b, facing } of rows.bottom) assert.equal(facing, 'back', `${b.id} at the bottom must be backward`);
  });

  await t.test('3. every placed hut\u2019s footprint matches its variant tile span', () => {
    const town = getTownDefinition('town_havenreach');
    for (const b of town.buildings) {
      const def = BUILDING_CATALOG[b.silhouette];
      assert.deepEqual(span(b.footprint), [def.tiles.w, def.tiles.h], `${b.id} footprint vs ${b.silhouette}`);
      // The baked canvas is exactly whole tiles at the def's own density (N64
      // for the 3D-baked huts, per LIV-121).
      assert.deepEqual(tileCanvasSize(def.tiles, nativePerTile(def)), def.native);
    }
  });

  await t.test('4. all four facings were actually baked (distinct frames exist)', () => {
    const facings = new Set();
    for (const def of Object.values(BUILDING_CATALOG)) facings.add(facingFrame(def));
    for (const need of ['view_0', 'view_90', 'view_270', 'view_180']) {
      assert.ok(facings.has(need), `missing baked facing ${need}`);
    }
    // Right and left are the mirror-image sides: same tile size, different view.
    assert.notEqual(facingFrame(BUILDING_CATALOG.fishing_hut_right), facingFrame(BUILDING_CATALOG.fishing_hut_left));
  });
});
