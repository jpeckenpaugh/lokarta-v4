/**
 * Lokarta: Come Into The Light - Sprite & Tile Canvas Renderer
 *
 * Tiles, items and HUD are procedural. Actors (4 vocations + monsters) resolve
 * to authored indexed-pixel sprite definitions from `html/assets/sprites/`
 * (see docs/art-direction.md), pre-rendered once per (actor, frame, scale,
 * flip, tint) into an offscreen canvas and blitted with nearest-neighbour
 * integer scaling. If a sprite definition or frame is missing, every renderer
 * falls back to the original procedural primitives, so the sprite pass can land
 * incrementally without breaking the game or the native tests.
 */

import { CONFIG, TILE_TYPES } from '../engine/index.js';
import { TILE_THEMES_CATALOG, VOCATIONS_CATALOG, CHESTS_CATALOG, DEFAULT_TOWER_ID, getTowerDefinition } from '../data/index.js';
import { SPRITE_CATALOG, PROP_CATALOG, PROP_IDS_BY_TIER } from '../assets/sprites/index.js';
import { dirFromFacing, resolveFrameIndex } from './animation-state.js';

// Minimal hairline guard so 1px strokes stay visible even if GRID_SIZE shrinks.
const HAIRLINE = (u) => Math.max(1, u);

export const SPRITE_NATIVE = 32;
export const OUTLINE_COLOR = '#0b0d12';
export const HIT_TINT = '#ff4d4d';
export const TOWER_LEVEL_COUNT = 5;

/** Chest tier fallback tints (used only when the authored prop is missing). */
const TIER_TINTS = {
  copper: { light: '#e8a86a', dark: '#7a4a1e' },
  silver: { light: '#dfe3ea', dark: '#7c8290' },
  gold: { light: '#fde68a', dark: '#b45309' },
};

/**
 * Resolves the tile theme for a run floor. The selected tower's data-authored
 * `theme.levelTheme` maps its level to a `tile_themes.levels` entry, merged over
 * the root catalog; unknown/out-of-range floors fall back to the root object.
 * See docs/art-direction-tower.md §2.
 * @param {number} floorNumber
 * @param {string} [towerId]
 * @returns {object} theme object with wall/floor/stairs/door (+ features/decor when leveled)
 */
export function themeForFloor(floorNumber, towerId = DEFAULT_TOWER_ID) {
  const n = Math.floor(Number(floorNumber));
  if (!Number.isFinite(n)) return TILE_THEMES_CATALOG;
  const tower = getTowerDefinition(towerId);
  const count = Number(tower?.levelCount) || TOWER_LEVEL_COUNT;
  const levels = TILE_THEMES_CATALOG.levels;
  if (!levels || n < 1 || n > count) return TILE_THEMES_CATALOG;
  const map = tower && tower.theme && tower.theme.levelTheme;
  const key = map ? (map[String(n)] ?? String(n)) : String(n);
  const level = levels[key];
  return level ? { ...TILE_THEMES_CATALOG, ...level } : TILE_THEMES_CATALOG;
}

/**
 * Deterministic tile-coordinate hash (docs/art-direction-tower.md §3.3).
 * Integer-exact across runs; never Math.random().
 */
function tileHash(x, y) {
  return (((x * 73856093) ^ (y * 19349663)) >>> 0);
}

/**
 * Picks the castle/tower motif for a lit wall tile, or null. Pure and
 * deterministic: same (x, y, theme, neighbor flags) always yields the same
 * feature. Only one feature per tile.
 *
 * @param {number} x @param {number} y
 * @param {object} theme - resolved floor theme
 * @param {boolean} hasFloorBelow - floor tile directly below
 * @param {boolean} adjacentFloor - any 4-neighbour is non-wall
 * @param {boolean} nearDoor - a DOOR/GATED_DOOR tile within 2 tiles
 * @returns {'sconce'|'banner'|'window'|null}
 */
export function wallFeatureFor(x, y, theme, hasFloorBelow, adjacentFloor, nearDoor) {
  const decor = theme && theme.decor;
  const features = theme && theme.features;
  if (!decor || !features) return null;
  const roll = (tileHash(x, y) % 1000) / 1000;
  if (hasFloorBelow && decor.sconce > 0 && roll < decor.sconce) return 'sconce';
  if (!nearDoor && decor.banner > 0 && roll < decor.banner) return 'banner';
  if (!adjacentFloor && decor.window > 0 && roll < decor.window) return 'window';
  return null;
}

/**
 * Deterministic per-tile wall shade from the data-driven `wall.shades` palette.
 * Falls back to the flat `wall.fill` when no palette is authored. Integer
 * coordinate hash only; no transient allocation on the render path.
 *
 * @param {object} theme - resolved floor theme
 * @param {number} x @param {number} y
 * @returns {string|undefined}
 */
export function wallShadeFor(theme, x, y) {
  const wall = theme && theme.wall;
  if (!wall) return undefined;
  const shades = wall.shades;
  if (shades && shades.length) return shades[tileHash(x, y) % shades.length];
  return wall.fill;
}

function fillNative(ctx, screenX, screenY, u, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(
    Math.round(screenX + x * u),
    Math.round(screenY + y * u),
    Math.max(1, Math.round(w * u)),
    Math.max(1, Math.round(h * u))
  );
}

/**
 * Draws a 32x32-native castle motif on a wall tile using integer fillRect only.
 * @param {CanvasRenderingContext2D} ctx
 * @param {'sconce'|'banner'|'window'} name
 */
export function drawWallFeature(ctx, name, screenX, screenY, size, theme) {
  const u = size / 32;
  const f = theme.features || {};
  if (name === 'sconce') {
    fillNative(ctx, screenX, screenY, u, 24, 10, 4, 10, f.sconce);
    fillNative(ctx, screenX, screenY, u, 24, 6, 4, 4, f.flame);
    fillNative(ctx, screenX, screenY, u, 25, 7, 2, 2, '#ffffff');
  } else if (name === 'banner') {
    fillNative(ctx, screenX, screenY, u, 15, 4, 1, 20, f.bannerTrim);
    fillNative(ctx, screenX, screenY, u, 10, 4, 12, 18, f.banner);
    fillNative(ctx, screenX, screenY, u, 10, 4, 12, 2, f.bannerTrim);
    fillNative(ctx, screenX, screenY, u, 10, 20, 12, 2, f.bannerTrim);
  } else if (name === 'window') {
    fillNative(ctx, screenX, screenY, u, 10, 4, 12, 18, theme.wall.topHighlight);
    fillNative(ctx, screenX, screenY, u, 12, 6, 8, 14, f.window);
    fillNative(ctx, screenX, screenY, u, 15, 6, 2, 14, theme.wall.gridLine);
  }
}

/**
 * Data-driven prop id for a ground item: keys resolve by `keyTier`, chests by
 * `chestTier` (falling back to `tier`). No string heuristics.
 * @returns {string|null}
 */
export function resolvePropId(item) {
  if (!item) return null;
  const tier = item.keyTier || item.chestTier || item.tier;
  const map = tier && PROP_IDS_BY_TIER[tier];
  if (!map) return null;
  if (item.type === 'key') return map.key;
  if (item.type === 'chest') return map.chest;
  return null;
}

/**
 * Blits an authored prop frame into a tile rect, falling back to a raw pixel
 * fill when no canvas is available (node). Returns true when a prop was drawn.
 */
function drawPropFrame(ctx, def, frameId, dx, dy, size) {
  if (!def || !def.frames || !def.frames[frameId] || !def.palette) return false;
  const scale = Math.max(1, Math.floor(size / (def.native?.w || SPRITE_NATIVE)));
  const canvas = getFrameCanvas(def, frameId, scale, false, null);
  if (canvas && typeof ctx.drawImage === 'function') {
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, dx, dy);
    return true;
  }
  const pixels = renderFramePixels(def, frameId, scale, false, null);
  if (!pixels || typeof ctx.fillRect !== 'function') return false;
  drawPixels(ctx, pixels, dx, dy, scale);
  return true;
}

const TILE_RENDERERS = {
  [TILE_TYPES.WALL]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const u = size / 32;

    // Slight per-tile shade variation (data-driven `wall.shades`) so a wall run
    // of otherwise identical tiles reads with texture. Deterministic by tile
    // coordinate; falls back to the flat `fill`.
    ctx.fillStyle = wallShadeFor(theme, opts.x || 0, opts.y || 0) || theme.wall.fill;
    ctx.fillRect(screenX, screenY, size, size);

    ctx.fillStyle = theme.wall.topHighlight;
    ctx.fillRect(screenX, screenY, size, 4 * u);

    ctx.strokeStyle = theme.wall.gridLine;
    ctx.lineWidth = HAIRLINE(u);
    ctx.beginPath();
    ctx.moveTo(screenX, screenY + size / 2);
    ctx.lineTo(screenX + size, screenY + size / 2);
    ctx.moveTo(screenX + size / 2, screenY);
    ctx.lineTo(screenX + size / 2, screenY + size / 2);
    ctx.moveTo(screenX + size / 4, screenY + size / 2);
    ctx.lineTo(screenX + size / 4, screenY + size);
    ctx.moveTo(screenX + (3 * size) / 4, screenY + size / 2);
    ctx.lineTo(screenX + (3 * size) / 4, screenY + size);
    ctx.stroke();

    ctx.strokeStyle = theme.wall.border;
    ctx.lineWidth = HAIRLINE(u);
    ctx.strokeRect(screenX + 0.5, screenY + 0.5, size - 1, size - 1);

    // Castle/tower motifs ride on lit wall tiles; placement is a pure hash.
    const feature = wallFeatureFor(
      opts.x || 0,
      opts.y || 0,
      theme,
      !!opts.hasFloorBelow,
      !!opts.adjacentFloor,
      !!opts.nearDoor
    );
    if (feature) drawWallFeature(ctx, feature, screenX, screenY, size, theme);
  },
  [TILE_TYPES.STAIRS]: (ctx, screenX, screenY, size, theme) => {
    const u = size / 32;

    ctx.fillStyle = theme.stairs.bg;
    ctx.fillRect(screenX, screenY, size, size);

    for (let i = 0; i < 4; i++) {
      const inset = i * 3 * u;
      ctx.fillStyle = i % 2 === 0 ? theme.stairs.stepEven : theme.stairs.stepOdd;
      ctx.fillRect(screenX + inset, screenY + inset, size - inset * 2, size - inset * 2);
    }

    ctx.fillStyle = theme.stairs.orb;
    ctx.beginPath();
    ctx.arc(screenX + size / 2, screenY + size / 2, 5 * u, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = theme.stairs.border;
    ctx.lineWidth = 2 * u;
    ctx.strokeRect(screenX + 2 * u, screenY + 2 * u, size - 4 * u, size - 4 * u);
  },
  [TILE_TYPES.DOOR]: (ctx, screenX, screenY, size, theme) => {
    const u = size / 32;

    ctx.fillStyle = theme.door.fill;
    ctx.fillRect(screenX, screenY, size, size);
    ctx.strokeStyle = theme.door.border;
    ctx.lineWidth = 2 * u;
    ctx.strokeRect(screenX + 2 * u, screenY + 2 * u, size - 4 * u, size - 4 * u);
  },
  [TILE_TYPES.GATED_DOOR]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const u = size / 32;

    // Tier art: blit the authored closed/open gated-door prop (data-driven by
    // `tier`). Falls back to the procedural lock affordance when absent.
    const tierMap = opts.tier && PROP_IDS_BY_TIER[opts.tier];
    const propDef = tierMap ? PROP_CATALOG[tierMap.door] : null;
    if (drawPropFrame(ctx, propDef, opts.open ? 'open' : 'closed', screenX, screenY, size)) return;

    ctx.fillStyle = theme.door.fill;
    ctx.fillRect(screenX, screenY, size, size);
    ctx.strokeStyle = theme.door.border;
    ctx.lineWidth = 2 * u;
    ctx.strokeRect(screenX + 2 * u, screenY + 2 * u, size - 4 * u, size - 4 * u);

    // Locked-gate affordance: a bolt bar across the door.
    ctx.strokeStyle = '#c0c0c8';
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    ctx.moveTo(screenX + size * 0.3, screenY + size * 0.5);
    ctx.lineTo(screenX + size * 0.7, screenY + size * 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(screenX + size * 0.5, screenY + size * 0.5, 3 * u, 0, Math.PI * 2);
    ctx.stroke();
  },
  default: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const u = size / 32;

    // Slight per-tile shade variation (data-driven `floor.shades`) so a floor of
    // otherwise identical tiles still reads as motion. Deterministic by tile
    // coordinate; falls back to the flat `fill`.
    const shades = theme.floor && theme.floor.shades;
    const fill = shades && shades.length
      ? shades[tileHash(opts.x || 0, opts.y || 0) % shades.length]
      : theme.floor.fill;
    ctx.fillStyle = fill;
    ctx.fillRect(screenX, screenY, size, size);

    ctx.strokeStyle = theme.floor.gridLine;
    ctx.lineWidth = HAIRLINE(u);
    ctx.strokeRect(screenX + 0.5, screenY + 0.5, size - 1, size - 1);

    ctx.fillStyle = theme.floor.accentSquare;
    ctx.fillRect(screenX + 4 * u, screenY + 4 * u, 6 * u, 6 * u);
    ctx.fillRect(screenX + size - 10 * u, screenY + size - 10 * u, 6 * u, 6 * u);
  },
};

/** Fallback nature palette when a theme omits `outside` (data-driven default). */
const DEFAULT_OUTSIDE = {
  grass: ['#1b2e1c', '#1f3420', '#172817', '#1d311e'],
  grassBlade: '#243d24',
  bush: '#2c4a2c',
  bushLight: '#3a5f3a',
  treeTrunk: '#33261a',
  treeCanopy: '#1f3a22',
  treeCanopyLight: '#2c5230',
};

const WEAPON_RENDERERS = {
  archer: (ctx, cx, cy, u) => {
    ctx.strokeStyle = '#c68b59';
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    ctx.arc(cx, cy, 9 * u, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1 * u;
    ctx.beginPath();
    ctx.moveTo(cx + 5 * u, cy - 8 * u);
    ctx.lineTo(cx + 5 * u, cy + 8 * u);
    ctx.stroke();
  },
  paladin: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(cx - 6 * u, cy - 8 * u, 12 * u, 6 * u);
    ctx.fillStyle = '#78350f';
    ctx.fillRect(cx - 2 * u, cy - 2 * u, 4 * u, 12 * u);
  },
  default: (ctx, cx, cy, u) => {
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    ctx.moveTo(cx - 6 * u, cy + 6 * u);
    ctx.lineTo(cx + 6 * u, cy - 6 * u);
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(cx - 8 * u, cy + 4 * u, 4 * u, 4 * u);
  },
};

const ITEM_RENDERERS = {
  health_potion: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    ctx.arc(cx, cy + 2 * u, 7 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f1faee';
    ctx.fillRect(cx - 3 * u, cy - 8 * u, 6 * u, 4 * u);
    ctx.fillStyle = '#d4a373';
    ctx.fillRect(cx - 4 * u, cy - 10 * u, 8 * u, 3 * u);
  },
  mana_potion: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#3a86ff';
    ctx.beginPath();
    ctx.arc(cx, cy + 2 * u, 7 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f1faee';
    ctx.fillRect(cx - 3 * u, cy - 8 * u, 6 * u, 4 * u);
    ctx.fillStyle = '#d4a373';
    ctx.fillRect(cx - 4 * u, cy - 10 * u, 8 * u, 3 * u);
  },
  torch: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#8b5a2b';
    ctx.fillRect(cx - 3 * u, cy - 4 * u, 6 * u, 14 * u);
    ctx.fillStyle = '#ffaa00';
    ctx.beginPath();
    ctx.arc(cx, cy - 6 * u, 5 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff4400';
    ctx.beginPath();
    ctx.arc(cx, cy - 5 * u, 3 * u, 0, Math.PI * 2);
    ctx.fill();
  },
  arrows: (ctx, cx, cy, u) => {
    ctx.strokeStyle = '#d4a373';
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.moveTo(cx - 6 * u, cy + 6 * u);
    ctx.lineTo(cx + 6 * u, cy - 6 * u);
    ctx.moveTo(cx - 4 * u, cy + 8 * u);
    ctx.lineTo(cx + 8 * u, cy - 4 * u);
    ctx.stroke();
    ctx.fillStyle = '#e9d8a6';
    ctx.fillRect(cx - 8 * u, cy + 5 * u, 4 * u, 4 * u);
  },
  currency: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(cx - 4 * u, cy + 2 * u, 5 * u, 0, Math.PI * 2);
    ctx.arc(cx + 5 * u, cy - 3 * u, 4 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b45309';
    ctx.beginPath();
    ctx.arc(cx - 4 * u, cy + 2 * u, 2 * u, 0, Math.PI * 2);
    ctx.arc(cx + 5 * u, cy - 3 * u, 1.5 * u, 0, Math.PI * 2);
    ctx.fill();
  },
  weapon: (ctx, cx, cy, u, item) => {
    // Catalog-driven: prefer the item's explicit `renderKey`, then its
    // vocation affinity, then the neutral sword fallback.
    const key = item?.renderKey || item?.vocationAffinity;
    const renderer = WEAPON_RENDERERS[key] || WEAPON_RENDERERS.default;
    renderer(ctx, cx, cy, u);
  },
  spell: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(cx, cy, 6 * u, 0, Math.PI * 2);
    ctx.fill();
  },
  default: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#e0a96d';
    ctx.fillRect(cx - 5 * u, cy - 5 * u, 10 * u, 10 * u);
  },
};

const MONSTER_RENDERERS = {
  giant_rat: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#5a3d28';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 2 * u, 8 * u, 5 * u, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff2222';
    ctx.beginPath();
    ctx.arc(cx + 4 * u, cy, 1.5 * u, 0, Math.PI * 2);
    ctx.fill();
  },
  crypt_skeleton: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#dcdde1';
    ctx.beginPath();
    ctx.arc(cx, cy - 4 * u, 5 * u, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#dcdde1';
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 1 * u);
    ctx.lineTo(cx, cy + 10 * u);
    ctx.stroke();

    ctx.fillStyle = '#00ffff';
    ctx.beginPath();
    ctx.arc(cx - 2 * u, cy - 4 * u, 1 * u, 0, Math.PI * 2);
    ctx.arc(cx + 2 * u, cy - 4 * u, 1 * u, 0, Math.PI * 2);
    ctx.fill();
  },
  shadow_cultist: (ctx, cx, cy, u, monster) => {
    const isElite = monster.type === 'elite_cultist';
    ctx.fillStyle = isElite ? '#3b0764' : '#1e1b4b';
    ctx.beginPath();
    ctx.moveTo(cx - 7 * u, cy + 12 * u);
    ctx.lineTo(cx + 7 * u, cy + 12 * u);
    ctx.lineTo(cx + 4 * u, cy - 4 * u);
    ctx.lineTo(cx - 4 * u, cy - 4 * u);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = isElite ? '#6b21a8' : '#312e81';
    ctx.beginPath();
    ctx.arc(cx, cy - 6 * u, 6 * u, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#a855f7';
    ctx.beginPath();
    ctx.arc(cx - 2 * u, cy - 6 * u, 1.5 * u, 0, Math.PI * 2);
    ctx.arc(cx + 2 * u, cy - 6 * u, 1.5 * u, 0, Math.PI * 2);
    ctx.fill();
  },
  elite_cultist: (ctx, cx, cy, u, monster) => {
    MONSTER_RENDERERS.shadow_cultist(ctx, cx, cy, u, monster);
  },
  abyssal_overlord: (ctx, cx, cy, u) => {
    ctx.fillStyle = '#450a0a';
    ctx.beginPath();
    ctx.arc(cx, cy - 4 * u, 12 * u, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.moveTo(cx - 8 * u, cy - 12 * u);
    ctx.lineTo(cx - 12 * u, cy - 18 * u);
    ctx.moveTo(cx + 8 * u, cy - 12 * u);
    ctx.lineTo(cx + 12 * u, cy - 18 * u);
    ctx.stroke();

    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(cx - 4 * u, cy - 4 * u, 2.5 * u, 0, Math.PI * 2);
    ctx.arc(cx + 4 * u, cy - 4 * u, 2.5 * u, 0, Math.PI * 2);
    ctx.fill();
  },
};

const FACING_EYE_OFFSETS = {
  up: { ox: 0, oy: -2 },
  down: { ox: 0, oy: 2 },
  left: { ox: -2, oy: 0 },
  right: { ox: 2, oy: 0 },
};

/* ==================== Pure sprite helpers (unit-test seam) ==================== */

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mixHex(a, b, t) {
  const ca = hexToRgb(a); const cb = hexToRgb(b);
  const m = i => Math.round(ca[i] + (cb[i] - ca[i]) * t);
  return `#${[m(0), m(1), m(2)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Parse a frame (array of `h` strings of `w` palette chars) into a flat RGBA
 * pixel object. `"."` and unknown chars are transparent.
 */
export function parseFrame(rows, palette) {
  const h = rows.length;
  const w = h ? rows[0].length : 0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      const hex = palette[row[x]];
      if (!hex) continue;
      const [r, g, b] = hexToRgb(hex);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { w, h, data };
}

/**
 * Apply the 1 px outline post-step: any transparent pixel with a non-transparent
 * 4-neighbour becomes `outlineHex`. Idempotent when re-applied to its own output.
 */
export function applyOutline(pix, outlineHex = OUTLINE_COLOR) {
  const { w, h, data } = pix;
  const out = new Uint8ClampedArray(data);
  const [or, og, ob] = hexToRgb(outlineHex);
  const isOutline = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    const i = (y * w + x) * 4;
    return data[i + 3] > 0 && data[i] === or && data[i + 1] === og && data[i + 2] === ob;
  };
  // Only paint around original art, never around existing outline pixels.
  // This makes the pass idempotent when re-applied.
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

/** Nearest-neighbour scale a pixel object by an integer factor, optionally mirrored. */
export function scalePixels(pix, scale, flipX = false) {
  const { w, h, data } = pix;
  const sw = w * scale;
  const sh = h * scale;
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = flipX ? w - 1 - x : x;
      const si = (y * w + sx) * 4;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const di = ((y * scale + dy) * sw + (x * scale + dx)) * 4;
          out[di] = data[si];
          out[di + 1] = data[si + 1];
          out[di + 2] = data[si + 2];
          out[di + 3] = data[si + 3];
        }
      }
    }
  }
  return { w: sw, h: sh, data: out };
}

function tintedPalette(def, tintHex, amount) {
  const out = {};
  for (const [k, v] of Object.entries(def.palette)) out[k] = v ? mixHex(v, tintHex, amount) : null;
  return out;
}

export function resolveSpriteId(actor) {
  if (!actor) return null;
  const candidates = [actor.spriteId, actor.vocation, actor.type, actor.id];
  for (const c of candidates) if (c && SPRITE_CATALOG[c]) return c;
  return null;
}

export function resolveSpriteFrame(def, anim) {
  const state = anim && def.animations[anim.state] ? anim.state : 'idle';
  let dir = (anim && anim.dir) || 'down';
  if (!def.animations[state][dir]) dir = def.animations[state].down ? 'down' : Object.keys(def.animations[state])[0];
  const list = def.animations[state][dir] || [];
  const rawFrame = (anim && anim.frame) || 0;
  const idx = state === 'death'
    ? Math.max(0, Math.min(rawFrame, Math.max(0, list.length - 1)))
    : resolveFrameIndex({ frame: rawFrame }, list.length);
  const frameId = list[idx] || (def.animations.idle && def.animations.idle.down ? def.animations.idle.down[0] : null);
  return { state, dir, frameId };
}

function prefersReducedMotion() {
  try {
    return !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/* ==================== Frame cache / rasterisation ==================== */

const _frameCache = new Map();

function createCanvas(w, h) {
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  } catch {
    /* no canvas available (e.g. node tests) */
  }
  return null;
}

function renderFramePixels(def, frameId, scale, flipX, tint) {
  const rows = def.frames[frameId];
  if (!rows) return null;
  const palette = tint ? tintedPalette(def, tint.hex, tint.amount) : def.palette;
  const pix = parseFrame(rows, palette);
  const outlined = applyOutline(pix, def.palette['0'] || OUTLINE_COLOR);
  return scalePixels(outlined, scale, flipX);
}

function getFrameCanvas(def, frameId, scale, flipX, tint) {
  const key = `${def.id}|${frameId}|${scale}|${flipX ? 1 : 0}|${tint ? tint.hex + tint.amount : ''}`;
  if (_frameCache.has(key)) return _frameCache.get(key);
  const pixels = renderFramePixels(def, frameId, scale, flipX, tint);
  if (!pixels) return null;
  const canvas = createCanvas(pixels.w, pixels.h);
  if (!canvas) return null;
  const cctx = canvas.getContext('2d');
  if (!cctx) return null;
  const img = cctx.createImageData(pixels.w, pixels.h);
  img.data.set(pixels.data);
  cctx.putImageData(img, 0, 0);
  _frameCache.set(key, canvas);
  return canvas;
}

function drawPixels(ctx, pixels, dx, dy, scale) {
  for (let y = 0; y < pixels.h; y += scale) {
    for (let x = 0; x < pixels.w; x += scale) {
      const i = (y * pixels.w + x) * 4;
      if (pixels.data[i + 3] === 0) continue;
      ctx.fillStyle = `rgba(${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]},${pixels.data[i + 3] / 255})`;
      ctx.fillRect(dx + x, dy + y, scale, scale);
    }
  }
}

/* ==================== Public renderer ==================== */

export class SpriteRenderer {
  static drawTile(ctx, type, screenX, screenY, size = CONFIG.GRID_SIZE, opts = {}) {
    const theme = opts.theme || TILE_THEMES_CATALOG;
    const renderer = TILE_RENDERERS[type] || TILE_RENDERERS.default;
    renderer(ctx, screenX, screenY, size, theme, opts);
  }

  /**
   * Draws the nature backdrop that sits outside the tower footprint. Tiles are
   * resolved deterministically from their coordinates: a grass base with a
   * sparse, hash-placed bush or tree. Data-driven via `theme.outside`.
   * @param {number} x @param {number} y - world tile coordinates (may be negative)
   */
  static drawOutside(ctx, screenX, screenY, size = CONFIG.GRID_SIZE, x = 0, y = 0, theme = {}) {
    const o = (theme && theme.outside) || DEFAULT_OUTSIDE;
    const u = size / 32;
    const h = tileHash(x, y);
    const grass = o.grass && o.grass.length ? o.grass[h % o.grass.length] : DEFAULT_OUTSIDE.grass[0];

    ctx.fillStyle = grass;
    ctx.fillRect(screenX, screenY, size, size);

    // Sparse grass blades for texture.
    ctx.fillStyle = o.grassBlade || DEFAULT_OUTSIDE.grassBlade;
    ctx.fillRect(screenX + 8 * u, screenY + 18 * u, 2 * u, 6 * u);
    ctx.fillRect(screenX + 22 * u, screenY + 10 * u, 2 * u, 7 * u);

    const roll = h % 100;
    if (roll < 5) {
      // Tree: trunk + layered canopy.
      ctx.fillStyle = o.treeTrunk || DEFAULT_OUTSIDE.treeTrunk;
      ctx.fillRect(screenX + 14 * u, screenY + 18 * u, 4 * u, 10 * u);
      ctx.fillStyle = o.treeCanopy || DEFAULT_OUTSIDE.treeCanopy;
      ctx.fillRect(screenX + 7 * u, screenY + 6 * u, 18 * u, 14 * u);
      ctx.fillStyle = o.treeCanopyLight || DEFAULT_OUTSIDE.treeCanopyLight;
      ctx.fillRect(screenX + 10 * u, screenY + 8 * u, 8 * u, 7 * u);
    } else if (roll < 16) {
      // Bush: two rounded leafy blocks.
      ctx.fillStyle = o.bush || DEFAULT_OUTSIDE.bush;
      ctx.fillRect(screenX + 8 * u, screenY + 16 * u, 16 * u, 10 * u);
      ctx.fillStyle = o.bushLight || DEFAULT_OUTSIDE.bushLight;
      ctx.fillRect(screenX + 11 * u, screenY + 18 * u, 7 * u, 6 * u);
    }
  }

  static drawItem(ctx, item, screenX, screenY, size = CONFIG.GRID_SIZE, opts = {}) {
    const u = size / 32;
    const cx = screenX + size / 2;
    const cy = screenY + size / 2;

    // Authored tier prop first (keys/chests); procedural primitive otherwise.
    const propId = resolvePropId(item);
    const propDef = propId ? PROP_CATALOG[propId] : null;
    if (propDef) {
      // A ground prop may declare a presentation scale (keys
      // render at half the tile); `drawSize` drives the integer pixel scale.
      const groundScale = Number(propDef.groundScale);
      const drawSize = Number.isFinite(groundScale) && groundScale > 0
        ? Math.max(1, Math.round(size * groundScale))
        : size;
      const scale = Math.max(1, Math.floor(drawSize / (propDef.native?.w || SPRITE_NATIVE)));
      const nw = (propDef.native?.w || SPRITE_NATIVE) * scale;
      const nh = (propDef.native?.h || SPRITE_NATIVE) * scale;
      const dx = Math.round(screenX + (size - nw) / 2);
      const dy = Math.round(screenY + (size - nh) / 2);
      const frameId = item.type === 'chest' ? (opts.open || item.opened ? 'open' : 'closed') : 'icon';
      if (drawPropFrame(ctx, propDef, frameId, dx, dy, drawSize)) {
        SpriteRenderer.drawItemQuantity(ctx, item, screenX, screenY, size);
        return;
      }
    }

    const renderer = ITEM_RENDERERS[item.item_id] || ITEM_RENDERERS[item.type] || ITEM_RENDERERS.default;
    renderer(ctx, cx, cy, u, item);
    SpriteRenderer.drawItemQuantity(ctx, item, screenX, screenY, size);
  }

  static drawItemQuantity(ctx, item, screenX, screenY, size) {
    const u = size / 32;
    if (!(item.quantity > 1)) return;
    ctx.fillStyle = '#000000';
    ctx.fillRect(screenX + size - 14 * u, screenY + size - 12 * u, 14 * u, 12 * u);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(9, 9 * u)}px monospace`;
    ctx.textAlign = 'right';
    ctx.fillText(`${item.quantity}`, screenX + size - 2 * u, screenY + size - 3 * u);
  }

  static scaleForSize(size = CONFIG.GRID_SIZE) {
    return Math.max(1, Math.floor(size / SPRITE_NATIVE));
  }

  /**
   * Draws a world chest at a tile, using the authored tier prop (`closed` or
   * `open` frame) resolved by `chestTier`, with a procedural fallback. Returns
   * true when a chest was drawn.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{tier?:string, opened?:boolean}} chest
   * @returns {boolean}
   */
  static drawChest(ctx, chest, screenX, screenY, size = CONFIG.GRID_SIZE) {
    if (!chest) return false;
    const opened = chest.opened === true;
    const propId = resolvePropId({ type: 'chest', chestTier: chest.tier, tier: chest.tier });
    const def = propId ? PROP_CATALOG[propId] : null;
    const frame = opened ? 'open' : 'closed';
    if (drawPropFrame(ctx, def, frame, screenX, screenY, size)) {
      if (opened) SpriteRenderer._applySpentChestLook(ctx, screenX, screenY, size);
      return true;
    }

    // Procedural fallback: a tier-tinted chest body with a lid seam. A spent
    // chest drops all tier colouring for the drained grey palette.
    const u = size / 32;
    const tint = opened
      ? (CHESTS_CATALOG?.spentVisual?.tint || { light: '#565b64', dark: '#2b2d33' })
      : (TIER_TINTS[chest.tier] || TIER_TINTS.copper);
    ctx.fillStyle = tint.dark;
    ctx.fillRect(screenX + 7 * u, screenY + 10 * u, 18 * u, 14 * u);
    ctx.fillStyle = tint.light;
    ctx.fillRect(screenX + 9 * u, screenY + 12 * u, 14 * u, 10 * u);
    ctx.fillStyle = tint.dark;
    ctx.fillRect(screenX + 7 * u, screenY + 15 * u, 18 * u, 2 * u);
    if (opened) SpriteRenderer._applySpentChestLook(ctx, screenX, screenY, size);
    return true;
  }

  /**
   * Drains the colour out of an opened chest: a translucent grey wash plus a
   * couple of dust specks so a spent chest can never be mistaken for an
   * unopened silver one. Colors come from `chests.json`.
   */
  static _applySpentChestLook(ctx, screenX, screenY, size) {
    const spent = CHESTS_CATALOG?.spentVisual || {};
    const u = size / 32;
    ctx.save();
    ctx.fillStyle = spent.overlay || 'rgba(30, 32, 38, 0.62)';
    ctx.fillRect(screenX + 5 * u, screenY + 8 * u, 22 * u, 17 * u);
    ctx.fillStyle = spent.accent || '#6b7280';
    ctx.fillRect(screenX + 9 * u, screenY + 14 * u, 2 * u, 2 * u);
    ctx.fillRect(screenX + 17 * u, screenY + 18 * u, 2 * u, 2 * u);
    ctx.fillRect(screenX + 13 * u, screenY + 11 * u, 2 * u, 2 * u);
    ctx.restore();
  }

  /**
   * Draws a room prop (furniture or floor decor) at a tile, using the authored
   * `idle` frame resolved from `PROP_CATALOG[prop.propId]`. Furniture uses the
   * same tile-origin blit as chests (the authored art is bottom-aligned); decor
   * is authored at the tile origin. Falls back to a procedural rim-lit block so
   * the prop set can land incrementally (D4 §6.2/§6.4).
   * @param {CanvasRenderingContext2D} ctx
   * @param {{propId?:string, layer?:string, class?:string}} prop
   * @returns {boolean}
   */
  static drawProp(ctx, prop, screenX, screenY, size = CONFIG.GRID_SIZE) {
    if (!prop) return false;
    const def = prop.propId ? PROP_CATALOG[prop.propId] : null;
    if (drawPropFrame(ctx, def, 'idle', screenX, screenY, size)) return true;

    const u = size / 32;
    const decor = prop.layer === 'decor' || (def && def.class) === 'decor';
    ctx.fillStyle = decor ? 'rgba(107,68,35,0.55)' : '#6b4423';
    ctx.fillRect(screenX + 4 * u, screenY + 4 * u, size - 8 * u, size - 8 * u);
    if (!decor) {
      ctx.fillStyle = '#c98a4a';
      ctx.fillRect(screenX + 4 * u, screenY + 4 * u, size - 8 * u, 2 * u);
    }
    return true;
  }

  /**
   * Draw an actor from its sprite definition. Returns sprite geometry
   * `{ dx, dy, w, h, scale }` when a sprite was drawn, or `null` when the
   * caller should use the procedural fallback.
   */
  static drawActor(ctx, actor, screenX, screenY, opts = {}) {
    const id = resolveSpriteId(actor);
    if (!id) return null;
    const def = SPRITE_CATALOG[id];
    const size = opts.size || CONFIG.GRID_SIZE;
    const scale = SpriteRenderer.scaleForSize(size);
    if (!Number.isInteger(scale) || scale < 1) return null;

    const reduced = prefersReducedMotion();
    const anim = actor.anim || null;
    const { state, dir, frameId } = resolveSpriteFrame(def, anim);
    if (!frameId) return null;

    const nw = def.native.w * scale;
    const nh = def.native.h * scale;
    const dx = Math.round(screenX + (size - nw) / 2);
    const dy = screenY + size - nh;

    // Ground contact shadow (shared across all actors).
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(screenX + size / 2, screenY + size * 0.82, size / 3, size / 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const dim = typeof opts.dim === 'number' ? opts.dim : 1;
    ctx.save();
    if (dim !== 1) ctx.globalAlpha = Math.max(0, Math.min(1, dim));

    // Hit feedback: a static tint under reduced motion, otherwise the same tint
    // baked into the frame (no per-frame shake, no alpha edge fades).
    const tint = (!reduced && state === 'hit') ? { hex: HIT_TINT, amount: 0.35 } : null;

    const canvas = getFrameCanvas(def, frameId, scale, dir === 'side' && !!anim?.flipX, tint);
    if (canvas && typeof ctx.drawImage === 'function') {
      if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;
      ctx.drawImage(canvas, dx, dy);
    } else {
      const pixels = renderFramePixels(def, frameId, scale, dir === 'side' && !!anim?.flipX, tint);
      if (!pixels) { ctx.restore(); return null; }
      if (typeof ctx.fillRect === 'function') drawPixels(ctx, pixels, dx, dy, scale);
    }
    ctx.restore();

    return { dx, dy, w: nw, h: nh, scale, id };
  }

  static drawPlayer(ctx, player, screenX, screenY, size = CONFIG.GRID_SIZE) {
    const u = size / 32;
    const cx = screenX + size / 2;
    const cy = screenY + size / 2;

    const geo = SpriteRenderer.drawActor(ctx, player, screenX, screenY, { size });

    if (!geo) {
      // Procedural fallback (pre-sprite renderer).
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.ellipse(cx, cy + size / 3, size / 3, size / 6, 0, 0, Math.PI * 2);
      ctx.fill();

      const vocKey = player.vocation || 'magician';
      const vocData = VOCATIONS_CATALOG[vocKey] || VOCATIONS_CATALOG.magician;
      const theme = vocData.renderTheme || { primary: '#5c2d91', accent: '#ffd700', secondary: '#7a3cb8' };

      ctx.fillStyle = theme.primary;
      ctx.beginPath();
      ctx.moveTo(cx - 8 * u, cy + 12 * u);
      ctx.lineTo(cx + 8 * u, cy + 12 * u);
      ctx.lineTo(cx + 6 * u, cy - 4 * u);
      ctx.lineTo(cx - 6 * u, cy - 4 * u);
      ctx.closePath();
      ctx.fill();

      if (vocKey === 'paladin') {
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 2 * u;
        ctx.beginPath();
        ctx.ellipse(cx, cy - 14 * u, 6 * u, 2 * u, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 1 * u;
        ctx.stroke();
      }

      ctx.fillStyle = theme.secondary;
      ctx.beginPath();
      ctx.arc(cx, cy - 6 * u, 6 * u, 0, Math.PI * 2);
      ctx.fill();

      const eyeColor = vocData.eyeColor || '#ffffff';
      SpriteRenderer.drawFacingEyes(ctx, cx, cy - 6 * u, player.facing, eyeColor, u);
    }

    // Paladin halo stays an effect, not baked into sprite pixels.
    if ((player.vocation || 'magician') === 'paladin') {
      const hy = geo ? geo.dy - 4 * geo.scale : cy - 14 * u;
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = Math.max(1, 2 * u);
      ctx.beginPath();
      ctx.ellipse(cx, hy, 6 * u, 2 * u, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  static drawMonster(ctx, monster, screenX, screenY, size = CONFIG.GRID_SIZE) {
    const u = size / 32;
    const cx = screenX + size / 2;
    const cy = screenY + size / 2;

    const isBoss = monster.isBoss || monster.type === 'abyssal_overlord';
    const geo = SpriteRenderer.drawActor(ctx, monster, screenX, screenY, {
      size,
      dim: monster._dim,
    });

    if (!geo) {
      const renderer = MONSTER_RENDERERS[monster.type] || (monster.isBoss ? MONSTER_RENDERERS.abyssal_overlord : MONSTER_RENDERERS.giant_rat);
      renderer(ctx, cx, cy, u, monster);
    }

    // Health Bar — anchored above the sprite box when a sprite is present.
    if (monster.hp < monster.max_hp) {
      const scale = geo ? geo.scale : 1;
      const barW = (isBoss ? 32 : 24) * (geo ? scale : u);
      const barH = Math.max(2, 3 * (geo ? scale : u));
      const barX = (geo ? geo.dx + geo.w / 2 : cx) - barW / 2;
      const barY = geo ? geo.dy - 6 * scale : cy - 16 * u;
      const pct = Math.max(0, monster.hp / monster.max_hp);

      ctx.fillStyle = '#1e293b';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(barX, barY, barW * pct, barH);
    }
  }

  static drawFacingEyes(ctx, headX, headY, facing, eyeColor = '#44ccff', u = 1) {
    ctx.fillStyle = eyeColor;
    const { ox, oy } = FACING_EYE_OFFSETS[facing] || { ox: 0, oy: 0 };

    ctx.beginPath();
    ctx.arc(headX + ox * u - 2 * u, headY + oy * u, 1.2 * u, 0, Math.PI * 2);
    ctx.arc(headX + ox * u + 2 * u, headY + oy * u, 1.2 * u, 0, Math.PI * 2);
    ctx.fill();
  }
}

export { MONSTER_RENDERERS, TILE_RENDERERS, ITEM_RENDERERS };
