#!/usr/bin/env node
/**
 * Lokarta NPC asset authoring tool (LIV-91).
 *
 * Deterministically derives the 8 Havenreach NPC actor sprites (32x32, full
 * 5-state x 3-dir contract) and the portrait sheet (48x48 x 3 expressions) from
 * the identity table in `docs/design/npc-identity-spec.md` §2-§3.
 *
 * Bodies are recoloured from the matching vocation sprite (so the silhouette
 * stays readable and the shading ramp is preserved), then a per-NPC signature
 * prop is stamped so every `idle_down` alpha mask is unique. Portraits are
 * authored from a shared bust template with an expression-specific face.
 *
 * The committed artifacts are the JSON under `html/assets/sprites/npc/` and
 * `html/assets/portraits/portraits.json`. This tool is re-runnable and pure:
 * it never runs at app runtime.
 *
 * Usage: node tools/author-npc-assets.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SPRITES_DIR = path.join(ROOT, 'html', 'assets', 'sprites');
const NPC_DIR = path.join(SPRITES_DIR, 'npc');
const PORTRAIT_DIR = path.join(ROOT, 'html', 'assets', 'portraits');
const OUTLINE = '#0b0d12';

/* ---------------- colour helpers ---------------- */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function srgbToLin(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}

/* Compact NPC art alphabet: 12 body tones + 2 prop tones + outline + empty. */
const ART_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
const PROP_KEY = 'p';
const PROP_ACCENT_KEY = 'q';

/**
 * Builds the NPC palette from a 12-entry dark->light art ramp plus prop tones.
 * Returns both the palette and a base-char -> NPC-char remap that pairs base
 * tones with ramp tones by luminance rank, preserving the authored shading.
 */
function buildPalette(basePalette, ramp, propMain, propAccent) {
  const sortedRamp = [...ramp].sort((x, y) => luminance(x) - luminance(y));
  const baseEntries = Object.entries(basePalette)
    .filter(([k, v]) => v && k !== '0' && k !== '.')
    .sort((x, y) => luminance(x[1]) - luminance(y[1]));
  const remap = {};
  const n = baseEntries.length;
  baseEntries.forEach(([baseKey], i) => {
    const idx = n <= 1 ? 0 : Math.round((i * (sortedRamp.length - 1)) / (n - 1));
    remap[baseKey] = ART_KEYS[idx];
  });
  const palette = { '0': OUTLINE, '.': null };
  ART_KEYS.forEach((k, i) => { palette[k] = sortedRamp[i]; });
  palette[PROP_KEY] = propMain;
  palette[PROP_ACCENT_KEY] = propAccent;
  return { palette, remap };
}

/** Remaps a base frame matrix through `remap` (unknown chars pass through). */
function remapRows(rows, remap) {
  return rows.map((row) => [...row].map((ch) => remap[ch] || ch).join(''));
}

/** Stamps a prop overlay (absolute pixels) onto a frame matrix. */
function stampProp(rows, pixels) {
  const grid = rows.map((row) => [...row]);
  for (const [x, y, ch] of pixels) {
    if (y < 0 || y >= grid.length || x < 0 || x >= grid[0].length) continue;
    grid[y][x] = ch;
  }
  return grid.map((row) => row.join(''));
}

/* ---------------- prop shapes ---------------- */
function rect(x0, y0, x1, y1, ch, out = []) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y, ch]);
  return out;
}
function line(x0, y0, x1, y1, ch, out = []) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (;;) {
    out.push([x, y, ch]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return out;
}

/* ---------------- identity table (spec §2) ---------------- */
const P = PROP_KEY, Q = PROP_ACCENT_KEY;
const NPC_SPECS = [
  {
    npcSpriteId: 'npc_elder_rowan_vane', base: 'magician', facing: 'down',
    ramp: ['#241410', '#382014', '#50301f', '#3b4a6b', '#2f2140', '#4a3a63', '#5c6a8f', '#7a8fb5', '#6a442e', '#a67c00', '#d4af37', '#e2e8f0'],
    prop: [...line(4, 8, 4, 30, P), ...rect(1, 11, 4, 14, Q), [4, 12, Q]],
  },
  {
    npcSpriteId: 'npc_captain_halden', base: 'archer', facing: 'right',
    ramp: ['#1e293b', '#334155', '#475569', '#5b6470', '#64748b', '#7f4d28', '#94a3b8', '#a56a3a', '#bf8551', '#2f6f73', '#cbd5e1', '#ffffff'],
    prop: [...rect(9, 5, 22, 7, P), ...rect(10, 8, 21, 8, Q), ...line(25, 18, 25, 26, P), ...rect(24, 16, 27, 17, Q)],
  },
  {
    npcSpriteId: 'npc_wick', base: 'archer', facing: 'right',
    ramp: ['#0a3018', '#2b2013', '#3f2f1a', '#5a4632', '#6b4423', '#94623a', '#b45309', '#b9824f', '#d19c66', '#facc15', '#e9d8a6', '#ffffff'],
    prop: [...rect(10, 9, 21, 10, Q), ...rect(23, 16, 27, 20, P), ...rect(24, 14, 26, 16, Q)],
  },
  {
    npcSpriteId: 'npc_high_dawnkeeper_aurel', base: 'paladin', facing: 'down',
    ramp: ['#241410', '#36211a', '#4a2e24', '#3a3f52', '#5a5f72', '#7a7f92', '#9aa0b4', '#b8bed0', '#a67c00', '#d4af37', '#e2e8f0', '#fbe6c8'],
    prop: [...line(24, 8, 24, 14, P), ...rect(21, 15, 27, 19, Q), ...rect(22, 16, 26, 18, P)],
  },
  {
    npcSpriteId: 'npc_mara', base: 'archer', facing: 'right',
    ramp: ['#241410', '#3a2414', '#4d2715', '#6b3a22', '#7c4a21', '#834d30', '#94623a', '#b3763c', '#b45309', '#d99a5b', '#eab778', '#d9a441'],
    prop: [...rect(7, 19, 22, 20, P), ...rect(22, 17, 27, 23, Q), ...rect(23, 18, 26, 22, P)],
  },
  {
    npcSpriteId: 'npc_innkeep_bessa', base: 'magician', facing: 'down',
    ramp: ['#2a160f', '#3a1c10', '#4d2715', '#5a3220', '#6b3a22', '#7a4a2a', '#9a5b2a', '#b04a3a', '#b3763c', '#c98f68', '#d99a5b', '#f5e6cf'],
    prop: [...rect(9, 16, 21, 25, P), ...line(19, 13, 24, 19, Q), ...rect(23, 18, 25, 20, Q)],
  },
  {
    npcSpriteId: 'npc_old_sailor_doran', base: 'magician', facing: 'down',
    ramp: ['#160d0a', '#241713', '#2b3247', '#33415c', '#47536e', '#5b6880', '#9a4a3a', '#7a879c', '#a0acc0', '#d8a888', '#f0d0b8', '#cbd5e1'],
    prop: [...rect(10, 4, 21, 7, P), ...line(26, 14, 26, 30, P), ...rect(25, 15, 27, 16, Q)],
  },
  {
    npcSpriteId: 'npc_pilgrims_apprentice_tam', base: 'archer', facing: 'right',
    ramp: ['#160d0a', '#241713', '#2f4a26', '#3f6a33', '#4a7a3c', '#6b4e2e', '#653716', '#8a4f2b', '#a5653c', '#b08a4a', '#e8dcc0', '#f0e6d0'],
    prop: [...rect(5, 2, 12, 12, P), ...rect(6, 3, 11, 11, Q), ...rect(7, 16, 22, 24, P)],
  },
];

/* ---------------- portrait template (spec §3) ---------------- */
/* Portrait palette keys: 0 outline, . empty, then face/garment/prop tones. */
const PORTRAIT_KEYS = {
  skin: 'a', skinShadow: 'b', skinLight: 'c', hair: 'd', hairLight: 'e',
  garment: 'f', garmentDark: 'g', accent: 'h',
  eye: 'j', mouth: 'k', prop: 'p', white: 'w',
};

function blank(w, h, ch = '.') {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => ch));
}
function fillEllipse(grid, cx, cy, rx, ry, ch) {
  for (let y = cy - ry; y <= cy + ry; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      if (y < 0 || y >= grid.length || x < 0 || x >= grid[0].length) continue;
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) grid[y][x] = ch;
    }
  }
}
function fillRect(grid, x0, y0, x1, y1, ch) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (y < 0 || y >= grid.length || x < 0 || x >= grid[0].length) continue;
    grid[y][x] = ch;
  }
}

/**
 * Builds one 48x48 portrait bust. `expression` changes the face + a lean so the
 * read survives at a glance (spec §3 readability rule).
 */
function portraitGrid(expression, spec) {
  const g = blank(48, 48);
  const K = PORTRAIT_KEYS;
  const lean = expression === 'urgent' ? -1 : 0;
  const shoulderBonus = expression === 'warm' ? 1 : expression === 'urgent' ? -1 : 0;

  // Shoulders / garment.
  for (let y = 34; y < 48; y++) {
    const half = Math.min(22, 8 + (y - 34) + shoulderBonus);
    for (let x = 24 - half; x <= 24 + half; x++) g[y][x] = K.garment;
  }
  fillRect(g, 16, 33, 32, 40, K.garmentDark);
  // Collar accent.
  fillRect(g, 21 + lean, 32, 27 + lean, 35, K.accent);

  // Neck.
  fillRect(g, 21 + lean, 27, 27 + lean, 34, K.skinShadow);

  // Head.
  fillEllipse(g, 24 + lean, 18, 11, 13, K.skin);
  fillEllipse(g, 24 + lean, 15, 10, 10, K.skinLight);
  // Ears.
  fillRect(g, 12 + lean, 18, 13 + lean, 22, K.skin);
  fillRect(g, 35 + lean, 18, 36 + lean, 22, K.skin);

  // Headwear / hair cap.
  fillEllipse(g, 24 + lean, 10, 11, 7, K.hair);
  fillRect(g, 13 + lean, 6, 35 + lean, 12, K.hair);
  fillRect(g, 14 + lean, 12, 34 + lean, 13, K.hairLight);

  const ex = lean;
  if (expression === 'urgent') {
    // Drawn brows + wide eyes + open mouth + set jaw.
    fillRect(g, 16 + ex, 15, 21 + ex, 16, K.hair);
    fillRect(g, 27 + ex, 15, 32 + ex, 16, K.hair);
    fillRect(g, 17 + ex, 18, 20 + ex, 21, K.eye);
    fillRect(g, 28 + ex, 18, 31 + ex, 21, K.eye);
    fillRect(g, 18 + ex, 18, 18 + ex, 18, K.white);
    fillRect(g, 29 + ex, 18, 29 + ex, 18, K.white);
    fillRect(g, 21 + ex, 25, 27 + ex, 28, K.mouth);
    fillRect(g, 22 + ex, 26, 26 + ex, 27, K.skinShadow);
  } else if (expression === 'warm') {
    // Soft eyes + up-turned smile + cheeks.
    fillRect(g, 17 + ex, 18, 20 + ex, 20, K.eye);
    fillRect(g, 28 + ex, 18, 31 + ex, 20, K.eye);
    fillRect(g, 18 + ex, 18, 19 + ex, 18, K.white);
    fillRect(g, 29 + ex, 18, 30 + ex, 18, K.white);
    fillRect(g, 15 + ex, 21, 17 + ex, 22, K.accent);
    fillRect(g, 31 + ex, 21, 33 + ex, 22, K.accent);
    fillRect(g, 20 + ex, 25, 28 + ex, 25, K.mouth);
    fillRect(g, 19 + ex, 24, 20 + ex, 24, K.mouth);
    fillRect(g, 28 + ex, 24, 29 + ex, 24, K.mouth);
  } else {
    // Neutral: level eyes, flat mouth.
    fillRect(g, 17 + ex, 18, 20 + ex, 20, K.eye);
    fillRect(g, 28 + ex, 18, 31 + ex, 20, K.eye);
    fillRect(g, 18 + ex, 18, 18 + ex, 18, K.white);
    fillRect(g, 29 + ex, 18, 29 + ex, 18, K.white);
    fillRect(g, 21 + ex, 25, 27 + ex, 25, K.mouth);
  }

  // Per-NPC prop echo (spec §2 signature prop carried into the bust).
  for (const [x, y, ch] of spec.portraitProp || []) {
    if (y < 0 || y >= 48 || x < 0 || x >= 48) continue;
    g[y][x] = ch === 'P' ? K.prop : K.white;
  }
  return g.map((row) => row.join(''));
}

/* ---------------- build & write ---------------- */
function buildSprite(spec) {
  const base = JSON.parse(fs.readFileSync(path.join(SPRITES_DIR, 'vocations', `${spec.base}.json`), 'utf8'));
  const { palette, remap } = buildPalette(base.palette, spec.ramp, spec.ramp[spec.ramp.length - 1], spec.ramp[spec.ramp.length - 2]);
  const frames = {};
  for (const [fid, rows] of Object.entries(base.frames)) {
    frames[fid] = stampProp(remapRows(rows, remap), spec.prop);
  }
  return {
    id: spec.npcSpriteId,
    kind: 'npc',
    native: { w: 32, h: 32 },
    anchor: { x: 16, y: 30 },
    palette,
    frames,
    animations: base.animations,
  };
}

function portraitPalette(spec) {
  // Map spec ramp tones onto the portrait keys, dark -> light.
  const ramp = [...spec.ramp].sort((a, b) => luminance(a) - luminance(b));
  const at = (i) => ramp[Math.max(0, Math.min(ramp.length - 1, i))];
  const K = PORTRAIT_KEYS;
  return {
    '0': OUTLINE, '.': null,
    [K.skin]: at(8), [K.skinShadow]: at(6), [K.skinLight]: at(10),
    [K.hair]: at(2), [K.hairLight]: at(4),
    [K.garment]: at(3), [K.garmentDark]: at(1),
    [K.accent]: at(9),
    [K.eye]: '#1a1a22', [K.mouth]: at(5), [K.accent]: at(9),
    [K.prop]: at(7), [K.white]: '#ffffff',
  };
}

function main() {
  fs.mkdirSync(NPC_DIR, { recursive: true });
  fs.mkdirSync(PORTRAIT_DIR, { recursive: true });

  for (const spec of NPC_SPECS) {
    const def = buildSprite(spec);
    fs.writeFileSync(path.join(NPC_DIR, `${spec.npcSpriteId}.json`), JSON.stringify(def, null, 2) + '\n');
  }

  const portraits = { version: 1, native: { w: 48, h: 48 }, portraits: {} };
  for (const spec of NPC_SPECS) {
    const npcId = spec.npcSpriteId.replace(/^npc_/, '');
    const palette = portraitPalette(spec);
    for (const expression of ['neutral', 'warm', 'urgent']) {
      const id = `portrait_${npcId}_${expression}`;
      portraits.portraits[id] = {
        id,
        kind: 'portrait',
        npcId,
        expression,
        native: { w: 48, h: 48 },
        palette,
        frames: { bust: portraitGrid(expression, spec) },
      };
    }
  }
  fs.writeFileSync(path.join(PORTRAIT_DIR, 'portraits.json'), JSON.stringify(portraits, null, 2) + '\n');

  console.log(`Wrote ${NPC_SPECS.length} NPC sprites to html/assets/sprites/npc/`);
  console.log(`Wrote ${Object.keys(portraits.portraits).length} portraits to html/assets/portraits/portraits.json`);
}

main();
