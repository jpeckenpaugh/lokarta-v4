#!/usr/bin/env node
/**
 * Lokarta LIV-139 movement-tween proof strip (Node-only, zero dependencies).
 *
 * Renders a deterministic frame strip showing one player hop and one opponent
 * hop, each drawn at the START tile, the three intermediate tween frames, and
 * the LAND tile. The intermediate x positions come from the same
 * `tweenIntermediatePositions` helper the runtime renderer uses, so the strip
 * cannot drift from the shipped interpolation.
 *
 * Review aid (docs/engineering/agents.md §8), not a T0 gate. Usage:
 *   node tools/render-liv139-tween-proof.mjs [outFile]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPRITE_CATALOG } from '../html/assets/sprites/index.js';
import { parseFrame, applyOutline } from '../html/app/sprite-renderer.js';
import { tweenIntermediatePositions } from '../html/app/actor-tween.js';
import { CONFIG } from '../html/engine/config.js';
import { MOVEMENT_CATALOG } from '../html/data/index.js';
import { encodePNG } from './render-sprite-preview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 32;
const SCALE = 3;
const TILEPX = CELL * SCALE;
const PW = 2 * TILEPX; // two tiles wide so the hop across the boundary reads
const PH = 2 * TILEPX;
const GAP = 12;
const MARGIN = 24;
const FONT_SCALE = 3;
const PANELS = 2 + CONFIG.MOVE_TWEEN_INTERMEDIATE_FRAMES; // start + intermediates + land

let W = 0;
let H = 0;

/* ---------------- 3x5 bitmap font (uppercase, digits, few symbols) ---------------- */
const GLYPHS = {
  A: ['010', '101', '111', '101', '101'], B: ['110', '101', '110', '101', '110'],
  C: ['011', '100', '100', '100', '011'], D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'], F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'], H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'], J: ['001', '001', '001', '101', '010'],
  K: ['101', '101', '110', '101', '101'], L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'], N: ['101', '111', '111', '111', '101'],
  O: ['010', '101', '101', '101', '010'], P: ['110', '101', '110', '100', '100'],
  Q: ['010', '101', '101', '110', '011'], R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'], T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'], V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'], X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'], Z: ['111', '001', '010', '100', '111'],
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
  2: ['110', '001', '010', '100', '111'], 3: ['111', '001', '011', '001', '111'],
  4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '110', '001', '110'],
  6: ['011', '100', '110', '101', '010'], 7: ['111', '001', '010', '010', '010'],
  8: ['010', '101', '010', '101', '010'], 9: ['010', '101', '011', '001', '110'],
  ' ': ['000', '000', '000', '000', '000'], ':': ['000', '010', '000', '010', '000'],
  '/': ['001', '001', '010', '100', '100'], '.': ['000', '000', '000', '000', '010'],
  '-': ['000', '000', '111', '000', '000'], '>': ['100', '010', '001', '010', '100'],
};

function setPx(buf, x, y, rgba) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
}

function fillRect(buf, x0, y0, w, h, rgba) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(buf, x, y, rgba);
}

function strokeRect(buf, x0, y0, w, h, rgba) {
  for (let x = x0; x < x0 + w; x++) { setPx(buf, x, y0, rgba); setPx(buf, x, y0 + h - 1, rgba); }
  for (let y = y0; y < y0 + h; y++) { setPx(buf, x0, y, rgba); setPx(buf, x0 + w - 1, y, rgba); }
}

function drawText(buf, x, y, text, rgba) {
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const g = GLYPHS[ch] || GLYPHS[' '];
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
      if (g[gy][gx] !== '1') continue;
      fillRect(buf, cx + gx * FONT_SCALE, y + gy * FONT_SCALE, FONT_SCALE, FONT_SCALE, rgba);
    }
    cx += 4 * FONT_SCALE;
  }
}

function actorFrame(spriteId, frameId) {
  const def = SPRITE_CATALOG[spriteId];
  if (!def) return null;
  const frame = def.frames[frameId] || Object.values(def.frames)[0];
  const pix = parseFrame(frame, def.palette);
  return def.outline === false ? pix : applyOutline(pix, def.palette['0'] || '#0b0d12');
}

function blit(buf, pix, ox, oy, scale) {
  for (let y = 0; y < pix.h; y++) for (let x = 0; x < pix.w; x++) {
    const si = (y * pix.w + x) * 4;
    const a = pix.data[si + 3] / 255;
    if (a <= 0) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const px = ox + x * scale + dx; const py = oy + y * scale + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const di = (py * W + px) * 4;
      buf[di] = Math.round(pix.data[si] * a + buf[di] * (1 - a));
      buf[di + 1] = Math.round(pix.data[si + 1] * a + buf[di + 1] * (1 - a));
      buf[di + 2] = Math.round(pix.data[si + 2] * a + buf[di + 2] * (1 - a));
      buf[di + 3] = 255;
    }
  }
}

const BG = [12, 13, 18, 255];
const TILE_A = [30, 33, 42, 255];
const TILE_B = [40, 46, 60, 255];
const EDGE = [90, 98, 120, 255];
const TARGET = [231, 185, 92, 255];
const PIP_ON = [124, 227, 255, 255];
const PIP_OFF = [55, 60, 74, 255];
const SHADOW = [0, 0, 0, 90];

function drawRow(buf, x0, y0, spriteId, frameId, label, captions) {
  const pix = actorFrame(spriteId, frameId);
  const offsets = [0, ...tweenIntermediatePositions(0, 0, 1, 0, CONFIG.MOVE_TWEEN_INTERMEDIATE_FRAMES).map((p) => p.x), 1];

  drawText(buf, x0, y0, label, [220, 228, 245, 255]);
  const rowTop = y0 + 7 * FONT_SCALE + 10;

  for (let i = 0; i < PANELS; i++) {
    const px = x0 + i * (PW + GAP);
    // Two tiles: source (A) and destination (B, tinted + gold target marker).
    fillRect(buf, px, rowTop, TILEPX, PH, TILE_A);
    fillRect(buf, px + TILEPX, rowTop, TILEPX, PH, TILE_B);
    for (let gx = 0; gx <= 2; gx++) {
      const gxl = px + gx * TILEPX;
      for (let y = rowTop; y < rowTop + PH; y += 2) setPx(buf, gxl, y, EDGE);
    }
    for (let gy = 0; gy <= 2; gy++) {
      const gyl = rowTop + gy * (PH / 2);
      for (let x = px; x < px + PW; x += 2) setPx(buf, x, Math.min(H - 1, gyl), EDGE);
    }
    strokeRect(buf, px, rowTop, PW, PH, EDGE);

    // Destination target marker (centre of tile B).
    const tcx = px + TILEPX + TILEPX / 2;
    const tcy = rowTop + PH / 2;
    for (let dy = -12; dy <= 12; dy += 2) setPx(buf, tcx, tcy + dy, TARGET);
    for (let dx = -12; dx <= 12; dx += 2) setPx(buf, tcx + dx, tcy, TARGET);

    // Step pips: how far through the hop this panel is.
    for (let j = 0; j < PANELS; j++) fillRect(buf, px + 8 + j * 12, rowTop + 8, 7, 7, j <= i ? PIP_ON : PIP_OFF);

    // The actor, drawn at its interpolated x (source tile origin + offset).
    const groundY = rowTop + PH - 16;
    const ox = Math.round(px + offsets[i] * TILEPX + TILEPX / 2 - (pix.w * SCALE) / 2);
    const oy = groundY - pix.h * SCALE;
    fillRect(buf, ox + 8, groundY - 4, pix.w * SCALE - 16, 5, SHADOW);
    blit(buf, pix, ox, oy, SCALE);

    drawText(buf, px + 6, rowTop + PH + 10, captions[i], [150, 160, 182, 255]);
  }

  return rowTop + PH + 10 + 7 * FONT_SCALE;
}

function main() {
  const out = process.argv[2] || path.join(ROOT, 'docs', 'art', 'preview', 'liv139-tween-framestrip.png');

  const rowSpan = PW * PANELS + GAP * (PANELS - 1);
  W = MARGIN * 2 + rowSpan;
  const captions = Array.from({ length: PANELS }, (_, i) => (i === 0 ? 'START' : i === PANELS - 1 ? 'LAND' : `STEP ${i}`));
  H = MARGIN + 6 * FONT_SCALE + 8 + (PH + 10 + 7 * FONT_SCALE + 56) * 2 + MARGIN;
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = 255; }

  drawText(buf, MARGIN, MARGIN, 'LIV-139 PLAYER/NPC MOVEMENT TWEEN', [235, 240, 250, 255]);
  drawText(buf, MARGIN, MARGIN + 7 * FONT_SCALE,
    `PLAYER ${MOVEMENT_CATALOG.player.tilesPerSec} TILES/SEC - ${CONFIG.MOVE_TWEEN_INTERMEDIATE_FRAMES} INTERMEDIATE FRAMES - LOGICAL TILE AUTHORITATIVE`,
    [124, 227, 255, 255]);

  let y = MARGIN + 6 * FONT_SCALE + 24;
  y = drawRow(buf, MARGIN, y, 'magician', 'walk_side_0', 'PLAYER (MAGICIAN) - SPEED HALVED + TWEEN', captions);
  y += 20;
  drawRow(buf, MARGIN, y, 'giant_rat', 'walk_side_0', 'OPPONENT (GIANT RAT) - TWEEN ONLY, SPEED UNCHANGED', captions);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePNG(W, H, buf));
  console.log(`Wrote ${out} (${W}x${H}, ${PANELS} panels/row)`);
}

main();
