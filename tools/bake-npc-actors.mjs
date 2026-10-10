#!/usr/bin/env node
/**
 * Lokarta 3D-baked Havenreach NPC actors (LIV-134; curated by LIV-143).
 *
 * Bakes the `html/data/npcs.json` cast from the rigged human GLBs the board
 * shipped in `lokarta-private` (origin/main @ 0412020) into the actor contract
 * from docs/art/3d-sprite-mapping.md §1-§2:
 *
 *   - 64 px/tile native, 1:1, N64 density; 64x64 canvas per actor
 *   - actor-exception pitch (rise < 60, §12.1) — NOT the 60° building baseline
 *   - no outline; data-driven silhouette ground shadow (renderer-derived)
 *   - directional idle (x1) + walk (x2, step-driven) per dir, side mirrored
 *
 * LIV-143 (board direction on LIV-141): the cast is **one NPC per unique source
 * model**, rendered in the model's OWN colours. The former per-NPC recolor ramp
 * ("reuse a mesh, repaint it a different hue") is retired — variety must come
 * from the models themselves, never from tinting. Each spec therefore carries
 * only `id` + `glb`; there is no `palette`.
 *
 * Authoring-only + deterministic: identical GLB inputs -> byte-identical
 * artifacts. Writes the committed authoring artifacts under
 * `docs/art/3d-poc/phase4/`; `tools/integrate-npc-bake.mjs` is the GLB-free step
 * that assembles the runtime defs, so T0 stays GLB-free in CI.
 *
 * Usage: node tools/bake-npc-actors.mjs [npcSpriteId ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAnimatedAsset, parseGLB, readClip, luma } from './gltf-to-sprite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const REPOS = path.join(ROOT, '.paperclip-repositories');
export const ARTIFACT_DIR = path.join(ROOT, 'docs', 'art', '3d-poc', 'phase4');

/** N64: 3D-baked sprites are 64 native px per tile (art-direction.md §6). */
export const PX_PER_TILE = 64;
/**
 * Actor-exception camera pitch (art-direction.md §12.1): character/actor
 * sprites stay shallower than the 60° building/prop baseline to preserve the
 * walk-cycle side read. Matches the existing rigged archer bake (`rise: 8`).
 */
export const ACTOR_RISE = 8;

/* ---- facing azimuths (matches tools/bake-rigged-archer.mjs): az 0 looks at
 * the model's front (down), 180 its back (up), 90 its right side (the runtime
 * mirrors this for left). ---- */
export const DIR_AZ = { down: 0, up: 180, side: 90 };

/** Normalized clip phases for the two stride extremes (fraction of duration). */
export const WALK_PHASES = [0.26, 0.781];
export const IDLE_PHASE = 0;

/* Garment/accent/rim tuning carried over from the archer bake (LIV-115). */
export const ACTOR_RIM = 1.1;
export const ACTOR_AMBIENT = 0.62;
export const ACTOR_EXPOSURE = 1.28;

/**
 * The curated Havenreach bake table (LIV-143): **one NPC per unique source
 * model**, no recolour. Six rigged human GLBs -> six NPCs, so the town reads as
 * six genuinely different people rather than one mesh repainted. `glb` is the
 * only authored field; the model's own texture colours are the identity.
 */
export const NPC_SPECS = [
  { id: 'npc_captain_halden', glb: 'villager_m_optimized.glb' },
  { id: 'npc_wick', glb: 'deckhand_walk_optimized.glb' },
  { id: 'npc_elder_rowan_vane', glb: 'first_fisher_optimized.glb' },
  { id: 'npc_mara', glb: 'villager_f_optimized.glb' },
  { id: 'npc_pilgrims_apprentice_tam', glb: 'young_fisher_optimized.glb' },
  { id: 'npc_child_kes', glb: 'child_white_hair_optimized.glb' },
];

const SPEC_BY_ID = Object.fromEntries(NPC_SPECS.map((s) => [s.id, s]));

/** Locates a GLB under `.paperclip-repositories/*` (authoring only). */
export function findGlb(name) {
  if (!fs.existsSync(REPOS)) throw new Error(`bake-npc-actors: ${REPOS} missing (run where lokarta-private is checked out)`);
  for (const d of fs.readdirSync(REPOS)) {
    const p = path.join(REPOS, d, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`bake-npc-actors: ${name} not found under .paperclip-repositories`);
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function rgbToHex(c) {
  return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function darken(c, f) { return c.map((v) => v * (1 - f)); }

/**
 * Builds a monotonic (ascending-luma) 4-stop colour ramp from an NPC's
 * garment/accent/rim tokens, then returns a Recolor closure that maps a pixel's
 * Rec.601 luma through the ramp. The darkest stop is a shaded garment so the
 * silhouette keeps a shadow side; the rim token lands on the lit edge.
 */
export function makeRecolor(palette) {
  const [garment, accent, rim] = palette.map(hexToRgb);
  const stops = [darken(garment, 0.45), garment, accent, rim]
    .map((c) => ({ c, l: luma(c[0], c[1], c[2]) }))
    .sort((a, b) => a.l - b.l)
    .map((s) => s.c);
  const n = stops.length;
  // Fixed tonal window (24..200) spreads the bake's mid-tones across the ramp.
  return (r, g, b) => {
    let t = (luma(r, g, b) - 24) / (200 - 24);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const x = t * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    const f = x - i;
    const a = stops[i], c = stops[i + 1];
    return [a[0] + (c[0] - a[0]) * f, a[1] + (c[1] - a[1]) * f, a[2] + (c[2] - a[2]) * f];
  };
}

/** Duration (seconds) of a GLB's first animation clip, for phase->time mapping. */
export function clipDuration(glbPath) {
  const glb = parseGLB(glbPath);
  const meshNode = glb.json.nodes.findIndex((n) => n.mesh !== undefined);
  const clip = readClip(glb, null, meshNode);
  return clip ? clip.duration : 0;
}

/** The runtime id list this bake emits, per direction. */
export function poseListFor(duration) {
  const list = [];
  const add = (key, dir, time) => list.push({ key, az: DIR_AZ[dir], time });
  for (const dir of ['down', 'up', 'side']) {
    add(`idle_${dir}`, dir, IDLE_PHASE);
    add(`walk_${dir}_0`, dir, WALK_PHASES[0] * duration);
    add(`walk_${dir}_1`, dir, WALK_PHASES[1] * duration);
  }
  return list;
}

/** Bakes one NPC's artifact (needs the GLB) and returns `{ def, palette }`. */
export async function bakeNpc(spec) {
  const glbPath = findGlb(spec.glb);
  const duration = clipDuration(glbPath);
  const res = await buildAnimatedAsset({
    glbPath, id: spec.id, outDir: ARTIFACT_DIR,
    clip: null, size: PX_PER_TILE, rise: ACTOR_RISE, tier: 'baked',
    poseList: poseListFor(duration), renderRes: 512, write: false,
    rim: ACTOR_RIM, ambient: ACTOR_AMBIENT, exposure: ACTOR_EXPOSURE,
    outline: false,
    // LIV-143: no recolor — the model renders in its own colours.
    recolor: null,
  });
  return res;
}

export async function bakeAll(ids = null) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const specs = ids && ids.length ? ids.map((id) => SPEC_BY_ID[id]).filter(Boolean) : NPC_SPECS;
  const out = [];
  for (const spec of specs) {
    const res = await bakeNpc(spec);
    fs.writeFileSync(path.join(ARTIFACT_DIR, `${spec.id}.sprite.json`), JSON.stringify(res.def, null, 2) + '\n');
    out.push({ id: spec.id, frames: Object.keys(res.def.frames).length, palette: res.palette.length });
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = await bakeAll(process.argv.slice(2));
  for (const r of out) console.log(`Wrote ${r.id}: ${r.frames} frames, ${r.palette}-colour palette -> docs/art/3d-poc/phase4`);
}
