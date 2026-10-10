#!/usr/bin/env node
/**
 * Lokarta Phase 3 proof sheets (LIV-111).
 *
 * Emits deterministic review PNGs under `docs/art/3d-poc/phase3/`:
 *   - hut_variants.png  — the four baked facings + the large front variant
 *   - archer_rig.png    — the rig-sampled archer frames per facing/state
 *   - town_havenreach.png — the reshaped town rendered through the engine path
 *
 * Self-serve review aid (docs/engineering/agents.md §8), not a T0 gate. Usage:
 *   node tools/render-phase3-proof.mjs [outDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePNG } from './gltf-to-sprite.mjs';
import { renderTownPreview } from './render-town-preview.mjs';
import { BUILDING_CATALOG, SPRITE_CATALOG } from '../html/assets/sprites/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BG = [10, 11, 14, 255];

function blank(w, h) { const b = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) { b[i * 4] = BG[0]; b[i * 4 + 1] = BG[1]; b[i * 4 + 2] = BG[2]; b[i * 4 + 3] = 255; } return b; }

function hexRGB(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

/** Blits one sprite def frame, integer-upscaled, into a buffer. */
function blitFrame(buf, W, H, def, frameId, ox, oy, scale) {
  const rows = def.frames[frameId];
  if (!rows) return;
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) {
    const hex = def.palette[rows[y][x]];
    if (!hex) continue;
    const [r, g, b] = hexRGB(hex);
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const px = ox + x * scale + dx, py = oy + y * scale + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const di = (py * W + px) * 4;
      buf[di] = r; buf[di + 1] = g; buf[di + 2] = b; buf[di + 3] = 255;
    }
  }
}

/** Lays one frame per entry left-to-right at a per-tile integer scale. */
function rowSheet(entries, scale, pad) {
  const tiles = entries.map((e) => ({ ...e, def: e.def, key: e.key }));
  const maxH = Math.max(...tiles.map((e) => e.def.frames[e.key].length));
  const W = tiles.reduce((a, e) => a + e.def.frames[e.key][0].length * scale + pad, pad);
  const H = maxH * scale + pad * 2;
  const buf = blank(W, H);
  let cx = pad;
  for (const e of tiles) {
    const h = e.def.frames[e.key].length;
    const oy = pad + (maxH - h) * scale; // bottom-align
    blitFrame(buf, W, H, e.def, e.key, cx, oy, scale);
    cx += e.def.frames[e.key][0].length * scale + pad;
  }
  return { W, H, buf };
}

export function renderHutVariants() {
  const ids = ['fishing_hut', 'fishing_hut_large', 'fishing_hut_right', 'fishing_hut_left', 'fishing_hut_back'];
  const entries = ids.map((id) => { const def = BUILDING_CATALOG[id]; return { key: (def.placement && def.placement.defaultFrame) || 'view_0', def }; });
  return rowSheet(entries, 4, 8);
}

export function renderArcherRig() {
  const def = SPRITE_CATALOG.archer;
  const layout = {
    down: ['idle_down', 'walk_down_0', 'walk_down_1', 'attack_down_0', 'attack_down_1', 'attack_down_2', 'hit_down', 'death_0', 'death_1', 'death_2', 'death_3'],
    side: ['idle_side', 'walk_side_0', 'walk_side_1', 'attack_side_0', 'attack_side_1', 'attack_side_2', 'hit_side', 'death_0', 'death_1', 'death_2', 'death_3'],
    up: ['idle_up', 'walk_up_0', 'walk_up_1', 'attack_up_0', 'attack_up_1', 'attack_up_2', 'hit_up', 'death_0', 'death_1', 'death_2', 'death_3'],
  };
  const rows = Object.values(layout).map((keys) => rowSheet(keys.map((key) => ({ key, def })), 5, 4));
  const W = Math.max(...rows.map((r) => r.W));
  const H = rows.reduce((a, r) => a + r.H, 0);
  const buf = blank(W, H);
  let oy = 0;
  for (const r of rows) {
    for (let y = 0; y < r.H; y++) buf.set(r.buf.subarray(y * r.W * 4, y * r.W * 4 + r.W * 4), ((oy + y) * W) * 4);
    oy += r.H;
  }
  return { W, H, buf };
}

export function writePhase3Proof(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const hut = renderHutVariants(); fs.writeFileSync(path.join(outDir, 'hut_variants.png'), encodePNG(hut.W, hut.H, hut.buf)); written.push('hut_variants.png');
  const arch = renderArcherRig(); fs.writeFileSync(path.join(outDir, 'archer_rig.png'), encodePNG(arch.W, arch.H, arch.buf)); written.push('archer_rig.png');
  const town = renderTownPreview('town_havenreach'); fs.writeFileSync(path.join(outDir, 'town_havenreach.png'), encodePNG(town.W, town.H, town.buf)); written.push('town_havenreach.png');
  return written;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] || path.join(ROOT, 'docs', 'art', '3d-poc', 'phase3');
  const written = writePhase3Proof(out);
  console.log(`Wrote ${written.length} Phase 3 proof sheets -> ${path.relative(ROOT, out)}`);
}
