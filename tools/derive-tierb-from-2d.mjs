#!/usr/bin/env node
/**
 * Lokarta Tier A -> Tier B "baked" derive path (LIV-110, Phase 2).
 *
 * Phase 1 baked Tier B from a 3D GLB render (`tools/gltf-to-sprite.mjs`). Phase 2
 * has no 3D source for the other 3 vocations or the 4 bosses and no meshy.ai
 * access, so this is the zero-cost derive path: take the EXISTING flat Tier A
 * char-grid sprite art and pass it through the SAME Tier B stage the GLB pipeline
 * uses — 135-degree upper-left key light + cool bounce + inner rim, chromaticity
 * k-means families x 4 ordered luma ramp steps with 2x2 Bayer dither, then the
 * 1px `#0b0d12` outline. The silhouette (alpha) is never touched, so gameplay
 * reads identically; only the interior shading changes.
 *
 * Because the 2D source is flat (one colour per material, no normals), this tool
 * synthesises a per-pixel surface normal from the silhouette: a chamfer distance
 * transform gives an "inflated dome" height field whose gradient becomes the
 * normal. That recovers the same lit-edge / shaded-edge read a 3D bake would,
 * without a mesh. See `docs/art/tierb-phase2-method.md` for the honest quality
 * delta vs a true 3D bake and the exact net-new-mesh ask.
 *
 * This is a DEV-ONLY authoring tool; the app never runs it. Zero dependencies:
 * it reuses the Phase 1 ramp/dither/outline passes and PNG encoder.
 *
 * Usage: node tools/derive-tierb-from-2d.mjs [outDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encodePNG,
  luma,
  rampPalette,
  quantizeRamp,
  outlinePass,
} from './gltf-to-sprite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const PHASE2_DIR = path.join(ROOT, 'docs', 'art', '3d-poc', 'phase2');

export const OUTLINE = '#0b0d12';

/**
 * The Phase 2 asset set: the 3 remaining vocations (archer's Tier B is the
 * Phase 1 3D-baked artifact) and the 4 tower bosses. Boss 3 `abyssal_overlord`
 * already has 48x48 Tier A art; the other three bosses have NO sprite art in the
 * repo, so they are derived from the abyssal_overlord silhouette via a documented
 * per-boss HSL retint (see the method doc). `families`/`steps` keep the palette
 * inside the Tier B ceiling (`families*steps + '0' + '.' <= 32`).
 *
 *   source    -> repo-relative flat Tier A def
 *   retint    -> optional HSL shift applied to the flat base colours first
 *   scale     -> proof upscale factor
 */
export const PHASE2_ASSETS = [
  { id: 'magician', source: 'html/assets/sprites/vocations/magician.json', scale: 7 },
  { id: 'paladin', source: 'html/assets/sprites/vocations/paladin.json', scale: 7 },
  { id: 'fighter', source: 'html/assets/sprites/vocations/fighter.json', scale: 7 },
  { id: 'abyssal_overlord', source: 'html/assets/sprites/monsters/abyssal_overlord.json', scale: 5 },
  { id: 'tidebound_king', source: 'html/assets/sprites/monsters/abyssal_overlord.json', scale: 5, retint: { hueDeg: 165, sat: 0.95, light: 1.0 } },
  { id: 'forgemaster_kol', source: 'html/assets/sprites/monsters/abyssal_overlord.json', scale: 5, retint: { hueDeg: -18, sat: 1.0, light: 0.95 } },
  { id: 'frostbound_choirmaster', source: 'html/assets/sprites/monsters/abyssal_overlord.json', scale: 5, retint: { hueDeg: 150, sat: 0.28, light: 1.18 } },
];

/* ---------------- colour helpers ---------------- */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)];
}
/** Applies a documented per-boss hue/sat/light shift to a flat colour. */
function retint(hex, tint) {
  if (!tint) return hex;
  const [r, g, b] = hexToRgb(hex);
  let [h, s, l] = rgbToHsl(r, g, b);
  h = (h + (tint.hueDeg || 0) / 360 + 1) % 1;
  s = Math.max(0, Math.min(1, s * (tint.sat == null ? 1 : tint.sat)));
  l = Math.max(0, Math.min(1, l * (tint.light == null ? 1 : tint.light)));
  const [nr, ng, nb] = hslToRgb(h, s, l);
  return rgbToHex(nr, ng, nb);
}

/* ---------------- char-grid <-> RGB ---------------- */
/** Parses one frame's rows + palette into `{ w, h, rgba }` (RGBA8). */
export function parseFrame(rows, palette) {
  const h = rows.length, w = h ? rows[0].length : 0;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const hex = palette[rows[y][x]];
    if (!hex) continue;
    const [r, g, b] = hexToRgb(hex); const i = (y * w + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
  return { w, h, rgba: Float32Array.from(rgba) };
}

/* ---------------- silhouette -> pseudo-normal ---------------- */
/**
 * Chamfer(3,4) distance transform of the opaque mask: 0 on transparent px, and
 * the distance-to-nearest-transparent on opaque px. Treating this as a height
 * field makes the sprite an inflated dome whose gradient is a plausible surface
 * normal — the same trick that lets a flat icon read as lit geometry.
 */
export function distanceTransform(mask, w, h) {
  const INF = 1e9; const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (d[i] === 0) continue;
    let best = d[i];
    if (x > 0) best = Math.min(best, d[i - 1] + 3);
    if (y > 0) best = Math.min(best, d[i - w] + 3);
    if (x > 0 && y > 0) best = Math.min(best, d[i - w - 1] + 4);
    if (x < w - 1 && y > 0) best = Math.min(best, d[i - w + 1] + 4);
    d[i] = best;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (d[i] === 0) continue;
    let best = d[i];
    if (x < w - 1) best = Math.min(best, d[i + 1] + 3);
    if (y < h - 1) best = Math.min(best, d[i + w] + 3);
    if (x < w - 1 && y < h - 1) best = Math.min(best, d[i + w + 1] + 4);
    if (x > 0 && y < h - 1) best = Math.min(best, d[i + w - 1] + 4);
    d[i] = best;
  }
  for (let i = 0; i < w * h; i++) if (d[i] > 1e8) d[i] = 0;
  return d;
}

/** 3x3 box blur of a scalar field, in place-safe (returns new array). */
function blur3(field, w, h, passes = 1) {
  let src = field;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        s += src[yy * w + xx]; n++;
      }
      out[y * w + x] = s / n;
    }
    src = out;
  }
  return src;
}

const KEY = (() => { const l = [-0.5, -0.5, 0.70710678]; return l; })(); // 135deg upper-left key

/**
 * Applies baked shading to a flat parsed frame. Returns a NEW `{ w, h, rgba }`
 * whose alpha is untouched. `baseRGB(x,y)` supplies the (possibly retinted) flat
 * colour for material identity; the shade multiplier comes from the dome normal.
 */
export function shadeFrame(img, baseRGB, { rim = 0.7, bounce = 0.35, ambient = 0.30, gain = 0.85, blur = 1 } = {}) {
  const { w, h } = img;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = img.rgba[i * 4 + 3] > 128 ? 1 : 0;
  const dist = blur3(distanceTransform(mask, w, h), w, h, blur);
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = img.rgba[i * 4 + 3];
    out[i * 4 + 3] = a;
    if (a <= 128) continue;
    const x = i % w, y = (i - x) / w;
    const hx = (x < w - 1 ? dist[i + 1] : dist[i]) - (x > 0 ? dist[i - 1] : dist[i]);
    const hy = (y < h - 1 ? dist[i + w] : dist[i]) - (y > 0 ? dist[i - w] : dist[i]);
    let nx = -hx, ny = -hy, nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz); nx *= inv; ny *= inv; nz *= inv;
    const diff = Math.max(0, nx * KEY[0] + ny * KEY[1] + nz * KEY[2]);
    let shade = ambient + gain * Math.pow(diff, 0.9);
    if (rim > 0) {
      const grazing = 1 - Math.min(1, Math.abs(nz));
      const keyEdge = Math.max(0, nx * KEY[0] + ny * KEY[1]);
      shade += rim * grazing * grazing * (0.30 + keyEdge);
    }
    const [br, bg, bb] = baseRGB(img.rgba[i * 4], img.rgba[i * 4 + 1], img.rgba[i * 4 + 2]);
    let r = br * shade, g = bg * shade, b = bb * shade;
    if (bounce > 0) {
      const k = (1 - diff) * bounce;
      r = r * (1 - k) + 38 * k; g = g * (1 - k) + 54 * k; b = b * (1 - k) + 96 * k;
    }
    out[i * 4] = Math.min(255, r); out[i * 4 + 1] = Math.min(255, g); out[i * 4 + 2] = Math.min(255, b);
  }
  return { w, h, rgba: out };
}

/* ---------------- ramp ordering guarantee ---------------- */
/**
 * rampPalette returns each family sorted ascending by luma but two sampled steps
 * can coincide (flat art). This nudges any non-strict step lighter so every
 * family is a genuinely strictly-increasing 4-step ramp, without changing hue.
 */
export function enforceRampOrdering(colors, families, steps) {
  for (let f = 0; f < families; f++) {
    for (let s = 1; s < steps; s++) {
      const cur = colors[f * steps + s], prev = colors[f * steps + s - 1];
      if (luma(...cur) > luma(...prev)) continue;
      const target = luma(...prev) * 1.08 + 1;
      const lum = luma(...cur) || 1;
      const k = target / lum;
      colors[f * steps + s] = cur.map((v) => Math.min(255, v * k));
    }
  }
  return colors;
}

/* ---------------- derivation ---------------- */
/**
 * Derives a Tier B "baked" def from a flat source def. Deterministic: identical
 * input -> byte-identical JSON. Options:
 *   families/steps  ramp granularity (default 6 x 4 => 24 colours)
 *   retint          optional HSL shift of the flat base colours
 *   shade           overrides for the shade model
 */
export function deriveTierB(sourceDef, {
  id = sourceDef.id,
  kind = sourceDef.kind,
  families = 6,
  steps = 4,
  retint: tint = null,
  shade = {},
} = {}) {
  const fam = Math.max(1, Math.min(families, Math.floor(30 / steps)));
  const baseRGB = tint ? (r, g, b) => hexToRgb(retint(rgbToHex(r, g, b), tint)) : (r, g, b) => [r, g, b];

  const frames = {};
  const shadedByFrame = {};
  const all = [];
  for (const [fid, rows] of Object.entries(sourceDef.frames)) {
    const flat = parseFrame(rows, sourceDef.palette);
    const shaded = shadeFrame(flat, baseRGB, shade);
    shadedByFrame[fid] = shaded;
    for (let i = 0; i < shaded.w * shaded.h; i++) {
      if (shaded.rgba[i * 4 + 3] > 128) all.push([shaded.rgba[i * 4], shaded.rgba[i * 4 + 1], shaded.rgba[i * 4 + 2]]);
    }
  }
  const ramp = rampPalette(all, { families: fam, steps });
  enforceRampOrdering(ramp.colors, fam, steps);

  const palette = { '0': OUTLINE };
  ramp.colors.forEach((c, i) => { palette[(i + 1).toString(36)] = rgbToHex(...c); });
  palette['.'] = null;

  for (const [fid, shaded] of Object.entries(shadedByFrame)) {
    frames[fid] = outlinePass(quantizeRamp(shaded, ramp), shaded.w, shaded.h);
  }

  const def = {
    id,
    kind,
    renderTier: 'baked',
    source: `${path.basename(sourceDef.id)} Tier A char-grid (derive-from-2D)`,
    method: `${fam}x${steps}-ramp palettes + 2x2 Bayer dither + baked 135deg key/rim from silhouette dome -> 1px outline`,
    native: { w: sourceDef.native.w, h: sourceDef.native.h },
    anchor: { ...sourceDef.anchor },
    palette,
    frames,
  };
  if (sourceDef.tiles) def.tiles = { ...sourceDef.tiles };
  if (sourceDef.placement) def.placement = JSON.parse(JSON.stringify(sourceDef.placement));
  return def;
}

/** Reads a source def from a repo-relative path. */
export function readSource(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

/** Flat "before" def for a retinted boss: same silhouette, retinted flat palette. */
export function beforeDefFor(asset) {
  const src = readSource(asset.source);
  if (!asset.retint) return src;
  const palette = {};
  for (const [k, v] of Object.entries(src.palette)) palette[k] = v == null ? null : (k === '0' ? v : retint(v, asset.retint));
  return { ...src, id: asset.id, palette };
}

/** The committed path of one asset's Tier B def. */
export function defPathFor(asset) { return path.join(PHASE2_DIR, `${asset.id}_baked.sprite.json`); }

/* ---------------- proof panels ---------------- */
const BG = [10, 11, 14, 255];
const SEP = [42, 49, 64, 255];
const PAD = 6;

function applyOutlinePixels(pix, outlineHex) {
  const { w, h } = pix; const data = pix.rgba; const out = new Float32Array(data);
  const [or, og, ob] = hexToRgb(outlineHex);
  const art = (x, y) => (x < 0 || x >= w || y < 0 || y >= h ? false : data[(y * w + x) * 4 + 3] > 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i + 3] > 0) continue;
    if (art(x - 1, y) || art(x + 1, y) || art(x, y - 1) || art(x, y + 1)) { out[i] = or; out[i + 1] = og; out[i + 2] = ob; out[i + 3] = 255; }
  }
  return { w, h, rgba: out };
}
function scalePixels(pix, scale) {
  const { w, h, rgba } = pix; const sw = w * scale, sh = h * scale; const out = new Float32Array(sw * sh * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * w + x) * 4;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const di = ((y * scale + dy) * sw + (x * scale + dx)) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return { w: sw, h: sh, rgba: out };
}
function frameTile(def, frameId, scale) {
  const pix = applyOutlinePixels(parseFrame(def.frames[frameId], def.palette), def.palette['0'] || OUTLINE);
  return scalePixels(pix, scale);
}
function blit(buf, W, tile, ox, oy) {
  for (let y = 0; y < tile.h; y++) for (let x = 0; x < tile.w; x++) {
    const si = (y * tile.w + x) * 4; const a = tile.rgba[si + 3] / 255;
    const di = ((oy + y) * W + (ox + x)) * 4;
    buf[di] = Math.round(tile.rgba[si] * a + BG[0] * (1 - a));
    buf[di + 1] = Math.round(tile.rgba[si + 1] * a + BG[1] * (1 - a));
    buf[di + 2] = Math.round(tile.rgba[si + 2] * a + BG[2] * (1 - a));
    buf[di + 3] = 255;
  }
}
function rgbaToPngBuf(tile) {
  const buf = Buffer.alloc(tile.w * tile.h * 4);
  for (let i = 0; i < tile.w * tile.h; i++) {
    for (let c = 0; c < 4; c++) buf[i * 4 + c] = Math.round(tile.rgba[i * 4 + c]);
  }
  return buf;
}

/** Renders one before/after proof pair into `outDir`. Returns written paths. */
export function renderProofPair(asset, outDir, afterDef) {
  const before = beforeDefFor(asset);
  const after = afterDef || JSON.parse(fs.readFileSync(defPathFor(asset), 'utf8'));
  const frame = 'idle_down';
  const bTile = frameTile(before, frame, asset.scale);
  const aTile = frameTile(after, frame, asset.scale);
  const W = bTile.w + aTile.w + PAD * 3 + 1;
  const H = Math.max(bTile.h, aTile.h) + PAD * 2;
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = BG[3]; }
  blit(buf, W, bTile, PAD, PAD);
  blit(buf, W, aTile, PAD * 2 + bTile.w, PAD);
  const sepX = PAD * 2 + bTile.w - 1 + Math.floor(PAD / 2);
  for (let y = 0; y < H; y++) { const di = (y * W + sepX) * 4; buf[di] = SEP[0]; buf[di + 1] = SEP[1]; buf[di + 2] = SEP[2]; buf[di + 3] = SEP[3]; }
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const combined = path.join(outDir, `${asset.id}_before_after.png`);
  fs.writeFileSync(combined, encodePNG(W, H, buf)); written.push(combined);
  const beforePath = path.join(outDir, `${asset.id}_before.png`);
  fs.writeFileSync(beforePath, encodePNG(bTile.w, bTile.h, rgbaToPngBuf(bTile))); written.push(beforePath);
  const afterPath = path.join(outDir, `${asset.id}_after.png`);
  fs.writeFileSync(afterPath, encodePNG(aTile.w, aTile.h, rgbaToPngBuf(aTile))); written.push(afterPath);
  return written;
}

/** Writes every Phase 2 def + proof set into `outDir` (default PHASE2_DIR). */
export function exportPhase2(outDir = PHASE2_DIR, { writeDefs = true } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const asset of PHASE2_ASSETS) {
    const def = deriveTierB(readSource(asset.source), { id: asset.id, retint: asset.retint });
    if (writeDefs) {
      const p = path.join(outDir, `${asset.id}_baked.sprite.json`);
      fs.writeFileSync(p, JSON.stringify(def, null, 2) + '\n'); written.push(p);
    }
    written.push(...renderProofPair(asset, outDir, def));
  }
  return written;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] || PHASE2_DIR;
  const written = exportPhase2(out);
  console.log(`Phase 2 Tier B: wrote ${written.length} file(s) under ${path.relative(ROOT, out)}`);
}
