#!/usr/bin/env node
/**
 * Lokarta 3D-baked Havenreach props (LIV-134, Phase 1 of LIV-132).
 *
 * Bakes the four new scene props from docs/art/3d-sprite-mapping.md §5 —
 * fishing dock, barrel (replaces the 2D `prop_barrel`), palm trees, rock piles —
 * as 3D-baked N64 props at the 60°-from-horizon building/prop baseline (§12.1).
 *
 * These are static scene objects, baked with the SAME `buildAsset` path as the
 * fisher buildings/nets: `renderTier:"baked"`, `baked3d:true`, `outline:false`,
 * native = tiles x 64. The committed runtime defs under `html/assets/sprites/
 * props/` are the deliverable, so CI stays GLB-free.
 *
 * Deterministic: identical GLB inputs -> byte-identical output. Dev-only.
 *
 * Usage: node tools/bake-havenreach-props.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAsset } from './gltf-to-sprite.mjs';
import { findGlb } from './bake-fisher-assets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const POC = path.join(ROOT, 'docs', 'art', '3d-poc', 'phase4');
const RUNTIME_PROPS = path.join(ROOT, 'html', 'assets', 'sprites', 'props');

/** N64: 64 native px per tile (art-direction.md §6). */
export const PX_PER_TILE = 64;
/** Buildings/props take the full 60°-from-horizon pitch (§12.1). */
export const PROP_RISE = 60;

/**
 * The four prop bake specs (§5). `layer` is applied by the scene catalog
 * (`towns.json`); the def only records geometry + a default `view_0`/`idle`.
 */
export const PROP_SPECS = [
  { id: 'prop_wooden_barrel', glb: 'wooden_barrel_optimized.glb', size: 64, views: [0], kind: 'prop', renderRes: 512 },
  { id: 'prop_rock_pile', glb: 'rock_pile_optimized.glb', size: 64, views: [0], kind: 'prop', renderRes: 512 },
  { id: 'prop_palm_tree', glb: 'palm_tree_optimized.glb', tiles: { w: 1, h: 2 }, views: [0], kind: 'prop', renderRes: 768 },
  { id: 'prop_wooden_dock', glb: 'wooden_dock_optimized.glb', tiles: { w: 3, h: 1 }, views: [0], kind: 'decor', renderRes: 768 },
];

/** Bakes one prop: writes the committed artifact + the runtime def (idle alias). */
export async function bakeProp(spec, outDoc = POC, runtimeDir = RUNTIME_PROPS) {
  const glbPath = findGlb(spec.glb);
  await buildAsset({
    glbPath, id: spec.id, outDir: outDoc, size: spec.size || 32, tiles: spec.tiles || null,
    views: spec.views || [0], kind: spec.kind || 'prop', tier: 'baked',
    pxPerTile: PX_PER_TILE, rise: PROP_RISE, yaw: 0, renderRes: spec.renderRes || 512, outline: false,
  });
  const artifact = path.join(outDoc, `${spec.id}.sprite.json`);
  const def = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  if (def.frames.view_0 && !def.frames.idle) def.frames.idle = JSON.parse(JSON.stringify(def.frames.view_0));
  fs.writeFileSync(artifact, JSON.stringify(def, null, 2) + '\n');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, `${spec.id}.json`), JSON.stringify(def, null, 2) + '\n');
  return def;
}

export async function bakeAll() {
  const out = [];
  for (const spec of PROP_SPECS) out.push(await bakeProp(spec));
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = await bakeAll();
  for (const d of out) console.log(`Wrote ${d.id}: ${d.native.w}x${d.native.h} @ ${PX_PER_TILE}px/tile, ${Object.keys(d.palette).length}-colour palette -> docs/art/3d-poc/phase4 + html/assets/sprites/props`);
}
