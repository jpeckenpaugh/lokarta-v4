#!/usr/bin/env node
/**
 * Lokarta sprite-def schema/validator (Node-only, zero dependencies).
 *
 * One contract for the char-grid sprite JSON authored under
 * `html/assets/sprites/**` and `docs/art/3d-poc/**`. It understands both
 * fidelity tiers from docs/art/art-direction-target.md §5 and the multi-tile
 * scene-object shape from docs/art/art-direction.md §1:
 *
 *   - `renderTier`: `"indexed"` (Tier A, default) | `"baked"` (Tier B)
 *   - palette cap is tier-aware: <=16 for indexed, <=32 for baked
 *   - frame geometry equals `native`
 *   - single-character palette keys, valid `#rrggbb` (`.` may be `null`)
 *   - multi-tile objects declare `{ tiles, anchor, placement }`; `native`
 *     equals `tiles * 32`, both dims are multiples of 32 and <=512, and the
 *     `placement.footprint` tile span equals the `tiles` span.
 *
 * Exported so `html/tests/sprite-assets.test.mjs` runs the same checks natively.
 * Usage: node tools/validate-sprite-def.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** Atomic tile: 32x32 native px == ONE tile (art-direction.md §1). */
export const NATIVE_TILE = 32;
/**
 * Legal native densities (art-direction.md §6, LIV-121): hand-authored /
 * 2D-derived art is 32 px per tile (N32); 3D-baked art is 64 px per tile (N64).
 * A def's density is inferred per-def from `native.w / tiles.w` (multi-tile) or
 * `native.w` (single-tile) so validators assert per-def/tier, never a global 32.
 */
export const NATIVE_TILES = [32, 64];

/**
 * The native px per tile of a def, inferred per-def. `64` for 3D-baked defs,
 * `32` for N32. Returns the inferred integer when it is a legal density, else
 * falls back to 32 so the caller's own mismatch check reports the real error.
 */
export function nativePerTile(def) {
  const nw = def && def.native && def.native.w;
  const nh = def && def.native && def.native.h;
  const tw = def && def.tiles && def.tiles.w;
  const th = def && def.tiles && def.tiles.h;
  if (Number.isInteger(nw) && Number.isInteger(nh) && Number.isInteger(tw) && Number.isInteger(th) && tw > 0 && th > 0) {
    if (nw % tw === 0 && nh % th === 0 && nw / tw === nh / th && NATIVE_TILES.includes(nw / tw)) return nw / tw;
  } else if (Number.isInteger(nw) && NATIVE_TILES.includes(nw)) {
    return nw;
  }
  return NATIVE_TILE;
}
/**
 * Allowed multi-tile footprint per axis. LIV-113 generalised the ceiling from
 * 4 (128px) to 16 (512px) so a large landmark such as the Havenreach longhouse
 * (12x4 tiles) fits ONE blitted bitmap through the existing footprint path. The
 * cap stays per-axis (not total area) so a def can be long in one dimension —
 * e.g. 12 tiles wide — while still rejecting accidental giant canvases.
 */
export const MULTI_TILE_MAX_TILES = 16;
export const MULTI_TILE_MAX_PX = NATIVE_TILE * MULTI_TILE_MAX_TILES;
export const RENDER_TIERS = ['indexed', 'baked'];
export const DEFAULT_RENDER_TIER = 'indexed';
export const PALETTE_CAP = { indexed: 16, baked: 32 };

/** Tier A when absent; validates the declared tier is known. */
export function resolveRenderTier(def) {
  return def && def.renderTier != null ? def.renderTier : DEFAULT_RENDER_TIER;
}

/** Palette ceiling for a def's tier: `baked ? 32 : 16`. */
export function paletteCapFor(def) {
  const tier = resolveRenderTier(def);
  return PALETTE_CAP[tier] ?? PALETTE_CAP[DEFAULT_RENDER_TIER];
}

/** True when a def opts into the multi-tile scene-object shape. */
export function isMultiTile(def) {
  return !!(def && def.tiles);
}

/** Inclusive footprint span [w, h] of an engine `[x0,y0,x1,y1]` rect. */
export function footprintSpan(footprint) {
  if (!Array.isArray(footprint) || footprint.length !== 4) return null;
  return [footprint[2] - footprint[0] + 1, footprint[3] - footprint[1] + 1];
}

/**
 * Validate one sprite def. Returns `{ errors }` (empty == valid). Additive:
 * Tier A defs that omit `renderTier` stay valid and cap at 16.
 */
export function validateSpriteDef(def, { label = def && def.id } = {}) {
  const errors = [];
  const push = (m) => errors.push(`${label}: ${m}`);
  if (!def || typeof def !== 'object') { push('def must be an object'); return { errors }; }

  if (def.renderTier != null && !RENDER_TIERS.includes(def.renderTier)) {
    push(`renderTier "${def.renderTier}" not in ${RENDER_TIERS.join('|')}`);
  }

  const native = def.native;
  const nativeOk = native && Number.isInteger(native.w) && Number.isInteger(native.h) && native.w > 0 && native.h > 0;
  if (!nativeOk) push('native must be positive integers {w,h}');

  if (def.frames && typeof def.frames === 'object' && nativeOk) {
    for (const [fid, rows] of Object.entries(def.frames)) {
      if (!Array.isArray(rows)) { push(`frame ${fid} must be an array of rows`); continue; }
      if (rows.length !== native.h) push(`frame ${fid}: ${rows.length} rows != native.h ${native.h}`);
      for (const row of rows) if (row.length !== native.w) push(`frame ${fid}: row width ${row.length} != native.w ${native.w}`);
    }
  }

  if (!def.palette || typeof def.palette !== 'object') {
    push('palette missing');
  } else {
    const cap = paletteCapFor(def);
    const entries = Object.entries(def.palette);
    if (entries.length > cap) push(`palette ${entries.length} > ${cap} (renderTier ${resolveRenderTier(def)})`);
    for (const [k, v] of entries) {
      if (k.length !== 1) push(`palette key "${k}" must be 1 char`);
      if (v === null) { if (k !== '.') push(`only "." may map to null (got "${k}")`); continue; }
      if (!/^#[0-9a-f]{6}$/i.test(v)) push(`palette ${k}=${v} not #rrggbb`);
    }
    if (def.frames && typeof def.frames === 'object') {
      for (const rows of Object.values(def.frames)) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows) for (const ch of row) {
          if (ch !== '.' && !def.palette[ch]) push(`uses undeclared palette char "${ch}"`);
        }
      }
    }
  }

  if (isMultiTile(def)) {
    const t = def.tiles;
    const pxPerTile = nativePerTile(def);
    const maxPx = MULTI_TILE_MAX_TILES * pxPerTile;
    if (!t || !Number.isInteger(t.w) || !Number.isInteger(t.h) || t.w < 1 || t.h < 1) {
      push('tiles must be positive integers {w,h}');
    } else {
      if (t.w > MULTI_TILE_MAX_TILES || t.h > MULTI_TILE_MAX_TILES) {
        push(`tiles ${t.w}x${t.h} exceeds ${MULTI_TILE_MAX_TILES}x${MULTI_TILE_MAX_TILES}`);
      }
      if (!NATIVE_TILES.includes(pxPerTile)) {
        push(`native ${native.w}x${native.h} over tiles ${t.w}x${t.h} is ${pxPerTile} px/tile; expected ${NATIVE_TILES.join(' or ')}`);
      }
      if (nativeOk && (native.w !== t.w * pxPerTile || native.h !== t.h * pxPerTile)) {
        push(`native ${native.w}x${native.h} != tiles ${t.w}x${t.h} * ${pxPerTile}px/tile`);
      }
    }
    if (nativeOk) {
      if (native.w % pxPerTile !== 0 || native.h % pxPerTile !== 0) push(`native ${native.w}x${native.h} not a multiple of ${pxPerTile}`);
      if (native.w > maxPx || native.h > maxPx) push(`native ${native.w}x${native.h} exceeds ${maxPx}x${maxPx}`);
    }
    const a = def.anchor;
    if (!a || !Number.isInteger(a.x) || !Number.isInteger(a.y)) push('anchor must be integer {x,y}');
    else if (nativeOk && (a.x < 0 || a.x > native.w || a.y < 0 || a.y > native.h)) push(`anchor {${a.x},${a.y}} outside canvas ${native.w}x${native.h}`);

    const place = def.placement;
    if (!place || place.mode !== 'multi-tile-blit') push('placement.mode must be "multi-tile-blit"');
    const span = footprintSpan(place && place.footprint);
    if (!span) push('placement.footprint must be [x0,y0,x1,y1]');
    else if (t && Number.isInteger(t.w) && Number.isInteger(t.h)) {
      // The LIV-107 assertion: canvas tile span must equal the footprint span.
      if ((native.w / pxPerTile) * (native.h / pxPerTile) !== span[0] * span[1] || span[0] !== t.w || span[1] !== t.h) {
        push(`footprint span ${span[0]}x${span[1]} != tiles ${t.w}x${t.h}`);
      }
    }
  }

  return { errors };
}

/** Multi-tile-only guard used by the footprint contract test. */
export function validateMultiTileDef(def, opts) {
  if (!isMultiTile(def)) return { errors: [`${(opts && opts.label) || (def && def.id)}: not a multi-tile def`] };
  return validateSpriteDef(def, opts);
}

const POC_DIR = path.join(ROOT, 'docs', 'art', '3d-poc');

export function validateCommittedMultiTileDefs({ dir = POC_DIR } = {}) {
  const errors = [];
  if (!fs.existsSync(dir)) return { errors, count: 0 };
  let count = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sprite.json')).sort()) {
    const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!isMultiTile(def)) continue;
    count++;
    errors.push(...validateSpriteDef(def, { label: f }).errors);
  }
  return { errors, count };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { errors, count } = validateCommittedMultiTileDefs();
  if (errors.length) {
    console.error(`Sprite defs: ${errors.length} problem(s)`);
    for (const e of errors) console.error('  ' + e);
    process.exitCode = 1;
  } else {
    console.log(`Sprite defs OK: ${count} multi-tile def(s) satisfy the tile/footprint/palette contract`);
  }
}
