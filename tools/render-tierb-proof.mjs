#!/usr/bin/env node
/**
 * Lokarta Tier A -> Tier B "before/after" proof renderer (LIV-109, Phase 1).
 *
 * Composes the board's two named assets side by side from their committed
 * char-grid sprite defs: the flat Tier A read ("before", NES) against the Tier B
 * "baked" read ("after", SNES-plus). It is a browser-free review aid authored
 * from the same pixel pipeline the runtime uses (`parseFrame` + `applyOutline`
 * + integer `scalePixels`); the app never runs it.
 *
 * Inputs are committed defs under `docs/art/3d-poc/`; outputs are committed
 * PNGs under `docs/art/3d-poc/phase1/`. A native test re-runs `exportProof`
 * into a temp dir and byte-compares so the proof cannot silently drift.
 *
 * Usage: node tools/render-tierb-proof.mjs [outDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const POC_DIR = path.join(ROOT, 'docs', 'art', '3d-poc');
export const DEFAULT_OUT = path.join(POC_DIR, 'phase1');

/** The board's Phase 1 before/after pairs, from art-direction-target.md §8. */
export const PROOF_PAIRS = [
  { id: 'archer', frame: 'view_0', scale: 8, before: 'rukiya_poc.sprite.json', after: 'rukiya_archer_baked.sprite.json' },
  { id: 'fishing_hut', frame: 'view_0', scale: 3, before: 'fisherman_hut_2x3_indexed.sprite.json', after: 'fisherman_hut_2x3.sprite.json' },
];

const BG = [10, 11, 14, 255];
const SEP = [42, 49, 64, 255];
const PAD = 6;

/* ---------------- PNG encoder ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crc]); }
export function encodePNG(w, h, rgba) {
  const stride = w * 4; const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- pixel helpers (mirror sprite-renderer.js) ---------------- */
function hexToRgb(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function parseFrame(rows, palette) {
  const h = rows.length, w = h ? rows[0].length : 0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const hex = palette[rows[y][x]];
    if (!hex) continue;
    const [r, g, b] = hexToRgb(hex); const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { w, h, data };
}
function applyOutline(pix, outlineHex) {
  const { w, h, data } = pix; const out = new Uint8ClampedArray(data);
  const [or, og, ob] = hexToRgb(outlineHex);
  const isOutline = (x, y) => { if (x < 0 || x >= w || y < 0 || y >= h) return false; const i = (y * w + x) * 4; return data[i + 3] > 0 && data[i] === or && data[i + 1] === og && data[i + 2] === ob; };
  const art = (x, y) => (x < 0 || x >= w || y < 0 || y >= h ? false : data[(y * w + x) * 4 + 3] > 0 && !isOutline(x, y));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i + 3] > 0) continue;
    if (art(x - 1, y) || art(x + 1, y) || art(x, y - 1) || art(x, y + 1)) { out[i] = or; out[i + 1] = og; out[i + 2] = ob; out[i + 3] = 255; }
  }
  return { w, h, data: out };
}
function scalePixels(pix, scale) {
  const { w, h, data } = pix; const sw = w * scale, sh = h * scale;
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * w + x) * 4;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const di = ((y * scale + dy) * sw + (x * scale + dx)) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return { w: sw, h: sh, data: out };
}
function frameTile(def, frameId, scale) {
  const pix = parseFrame(def.frames[frameId], def.palette);
  return scalePixels(applyOutline(pix, def.palette['0'] || '#0b0d12'), scale);
}
function readDef(file) { return JSON.parse(fs.readFileSync(path.join(POC_DIR, file), 'utf8')); }

/** Draws one upscaled tile over a background at (ox, oy). */
function blit(buf, W, tile, ox, oy, bg = BG) {
  for (let y = 0; y < tile.h; y++) for (let x = 0; x < tile.w; x++) {
    const si = (y * tile.w + x) * 4; const a = tile.data[si + 3] / 255;
    const di = ((oy + y) * W + (ox + x)) * 4;
    buf[di] = Math.round(tile.data[si] * a + bg[0] * (1 - a));
    buf[di + 1] = Math.round(tile.data[si + 1] * a + bg[1] * (1 - a));
    buf[di + 2] = Math.round(tile.data[si + 2] * a + bg[2] * (1 - a));
    buf[di + 3] = 255;
  }
}

/**
 * Renders the before/after comparison for one pair into `outDir`. Writes the
 * individual panels plus a combined sheet. Returns the list of file paths.
 */
export function renderProofPair(pair, outDir) {
  const before = readDef(pair.before), after = readDef(pair.after);
  const bTile = frameTile(before, pair.frame, pair.scale);
  const aTile = frameTile(after, pair.frame, pair.scale);
  const W = bTile.w + aTile.w + PAD * 3 + 1;
  const H = Math.max(bTile.h, aTile.h) + PAD * 2;
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = BG[3]; }
  blit(buf, W, bTile, PAD, PAD);
  blit(buf, W, aTile, PAD * 2 + bTile.w, PAD);
  // 1px separator between the "before" and "after" panels.
  const sepX = PAD * 2 + bTile.w - 1 + Math.floor(PAD / 2);
  for (let y = 0; y < H; y++) { const di = (y * W + sepX) * 4; buf[di] = SEP[0]; buf[di + 1] = SEP[1]; buf[di + 2] = SEP[2]; buf[di + 3] = SEP[3]; }
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const combined = path.join(outDir, `${pair.id}_before_after.png`);
  fs.writeFileSync(combined, encodePNG(W, H, buf)); written.push(combined);
  const beforePath = path.join(outDir, `${pair.id}_before.png`);
  fs.writeFileSync(beforePath, encodePNG(bTile.w, bTile.h, Buffer.from(bTile.data.buffer, bTile.data.byteOffset, bTile.data.length))); written.push(beforePath);
  const afterPath = path.join(outDir, `${pair.id}_after.png`);
  fs.writeFileSync(afterPath, encodePNG(aTile.w, aTile.h, Buffer.from(aTile.data.buffer, aTile.data.byteOffset, aTile.data.length))); written.push(afterPath);
  return written;
}

/** Renders every Phase 1 proof pair into `outDir`. Returns written paths. */
export function exportProof(outDir = DEFAULT_OUT) {
  const written = [];
  for (const pair of PROOF_PAIRS) written.push(...renderProofPair(pair, outDir));
  return written;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] || DEFAULT_OUT;
  const written = exportProof(out);
  console.log(`Wrote ${written.length} before/after proof PNGs to ${path.relative(ROOT, out)}`);
  for (const w of written) console.log('  ' + path.relative(ROOT, w));
}
