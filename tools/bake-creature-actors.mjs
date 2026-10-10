#!/usr/bin/env node
/**
 * Lokarta 3D-baked Dawnreach overworld creatures (LIV-135, Phase 2 of LIV-132).
 *
 * Bakes the three `docs/art/3d-sprite-mapping.md` §4 creature GLBs (shipped in
 * `lokarta-private` origin/main @ 0412020) into the shared actor contract
 * (docs/art/3d-sprite-mapping.md §1): N64 64 px/tile 1:1, actor-exception pitch
 * (rise < 60), no outline, silhouette ground shadow, 3-direction facing.
 *
 *   - `piranha_optimized.glb` / `river_eel_optimized.glb` — UNRIGGED single-pose
 *     "static" ambushers -> one idle pose per direction (`buildAsset`).
 *   - `river_rat_static_optimized.glb` + `river_rat_walking_optimized.glb` — a
 *     rigged walker: idle sampled from the static clip, walk from the walking
 *     clip, both projected through ONE shared model-space bounds so the shipped
 *     idle+walk frames never pop scale/position.
 *
 * Authoring-only + deterministic: identical GLB inputs -> byte-identical
 * artifacts. Writes the committed exposed artifacts under
 * `docs/art/3d-poc/phase5/`; `tools/integrate-creature-bake.mjs` is the GLB-free
 * step that assembles the runtime defs, so T0 stays GLB-free in CI.
 *
 * Usage: node tools/bake-creature-actors.mjs [creatureId ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BAKED_ALPHABET,
  BAKED_OPAQUE_BUDGET,
  buildAsset,
  buildAnimatedAsset,
  canonicalPaletteOrder,
  medianCut,
  parseGLB,
  quantize,
  readAccessor,
  readClip,
  skinAtTime,
  unionBounds,
} from './gltf-to-sprite.mjs';
import { findGlb } from './bake-fisher-assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const ARTIFACT_DIR = path.join(ROOT, 'docs', 'art', '3d-poc', 'phase5');

/** N64: 3D-baked sprites are 64 native px per tile (art-direction.md §6). */
export const PX_PER_TILE = 64;
/** Actor-exception camera pitch (art-direction.md §12.1) — matches the archer/NPC bakes. */
export const ACTOR_RISE = 8;
/* Facing azimuths: az 0 looks front (down), 180 back (up), 90 the right side.
 * LIV-146 adds the two 45-degree three-quarter views (down_side front-right,
 * up_side back-right); the runtime mirrors the right-hand views for the
 * left-hand half, so each creature carries eight directions. */
export const DIR_AZ = { down: 0, down_side: 45, side: 90, up_side: 135, up: 180 };
/** Authored directions per creature (unique yaw bakes; left = mirrored right). */
export const BAKE_DIRS = ['down', 'down_side', 'side', 'up_side', 'up'];
/** Normalized stride extremes (fraction of the walking clip duration). */
export const WALK_PHASES = [0.26, 0.781];
export const IDLE_PHASE = 0;

/* Lighting tuning carried over from the archer/NPC bakes (LIV-115). */
export const CREATURE_RIM = 1.1;
export const CREATURE_AMBIENT = 0.62;
export const CREATURE_EXPOSURE = 1.28;

/**
 * The creature bake table (docs/art/3d-sprite-mapping.md §4.1). `movement` is
 * the one field the runtime integrator consumes: `static` -> idle-only (the
 * sessile ambusher class), `walking` -> idle + walk (the roaming chaser).
 */
export const CREATURE_SPECS = [
  { id: 'river_piranha', movement: 'static', glb: 'piranha_optimized.glb' },
  { id: 'river_eel', movement: 'static', glb: 'river_eel_optimized.glb' },
  {
    id: 'river_rat',
    movement: 'walking',
    idleGlb: 'river_rat_static_optimized.glb',
    walkGlb: 'river_rat_walking_optimized.glb',
  },
];

const SPEC_BY_ID = Object.fromEntries(CREATURE_SPECS.map((s) => [s.id, s]));

/* ---- palette helpers (kept local so this tool has no runtime deps) ---- */
export function rgbToHex(c) {
  return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function posesFor(glbPath, times) {
  const glb = parseGLB(glbPath);
  const j = glb.json;
  const skin = (j.skins || [])[0];
  if (!skin) throw new Error(`bake-creature-actors: ${glbPath} is unrigged (no skin)`);
  const meshNode = j.nodes.findIndex((n) => n.mesh !== undefined);
  const prim = j.meshes[j.nodes[meshNode].mesh].primitives[0];
  const ibm = readAccessor(glb, skin.inverseBindMatrices);
  const anim = readClip(glb, null, meshNode);
  const roots = j.scenes[j.scene || 0].nodes;
  return times.map((t) => skinAtTime(glb, anim, 0, prim, ibm, t, roots, null));
}

/** Union model-space bounds for a rigged GLB sampled at `times`. */
export function boundsFor(glbPath, times) {
  return unionBounds(posesFor(glbPath, times));
}

function unionOf(a, b) {
  return {
    mnx: Math.min(a.mnx, b.mnx), mny: Math.min(a.mny, b.mny), mnz: Math.min(a.mnz, b.mnz),
    mxx: Math.max(a.mxx, b.mxx), mxy: Math.max(a.mxy, b.mxy), mxz: Math.max(a.mxz, b.mxz),
  };
}

/** Reads a baked frame's RGB pixels back out of a char matrix + palette. */
function frameToRgba(rows, palette) {
  const h = rows.length;
  const w = rows[0].length;
  const rgba = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const hexs = palette[rows[y][x]];
      if (!hexs) continue;
      const [r, g, b] = hexToRgb(hexs);
      const i = (y * w + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return { w, h, rgba };
}

/**
 * Merges two single-projection baked defs (idle + walk from two GLBs) into ONE
 * def with a unified palette. Two independent bakes quantize to their own
 * palettes, so a straight frame merge would use undeclared chars. Re-collect
 * every frame's pixels and run ONE direct median-cut over the combined set
 * (canonical luma order), then re-quantize all frames against it — the same
 * direct-quantizer contract the single-GLB bakes use, deterministic across runs.
 */
export function mergeDefs(base, parts) {
  const all = [];
  for (const part of parts) {
    for (const rows of Object.values(part.frames)) {
      const px = frameToRgba(rows, part.palette);
      for (let i = 0; i < px.w * px.h; i++) {
        if (px.rgba[i * 4 + 3] > 128) all.push([px.rgba[i * 4], px.rgba[i * 4 + 1], px.rgba[i * 4 + 2]]);
      }
    }
  }
  const ordered = canonicalPaletteOrder(medianCut(all, BAKED_OPAQUE_BUDGET));
  const palette = { '.': null };
  ordered.forEach((c, i) => { palette[BAKED_ALPHABET[i]] = rgbToHex(c); });

  const frames = {};
  for (const part of parts) {
    for (const [fid, rows] of Object.entries(part.frames)) {
      frames[fid] = quantize(frameToRgba(rows, part.palette), ordered, BAKED_ALPHABET);
    }
  }
  return {
    ...base,
    palette,
    quantize: { method: 'median-cut', budget: BAKED_OPAQUE_BUDGET },
    frames,
  };
}

/** Bakes one static ambusher: 3-direction idle from its unrigged GLB. */
export async function bakeStatic(spec, outDir = ARTIFACT_DIR) {
  const glbPath = findGlb(spec.glb);
  await buildAsset({
    glbPath, id: spec.id, outDir, size: PX_PER_TILE, views: [0, 45, 90, 135, 180],
    kind: 'monster', tier: 'baked', rise: ACTOR_RISE, renderRes: 512, outline: false,
  });
  const artifact = path.join(outDir, `${spec.id}.sprite.json`);
  const def = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  // Runtime frame ids are directional (idle_down/down_side/side/up_side/up);
  // drop the generic `view_<az>` keys so the def matches the actor contract.
  const renamed = {};
  for (const [dir, az] of [['down', 0], ['down_side', 45], ['side', 90], ['up_side', 135], ['up', 180]]) {
    renamed[`idle_${dir}`] = def.frames[`view_${az}`];
  }
  def.frames = renamed;
  def.movement = spec.movement;
  delete def.camera;
  fs.writeFileSync(artifact, JSON.stringify(def, null, 2) + '\n');
  return def;
}

/** Bakes one walking creature: idle from the static clip, walk from the rig. */
export async function bakeWalking(spec, outDir = ARTIFACT_DIR) {
  const idlePath = findGlb(spec.idleGlb);
  const walkPath = findGlb(spec.walkGlb);
  const idleDuration = (() => {
    const glb = parseGLB(idlePath);
    const meshNode = glb.json.nodes.findIndex((n) => n.mesh !== undefined);
    const clip = readClip(glb, null, meshNode);
    return clip ? clip.duration : 0;
  })();
  const walkDuration = (() => {
    const glb = parseGLB(walkPath);
    const meshNode = glb.json.nodes.findIndex((n) => n.mesh !== undefined);
    const clip = readClip(glb, null, meshNode);
    return clip ? clip.duration : 0;
  })();

  // One shared projection across both GLBs so idle and walk never pop.
  const shared = unionOf(
    boundsFor(idlePath, [IDLE_PHASE * idleDuration]),
    boundsFor(walkPath, WALK_PHASES.map((p) => p * walkDuration)),
  );

  const common = {
    size: PX_PER_TILE, rise: ACTOR_RISE, tier: 'baked', renderRes: 512, write: false,
    rim: CREATURE_RIM, ambient: CREATURE_AMBIENT, exposure: CREATURE_EXPOSURE,
    outline: false, bounds: shared,
  };

  const idleList = [];
  for (const dir of BAKE_DIRS) {
    idleList.push({ key: `idle_${dir}`, az: DIR_AZ[dir], time: IDLE_PHASE * idleDuration });
  }
  const idleRes = await buildAnimatedAsset({ ...common, glbPath: idlePath, id: spec.id, clip: null, poseList: idleList });

  const walkList = [];
  for (const dir of BAKE_DIRS) {
    walkList.push({ key: `walk_${dir}_0`, az: DIR_AZ[dir], time: WALK_PHASES[0] * walkDuration });
    walkList.push({ key: `walk_${dir}_1`, az: DIR_AZ[dir], time: WALK_PHASES[1] * walkDuration });
  }
  const walkRes = await buildAnimatedAsset({ ...common, glbPath: walkPath, id: `${spec.id}_walk`, clip: null, poseList: walkList });

  const merged = mergeDefs({
    id: spec.id,
    kind: 'monster',
    renderTier: 'baked',
    baked3d: true,
    outline: false,
    source: `${path.basename(spec.idleGlb)} + ${path.basename(spec.walkGlb)}`,
    method: `dual-glb shared-bounds skinned bake @ rise ${ACTOR_RISE} -> 5-dir (8-dir mirrored) idle+walk -> direct median-cut`,
    native: { w: PX_PER_TILE, h: PX_PER_TILE },
    anchor: { x: Math.floor(PX_PER_TILE / 2), y: PX_PER_TILE - 2 },
    movement: spec.movement,
  }, [idleRes.def, walkRes.def]);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${spec.id}.sprite.json`), JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

export async function bakeCreature(spec, outDir = ARTIFACT_DIR) {
  return spec.movement === 'walking' ? bakeWalking(spec, outDir) : bakeStatic(spec, outDir);
}

export async function bakeAll(ids = null, outDir = ARTIFACT_DIR) {
  const specs = ids && ids.length ? ids.map((id) => SPEC_BY_ID[id]).filter(Boolean) : CREATURE_SPECS;
  const out = [];
  for (const spec of specs) {
    const def = await bakeCreature(spec, outDir);
    out.push({ id: spec.id, movement: spec.movement, frames: Object.keys(def.frames).length, palette: Object.keys(def.palette).length });
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = await bakeAll(process.argv.slice(2));
  for (const r of out) console.log(`Wrote ${r.id} (${r.movement}): ${r.frames} frames, ${r.palette}-colour palette -> docs/art/3d-poc/phase5`);
}
