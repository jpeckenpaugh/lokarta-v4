#!/usr/bin/env node
/**
 * Lokarta rigged-archer bake (LIV-111 Phase 3).
 *
 * The board supplied a genuinely-rigged rukiya mesh
 * (`rukiya_walking_optimized.glb`: SmartRigArmature, 42 joints, one `Walking`
 * clip). This tool samples that skeleton through `buildAnimatedAsset` and bakes
 * the runtime frame ids directly, so the archer's motion is real rig motion
 * rather than a synthesized shear.
 *
 * Output (committed): `docs/art/3d-poc/rukiya_archer_rigged.sprite.json` — a
 * Tier B def whose frames are named `idle_down`, `walk_down_0`, ... exactly the
 * runtime animation ids. `tools/integrate-actor-bake.mjs` reads that committed
 * artifact (no GLB needed) and assembles `html/assets/sprites/vocations/archer.json`,
 * so the T0 suite stays deterministic and GLB-free in CI.
 *
 * Only the `Walking` clip exists, so idle/attack/hit/death are POSED from the
 * rig: idle is a neutral walk phase, attack raises the bow arm / draws the
 * string / releases, hit recoils, death collapses. Honest limits are documented
 * in docs/art/tierb-variants-and-motion.md.
 *
 * Usage: node tools/bake-rigged-archer.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAnimatedAsset } from './gltf-to-sprite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const ARTIFACT = path.join(ROOT, 'docs', 'art', '3d-poc', 'rukiya_archer_rigged.sprite.json');
const REPOS = path.join(ROOT, '.paperclip-repositories');

/** Locates the rigged GLB under `.paperclip-repositories/*` (authoring only). */
export function findRiggedGlb() {
  if (!fs.existsSync(REPOS)) throw new Error(`bake-rigged-archer: ${REPOS} missing (run where lokarta-private is checked out)`);
  for (const d of fs.readdirSync(REPOS)) {
    const p = path.join(REPOS, d, 'rukiya_walking_optimized.glb');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('bake-rigged-archer: rukiya_walking_optimized.glb not found under .paperclip-repositories');
}

/* ---- facing azimuths: az 0 looks at the model's front (down), az 180 its
 * back (up), az 90 its right side (the runtime mirrors this for left). ---- */
export const DIR_AZ = { down: 0, up: 180, side: 90 };

/* Walk-cycle phases chosen from the rig: the two stride extremes (max foot
 * separation) and a neutral standing phase for idle. */
export const WALK_PHASES = [0.26, 0.781];
export const IDLE_PHASE = 0;

/* Rim-light strength for the bake. The default 0.7 left the full-tile archer's
 * brightest green just under the 3:1 rim-contrast floor (the larger model's
 * ramp top-step averages more mid-tones than the old shrunken bake did), so the
 * bake raises it to keep the silhouette's lit edge readable against the floor. */
export const ARCHER_RIM = 1.1;

/* LIV-115 (Fix 2): the archer bake read "night/low light" against the flat
 * Tier A vocations (mean luma ~40 vs 79-128). Raise the ambient/fill and apply a
 * normalized exposure gain so the baked archer sits in the same tonal range as
 * the flat art (mean ~85) while keeping the 135-degree key + ramp form. */
export const ARCHER_AMBIENT = 0.62;
export const ARCHER_EXPOSURE = 1.28;

/* ---- small quaternion helpers for skeletal posing ---- */
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisAngle = (axis, deg) => { const a = (deg * Math.PI) / 180 / 2, s = Math.sin(a); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(a)]; };

/**
 * Builds a pose overrides Map (node index -> {rotation}) for the draw/fire/
 * settle attack poses and the hit/death leans. `bones` maps a bone name to its
 * node index and `rest` gives its authored rest rotation, so every delta is
 * relative to the rig's own bind pose (no fixed-angle assumptions).
 */
export function archerPoses(bones, rest) {
  const rot = (name, ...deltas) => {
    let q = rest(name);
    for (const [axis, deg] of deltas) q = qmul(axisAngle(axis, deg), q);
    return q;
  };
  const armPose = ({ la, ra, lf, rf, lean = 0 }) => {
    const m = new Map();
    m.set(bones['mixamorig:LeftArm'], { rotation: rot('mixamorig:LeftArm', [[1, 0, 0], la[0]], [[0, 0, 1], la[1]]) });
    m.set(bones['mixamorig:RightArm'], { rotation: rot('mixamorig:RightArm', [[1, 0, 0], ra[0]], [[0, 0, 1], ra[1]]) });
    m.set(bones['mixamorig:LeftForeArm'], { rotation: rot('mixamorig:LeftForeArm', [[0, 0, 1], lf]) });
    m.set(bones['mixamorig:RightForeArm'], { rotation: rot('mixamorig:RightForeArm', [[0, 0, 1], rf]) });
    if (lean) m.set(bones['mixamorig:Spine1'], { rotation: rot('mixamorig:Spine1', [[1, 0, 0], lean]) });
    return m;
  };
  // `leanPose` bends the torso about the waist. It deliberately does NOT touch
  // the Hips node: the `Walking` clip carries the Hips translation that plants
  // the feet on the ground (y ~= 0). Overriding it — as a naive "hip drop" did —
  // dropped the whole rig below the foot plane, which inflated the union bounds
  // used to scale/centre the bake and shrank every frame inside the tile
  // (LIV-112). Folding the spine alone keeps the feet grounded at every frame.
  const leanPose = (spine1, spine2) => {
    const m = new Map();
    m.set(bones['mixamorig:Spine1'], { rotation: rot('mixamorig:Spine1', [[1, 0, 0], spine1]) });
    if (spine2) m.set(bones['mixamorig:Spine2'], { rotation: rot('mixamorig:Spine2', [[1, 0, 0], spine2]) });
    return m;
  };
  return {
    draw: armPose({ la: [-25, -45], ra: [-15, 55], lf: -45, rf: 70, lean: -6 }),
    fire: armPose({ la: [-5, -10], ra: [20, 10], lf: -15, rf: 20 }),
    settle: armPose({ la: [-12, -22], ra: [2, 30], lf: -28, rf: 48, lean: -3 }),
    recoil: leanPose(-14, -8),
    death: [leanPose(10, 4), leanPose(30, 12), leanPose(55, 24), leanPose(80, 34)],
  };
}

/**
 * Full pose list: one entry per runtime frame id. Directions repeat the same
 * clip time / pose at a different azimuth (the fixed projection keeps all frames
 * aligned), so `walk_side_*` etc. animate the same skeleton seen from the side.
 */
export function buildPoseList(bones, rest) {
  const P = archerPoses(bones, rest);
  const list = [];
  const add = (key, dir, time, override = null) => list.push({ key, az: DIR_AZ[dir], time, override });
  for (const dir of ['down', 'up', 'side']) {
    add(`idle_${dir}`, dir, IDLE_PHASE);
    add(`walk_${dir}_0`, dir, WALK_PHASES[0]);
    add(`walk_${dir}_1`, dir, WALK_PHASES[1]);
    add(`attack_${dir}_0`, dir, IDLE_PHASE, P.draw);
    add(`attack_${dir}_1`, dir, IDLE_PHASE, P.fire);
    add(`attack_${dir}_2`, dir, IDLE_PHASE, P.settle);
    add(`hit_${dir}`, dir, IDLE_PHASE, P.recoil);
    P.death.forEach((ov, i) => add(`death_${i}`, dir, IDLE_PHASE, ov));
  }
  return list;
}

/** Reads the rig's bone node indices + rest rotations from the GLB. */
export function readRigBones(glbJson) {
  const bones = {};
  glbJson.nodes.forEach((n, i) => { if (n.name && n.name.startsWith('mixamorig:')) bones[n.name] = i; });
  const rest = (name) => (glbJson.nodes[bones[name]].rotation || [0, 0, 0, 1]);
  return { bones, rest };
}

/** Bakes the rigged archer artifact from the GLB (authoring step; needs the GLB). */
export async function bakeRiggedArcher() {
  const glbPath = findRiggedGlb();
  const { parseGLB } = await import('./gltf-to-sprite.mjs');
  const glb = parseGLB(glbPath);
  const { bones, rest } = readRigBones(glb.json);
  const poseList = buildPoseList(bones, rest);
  const res = await buildAnimatedAsset({
    glbPath, id: 'rukiya_archer_rigged', outDir: path.dirname(ARTIFACT),
    clip: 'Walking', size: 32, rise: 8, tier: 'baked',
    families: 6, steps: 4, poseList, renderRes: 512, write: false, rim: ARCHER_RIM,
    ambient: ARCHER_AMBIENT, exposure: ARCHER_EXPOSURE, outline: false,
  });
  fs.writeFileSync(ARTIFACT, JSON.stringify(res.def, null, 2) + '\n');
  return res;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const res = await bakeRiggedArcher();
  console.log(`Wrote ${path.relative(ROOT, ARTIFACT)}: ${Object.keys(res.def.frames).length} rig frames, ${res.palette.length}-colour palette`);
}
