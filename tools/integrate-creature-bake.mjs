#!/usr/bin/env node
/**
 * Lokarta runtime creature integration (LIV-135, Phase 2 of LIV-132).
 *
 * The bake (`tools/bake-creature-actors.mjs`) writes the committed 3D artifacts
 * under `docs/art/3d-poc/phase5/` — one `<id>.sprite.json` per creature whose
 * frames are already named with the runtime animation ids (`idle_down`,
 * `walk_side_1`, ...) and whose `movement` field names its bake class. This tool
 * is the final, GLB-free step: it adds the runtime `animations` table and writes
 * `html/assets/sprites/monsters/<id>.json`.
 *
 * Why split: the bake needs the GLB (`.paperclip-repositories`, not in the repo)
 * but the runtime def must be verifiable in CI. Reading only the committed
 * artifact + this contract keeps T0 deterministic and GLB-free (mirrors
 * `tools/integrate-npc-bake.mjs`).
 *
 * Deterministic: identical inputs -> byte-identical output. Dev-only.
 *
 * Usage: node tools/integrate-creature-bake.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const ARTIFACT_DIR = path.join(ROOT, 'docs', 'art', '3d-poc', 'phase5');
export const MONSTER_DIR = path.join(ROOT, 'html', 'assets', 'sprites', 'monsters');

/**
 * Runtime animation contracts (art-direction.md §2). A **static** ambusher
 * authors directional idle only — the renderer falls back to `idle.down[0]` for
 * any missing state/dir, so shipping idle-only is legal. A **walking** chaser
 * adds a step-driven walk (×2) per direction.
 */
export const STATIC_ANIMATIONS = {
  idle: {
    down: ['idle_down'],
    down_side: ['idle_down_side'],
    side: ['idle_side'],
    up_side: ['idle_up_side'],
    up: ['idle_up'],
    frameMs: null,
    advanceOn: 'timer',
  },
};
export const WALK_ANIMATIONS = {
  idle: {
    down: ['idle_down'],
    down_side: ['idle_down_side'],
    side: ['idle_side'],
    up_side: ['idle_up_side'],
    up: ['idle_up'],
    frameMs: null,
    advanceOn: 'timer',
  },
  walk: {
    down: ['walk_down_0', 'walk_down_1'],
    down_side: ['walk_down_side_0', 'walk_down_side_1'],
    side: ['walk_side_0', 'walk_side_1'],
    up_side: ['walk_up_side_0', 'walk_up_side_1'],
    up: ['walk_up_0', 'walk_up_1'],
    frameMs: null,
    advanceOn: 'step',
  },
};
export const ANIMATIONS_BY_MOVEMENT = { static: STATIC_ANIMATIONS, walking: WALK_ANIMATIONS };

/** The creature sprite ids the baked set owns (must match monsters.json types). */
export function listCreatureArtifacts(dir = ARTIFACT_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sprite.json'))
    .map((f) => f.slice(0, -'.sprite.json'.length))
    .sort();
}

/** Assembles one runtime monster def from its committed baked artifact. */
export function buildCreatureDef(id, dir = ARTIFACT_DIR) {
  const art = JSON.parse(fs.readFileSync(path.join(dir, `${id}.sprite.json`), 'utf8'));
  const movement = art.movement === 'walking' ? 'walking' : 'static';
  const animations = ANIMATIONS_BY_MOVEMENT[movement];
  return {
    id,
    kind: 'monster',
    renderTier: art.renderTier || 'baked',
    ...(art.baked3d ? { baked3d: true } : {}),
    ...(art.outline === false ? { outline: false } : {}),
    native: { ...art.native },
    anchor: { ...art.anchor },
    ...(art.quantize ? { quantize: { ...art.quantize } } : {}),
    palette: { ...art.palette },
    animations: JSON.parse(JSON.stringify(animations)),
    frames: { ...art.frames },
  };
}

export function integrateAll(dir = ARTIFACT_DIR, outDir = MONSTER_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  const ids = listCreatureArtifacts(dir);
  const written = [];
  for (const id of ids) {
    const def = buildCreatureDef(id, dir);
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(def, null, 2) + '\n');
    written.push(id);
  }
  return written;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const written = integrateAll();
  console.log(`Integrated ${written.length} baked creature defs -> html/assets/sprites/monsters/`);
}
