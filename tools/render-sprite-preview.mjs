#!/usr/bin/env node
/**
 * Lokarta sprite preview exporter (Node-only, zero dependencies).
 *
 * Reads the authored sprite definitions from `html/assets/sprites/**`, applies
 * the same outline pass + palette as the runtime renderer, and writes one PNG
 * per actor plus a combined contact sheet to `docs/art/preview/`.
 *
 * This is a review/export tool. The app never runs it: art data is the JSON
 * under `html/assets/sprites/`. A native test re-runs this exporter into a temp
 * directory and byte-compares against the committed PNGs so they cannot drift.
 *
 * Usage: node tools/render-sprite-preview.mjs [outDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SPRITES_DIR = path.join(ROOT, 'html', 'assets', 'sprites');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'art', 'preview');
const SCALE = 2;

/* ---------------- PNG encoder ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
export function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- pixel helpers (mirror sprite-renderer.js) ---------------- */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function parseFrame(rows, palette) {
  const h = rows.length;
  const w = h ? rows[0].length : 0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const hex = palette[rows[y][x]];
      if (!hex) continue;
      const [r, g, b] = hexToRgb(hex);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { w, h, data };
}
function applyOutline(pix, outlineHex) {
  const { w, h, data } = pix;
  const out = new Uint8ClampedArray(data);
  const [or, og, ob] = hexToRgb(outlineHex);
  const isOutline = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    const i = (y * w + x) * 4;
    return data[i + 3] > 0 && data[i] === or && data[i + 1] === og && data[i + 2] === ob;
  };
  const art = (x, y) => (x < 0 || x >= w || y < 0 || y >= h ? false : data[(y * w + x) * 4 + 3] > 0 && !isOutline(x, y));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] > 0) continue;
      if (art(x - 1, y) || art(x + 1, y) || art(x, y - 1) || art(x, y + 1)) {
        out[i] = or; out[i + 1] = og; out[i + 2] = ob; out[i + 3] = 255;
      }
    }
  }
  return { w, h, data: out };
}
function scalePixels(pix, scale) {
  const { w, h, data } = pix;
  const sw = w * scale, sh = h * scale;
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const di = ((y * scale + dy) * sw + (x * scale + dx)) * 4;
          out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
        }
      }
    }
  }
  return { w: sw, h: sh, data: out };
}
function frameTile(def, frameId, scale) {
  const pix = parseFrame(def.frames[frameId], def.palette);
  // LIV-115 (Fix 1): a baked def opt-out (`outline:false`) matches the runtime.
  const outlined = def.outline === false ? pix : applyOutline(pix, def.palette['0'] || '#0b0d12');
  return scalePixels(outlined, scale);
}
function compose(tiles, cols, pad = 4, bg = [10, 11, 14, 255]) {
  const cw = Math.max(...tiles.map(t => t.w)) + pad;
  const ch = Math.max(...tiles.map(t => t.h)) + pad;
  const rows = Math.ceil(tiles.length / cols);
  const W = cols * cw + pad, H = rows * ch + pad;
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = bg[3]; }
  tiles.forEach((t, idx) => {
    const ox = (idx % cols) * cw + pad, oy = Math.floor(idx / cols) * ch + pad;
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) {
        const si = (y * t.w + x) * 4, di = ((oy + y) * W + (ox + x)) * 4;
        const a = t.data[si + 3] / 255;
        out[di] = Math.round(t.data[si] * a + bg[0] * (1 - a));
        out[di + 1] = Math.round(t.data[si + 1] * a + bg[1] * (1 - a));
        out[di + 2] = Math.round(t.data[si + 2] * a + bg[2] * (1 - a));
        out[di + 3] = 255;
      }
    }
  });
  return { W, H, buf: out };
}

export function exportPreviews(outDir = DEFAULT_OUT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SPRITES_DIR, 'manifest.json'), 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const sheetTiles = [];
  for (const [id, meta] of Object.entries(manifest.actors)) {
    const def = JSON.parse(fs.readFileSync(path.join(SPRITES_DIR, meta.file), 'utf8'));
    const frameIds = Object.keys(def.frames);
    const tiles = frameIds.map(fid => frameTile(def, fid, SCALE));
    const cols = Math.min(9, frameIds.length);
    const sheet = compose(tiles, cols);
    const dest = path.join(outDir, `${id}.png`);
    fs.writeFileSync(dest, encodePNG(sheet.W, sheet.H, sheet.buf));
    written.push(dest);
    sheetTiles.push(frameTile(def, 'idle_down', SCALE));
  }
  const combined = compose(sheetTiles, 3);
  const combinedDest = path.join(outDir, 'sheet.png');
  fs.writeFileSync(combinedDest, encodePNG(combined.W, combined.H, combined.buf));
  written.push(combinedDest);

  // Prop/tile art (keys, chests, gated doors) — same pipeline, flat frame map.
  if (manifest.props) {
    const propTiles = [];
    for (const [id, meta] of Object.entries(manifest.props)) {
      const def = JSON.parse(fs.readFileSync(path.join(SPRITES_DIR, meta.file), 'utf8'));
      for (const fid of Object.keys(def.frames)) propTiles.push(frameTile(def, fid, SCALE));
    }
    if (propTiles.length) {
      const sheet = compose(propTiles, 6);
      const dest = path.join(outDir, 'props.png');
      fs.writeFileSync(dest, encodePNG(sheet.W, sheet.H, sheet.buf));
      written.push(dest);
    }
  }

  // Portrait sheet (LIV-81): one bust per NPC per expression, in catalog order.
  const portraitFile = path.join(ROOT, 'html', 'assets', 'portraits', 'portraits.json');
  if (fs.existsSync(portraitFile)) {
    const portraits = JSON.parse(fs.readFileSync(portraitFile, 'utf8'));
    const tiles = Object.values(portraits.portraits || {}).map(def => frameTile(def, 'bust', SCALE));
    if (tiles.length) {
      const sheet = compose(tiles, 6);
      const dest = path.join(outDir, 'portraits.png');
      fs.writeFileSync(dest, encodePNG(sheet.W, sheet.H, sheet.buf));
      written.push(dest);
    }
  }
  return written;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] || DEFAULT_OUT;
  const written = exportPreviews(out);
  console.log(`Wrote ${written.length} preview PNGs to ${path.relative(ROOT, out)}`);
  for (const w of written) console.log('  ' + path.relative(ROOT, w));
}
