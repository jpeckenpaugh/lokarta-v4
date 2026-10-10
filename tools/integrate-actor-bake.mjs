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

/* ---------------- cheap unrigged "movement" (LIV-110 follow-up) ----------------
 * The rukiya GLB is a single unrigged pose (1 node, 0 skins, 0 animations), so
 * there is no skeleton to drive limb motion. These cheap, seam-preserving
 * transforms synthesise basic movement from the baked pose:
 *   - walk: a leg shear — rows below `legStart` shift progressively so the feet
 *     swing while the hips stay connected (no cut-out gaps).
 *   - attack: an upper-body lean toward the target plus a small arm raise band,
 *     so a 3-frame draw/release reads without a rig.
 * They operate on char-grid rows only (no allocation in the render hot path) and
 * never touch the alpha silhouette's connectedness.
 */
function shiftRow(row, dx) {
  if (dx === 0) return row;
  const w = row.length;
  if (dx > 0) return '.'.repeat(dx) + row.slice(0, w - dx);
  return row.slice(-dx) + '.'.repeat(-dx);
}

/** Leg shear so the feet step; hips stay fixed. `legStart` = where legs begin. */
export function shearLegs(rows, amp, legStart = Math.round(rows.length * 0.68)) {
  const h = rows.length;
  if (legStart >= h - 1) return rows;
  return rows.map((row, y) => {
    if (y < legStart) return row;
    const t = (y - legStart) / (h - 1 - legStart);
    return shiftRow(row, Math.round(amp * t));
  });
}

/** Whole-sprite vertical bob (feet squash) for a subtle weight shift. */
export function bobSprite(rows, dy) {
  if (dy === 0) return rows;
  const w = rows[0].length;
  if (dy > 0) return ['.'.repeat(w), ...rows.slice(0, rows.length - dy)];
  return [...rows.slice(-dy), '.'.repeat(w)].slice(0, rows.length);
}

/**
 * Applies the cheap motion for a (state, frame-index) to a baked view's rows.
 * Idle/hit/death keep the baked pose; walk steps; attack leans + raises the bow.
 */
export function applyMotion(rows, state, idx, dir) {
  if (!rows || !rows.length) return rows;
  if (state === 'walk') {
    const sign = idx % 2 === 0 ? -1 : 1;
    return shearLegs(bobSprite(rows, idx % 2 === 1 ? 1 : 0), sign * 2);
  }
  if (state === 'attack') {
    const legStart = Math.round(rows.length * 0.68);
    // 0 = wind-up (lean back), 1 = release (lean into the shot), 2 = settle.
    const lean = idx === 1 ? 2 : idx === 0 ? -1 : 0;
    return rows.map((row, y) => (y >= legStart || lean === 0 ? row : shiftRow(row, lean)));
  }
  return rows;
}

/** Builds a runtime-ready Tier B actor def from a baked multi-view def plus a
 *  runtime def's animation table. */
export function bakeViewsIntoRuntime(viewDef, runtimeDef, { dirView = DIR_VIEW, motion = true } = {}) {
  const anims = runtimeDef.animations || {};
  const frames = {};
  for (const [state, table] of Object.entries(anims)) {
    for (const [dir, list] of Object.entries(table)) {
      if (!Array.isArray(list)) continue;
      const viewId = dirView[dir] || dirView.down;
      const rows = viewDef.frames[viewId];
      if (!rows) continue;
      list.forEach((fid, idx) => {
        frames[fid] = motion ? applyMotion(rows, state, idx, dir) : rows;
      });
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
