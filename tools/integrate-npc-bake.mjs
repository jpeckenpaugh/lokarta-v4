#!/usr/bin/env node
/**
 * Lokarta runtime NPC actor integration (LIV-134, Phase 1 of LIV-132).
 *
 * The bake (`tools/bake-npc-actors.mjs`) writes the committed 3D artifacts under
 * `docs/art/3d-poc/phase4/` — one `<npcSpriteId>.sprite.json` per NPC whose
 * frames are already named with the runtime animation ids (`idle_down`,
 * `walk_side_1`, ...). This tool is the final, GLB-free step: it adds the
 * runtime `animations` table and writes `html/assets/sprites/npc/<id>.json`.
 *
 * Why split: the bake needs the GLB (`.paperclip-repositories`, not in the repo)
 * but the runtime def must be verifiable in CI. Reading only the committed
 * artifact + this contract keeps T0 deterministic and GLB-free.
 *
 * Deterministic: identical inputs -> byte-identical output. Dev-only.
 *
 * Usage: node tools/integrate-npc-bake.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const ARTIFACT_DIR = path.join(ROOT, 'docs', 'art', '3d-poc', 'phase4');
export const NPC_DIR = path.join(ROOT, 'html', 'assets', 'sprites', 'npc');

/**
 * The runtime animation contract for baked NPC actors (art-direction.md §2):
 * directional idle (x1) + walk (x2, step-driven). The renderer falls back to
 * `idle.down[0]` for any state/dir an actor does not author, so shipping only
 * idle+walk is legal (docs/art/3d-sprite-mapping.md §1, §2.4).
 */
export const NPC_ANIMATIONS = {
  idle: { down: ['idle_down'], up: ['idle_up'], side: ['idle_side'], frameMs: null, advanceOn: 'timer' },
  walk: { down: ['walk_down_0', 'walk_down_1'], up: ['walk_up_0', 'walk_up_1'], side: ['walk_side_0', 'walk_side_1'], frameMs: null, advanceOn: 'step' },
};

/** The NPC sprite ids the baked set owns (must match npcs.json `npcSpriteId`s). */
export function listNpcArtifacts(dir = ARTIFACT_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith('npc_') && f.endsWith('.sprite.json'))
    .map((f) => f.slice(0, -'.sprite.json'.length))
    .sort();
}

/** Assembles one runtime NPC def from its committed baked artifact. */
export function buildNpcDef(id, dir = ARTIFACT_DIR) {
  const art = JSON.parse(fs.readFileSync(path.join(dir, `${id}.sprite.json`), 'utf8'));
  return {
    id,
    kind: 'npc',
    renderTier: art.renderTier || 'baked',
    ...(art.baked3d ? { baked3d: true } : {}),
    ...(art.outline === false ? { outline: false } : {}),
    native: { ...art.native },
    anchor: { ...art.anchor },
    ...(art.quantize ? { quantize: { ...art.quantize } } : {}),
    palette: { ...art.palette },
    animations: JSON.parse(JSON.stringify(NPC_ANIMATIONS)),
    frames: { ...art.frames },
  };
}

export function integrateAll(dir = ARTIFACT_DIR, outDir = NPC_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  const ids = listNpcArtifacts(dir);
  const written = [];
  for (const id of ids) {
    const def = buildNpcDef(id, dir);
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(def, null, 2) + '\n');
    written.push(id);
  }
  return written;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const written = integrateAll();
  console.log(`Integrated ${written.length} baked NPC defs -> html/assets/sprites/npc/`);
}
