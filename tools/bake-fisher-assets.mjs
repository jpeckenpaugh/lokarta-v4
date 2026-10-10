#!/usr/bin/env node
/**
 * Lokarta fisher-asset 64px/tile bake + integration (LIV-121).
 *
 * Re-bakes every 3D-sourced building and prop in the LIV-116 rev-2 scope table
 * at the N64 native density (64 px per tile, art-direction.md §6) so each renders
 * 1:1 at the default 64 px display tile. It writes the committed authoring
 * artifacts under `docs/art/3d-poc/` (sprite JSON + grid/chop proof PNGs) AND the
 * runtime defs under `html/assets/sprites/` — the two are byte-identical, exactly
 * as before this change.
 *
 * Deterministic: identical GLB inputs -> byte-identical output. Dev-only; the
 * runtime (and T0) never import it (the pipeline runs GLB-free in CI).
 *
 * The archer is baked separately by `tools/bake-rigged-archer.mjs` (rigged path)
 * and assembled by `tools/integrate-actor-bake.mjs`.
 *
 * Usage: node tools/bake-fisher-assets.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAsset } from './gltf-to-sprite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const REPOS = path.join(ROOT, '.paperclip-repositories');
const POC = path.join(ROOT, 'docs', 'art', '3d-poc');
const VARIANTS = path.join(POC, 'variants');
const RUNTIME_BUILDINGS = path.join(ROOT, 'html', 'assets', 'sprites', 'buildings');
const RUNTIME_PROPS = path.join(ROOT, 'html', 'assets', 'sprites', 'props');

/** N64: 3D-sourced sprites are 64 native px per tile (art-direction.md §6). */
export const PX_PER_TILE = 64;

/**
 * LIV-129: the board-adopted 3D-render perspective baseline (art-direction.md
 * §12) — a Top-Down Oblique "3/4" orthographic camera at 60° from the horizon.
 * Pinned explicitly here (not left to the tool's ambient default) so a
 * re-bake always reproduces the conforming camera. Actors are the exception
 * (§12.1) and are baked by `bake-rigged-archer.mjs`, not this list.
 */
export const BAKE_RISE = 60;

/**
 * LIV-129: a +45° yaw offsets every view azimuth so an asset reads on the
 * isometric diagonal and a row of huts no longer aligns exactly N/S/E/W
 * (art-direction.md §12.3). It is **0 for this pass**: yaw materially changes
 * each asset's *projected aspect* (measured at `rise:60` — hut 0.76→0.93,
 * fishers_house 0.88→1.06, longhouse 2.06→1.08), which would force every
 * `tiles`/footprint to be re-derived per asset and, for the longhouse, collapse
 * its long silhouette into a squat block. Choosing which assets take the
 * isometric yaw is a visual-direction decision; see the follow-up filed for the
 * Game Designer. The plumbing is live (`camera.yaw` records it), so flipping an
 * asset is a one-line `yaw` change here.
 */
export const BUILDING_YAW = 0;

/**
 * Bake specs for the 8 buildings + 2 nets. Each `views` set, `tiles` footprint,
 * `stretchX`/`margin` (side huts), and the net `idleFrom` alias reproduce the
 * approved authoring choices, re-baked at the 60° baseline (LIV-129). The
 * longhouse (12x6) and face-on net (4x1) tile counts were re-derived from the
 * new projected aspect (§12.4 / 3d-to-2d-pipeline.md §3.1).
 */
export const FISHER_SPECS = [
  { id: 'fisherman_hut_2x3', glb: 'fisherman_hut_optimized.glb', tiles: { w: 2, h: 3 }, views: [0, 90, 180, 270], yaw: BUILDING_YAW, outDir: POC, runtime: path.join(RUNTIME_BUILDINGS, 'fishing_hut.json'), renderRes: 768 },
  { id: 'fishing_hut_back', glb: 'fisherman_hut_optimized.glb', tiles: { w: 2, h: 3 }, views: [180], yaw: BUILDING_YAW, outDir: VARIANTS, runtime: path.join(RUNTIME_BUILDINGS, 'fishing_hut_back.json'), renderRes: 768 },
  { id: 'fishing_hut_large', glb: 'fisherman_hut_optimized.glb', tiles: { w: 3, h: 4 }, views: [0], yaw: BUILDING_YAW, outDir: VARIANTS, runtime: path.join(RUNTIME_BUILDINGS, 'fishing_hut_large.json'), renderRes: 768 },
  { id: 'fishing_hut_left', glb: 'fisherman_hut_optimized.glb', tiles: { w: 4, h: 3 }, views: [270], yaw: BUILDING_YAW, stretchX: true, margin: 6, outDir: VARIANTS, runtime: path.join(RUNTIME_BUILDINGS, 'fishing_hut_left.json'), renderRes: 768 },
  { id: 'fishing_hut_right', glb: 'fisherman_hut_optimized.glb', tiles: { w: 4, h: 3 }, views: [90], yaw: BUILDING_YAW, stretchX: true, margin: 6, outDir: VARIANTS, runtime: path.join(RUNTIME_BUILDINGS, 'fishing_hut_right.json'), renderRes: 768 },
  { id: 'longhouse', glb: 'longhouse_optimized.glb', tiles: { w: 12, h: 6 }, views: [0], yaw: BUILDING_YAW, outDir: POC, runtime: path.join(RUNTIME_BUILDINGS, 'longhouse.json'), renderRes: 1024 },
  { id: 'fishers_house', glb: 'fishers_house_optimized.glb', tiles: { w: 3, h: 3 }, views: [0], yaw: BUILDING_YAW, outDir: POC, runtime: path.join(RUNTIME_BUILDINGS, 'fishers_house.json'), renderRes: 768 },
  { id: 'fishers_house_large', glb: 'fishers_house_optimized.glb', tiles: { w: 3, h: 4 }, views: [0], yaw: BUILDING_YAW, outDir: POC, runtime: path.join(RUNTIME_BUILDINGS, 'fishers_house_large.json'), renderRes: 768 },
  { id: 'prop_fishers_net', glb: 'fishers_net_optimized.glb', tiles: { w: 4, h: 1 }, views: [0, 180], idleFrom: 'view_0', kind: 'prop', outDir: POC, runtime: path.join(RUNTIME_PROPS, 'prop_fishers_net.json'), renderRes: 768 },
  { id: 'prop_fishers_net_vertical', glb: 'fishers_net_optimized.glb', tiles: { w: 1, h: 2 }, views: [90, 270], idleFrom: 'view_90', kind: 'prop', outDir: POC, runtime: path.join(RUNTIME_PROPS, 'prop_fishers_net_vertical.json'), renderRes: 768 },
];

/** Locates a GLB under `.paperclip-repositories/*` (authoring only). */
export function findGlb(name) {
  if (!fs.existsSync(REPOS)) throw new Error(`bake-fisher-assets: ${REPOS} missing (run where lokarta-private is checked out)`);
  for (const d of fs.readdirSync(REPOS)) {
    const p = path.join(REPOS, d, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`bake-fisher-assets: ${name} not found under .paperclip-repositories`);
}

/**
 * Removes the stale size-stamped grid proof for `id` when the canvas size
 * changed. Scoped to exactly `${id}_<W>x<H>_x4_grid.png` so sibling artifacts
 * such as `${id}_indexed_...` are never touched.
 */
function cleanStaleProofs(dir, id, canvas) {
  if (!fs.existsSync(dir)) return;
  const wantGrid = `${id}_${canvas.w}x${canvas.h}_x4_grid.png`;
  const re = new RegExp(`^${id}_\\d+x\\d+_x4_grid\\.png$`);
  for (const f of fs.readdirSync(dir)) {
    if (f !== wantGrid && re.test(f)) fs.rmSync(path.join(dir, f));
  }
}

/** Bakes one spec, adds any `idle` alias, and writes artifact + runtime defs. */
export async function bakeSpec(spec) {
  const glbPath = findGlb(spec.glb);
  const res = await buildAsset({
    glbPath, id: spec.id, outDir: spec.outDir,
    tiles: spec.tiles, views: spec.views, kind: spec.kind || 'building',
    tier: 'baked', pxPerTile: PX_PER_TILE, renderRes: spec.renderRes,
    rise: BAKE_RISE, yaw: spec.yaw || 0, stretchX: !!spec.stretchX, margin: spec.margin || 0, outline: false,
  });
  const artifact = path.join(spec.outDir, `${spec.id}.sprite.json`);
  const def = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  if (spec.idleFrom && def.frames[spec.idleFrom]) {
    def.frames.idle = JSON.parse(JSON.stringify(def.frames[spec.idleFrom]));
    fs.writeFileSync(artifact, JSON.stringify(def, null, 2) + '\n');
  }
  cleanStaleProofs(spec.outDir, spec.id, { w: def.native.w, h: def.native.h });
  fs.writeFileSync(spec.runtime, JSON.stringify(def, null, 2) + '\n');
  return res;
}

export async function bakeFisherAssets() {
  const out = [];
  for (const spec of FISHER_SPECS) out.push(await bakeSpec(spec));
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const results = await bakeFisherAssets();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`Wrote ${FISHER_SPECS[i].id}: ${r.tiles.w}x${r.tiles.h} tiles @ ${PX_PER_TILE}px, ${r.palette.length}-colour palette -> runtime + docs/art/3d-poc`);
  }
}
