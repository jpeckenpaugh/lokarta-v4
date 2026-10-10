#!/usr/bin/env node
/**
 * Lokarta runtime NPC portrait integration (LIV-136, Phase 3 of LIV-132).
 *
 * The bake (`tools/bake-npc-portraits.mjs`) writes the committed 3D portrait
 * artifacts under `docs/art/3d-poc/phase4/portraits/` — one `<npcSpriteId>.portrait.json`
 * per NPC carrying the three expression frames (`neutral`, `warm`, `urgent`)
 * plus the shared palette. This tool is the final, GLB-free step: it assembles
 * the runtime portrait sheet `html/assets/portraits/portraits.json` keyed by the
 * ids each NPC's `portraits` map points at (`portrait_<npcId>_<expression>`), so
 * `resolvePortraitId` + dialogue-stage resolution stay unchanged.
 *
 * Why split: the bake needs the GLB (`.paperclip-repositories`, not in the repo)
 * but the runtime sheet must be verifiable in CI. Reading only the committed
 * artifact + this contract keeps T0 deterministic and GLB-free.
 *
 * Deterministic: identical artifacts -> byte-identical output. Dev-only.
 *
 * Usage: node tools/integrate-npc-portraits.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTRAIT_ARTIFACT_DIR, PORTRAIT_SIZE, EXPRESSIONS } from './bake-npc-portraits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const PORTRAIT_DIR = path.join(ROOT, 'html', 'assets', 'portraits');
export const PORTRAIT_CATALOG_PATH = path.join(PORTRAIT_DIR, 'portraits.json');

/** The baked portrait artifact ids present on disk (`npc_*`), sorted. */
export function listPortraitArtifacts(dir = PORTRAIT_ARTIFACT_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith('npc_') && f.endsWith('.portrait.json'))
    .map((f) => f.slice(0, -'.portrait.json'.length))
    .sort();
}

/** The `portrait_<npcId>_<expression>` catalog id for an NPC sprite id. */
export function portraitIdFor(npcSpriteId, expression) {
  return `portrait_${npcSpriteId.replace(/^npc_/, '')}_${expression}`;
}

/**
 * Assembles one runtime portrait def for `(npcSpriteId, expression)` from its
 * committed baked artifact. Keeps the id scheme and the 48x48 `bust` frame key.
 */
export function buildPortraitDef(npcSpriteId, expression, dir = PORTRAIT_ARTIFACT_DIR) {
  const art = JSON.parse(fs.readFileSync(path.join(dir, `${npcSpriteId}.portrait.json`), 'utf8'));
  const rows = art.expressions[expression];
  if (!rows) throw new Error(`integrate-npc-portraits: ${npcSpriteId} has no "${expression}" frame`);
  return {
    id: portraitIdFor(npcSpriteId, expression),
    kind: 'portrait',
    npcId: art.npcId,
    expression,
    renderTier: 'baked',
    baked3d: true,
    outline: false,
    native: { w: PORTRAIT_SIZE, h: PORTRAIT_SIZE },
    palette: { ...art.palette },
    frames: { bust: rows },
  };
}

/** Builds the full `portraits.json` payload from the committed artifacts. */
export function buildPortraitSheet(dir = PORTRAIT_ARTIFACT_DIR) {
  const portraits = {};
  for (const npcSpriteId of listPortraitArtifacts(dir)) {
    for (const expression of EXPRESSIONS) {
      const def = buildPortraitDef(npcSpriteId, expression, dir);
      portraits[def.id] = def;
    }
  }
  return { version: 1, native: { w: PORTRAIT_SIZE, h: PORTRAIT_SIZE }, portraits };
}

export function integratePortraits(dir = PORTRAIT_ARTIFACT_DIR, outPath = PORTRAIT_CATALOG_PATH) {
  const sheet = buildPortraitSheet(dir);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(sheet, null, 2) + '\n');
  return Object.keys(sheet.portraits);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ids = integratePortraits();
  console.log(`Integrated ${ids.length} 3D portraits -> html/assets/portraits/portraits.json`);
}
