#!/usr/bin/env node
/**
 * Lokarta NPC asset authoring entry point.
 *
 * History:
 *   - LIV-91 authored the 32x32 Havenreach NPC actor sprites and the 48x48
 *     portrait busts procedurally from the identity table.
 *   - LIV-134 (Phase 1 of LIV-132) superseded the NPC actors with 3D-baked
 *     64px sprites (`tools/bake-npc-actors.mjs` + `tools/integrate-npc-bake.mjs`).
 *   - LIV-136 (Phase 3 of LIV-132) superseded the hand-authored busts with
 *     3D-model head stills (`tools/bake-npc-portraits.mjs` +
 *     `tools/integrate-npc-portraits.mjs`).
 *
 * The 2D authoring code is retired: it would clobber the baked 64px actor defs
 * and overwrite the 3D portraits with the old hand-drawn busts. This tool now
 * only regenerates the runtime portrait sheet from the committed 3D artifacts
 * (GLB-free), so a single `node tools/author-npc-assets.mjs` stays safe.
 *
 * To re-bake the 3D source art (needs the `lokarta-private` GLBs) run:
 *   node tools/bake-npc-actors.mjs && node tools/integrate-npc-bake.mjs
 *   node tools/bake-npc-portraits.mjs && node tools/integrate-npc-portraits.mjs
 *
 * Usage: node tools/author-npc-assets.mjs
 */

import { integratePortraits } from './integrate-npc-portraits.mjs';

function main() {
  const ids = integratePortraits();
  console.log(`Regenerated ${ids.length} 3D portraits -> html/assets/portraits/portraits.json`);
  console.log('(NPC actor sprites are 3D-baked by tools/bake-npc-actors.mjs; see the header.)');
}

main();
