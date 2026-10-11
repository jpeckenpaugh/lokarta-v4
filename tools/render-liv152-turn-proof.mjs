#!/usr/bin/env node
/**
 * Lokarta LIV-152 turn-bug proof strip (Node-only, zero deps).
 *
 * Renders a deterministic review strip that cannot drift from the shipped
 * logic — it drives the exact `advanceTurn` the render tick calls and reads the
 * exact frame the renderer draws (`resolveSpriteFrame`):
 *
 *   Row 1  8-facing compass for the real archer def (DIR8 order + indices).
 *   Row 2  the `up -> down` (backward->forward) 180-degree turn, 5 buckets.
 *   Row 3  the `down -> up` (forward->backward) 180-degree turn, 5 buckets.
 *
 * Each turn panel is labelled with its DIR8 index and authored frame so the
 * board can read the arc (`4,5,6,7,0` / `0,1,2,3,4`) directly off the image.
 *
 * Review aid (docs/engineering/agents.md §8), not a T0 gate. Usage:
 *   node tools/render-liv152-turn-proof.mjs [outFile]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPRITE_CATALOG } from '../html/assets/sprites/index.js';
import { parseFrame, applyOutline, resolveSpriteFrame } from '../html/app/sprite-renderer.js';
import { createAnimState, advanceTurn, DIR8 } from '../html/app/animation-state.js';
import { CONFIG } from '../html/engine/config.js';
import { encodePNG } from './render-sprite-preview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 32;
const SCALE = 3;
const TILEPX = CELL * SCALE;
const GAP = 12;
const MARGIN = 24;
const FONT_SCALE = 3;

let W = 0;
let H = 0;

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
  '*': ['101', '010', '101', '010', '101'], '=': ['000', '111', '000', '111', '000'],
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

function blit(buf, pix, ox, oy, scale, flip) {
  for (let y = 0; y < pix.h; y++) for (let x = 0; x < pix.w; x++) {
    const sx = flip ? pix.w - 1 - x : x;
    const si = (y * pix.w + sx) * 4;
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
const TILE = [30, 33, 42, 255];
const EDGE = [90, 98, 120, 255];
const PIP_ON = [124, 227, 255, 255];
const PIP_OFF = [55, 60, 74, 255];
const SHADOW = [0, 0, 0, 90];

/** DIR8 index of a runtime direction. */
const idx = (dir) => DIR8.indexOf(dir);

/** One tile cell with the actor drawn in `dir` and a caption underneath. */
function drawPanel(buf, px, rowTop, spriteId, dir, caption) {
  fillRect(buf, px, rowTop, TILEPX, TILEPX, TILE);
  strokeRect(buf, px, rowTop, TILEPX, TILEPX, EDGE);

  const def = SPRITE_CATALOG[spriteId];
  const { frameId, flip } = resolveSpriteFrame(def, { state: 'idle', dir, frame: 0 });
  const pix = actorFrame(spriteId, frameId);
  const s = Math.max(1, Math.floor((TILEPX - 10) / Math.max(pix.w, pix.h)));
  const groundY = rowTop + TILEPX - 10;
  const cxc = px + TILEPX / 2;
  const ox = Math.round(cxc - (pix.w * s) / 2);
  const oy = groundY - pix.h * s;
  fillRect(buf, ox + 8, groundY - 4, pix.w * s - 16, 5, SHADOW);
  blit(buf, pix, ox, oy, s, flip);
  drawText(buf, px + 6, rowTop + TILEPX + 10, caption, [150, 160, 182, 255]);
}

/** Walk a facing change one 45-degree bucket at a time through `advanceTurn`. */
function turnDirs(spriteId, startFacing, targetFacing) {
  const actor = { facing: startFacing, anim: createAnimState(startFacing) };
  const dirs = [actor.anim.dir];
  actor.facing = targetFacing;
  for (let i = 0; i < 8 && actor.anim.dir !== targetFacing; i++) {
    advanceTurn(actor, CONFIG.TURN_STEP_MS, CONFIG.TURN_STEP_MS);
    dirs.push(actor.anim.dir);
  }
  return dirs;
}

function drawTurnRow(buf, x0, y0, spriteId, startFacing, targetFacing, label) {
  const dirs = turnDirs(spriteId, startFacing, targetFacing);
  drawText(buf, x0, y0, label, [220, 228, 245, 255]);
  const rowTop = y0 + 7 * FONT_SCALE + 10;
  for (let i = 0; i < dirs.length; i++) {
    const px = x0 + i * (TILEPX + GAP);
    drawPanel(buf, px, rowTop, spriteId, dirs[i], `${idx(dirs[i])}`);
    for (let j = 0; j < dirs.length; j++) fillRect(buf, px + 8 + j * 12, rowTop + 8, 7, 7, j <= i ? PIP_ON : PIP_OFF);
  }
  return rowTop + TILEPX + 10 + 7 * FONT_SCALE;
}

function drawCompassRow(buf, x0, y0, spriteId, label) {
  drawText(buf, x0, y0, label, [220, 228, 245, 255]);
  const rowTop = y0 + 7 * FONT_SCALE + 10;
  for (let i = 0; i < DIR8.length; i++) {
    const px = x0 + i * (TILEPX + GAP);
    drawPanel(buf, px, rowTop, spriteId, DIR8[i], `${i}`);
  }
  return rowTop + TILEPX + 10 + 7 * FONT_SCALE;
}

function main() {
  const out = process.argv[2] || path.join(ROOT, 'docs', 'art', 'liv152-turn-framestrip.png');

  const panels = DIR8.length;
  const rowSpan = TILEPX * panels + GAP * (panels - 1);
  W = MARGIN * 2 + rowSpan;
  const rowH = TILEPX + 10 + 7 * FONT_SCALE + 34;
  H = MARGIN + 9 * FONT_SCALE + 34 + rowH * 3 + MARGIN;
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = 255; }

  drawText(buf, MARGIN, MARGIN, 'LIV-152 180-DEGREE TURN - REAL ARCHER DEF', [235, 240, 250, 255]);
  drawText(buf, MARGIN, MARGIN + 7 * FONT_SCALE,
    `8-DIR COMPASS + EASED ARCS - ${CONFIG.TURN_STEP_MS}MS PER 45-DEG STEP - LABEL = DIR8 INDEX`,
    [124, 227, 255, 255]);

  let y = MARGIN + 9 * FONT_SCALE + 34;
  const compass = drawCompassRow(buf, MARGIN, y, 'archer', 'COMPASS 0..7 (0=DOWN/TOWARD CAMERA, 4=UP/AWAY)');
  y = compass + 30;
  const up = drawTurnRow(buf, MARGIN, y, 'archer', 'up', 'down', 'UP>DOWN EXPECT 4 5 6 7 0 (LEFT ARC, MIRRORED DIAGONAL)');
  y = up + 30;
  drawTurnRow(buf, MARGIN, y, 'archer', 'down', 'up', 'DOWN>UP EXPECT 0 1 2 3 4 (RIGHT ARC)');

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePNG(W, H, buf));
  console.log(`Wrote ${out} (${W}x${H})`);
}

main();
