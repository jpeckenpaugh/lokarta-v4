#!/usr/bin/env node
/**
 * Lokarta GLB/glTF -> 2D sprite authoring pipeline (LIV-104, prototype).
 *
 * Turns a 3D model into the repo's indexed-sprite JSON format by rendering it
 * down instead of hand-pixeling it: orthographic software raster -> box
 * downscale to the 32px actor canvas -> median-cut to a <=16-colour indexed
 * palette -> 1px `#0b0d12` silhouette outline -> sprite JSON + preview PNG.
 *
 * This is a DEV-ONLY authoring tool. The app never runs it, exactly like
 * `tools/render-sprite-preview.mjs` and `tools/author-npc-assets.mjs`. It is
 * zero-native-dependency: the rasteriser, PNG encoder, downscaler, quantiser
 * and outline pass are all in this file.
 *
 * Textured output needs a JPEG decoder because glTF base-colour maps ship as
 * embedded JPEG. Install the optional dev dependency once:
 *     npm i --no-save jpeg-js
 * Without it the tool still runs and falls back to flat Lambert shading of the
 * geometry (silhouette + form), which is enough to validate the pipeline.
 *
 * Usage:
 *     node tools/gltf-to-sprite.mjs <input.glb> [--id rukiya] [--out docs/art/3d-poc]
 *         [--size 32] [--views 0,90,180,270] [--colors 14] [--rise 10] [--flat]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUTLINE = '#0b0d12';
// Native tile grid: 32px == ONE tile. Actors/props are authored at 1 tile
// (32x32); buildings/landmarks are authored at NxM tiles (e.g. 128x64 = 4x2).
// The display grid is CONFIG.GRID_SIZE=64 == 32 * SCALE(2). The ratio between
// native and display must stay an integer (SCALE), so multi-tile bitmaps are
// upscaled by the same integer SCALE as single-tile sprites (LIV-106).
const NATIVE_TILE = 32;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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

/* ---------------- GLB parse ---------------- */
export function parseGLB(file) {
  const buf = fs.readFileSync(file);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const clen = buf.readUInt32LE(off), ct = buf.readUInt32LE(off + 4);
    const d = buf.subarray(off + 8, off + 8 + clen);
    if (ct === 0x4E4F534A) json = JSON.parse(d.toString('utf8'));
    if (ct === 0x004E4942) bin = d;
    off += 8 + clen;
  }
  if (!json) throw new Error(`not a GLB (no JSON chunk): ${file}`);
  return { json, bin };
}
const CT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const CT_READ = { 5121: (b, o) => b.readUInt8(o), 5123: (b, o) => b.readUInt16LE(o), 5125: (b, o) => b.readUInt32LE(o), 5126: (b, o) => b.readFloatLE(o) };
const NUM_COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function readAccessor(glb, idx) {
  const a = glb.json.accessors[idx]; const bv = glb.json.bufferViews[a.bufferView];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0); const n = NUM_COMP[a.type];
  const stride = bv.byteStride || n * CT_SIZE[a.componentType]; const read = CT_READ[a.componentType];
  const out = new Float32Array(a.count * n);
  for (let i = 0; i < a.count; i++) { const o = base + i * stride; for (let k = 0; k < n; k++) out[i * n + k] = read(glb.bin, o + k * CT_SIZE[a.componentType]); }
  return { data: out, n, count: a.count };
}
async function loadBaseColor(glb, materialIndex) {
  if (materialIndex == null) return null;
  const mat = glb.json.materials[materialIndex];
  const tex = mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorTexture;
  if (!tex) return null;
  const im = glb.json.images[glb.json.textures[tex.index].source];
  const bv = glb.json.bufferViews[im.bufferView];
  const bytes = glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  try {
    const mod = await import('jpeg-js');
    const raw = (mod.default || mod).decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { w: raw.width, h: raw.height, data: raw.data };
  } catch { return null; }
}
function sampleBilinear(tex, u, v) {
  let x = u * (tex.w - 1), y = v * (tex.h - 1);
  x = Math.max(0, Math.min(tex.w - 1, x)); y = Math.max(0, Math.min(tex.h - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(tex.w - 1, x0 + 1), y1 = Math.min(tex.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0; const d = tex.data; const off = (xx, yy) => (yy * tex.w + xx) * 4;
  const o00 = off(x0, y0), o10 = off(x1, y0), o01 = off(x0, y1), o11 = off(x1, y1);
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  return [d[o00] * w00 + d[o10] * w10 + d[o01] * w01 + d[o11] * w11,
    d[o00 + 1] * w00 + d[o10 + 1] * w10 + d[o01 + 1] * w01 + d[o11 + 1] * w11,
    d[o00 + 2] * w00 + d[o10 + 2] * w10 + d[o01 + 2] * w01 + d[o11 + 2] * w11];
}

/* ---------------- orthographic software rasteriser ---------------- */
export function render(glb, tex, { azimuth = 0, rise = 10, targetH = 512, ambient = 0.30, light = [-0.45, 0.72, 0.53], rim = 0, bounce = 0 } = {}) {
  const j = glb.json; const prim = j.meshes[0].primitives[0];
  const pos = readAccessor(glb, prim.attributes.POSITION);
  const nrm = prim.attributes.NORMAL != null ? readAccessor(glb, prim.attributes.NORMAL) : null;
  const uv = prim.attributes.TEXCOORD_0 != null ? readAccessor(glb, prim.attributes.TEXCOORD_0) : null;
  const idx = prim.indices != null ? readAccessor(glb, prim.indices) : null;
  let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
  for (let i = 0; i < pos.count; i++) { const x = pos.data[i * 3], y = pos.data[i * 3 + 1], z = pos.data[i * 3 + 2]; if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z; if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z; }
  const ccx = (mnx + mxx) / 2, ccy = (mny + mxy) / 2, ccz = (mnz + mxz) / 2;
  const modelH = (mxy - mny) || 1; const scale = (targetH * 0.92) / modelH; const Hpx = targetH;
  const halfXZ = Math.max(mxx - mnx, mxz - mnz) / 2;
  const Wpx = Math.max(Hpx, Math.ceil(2 * halfXZ * scale) + 8);
  const rgba = new Float32Array(Wpx * Hpx * 4); const depth = new Float32Array(Wpx * Hpx).fill(-1e9);
  const _rise = rise * Math.PI / 180;
  const ca = Math.cos(azimuth), sa = Math.sin(azimuth), cr = Math.cos(_rise), sr = Math.sin(_rise);
  const xf = (x, y, z, out) => { x -= ccx; y -= ccy; z -= ccz; const vx = ca * x + sa * z; const vz = -sa * x + ca * z; out[0] = vx; out[1] = cr * y - sr * vz; out[2] = sr * y + cr * vz; };
  const ll = Math.hypot(light[0], light[1], light[2]); const Lx = light[0] / ll, Ly = light[1] / ll, Lz = light[2] / ll;
  const tn = idx ? idx.count : pos.count; const getI = k => (idx ? idx.data[k] : k);
  const sx = new Float32Array(pos.count), sy = new Float32Array(pos.count), sz = new Float32Array(pos.count);
  const tmp = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) { xf(pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2], tmp); sx[i] = Wpx / 2 + tmp[0] * scale; sy[i] = Hpx / 2 - tmp[1] * scale; sz[i] = tmp[2]; }
  const N0 = [0, 0, 0];
  function tri(p0, p1, p2) {
    const ax = sx[p0], ay = sy[p0], az = sz[p0], bx = sx[p1], by = sy[p1], bz = sz[p1], dx = sx[p2], dy = sy[p2], dz = sz[p2];
    const minx = Math.max(0, Math.floor(Math.min(ax, bx, dx))), maxx = Math.min(Wpx - 1, Math.ceil(Math.max(ax, bx, dx)));
    const miny = Math.max(0, Math.floor(Math.min(ay, by, dy))), maxy = Math.min(Hpx - 1, Math.ceil(Math.max(ay, by, dy)));
    if (minx > maxx || miny > maxy) return;
    const area = (bx - ax) * (dy - ay) - (dx - ax) * (by - ay); if (Math.abs(area) < 1e-9) return; const inv = 1 / area;
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((bx - px) * (dy - py) - (dx - px) * (by - py)) * inv;
      const w1 = ((dx - px) * (ay - py) - (ax - px) * (dy - py)) * inv;
      const w2 = 1 - w0 - w1; if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * az + w1 * bz + w2 * dz; const di = y * Wpx + x; if (z <= depth[di]) continue;
      let Nx, Ny, Nz;
      if (nrm) { xf(w0 * nrm.data[p0 * 3] + w1 * nrm.data[p1 * 3] + w2 * nrm.data[p2 * 3], w0 * nrm.data[p0 * 3 + 1] + w1 * nrm.data[p1 * 3 + 1] + w2 * nrm.data[p2 * 3 + 1], w0 * nrm.data[p0 * 3 + 2] + w1 * nrm.data[p1 * 3 + 2] + w2 * nrm.data[p2 * 3 + 2], N0); Nx = N0[0]; Ny = N0[1]; Nz = N0[2]; }
      else { Nx = 0; Ny = 0; Nz = 1; }
      const nl = Math.hypot(Nx, Ny, Nz) || 1; Nx /= nl; Ny /= nl; Nz /= nl;
      const diff = Math.max(0, Nx * Lx + Ny * Ly + Nz * Lz);
      let shade = ambient + 0.85 * Math.pow(diff, 0.9);
      // Tier B (LIV-109): baked 135-degree key already comes from `light`
      // (upper-left). Add an inner rim-light band on grazing, key-facing
      // normals so the silhouette's lit edge gets the brightest ramp step.
      if (rim > 0) {
        const grazing = 1 - Math.min(1, Math.abs(Nz));
        const keyEdge = Math.max(0, Nx * Lx + Ny * Ly);
        shade += rim * grazing * grazing * (0.30 + keyEdge);
      }
      let cre = 200, cgr = 190, cbl = 180;
      if (tex && uv) { const uu = w0 * uv.data[p0 * 2] + w1 * uv.data[p1 * 2] + w2 * uv.data[p2 * 2]; const vv = w0 * uv.data[p0 * 2 + 1] + w1 * uv.data[p1 * 2 + 1] + w2 * uv.data[p2 * 2 + 1]; const col = sampleBilinear(tex, uu, vv); cre = col[0]; cgr = col[1]; cbl = col[2]; }
      // Cool bounce shade in the lower-right (shadow) so baked assets share one
      // consistent light model: warm key upper-left, cool ambient fill.
      if (bounce > 0) { const k = (1 - diff) * bounce; cre = cre * (1 - k) + 38 * k; cgr = cgr * (1 - k) + 54 * k; cbl = cbl * (1 - k) + 96 * k; }
      const di4 = di * 4; rgba[di4] = Math.min(255, cre * shade); rgba[di4 + 1] = Math.min(255, cgr * shade); rgba[di4 + 2] = Math.min(255, cbl * shade); rgba[di4 + 3] = 255; depth[di] = z;
    }
  }
  for (let k = 0; k < tn; k += 3) tri(getI(k), getI(k + 1), getI(k + 2));
  return { w: Wpx, h: Hpx, rgba };
}

/* ---------------- post passes ---------------- */
export function downscale(r, ow, oh) {
  const out = new Float32Array(ow * oh * 4); const xr = r.w / ow, yr = r.h / oh;
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
    const x0 = Math.floor(ox * xr), x1 = Math.max(x0 + 1, Math.ceil((ox + 1) * xr));
    const y0 = Math.floor(oy * yr), y1 = Math.max(y0 + 1, Math.ceil((oy + 1) * yr));
    let sr = 0, sg = 0, sb = 0, cov = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * r.w + x) * 4; n++; if (r.rgba[i + 3] > 0) { sr += r.rgba[i]; sg += r.rgba[i + 1]; sb += r.rgba[i + 2]; cov++; } }
    const o = (oy * ow + ox) * 4;
    if (cov > 0) { out[o] = sr / cov; out[o + 1] = sg / cov; out[o + 2] = sb / cov; out[o + 3] = Math.round(255 * cov / n); }
  }
  return { w: ow, h: oh, rgba: out };
}
export function medianCut(pixels, k) {
  let buckets = [pixels];
  while (buckets.length < k) {
    let bi = -1, best = -1;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]; if (b.length < 2) continue;
      const mn = [255, 255, 255], mx = [0, 0, 0];
      for (const p of b) for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
      const score = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * b.length;
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0) break;
    const b = buckets[bi]; const mn = [255, 255, 255], mx = [0, 0, 0];
    for (const p of b) for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
    let ch = 0, rr = mx[0] - mn[0]; if (mx[1] - mn[1] > rr) { ch = 1; rr = mx[1] - mn[1]; } if (mx[2] - mn[2] > rr) ch = 2;
    b.sort((p, q) => p[ch] - q[ch]); const mid = b.length >> 1;
    buckets.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return buckets.filter(b => b.length).map(b => { const s = [0, 0, 0]; for (const p of b) for (let c = 0; c < 3; c++) s[c] += p[c]; return s.map(v => Math.round(v / b.length)); });
}
export function quantize(sprite, palette) {
  const { w, h, rgba } = sprite; const idx = [];
  for (let y = 0; y < h; y++) { let row = ''; for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (rgba[i + 3] < 128) { row += '.'; continue; }
    let bi = 0, bd = 1e9;
    for (let p = 0; p < palette.length; p++) { const d = (rgba[i] - palette[p][0]) ** 2 + (rgba[i + 1] - palette[p][1]) ** 2 + (rgba[i + 2] - palette[p][2]) ** 2; if (d < bd) { bd = d; bi = p; } }
    row += bi.toString(16);
  } idx.push(row); }
  return idx;
}
export function outlinePass(idx, w, h) {
  const rows = idx.map(r => [...r]);
  const op = (xx, yy) => xx >= 0 && xx < w && yy >= 0 && yy < h && rows[yy][xx] !== '.' && rows[yy][xx] !== '0';
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rows[y][x] !== '.') continue;
    if (op(x - 1, y) || op(x + 1, y) || op(x, y - 1) || op(x, y + 1)) rows[y][x] = '0';
  }
  return rows.map(r => r.join(''));
}

/* ---------------- Tier B "baked" shading (LIV-109) ---------------- */
// 2x2 Bayer matrix normalised to /4. Ordered-dither thresholds between two
// ADJACENT ramp steps; this is the on-grid dither the art-direction doc allows.
const BAYER2X2 = [0, 2, 3, 1];

/** Rec.601 luma — the ramp axis a reviewer perceives. */
export function luma(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

/**
 * Builds a Tier B "baked" palette: `families` chromaticity clusters (materials),
 * each carrying `steps` ordered luminance entries (shadow -> base -> light ->
 * rim). This guarantees the §5.3 ">=4-step ramp per material" contract instead
 * of letting a naive median-cut scatter colors arbitrarily.
 *
 * Returns `{ families, steps, colors, assign(r,g,b) }` where `colors` is the
 * ramp-ordered RGB list indexed `family*steps + step`, and `assign` returns the
 * family index plus a continuous `pos` in [0,1] along that family's luma range
 * (the dither pass turns `pos` into a step).
 */
export function rampPalette(pixels, { families = 6, steps = 4 } = {}) {
  if (!pixels.length || families < 1 || steps < 2) throw new Error('rampPalette: need pixels and families>=1, steps>=2');
  const pts = pixels.map(([r, g, b]) => { const s = r + g + b || 1; return [r / s, g / s]; });
  // Seed centroids across the chroma spread so initial assignment is not degenerate.
  const order = pts.map((_, i) => i).sort((i, j) => (pts[i][0] - pts[i][1]) - (pts[j][0] - pts[j][1]));
  const cents = [];
  for (let f = 0; f < families; f++) { const p = pts[order[Math.min(order.length - 1, Math.floor((f + 0.5) / families * order.length))]]; cents.push([p[0], p[1]]); }
  const assignC = new Int32Array(pts.length).fill(-1);
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    for (let i = 0; i < pts.length; i++) {
      let bi = 0, bd = 1e9;
      for (let f = 0; f < families; f++) { const dx = pts[i][0] - cents[f][0], dy = pts[i][1] - cents[f][1], d = dx * dx + dy * dy; if (d < bd) { bd = d; bi = f; } }
      if (assignC[i] !== bi) { assignC[i] = bi; changed = true; }
    }
    if (!changed) break;
    const sum = Array.from({ length: families }, () => [0, 0, 0]);
    for (let i = 0; i < pts.length; i++) { const f = assignC[i]; sum[f][0] += pts[i][0]; sum[f][1] += pts[i][1]; sum[f][2]++; }
    for (let f = 0; f < families; f++) if (sum[f][2] > 0) cents[f] = [sum[f][0] / sum[f][2], sum[f][1] / sum[f][2]];
  }
  const fam = Array.from({ length: families }, () => ({ lums: [], acc: Array.from({ length: steps }, () => [0, 0, 0, 0]), lmin: 0, lmax: 1 }));
  for (let i = 0; i < pixels.length; i++) fam[assignC[i]].lums.push(luma(...pixels[i]));
  for (const f of fam) {
    if (f.lums.length) { const s = f.lums.slice().sort((a, b) => a - b); f.lmin = s[Math.floor(s.length * 0.03)]; f.lmax = s[Math.floor(s.length * 0.97)]; if (f.lmax - f.lmin < 1) { f.lmin -= 2; f.lmax += 2; } }
    else { f.lmin = 0; f.lmax = 255; }
  }
  for (let i = 0; i < pixels.length; i++) {
    const f = assignC[i]; const L = luma(...pixels[i]);
    let pos = (L - fam[f].lmin) / (fam[f].lmax - fam[f].lmin); pos = Math.max(0, Math.min(1, pos));
    const st = Math.min(steps - 1, Math.round(pos * (steps - 1)));
    const a = fam[f].acc[st]; a[0] += pixels[i][0]; a[1] += pixels[i][1]; a[2] += pixels[i][2]; a[3]++;
  }
  const colors = [];
  // Ramp factors used to synthesise a step that no pixel landed on (sparse
  // texture): keeps every family a full shadow->rim ramp instead of a grey gap.
  const factors = steps === 4 ? [0.55, 0.8, 1.05, 1.35] : Array.from({ length: steps }, (_, i) => 0.55 + 0.8 * (i / (steps - 1)));
  for (const f of fam) {
    let mr = 0, mg = 0, mb = 0, mn = 0;
    for (let st = 0; st < steps; st++) { const a = f.acc[st]; if (a[3] > 0) { mr += a[0]; mg += a[1]; mb += a[2]; mn += a[3]; } }
    const mean = mn > 0 ? [mr / mn, mg / mn, mb / mn] : [128, 128, 128];
    for (let st = 0; st < steps; st++) {
      const a = f.acc[st];
      if (a[3] > 0) colors.push([a[0] / a[3], a[1] / a[3], a[2] / a[3]]);
      else colors.push([mean[0] * factors[st], mean[1] * factors[st], mean[2] * factors[st]]);
    }
  }
  for (let i = 0; i < colors.length; i++) colors[i] = colors[i].map((v) => Math.max(0, Math.min(255, Math.round(v))));
  // Enforce shadow->rim ordering: sort each family's slice by luma ascending.
  for (let f = 0; f < families; f++) {
    const slice = colors.slice(f * steps, (f + 1) * steps);
    const ord = slice.map((c, i) => [luma(...c), i]).sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < steps; i++) colors[f * steps + i] = slice[ord[i][1]];
  }
  const assign = (r, g, b) => {
    const s = r + g + b || 1; const x = r / s, y = g / s;
    let bf = 0, bd = 1e9;
    for (let f = 0; f < families; f++) { const dx = x - cents[f][0], dy = y - cents[f][1], d = dx * dx + dy * dy; if (d < bd) { bd = d; bf = f; } }
    const L = luma(r, g, b);
    let pos = (L - fam[bf].lmin) / (fam[bf].lmax - fam[bf].lmin);
    pos = Math.max(0, Math.min(1, pos));
    return { family: bf, pos };
  };
  return { families, steps, colors, assign };
}

/**
 * Quantises a shaded sprite to a ramp palette with 2x2 ordered dithering. Each
 * opaque pixel maps to a family and a continuous ramp position; the fractional
 * part splits between two adjacent steps using the Bayer matrix, so gradients
 * read as dithered SNES-plus bands instead of hard edges. Palette chars start at
 * '1'; '0' stays the shared outline and '.' the transparent slot.
 */
export function quantizeRamp(sprite, ramp) {
  const { w, h, rgba } = sprite; const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] < 128) { row += '.'; continue; }
      const { family, pos } = ramp.assign(rgba[i], rgba[i + 1], rgba[i + 2]);
      const scaled = pos * (ramp.steps - 1);
      let step = Math.floor(scaled); const frac = scaled - step;
      if (frac > BAYER2X2[(y & 1) * 2 + (x & 1)] / 4) step++;
      if (step >= ramp.steps) step = ramp.steps - 1; if (step < 0) step = 0;
      row += (family * ramp.steps + step + 1).toString(36);
    }
    rows.push(row);
  }
  return rows;
}

/* ---------------- multi-tile chopping (LIV-106) ---------------- */
/**
 * Trims fully-transparent border rows/cols from a render so the model's
 * projected bounding box fills the downscale target. The rasteriser always
 * emits a padded canvas (min targetH square); cropping first means the
 * multi-tile downscale spends all its resolution on the model rather than on
 * dead margin. Returns a new `{ w, h, rgba }`.
 */
export function cropToContent(sprite) {
  const { w, h, rgba } = sprite;
  let minx = w, miny = h, maxx = -1, maxy = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] > 0) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  }
  if (maxx < 0) return sprite;
  const cw = maxx - minx + 1, ch = maxy - miny + 1;
  const out = new Float32Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(rgba.subarray(((miny + y) * w + minx) * 4, ((miny + y) * w + minx + cw) * 4), y * cw * 4);
  return { w: cw, h: ch, rgba: out };
}

/**
 * Native pixel size of a TilesxTiles boolean pair: `cols` tiles wide, `rows`
 * tiles tall. `{ tiles: { w: 4, h: 2 } }` -> `{ w: 128, h: 64 }`. This is the
 * ONLY place a tile count becomes pixels; callers never hardcode 128/64.
 */
export function tileCanvasSize(tiles) {
  if (!tiles || !Number.isInteger(tiles.w) || !Number.isInteger(tiles.h) || tiles.w < 1 || tiles.h < 1) {
    throw new Error(`tiles must be positive integers, got ${JSON.stringify(tiles)}`);
  }
  return { w: tiles.w * NATIVE_TILE, h: tiles.h * NATIVE_TILE };
}

/**
 * "Chops" (aligns) a raw high-res orthographic render to the nearest whole-tile
 * native canvas. The render keeps its aspect ratio, is box-downscaled to the
 * largest fit inside a `cols*32 x rows*32` canvas, then padded bottom-centre so
 * the building's ground contact sits on the footprint's bottom edge and the
 * silhouette is centred horizontally. Padding is transparent so the outline
 * pass can trace the real silhouette. This is alignment, not physical slicing:
 * the result stays ONE multi-tile bitmap for the engine's footprint path.
 *
 * Returns `{ w, h, rgba, fit, offset, tiles }` where `fit` is the fitted render
 * box and `offset` its top-left placement inside the tile canvas.
 */
export function chopToTileCanvas(sprite, tiles, { align = 'bottom', anchor = 'center' } = {}) {
  const { w: cw, h: ch } = tileCanvasSize(tiles);
  const fitScale = Math.min(cw / sprite.w, ch / sprite.h);
  const fw = Math.max(1, Math.min(cw, Math.round(sprite.w * fitScale)));
  const fh = Math.max(1, Math.min(ch, Math.round(sprite.h * fitScale)));
  const fitted = fw === sprite.w && fh === sprite.h ? sprite : downscale(sprite, fw, fh);
  const out = new Float32Array(cw * ch * 4);
  const ox = anchor === 'center' ? Math.round((cw - fw) / 2) : anchor === 'right' ? cw - fw : 0;
  const oy = align === 'bottom' ? ch - fh : align === 'center' ? Math.round((ch - fh) / 2) : 0;
  for (let y = 0; y < fh; y++) {
    const src = y * fw * 4;
    const dst = ((oy + y) * cw + ox) * 4;
    out.set(fitted.rgba.subarray(src, src + fw * 4), dst);
  }
  return { w: cw, h: ch, rgba: out, fit: { w: fw, h: fh }, offset: { x: ox, y: oy }, tiles: { w: tiles.w, h: tiles.h } };
}

/**
 * Decomposes a chopped multi-tile sprite into its `rows*cols` 32x32 tile
 * slices, row-major (top-left first). Used for the "chop" proof sheet: each
 * slice is an exact NATIVE_TILE x NATIVE_TILE crop of the whole bitmap, so the
 * sheet visually proves the large raster aligns to the 32px tile grid. The
 * engine itself keeps the single bitmap; this is authoring/verification only.
 * Returns `[{ tx, ty, rgba }]`.
 */
export function tileSlices(sprite, tiles) {
  const { w: cw } = tileCanvasSize(tiles);
  const slices = [];
  for (let ty = 0; ty < tiles.h; ty++) for (let tx = 0; tx < tiles.w; tx++) {
    const rgba = new Float32Array(NATIVE_TILE * NATIVE_TILE * 4);
    for (let y = 0; y < NATIVE_TILE; y++) {
      const src = ((ty * NATIVE_TILE + y) * cw + tx * NATIVE_TILE) * 4;
      rgba.set(sprite.rgba.subarray(src, src + NATIVE_TILE * 4), y * NATIVE_TILE * 4);
    }
    slices.push({ tx, ty, rgba });
  }
  return slices;
}

/**
 * Inclusive footprint rect for a building that occupies `tiles.w x tiles.h`
 * grid cells at top-left `[x0, y0]`, matching the engine's
 * `footprint:[x0,y0,x1,y1]` contract (both corners inclusive). A 4x2 building
 * at (3,5) -> `[3,5,6,6]`.
 */
export function footprintFor(x0, y0, tiles) {
  return [x0, y0, x0 + tiles.w - 1, y0 + tiles.h - 1];
}

/* ---------------- pipeline driver ---------------- */
const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

function sheet(rgbaTiles, size, scale, bg = [10, 11, 14, 255], pad = 4, cols = null) {
  cols = cols || rgbaTiles.length;
  const tile = size * scale; const rowsN = Math.ceil(rgbaTiles.length / cols);
  const W = cols * (tile + pad) + pad, H = rowsN * (tile + pad) + pad; const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = bg[3]; }
  rgbaTiles.forEach((rgba, vi) => {
    const ox = (vi % cols) * (tile + pad) + pad, oy = Math.floor(vi / cols) * (tile + pad) + pad;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4, a = rgba[si + 3] / 255;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const di = ((oy + y * scale + dy) * W + (ox + x * scale + dx)) * 4;
        buf[di] = Math.round(rgba[si] * a + bg[0] * (1 - a)); buf[di + 1] = Math.round(rgba[si + 1] * a + bg[1] * (1 - a)); buf[di + 2] = Math.round(rgba[si + 2] * a + bg[2] * (1 - a)); buf[di + 3] = 255;
      }
    }
  });
  return { w: W, h: H, buf };
}

/**
 * Upscales one chopped multi-tile bitmap `scale`x with a visible native-tile
 * grid overlay (1px cyan lines every NATIVE_TILE px) so a reviewer can see the
 * raster align to 32px tiles. Neutral background under transparent pixels.
 */
function gridSheet(sprite, scale, bg = [10, 11, 14, 255]) {
  const W = sprite.w * scale, H = sprite.h * scale; const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = bg[3]; }
  for (let y = 0; y < sprite.h; y++) for (let x = 0; x < sprite.w; x++) {
    const si = (y * sprite.w + x) * 4, a = sprite.rgba[si + 3] / 255;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const di = ((y * scale + dy) * W + (x * scale + dx)) * 4;
      buf[di] = Math.round(sprite.rgba[si] * a + bg[0] * (1 - a));
      buf[di + 1] = Math.round(sprite.rgba[si + 1] * a + bg[1] * (1 - a));
      buf[di + 2] = Math.round(sprite.rgba[si + 2] * a + bg[2] * (1 - a));
      buf[di + 3] = 255;
    }
  }
  // Native tile-boundary lines (every NATIVE_TILE native px == one tile edge).
  for (let tx = 1; tx < sprite.w / NATIVE_TILE; tx++) for (let y = 0; y < H; y++) { const di = (y * W + tx * NATIVE_TILE * scale) * 4; buf[di] = 40; buf[di + 1] = 200; buf[di + 2] = 220; buf[di + 3] = 255; }
  for (let ty = 1; ty < sprite.h / NATIVE_TILE; ty++) for (let x = 0; x < W; x++) { const di = ((ty * NATIVE_TILE * scale) * W + x) * 4; buf[di] = 40; buf[di + 1] = 200; buf[di + 2] = 220; buf[di + 3] = 255; }
  return { w: W, h: H, buf };
}

/**
 * "Chop" proof: lays the `rows*cols` 32x32 tile slices in a row with gaps,
 * each upscaled `scale`x, so the decomposition into whole tiles is visible.
 */
function chopSheet(slices, scale, bg = [10, 11, 14, 255], pad = 6) {
  const tile = NATIVE_TILE * scale; const n = slices.length;
  const W = n * (tile + pad) + pad, H = tile + pad * 2; const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = bg[3]; }
  slices.forEach((s, i) => {
    const ox = i * (tile + pad) + pad, oy = pad;
    for (let y = 0; y < NATIVE_TILE; y++) for (let x = 0; x < NATIVE_TILE; x++) {
      const si = (y * NATIVE_TILE + x) * 4, a = s.rgba[si + 3] / 255;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const di = ((oy + y * scale + dy) * W + (ox + x * scale + dx)) * 4;
        buf[di] = Math.round(s.rgba[si] * a + bg[0] * (1 - a));
        buf[di + 1] = Math.round(s.rgba[si + 1] * a + bg[1] * (1 - a));
        buf[di + 2] = Math.round(s.rgba[si + 2] * a + bg[2] * (1 - a));
        buf[di + 3] = 255;
      }
    }
  });
  return { w: W, h: H, buf };
}

export async function buildAsset({ glbPath, id, outDir, size = 32, views = [0, 90, 180, 270], colors = 14, rise = 10, flat = false, renderRes = 512, tiles = null, kind = null, tier = 'indexed', families = 6, steps = 4 }) {
  const baked = tier === 'baked';
  const glb = parseGLB(glbPath);
  const tex = flat ? null : await loadBaseColor(glb, glb.json.meshes[0].primitives[0].material);
  const multiTile = !!tiles;
  const viewPix = [];
  for (const az of views) {
    // Tier B bakes the 135-degree key (upper-left `light`) plus a rim term and a
    // cool bounce; Tier A stays flat Lambert (LIV-109 / art-direction-target §5).
    const hi = render(glb, tex, { azimuth: az * Math.PI / 180, rise, targetH: renderRes, rim: baked ? 0.7 : 0, bounce: baked ? 0.35 : 0 });
    // Single-tile classes box-downscale the whole render into ONE 32x32 tile.
    // Multi-tile buildings CHOP the render into a whole-tile canvas instead of
    // squishing it into a single tile (LIV-106).
    viewPix.push({ az, px: multiTile ? chopToTileCanvas(cropToContent(hi), tiles) : downscale(hi, size, size) });
  }
  const all = [];
  for (const v of viewPix) for (let i = 0; i < v.px.w * v.px.h; i++) if (v.px.rgba[i * 4 + 3] > 128) all.push([v.px.rgba[i * 4], v.px.rgba[i * 4 + 1], v.px.rgba[i * 4 + 2]]);
  const palette = { '0': OUTLINE, '.': null };
  let palRGB, ramp = null, quantizeFn;
  if (baked) {
    // Keep the whole palette inside the Tier B ceiling (<=32 incl. '.'/'0').
    const fam = Math.max(1, Math.min(families, Math.floor(30 / steps)));
    ramp = rampPalette(all, { families: fam, steps });
    palRGB = ramp.colors;
    palRGB.forEach((c, i) => { palette[(i + 1).toString(36)] = hex(...c); });
    quantizeFn = (px) => quantizeRamp(px, ramp);
  } else {
    palRGB = medianCut(all, colors);
    palRGB.forEach((c, i) => { palette[i.toString(16)] = hex(...c); });
    quantizeFn = (px) => quantize(px, palRGB);
  }
  const frames = {};
  const frameRgba = [];
  for (const v of viewPix) {
    const vw = v.px.w, vh = v.px.h;
    const idx = outlinePass(quantizeFn(v.px), vw, vh);
    frames[`view_${v.az}`] = idx;
    const rgba = new Uint8ClampedArray(vw * vh * 4);
    for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) {
      const p = palette[idx[y][x]]; if (!p) continue; const hx = p.slice(1); const i = (y * vw + x) * 4;
      rgba[i] = parseInt(hx.slice(0, 2), 16); rgba[i + 1] = parseInt(hx.slice(2, 4), 16); rgba[i + 2] = parseInt(hx.slice(4, 6), 16); rgba[i + 3] = 255;
    }
    frameRgba.push({ w: vw, h: vh, rgba: new Float32Array(rgba) });
  }
  const canvas = multiTile ? tileCanvasSize(tiles) : null;
  fs.mkdirSync(outDir, { recursive: true });
  const pipeline = baked
    ? `${ramp.families}x${ramp.steps}-ramp palettes + 2x2 Bayer dither + baked 135deg key/rim -> 1px outline`
    : `${palRGB.length}-colour median-cut -> 1px outline`;
  const def = {
    id, kind: kind || (multiTile ? 'building' : 'actor'),
    ...(baked ? { renderTier: 'baked' } : {}),
    source: `${path.basename(glbPath)} (glTF-Transform ${glb.json.asset && glb.json.asset.generator})`,
    method: multiTile
      ? `ortho-software-raster@${renderRes} -> chop-to-tile-canvas(${tiles.w}x${tiles.h}) -> ${pipeline}`
      : `ortho-software-raster@${renderRes} -> ${size}px box-downscale -> ${pipeline}`,
    native: multiTile ? { w: tiles.w * NATIVE_TILE, h: tiles.h * NATIVE_TILE } : { w: size, h: size },
    anchor: multiTile ? { x: Math.floor((tiles.w * NATIVE_TILE) / 2), y: tiles.h * NATIVE_TILE - 2 } : { x: Math.floor(size / 2), y: size - 2 },
    palette, frames,
  };
  if (multiTile) {
    // Intrinsic asset shape for a multi-tile building: tile counts + the
    // placement mode + a default relative footprint. Scene files author the
    // absolute footprint; the engine's footprint path (renderBuildingSilhouettes)
    // consumes it. `mode: multi-tile-blit` == one blitted bitmap, NOT per-tile
    // slicing (LIV-106).
    def.tiles = { w: tiles.w, h: tiles.h };
    def.placement = { mode: 'multi-tile-blit', footprint: footprintFor(0, 0, tiles) };
  }
  fs.writeFileSync(path.join(outDir, `${id}.sprite.json`), JSON.stringify(def, null, 2) + '\n');
  if (multiTile) {
    const zoom = 4;
    const g = gridSheet(frameRgba[0], zoom);
    fs.writeFileSync(path.join(outDir, `${id}_${canvas.w}x${canvas.h}_x${zoom}_grid.png`), encodePNG(g.w, g.h, g.buf));
    const c = chopSheet(tileSlices(frameRgba[0], tiles), 8);
    fs.writeFileSync(path.join(outDir, `${id}_chop.png`), encodePNG(c.w, c.h, c.buf));
  } else {
    const s = sheet(frameRgba.map((f) => f.rgba), size, 8);
    fs.writeFileSync(path.join(outDir, `${id}_${size}px_x8.png`), encodePNG(s.w, s.h, s.buf));
  }
  return { id, palette: palRGB, opaquePixels: all.length, textured: !!tex, tiles: multiTile ? tiles : null, renderTier: baked ? 'baked' : 'indexed', ramp: ramp ? { families: ramp.families, steps: ramp.steps } : null };
}

function parseArgs(argv) {
  const a = { views: [0, 90, 180, 270], size: 32, colors: 14, rise: 10, flat: false, renderRes: 512, tiles: null, kind: null, tier: 'indexed', families: 6, steps: 4 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--id') a.id = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--size') a.size = +argv[++i];
    else if (t === '--colors') a.colors = +argv[++i];
    else if (t === '--rise') a.rise = +argv[++i];
    else if (t === '--render-res') a.renderRes = +argv[++i];
    else if (t === '--views') a.views = argv[++i].split(',').map(Number);
    else if (t === '--tiles') { const [tw, th] = argv[++i].split('x').map(Number); a.tiles = { w: tw, h: th }; }
    else if (t === '--kind') a.kind = argv[++i];
    else if (t === '--tier') a.tier = argv[++i];
    else if (t === '--families') a.families = +argv[++i];
    else if (t === '--steps') a.steps = +argv[++i];
    else if (t === '--flat') a.flat = true;
    else rest.push(t);
  }
  return { a, rest };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { a, rest } = parseArgs(process.argv.slice(2));
  if (!rest.length) { console.error('usage: node tools/gltf-to-sprite.mjs <input.glb> [--id name] [--out dir] [--tiles 4x2] [--kind building] [--tier indexed|baked] ...'); process.exit(1); }
  const glbPath = rest[0];
  const id = a.id || path.basename(glbPath).replace(/\.glb$/i, '');
  const outDir = a.out || path.join(ROOT, 'docs', 'art', '3d-poc');
  const res = await buildAsset({ glbPath, id, outDir, size: a.size, views: a.views, colors: a.colors, rise: a.rise, flat: a.flat, renderRes: a.renderRes, tiles: a.tiles, kind: a.kind, tier: a.tier, families: a.families, steps: a.steps });
  const shape = res.tiles ? `${res.tiles.w}x${res.tiles.h} tiles` : `${a.size}px`;
  console.log(`${res.id}: ${res.opaquePixels} opaque px, ${res.palette.length}-colour palette (${res.renderTier}), textured=${res.textured}, ${shape} -> ${path.relative(ROOT, outDir)}`);
}
