#!/usr/bin/env node
/**
 * Lokarta runtime archer integration (LIV-111 Phase 3).
 *
 * Phase 3 baked the *rigged* rukiya mesh (42-joint SmartRigArmature, `Walking`
 * clip) into `docs/art/3d-poc/rukiya_archer_rigged.sprite.json` — a Tier B def
 * whose frames are already named with the runtime animation ids
 * (`idle_down`, `walk_side_1`, `attack_up_2`, ...). This tool is the final,
 * GLB-free step: it adds the runtime `animations` table and writes
 * `html/assets/sprites/vocations/archer.json`.
 *
 * Why split: the bake needs the GB-scale GLB (`.paperclip-repositories`, not in
 * the repo), but the runtime def must be verifiable in CI. `buildArcherBaked()`
 * reads only the committed artifact + this contract, so the T0 drift test runs
 * with no 3D source present.
 *
 * Deterministic: identical inputs -> byte-identical output. Dev-only.
 *
 * Usage: node tools/integrate-actor-bake.mjs [outFile]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export const RIGGED_ARTIFACT = path.join(ROOT, 'docs', 'art', '3d-poc', 'rukiya_archer_rigged.sprite.json');
export const ARCHER_RUNTIME = path.join(ROOT, 'html', 'assets', 'sprites', 'vocations', 'archer.json');

/**
 * The runtime animation contract. Ids/counts/directions are the Tier A actor
 * contract every vocation shares; only the baked pixels changed in Phase 3.
 */
export const ARCHER_ANIMATIONS = {
  idle: {
    down: ['idle_down'],
    down_side: ['idle_down_side'],
    side: ['idle_side'],
    up_side: ['idle_up_side'],
    up: ['idle_up'],
    frameMs: null, advanceOn: 'timer',
  },
  walk: {
    down: ['walk_down_0', 'walk_down_1'],
    down_side: ['walk_down_side_0', 'walk_down_side_1'],
    side: ['walk_side_0', 'walk_side_1'],
    up_side: ['walk_up_side_0', 'walk_up_side_1'],
    up: ['walk_up_0', 'walk_up_1'],
    frameMs: null, advanceOn: 'step',
  },
  attack: {
    down: ['attack_down_0', 'attack_down_1', 'attack_down_2'],
    down_side: ['attack_down_side_0', 'attack_down_side_1', 'attack_down_side_2'],
    side: ['attack_side_0', 'attack_side_1', 'attack_side_2'],
    up_side: ['attack_up_side_0', 'attack_up_side_1', 'attack_up_side_2'],
    up: ['attack_up_0', 'attack_up_1', 'attack_up_2'],
    frameMs: 90, advanceOn: 'timer',
  },
  hit: {
    down: ['hit_down'],
    down_side: ['hit_down_side'],
    side: ['hit_side'],
    up_side: ['hit_up_side'],
    up: ['hit_up'],
    frameMs: 120, advanceOn: 'timer',
  },
  // Death is direction-independent (one collapse pose seen from the side); the
  // runtime resolves every 8-dir request to the same edited set.
  death: {
    down: ['death_0', 'death_1', 'death_2', 'death_3'],
    up: ['death_0', 'death_1', 'death_2', 'death_3'],
    side: ['death_0', 'death_1', 'death_2', 'death_3'],
    frameMs: 120, advanceOn: 'timer',
  },
};

/** Assembles the runtime archer def from the committed rig artifact + contract. */
export function buildArcherBaked() {
  const art = JSON.parse(fs.readFileSync(RIGGED_ARTIFACT, 'utf8'));
  return {
    id: 'archer',
    kind: 'vocation',
    renderTier: art.renderTier || 'baked',
    // LIV-122/LIV-125: carry the 3D-baked declaration + direct-quantization
    // metadata into the runtime def so the shared validator resolves the
    // 256-entry ceiling (255 opaque, §11).
    ...(art.baked3d ? { baked3d: true } : {}),
    // LIV-115 (Fix 1): propagate the bake's Tier B outline opt-out so the runtime
    // renderer ends colours at the silhouette instead of re-adding a 1px outline.
    ...(art.outline === false ? { outline: false } : {}),
    native: { ...art.native },
    anchor: { ...art.anchor },
    ...(art.quantize ? { quantize: { ...art.quantize } } : {}),
    palette: { ...art.palette },
    animations: JSON.parse(JSON.stringify(ARCHER_ANIMATIONS)),
    frames: { ...art.frames },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] || ARCHER_RUNTIME;
  const def = buildArcherBaked();
  fs.writeFileSync(out, JSON.stringify(def, null, 2) + '\n');
  console.log(`Wrote baked runtime archer (${Object.keys(def.frames).length} frames, ${Object.keys(def.palette).length} palette) -> ${path.relative(ROOT, out)}`);
}
