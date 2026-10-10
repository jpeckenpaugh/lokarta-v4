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
export function render(glb, tex, { azimuth = 0, rise = 10, targetH = 512, ambient = 0.30, light = [-0.45, 0.72, 0.53] } = {}) {
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
      const shade = ambient + 0.85 * Math.pow(diff, 0.9);
      let cre = 200, cgr = 190, cbl = 180;
      if (tex && uv) { const uu = w0 * uv.data[p0 * 2] + w1 * uv.data[p1 * 2] + w2 * uv.data[p2 * 2]; const vv = w0 * uv.data[p0 * 2 + 1] + w1 * uv.data[p1 * 2 + 1] + w2 * uv.data[p2 * 2 + 1]; const col = sampleBilinear(tex, uu, vv); cre = col[0]; cgr = col[1]; cbl = col[2]; }
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

export async function buildAsset({ glbPath, id, outDir, size = 32, views = [0, 90, 180, 270], colors = 14, rise = 10, flat = false, renderRes = 512 }) {
  const glb = parseGLB(glbPath);
  const tex = flat ? null : await loadBaseColor(glb, glb.json.meshes[0].primitives[0].material);
  const viewPix = [];
  for (const az of views) {
    const hi = render(glb, tex, { azimuth: az * Math.PI / 180, rise, targetH: renderRes });
    viewPix.push({ az, px: downscale(hi, size, size) });
  }
  const all = [];
  for (const v of viewPix) for (let i = 0; i < v.px.w * v.px.h; i++) if (v.px.rgba[i * 4 + 3] > 128) all.push([v.px.rgba[i * 4], v.px.rgba[i * 4 + 1], v.px.rgba[i * 4 + 2]]);
  const palRGB = medianCut(all, colors);
  const palette = { '0': OUTLINE, '.': null };
  palRGB.forEach((c, i) => { palette[i.toString(16)] = hex(...c); });
  const frames = {};
  const tiles = [];
  for (const v of viewPix) {
    const idx = outlinePass(quantize(v.px, palRGB), size, size);
    frames[`view_${v.az}`] = idx;
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = palette[idx[y][x]]; if (!p) continue; const hx = p.slice(1); const i = (y * size + x) * 4;
      rgba[i] = parseInt(hx.slice(0, 2), 16); rgba[i + 1] = parseInt(hx.slice(2, 4), 16); rgba[i + 2] = parseInt(hx.slice(4, 6), 16); rgba[i + 3] = 255;
    }
    tiles.push(new Float32Array(rgba));
  }
  fs.mkdirSync(outDir, { recursive: true });
  const def = {
    id, kind: 'actor',
    source: `${path.basename(glbPath)} (glTF-Transform ${glb.json.asset && glb.json.asset.generator})`,
    method: `ortho-software-raster@${renderRes} -> ${size}px box-downscale -> ${palRGB.length}-colour median-cut -> 1px outline`,
    native: { w: size, h: size }, anchor: { x: Math.floor(size / 2), y: size - 2 },
    palette, frames,
  };
  fs.writeFileSync(path.join(outDir, `${id}.sprite.json`), JSON.stringify(def, null, 2) + '\n');
  const s = sheet(tiles, size, 8);
  fs.writeFileSync(path.join(outDir, `${id}_${size}px_x8.png`), encodePNG(s.w, s.h, s.buf));
  return { id, palette: palRGB, opaquePixels: all.length, textured: !!tex };
}

function parseArgs(argv) {
  const a = { views: [0, 90, 180, 270], size: 32, colors: 14, rise: 10, flat: false, renderRes: 512 };
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
    else if (t === '--flat') a.flat = true;
    else rest.push(t);
  }
  return { a, rest };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { a, rest } = parseArgs(process.argv.slice(2));
  if (!rest.length) { console.error('usage: node tools/gltf-to-sprite.mjs <input.glb> [--id name] [--out dir] ...'); process.exit(1); }
  const glbPath = rest[0];
  const id = a.id || path.basename(glbPath).replace(/\.glb$/i, '');
  const outDir = a.out || path.join(ROOT, 'docs', 'art', '3d-poc');
  const res = await buildAsset({ glbPath, id, outDir, size: a.size, views: a.views, colors: a.colors, rise: a.rise, flat: a.flat, renderRes: a.renderRes });
  console.log(`${res.id}: ${res.opaquePixels} opaque px, ${res.palette.length}-colour palette, textured=${res.textured} -> ${path.relative(ROOT, outDir)}`);
}
