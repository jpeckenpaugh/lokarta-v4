#!/usr/bin/env node
/**
 * Lokarta runtime actor integration for a Tier B "baked" view def (LIV-110 follow-up).
 *
 * Phase 1 baked the rukiya archer from its GLB into a 4-view def
 * (`docs/art/3d-poc/rukiya_archer_baked.sprite.json`, frames `view_0/90/180/270`).
 * The runtime `SpriteRenderer.drawActor` consumes a *different* shape: named
 * animation frames (`idle_down`, `walk_down_0`, ...) resolved through an
 * `animations` state machine. This tool bridges the two without touching the
 * renderer: it maps the baked orthogonal views onto the runtime animation frame
 * ids by facing direction (down <- view_0, up <- view_180, side <- view_90) and
 * copies the source def's `animations` block verbatim.
 *
 * The GLB is a single unrigged pose, so idle/walk/attack share that direction's
 * baked pixels — the honest output of a static 3D->2D bake. The frame COUNT and
 * ids stay identical to the source, so every animation-contract test still holds.
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

export const RUKIYA_VIEWS = path.join(ROOT, 'docs', 'art', '3d-poc', 'rukiya_archer_baked.sprite.json');
export const ARCHER_RUNTIME = path.join(ROOT, 'html', 'assets', 'sprites', 'vocations', 'archer.json');

/** Baked azimuth-view frame id for each facing direction. */
export const DIR_VIEW = { down: 'view_0', up: 'view_180', side: 'view_90' };

/**
 * Builds a runtime-ready Tier B actor def from a baked multi-view def plus a
 * runtime def's animation table. The source runtime def supplies the geometry,
 * anchor, kind, `animations`, and any non-directional metadata; the view def
 * supplies the baked palette + view pixels.
 */
export function bakeViewsIntoRuntime(viewDef, runtimeDef, { dirView = DIR_VIEW } = {}) {
  const anims = runtimeDef.animations || {};
  const frames = {};
  for (const [state, table] of Object.entries(anims)) {
    for (const [dir, list] of Object.entries(table)) {
      if (!Array.isArray(list)) continue;
      const viewId = dirView[dir] || dirView.down;
      const rows = viewDef.frames[viewId];
      if (!rows) continue;
      for (const fid of list) frames[fid] = rows;
    }
  }
  // Any authored frame not reachable through the animation table is carried over
  // from the view's default so the def never references a missing frame.
  for (const fid of Object.keys(runtimeDef.frames || {})) {
    if (!frames[fid]) frames[fid] = viewDef.frames[dirView.down];
  }
  return {
    id: runtimeDef.id,
    kind: runtimeDef.kind,
    renderTier: viewDef.renderTier || 'baked',
    native: { ...runtimeDef.native },
    anchor: { ...(runtimeDef.anchor || { x: 16, y: 30 }) },
    palette: { ...viewDef.palette },
    animations: JSON.parse(JSON.stringify(anims)),
    frames,
  };
}

/** Reads the baked rukiya archer views + the Tier A archer runtime shell. */
export function buildArcherBaked() {
  const viewDef = JSON.parse(fs.readFileSync(RUKIYA_VIEWS, 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(ARCHER_RUNTIME, 'utf8'));
  return bakeViewsIntoRuntime(viewDef, runtime);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] || ARCHER_RUNTIME;
  const def = buildArcherBaked();
  fs.writeFileSync(out, JSON.stringify(def, null, 2) + '\n');
  console.log(`Wrote baked runtime archer (${Object.keys(def.frames).length} frames, ${Object.keys(def.palette).length} palette) -> ${path.relative(ROOT, out)}`);
}
