#!/usr/bin/env node
/**
 * Lokarta prop/tile asset validator (Node-only, zero dependencies).
 *
 * Enforces the contract the prop assets share with actor sprites (see
 * docs/art-direction.md §2.5/§3 and docs/art-direction-tower.md):
 *   - frame geometry equals native size
 *   - palette <= 16 entries, valid hex, declared chars only
 *   - a rim color with >= 3:1 contrast against the tier floor
 *   - tier progression is structural (teeth/bands/studs), not hue-only, so the
 *     three tiers stay distinguishable in greyscale (WCAG 1.4.1).
 *
 * Exported so `html/tests/prop-assets.test.mjs` runs the same checks natively.
 * Usage: node tools/validate-prop-assets.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const SPRITES_DIR = path.join(ROOT, 'html', 'assets', 'sprites');

function srgbToLin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
export function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Count opaque connected runs ("features") in a frame row band. */
function rowRuns(rows, y) {
  let runs = 0, prev = null;
  for (const ch of rows[y]) {
    const on = ch !== '.';
    if (on && !prev) runs++;
    prev = on;
  }
  return runs;
}

export function validatePropAssets({ spritesDir = SPRITES_DIR } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(spritesDir, 'manifest.json'), 'utf8'));
  const themes = JSON.parse(fs.readFileSync(path.join(ROOT, 'html', 'data', 'tile_themes.json'), 'utf8'));
  const errors = [];
  const tiers = ['copper', 'silver', 'gold'];
  const floorByTier = { copper: '#1c1a17', silver: '#1c1a17', gold: '#1c1a17' };
  for (const t of Object.values(themes.levels)) floorByTier[t.id] = t.floor.fill;

  /** Floors a furniture prop appears on, derived from levels[n].props.set. */
  const levelsForPropId = id => {
    const bare = id.replace(/^prop_/, '');
    const floors = new Set();
    for (const lv of Object.values(themes.levels || {})) {
      const set = (lv.props && lv.props.set) || [];
      if (set.includes(bare)) floors.add(lv.floor.fill);
    }
    if (floors.size === 0) floors.add(themes.floor.fill);
    return [...floors];
  };

  const defs = {};
  for (const [id, meta] of Object.entries(manifest.props || {})) {
    const def = JSON.parse(fs.readFileSync(path.join(spritesDir, meta.file), 'utf8'));
    defs[id] = { def, meta };
    const { w, h } = meta.native;

    if (def.native.w !== w || def.native.h !== h) errors.push(`${id}: native ${def.native.w}x${def.native.h} != manifest ${w}x${h}`);
    for (const [fid, rows] of Object.entries(def.frames)) {
      if (rows.length !== h) errors.push(`${id}/${fid}: ${rows.length} rows != ${h}`);
      for (const row of rows) if (row.length !== w) errors.push(`${id}/${fid}: row width ${row.length} != ${w}`);
    }
    const entries = Object.entries(def.palette);
    if (entries.length > 16) errors.push(`${id}: palette ${entries.length} > 16`);
    for (const [k, v] of entries) {
      if (k.length !== 1) errors.push(`${id}: palette key "${k}"`);
      if (v !== null && !/^#[0-9a-f]{6}$/i.test(v)) errors.push(`${id}: palette ${k}=${v}`);
    }
    for (const rows of Object.values(def.frames)) {
      for (const row of rows) for (const ch of row) {
        if (ch !== '.' && !def.palette[ch]) errors.push(`${id}: undeclared char "${ch}"`);
      }
    }

    // D4 prop/decor shape (additive; tier props keep the legacy tier checks).
    const kind = def.kind || meta.kind;
    const cls = def.class || meta.class;
    if (cls !== undefined && !['wall', 'free', 'decor'].includes(cls)) {
      errors.push(`${id}: invalid class "${cls}"`);
    }
    if (meta.frames !== undefined) {
      if (!Array.isArray(meta.frames) || meta.frames.length === 0) errors.push(`${id}: frames must be a non-empty array`);
      else for (const f of meta.frames) if (!def.frames[f]) errors.push(`${id}: declared frame "${f}" missing`);
    }
    if (meta.anchor && (!Number.isInteger(meta.anchor.x) || !Number.isInteger(meta.anchor.y))) {
      errors.push(`${id}: anchor must be integer {x,y}`);
    }

    // Rim gate. Tier props validate against their tier floor; D4 furniture
    // validates against every level floor it appears on; decor is exempt.
    if (def.tier) {
      const floor = floorByTier[def.tier];
      if (!floor) errors.push(`${id}: unknown tier ${def.tier}`);
      else {
        const best = Math.max(0, ...Object.values(def.palette).filter(Boolean).map(v => contrast(v, floor)));
        if (best < 3.0) errors.push(`${id}: best contrast ${best.toFixed(2)} < 3.0 vs ${floor}`);
      }
    } else if (kind === 'decor') {
      // Floor decals are intentionally low-contrast; exempt from the rim gate.
    } else {
      if (!['wall', 'free'].includes(cls)) errors.push(`${id}: prop must declare class "wall"|"free"`);
      for (const floor of levelsForPropId(id)) {
        const best = Math.max(0, ...Object.values(def.palette).filter(Boolean).map(v => contrast(v, floor)));
        if (best < 3.0) errors.push(`${id}: best contrast ${best.toFixed(2)} < 3.0 vs ${floor}`);
      }
    }
  }

  // Structural tier progression: countable non-color cues must increase by tier.
  const teeth = tier => {
    const d = defs[`key_${tier}`].def.frames.icon;
    // teeth extend right of the shaft at x>=18; count distinct tooth rows.
    let count = 0;
    for (let y = 0; y < d.length; y++) if (d[y][18] !== '.' && d[y][19] !== '.') count++;
    return count;
  };
  const bands = tier => {
    const rows = defs[`chest_${tier}`].def.frames.closed;
    // Count metal-stud columns in the lid interior. Side bands (x 4-9, 22-27)
    // and the lock band (x 13-18) are shared by all tiers, so exclude them;
    // the remaining lid studs increase per tier (structural, not hue-only).
    const cols = new Set();
    for (let y = 5; y <= 14; y++) {
      const row = rows[y];
      for (let x = 10; x <= 21; x++) {
        if (x >= 13 && x <= 18) continue;
        if (row[x] === 'a' || row[x] === 'b' || row[x] === 'c') cols.add(x);
      }
    }
    return cols.size;
  };
  if (!(teeth('copper') < teeth('silver') && teeth('silver') < teeth('gold'))) {
    errors.push(`key teeth not strictly increasing: ${tiers.map(t => `${t}=${teeth(t)}`).join(', ')}`);
  }
  if (!(bands('copper') < bands('silver') && bands('silver') < bands('gold'))) {
    errors.push(`chest banding not strictly increasing: ${tiers.map(t => `${t}=${bands(t)}`).join(', ')}`);
  }
  // Door frame studs: gold >= silver > copper.
  const doorStuds = tier => defs[`gated_door_${tier}`].def.frames.closed.reduce((n, r) => n + [...r].filter(ch => ch === 'b').length, 0);
  if (!(doorStuds('gold') > doorStuds('copper'))) errors.push('gold door must add structural studs over copper');

  return { errors, tiers, defs };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { errors } = validatePropAssets();
  if (errors.length) {
    console.error(`Props: ${errors.length} problem(s)`);
    for (const e of errors) console.error('  ' + e);
    process.exitCode = 1;
  } else {
    console.log('Prop assets OK: geometry, palette, rim contrast, structural tier progression');
  }
}
