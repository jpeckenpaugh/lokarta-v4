#!/usr/bin/env node
/**
 * Lokarta LIV-140 procedural defeat "squish" proof strip (Node-only, zero deps).
 *
 * Renders a deterministic frame strip of a 3D-baked opponent (river_rat, which
 * has no authored death frames) being defeated: START -> mid-squash -> flattened
 * -> gone. The squash applied here uses the exact `squishScaleFor` helper and the
 * same ground-point anchor (bottom-centre) the runtime `SpriteRenderer.drawActor`
 * uses, so the strip cannot drift from the shipped transform.
 *
 * Review aid (docs/engineering/agents.md §8), not a T0 gate. Usage:
 *   node tools/render-liv140-squish-proof.mjs [outFile]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPRITE_CATALOG } from '../html/assets/sprites/index.js';
import { parseFrame } from '../html/app/sprite-renderer.js';
import { squishScaleFor } from '../html/app/animation-state.js';
import { PROCEDURAL_SQUISH } from '../html/data/index.js';
import { encodePNG } from './render-sprite-preview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPRITE_ID = 'river_rat';
const FRAME_ID = 'idle_down';
const SCALE = 2;
const MARGIN = 24;
const GAP = 16;
const FONT_SCALE = 3;

const PANELS = [
  { label: 'START', progress: 0.0, fade: 1 },
  { label: 'SQUASH 35%', progress: 0.35, fade: 1 },
  { label: 'SQUASH 70%', progress: 0.7, fade: 1 },
  { label: 'FLATTENED', progress: 1.0, fade: 1 },
  { label: 'GONE', progress: 1.0, fade: 0 },
];

const BG = [12, 13, 18, 255];
const GROUND = [34, 40, 52, 255];
const EDGE = [90, 98, 120, 255];
const SHADOW = [0, 0, 0, 90];
const TITLE = [235, 240, 250, 255];
const SUB = [124, 227, 255, 255];
const CAP = [150, 160, 182, 255];

/* ---------------- 3x5 bitmap font ---------------- */
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
  '%': ['101', '001', '010', '100', '101'], '.': ['000', '000', '000', '000', '010'],
  '-': ['000', '000', '111', '000', '000'],
};

let W = 0;
let H = 0;

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

/** Draws a pixel frame squashed about its bottom-centre ground point. */
function blitSquished(buf, pix, boxX, boxY, scale, progress, fade) {
  const { scaleX, scaleY } = squishScaleFor(progress, PROCEDURAL_SQUISH);
  const nw = pix.w * scale;
  const nh = pix.h * scale;
  const pivotX = nw / 2;
  const pivotY = nh; // ground point
  const alphaMul = Math.max(0, Math.min(1, fade));
  if (alphaMul <= 0) return;
  for (let dy = 0; dy < nh; dy++) {
    for (let dx = 0; dx < nw; dx++) {
      const sx = pivotX + (dx + 0.5 - pivotX) / scaleX;
      const sy = pivotY + (dy + 0.5 - pivotY) / scaleY;
      if (sx < 0 || sy < 0 || sx >= nw || sy >= nh) continue;
      const sxi = Math.floor(sx / scale);
      const syi = Math.floor(sy / scale);
      const si = (syi * pix.w + sxi) * 4;
      const a = (pix.data[si + 3] / 255) * alphaMul;
      if (a <= 0) continue;
      const px = boxX + dx;
      const py = boxY + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const di = (py * W + px) * 4;
      buf[di] = Math.round(pix.data[si] * a + buf[di] * (1 - a));
      buf[di + 1] = Math.round(pix.data[si + 1] * a + buf[di + 1] * (1 - a));
      buf[di + 2] = Math.round(pix.data[si + 2] * a + buf[di + 2] * (1 - a));
      buf[di + 3] = 255;
    }
  }
}

function main() {
  // Defaults outside docs/art/preview: that directory is drift-checked against a
  // fresh `exportPreviews` run (sprite-assets.test.mjs), so a proof strip must
  // not be committed there.
  const out = process.argv[2] || path.join(ROOT, 'docs', 'art', 'liv140-defeat-squish-framestrip.png');
  const def = SPRITE_CATALOG[SPRITE_ID];
  if (!def) throw new Error(`missing sprite ${SPRITE_ID}`);
  const pix = parseFrame(def.frames[FRAME_ID], def.palette);

  const boxW = pix.w * SCALE;
  const boxH = pix.h * SCALE;
  const headerH = 6 * FONT_SCALE + 8;
  W = MARGIN * 2 + PANELS.length * boxW + GAP * (PANELS.length - 1);
  H = MARGIN + headerH + 7 * FONT_SCALE + 10 + boxH + 12 + 7 * FONT_SCALE + MARGIN;
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = 255; }

  drawText(buf, MARGIN, MARGIN, 'LIV-140 PROCEDURAL DEFEAT SQUISH', TITLE);
  drawText(buf, MARGIN, MARGIN + 7 * FONT_SCALE, `${SPRITE_ID.toUpperCase()} (NO AUTHORED DEATH) - RUNTIME FLATTEN, NO RE-BAKE`, SUB);

  const rowTop = MARGIN + headerH + 7 * FONT_SCALE + 10;
  PANELS.forEach((panel, i) => {
    const px = MARGIN + i * (boxW + GAP);
    fillRect(buf, px, rowTop, boxW, boxH, GROUND);
    for (let gx = 0; gx <= 1; gx++) {
      const gxl = px + gx * (boxW - 1);
      for (let y = rowTop; y < rowTop + boxH; y += 2) setPx(buf, gxl, y, EDGE);
    }
    for (let gy = 0; gy <= 1; gy++) {
      const gyl = rowTop + gy * (boxH - 1);
      for (let x = px; x < px + boxW; x += 2) setPx(buf, x, gyl, EDGE);
    }
    strokeRect(buf, px, rowTop, boxW, boxH, EDGE);

    // Ground shadow stays anchored to the tile ground while the body squashes.
    fillRect(buf, px + boxW / 4, rowTop + boxH - 5, boxW / 2, 5, SHADOW);
    blitSquished(buf, pix, px, rowTop, SCALE, panel.progress, panel.fade);

    drawText(buf, px + 4, rowTop + boxH + 12, panel.label, CAP);
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePNG(W, H, buf));
  console.log(`Wrote ${out} (${W}x${H}, ${PANELS.length} panels)`);
}

main();
