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
import { TILE_THEMES_CATALOG, VOCATIONS_CATALOG, CHESTS_CATALOG, MONSTERS_CATALOG, DEFAULT_TOWER_ID, getTowerDefinition, PROCEDURAL_SQUISH } from '../data/index.js';
import { SPRITE_CATALOG, PROP_CATALOG, PROP_IDS_BY_TIER } from '../assets/sprites/index.js';
import { dirFromFacing, resolveFrameIndex, squishScaleFor } from './animation-state.js';

// Minimal hairline guard so 1px strokes stay visible even if GRID_SIZE shrinks.
const HAIRLINE = (u) => Math.max(1, u);

export const SPRITE_NATIVE = 32;
export const OUTLINE_COLOR = '#0b0d12';
export const HIT_TINT = '#ff4d4d';
export const TOWER_LEVEL_COUNT = 5;

/**
 * Data-driven ground-shadow style defaults (art-direction.md §7, LIV-120). A
 * sprite def may override any field via `groundShadow`; the renderer derives the
 * shadow from the actor's own per-frame alpha mask, so no separate shadow art is
 * authored. Used by Tier A and Tier B alike; the procedural fallback uses
 * `shape:"ellipse"` when no frame mask exists.
 */
export const GROUND_SHADOW_DEFAULTS = {
  enabled: true,
  shape: 'silhouette',
  color: '#0a0d16',
  alpha: 0.45,
  squashY: 0.34,
  offset: { x: 0.05, y: 0.02 },
};

/** Resolves a def's ground-shadow style over the shared defaults (never throws). */
export function groundShadowStyle(def) {
  const d = GROUND_SHADOW_DEFAULTS;
  const s = (def && def.groundShadow) || {};
  const off = s.offset || d.offset;
  return {
    enabled: s.enabled !== false,
    shape: s.shape || d.shape,
    color: s.color || d.color,
    alpha: Number.isFinite(Number(s.alpha)) ? Number(s.alpha) : d.alpha,
    squashY: Number.isFinite(Number(s.squashY)) ? Number(s.squashY) : d.squashY,
    offset: {
      x: Number.isFinite(Number(off.x)) ? Number(off.x) : d.offset.x,
      y: Number.isFinite(Number(off.y)) ? Number(off.y) : d.offset.y,
    },
  };
}

/**
 * The atomic native tile size of a def, in native px. A single-tile def's atomic
 * tile is its whole canvas (`native.w`); a multi-tile def's is `native.w / tiles.w`
 * (e.g. a 2×1 net authored 128×64 has a 64 px atomic tile, N64). This is what the
 * native-aware display scale divides the display tile by.
 */
export function atomicNative(def) {
  const nw = (def && def.native && def.native.w) || SPRITE_NATIVE;
  const tw = def && def.tiles && def.tiles.w;
  if (Number.isFinite(tw) && tw > 0) return nw / tw;
  return nw;
}

/**
 * Default display box for 3D-baked humanoid actors (LIV-142), expressed in px at
 * the default 64 px tile. A baked actor renders LARGER than its tile — 72x96 —
 * and is centre-bottom aligned, so a character nearer the camera overlaps
 * (occludes) the one behind it instead of sitting strictly side-by-side. A def
 * may override the box with `renderBox: { w, h }`; hand-authored (non-3D) actors
 * are untouched and keep their integer tile scale.
 */
export const HUMANOID_RENDER_BOX = Object.freeze({ w: 72, h: 96 });

/** Reference tile the humanoid box is authored against (the default GRID_SIZE). */
const HUMANOID_BOX_REF_TILE = 64;

/**
 * Resolves an actor def's display box, or null when it keeps the tile scale.
 * Only 3D-baked single-tile actor defs (vocations, NPCs, opponents) opt in.
 * @returns {{w:number,h:number}|null}
 */
export function actorRenderBox(def, size = CONFIG.GRID_SIZE) {
  if (!def || def.baked3d !== true || def.tiles) return null;
  const rb = def.renderBox;
  const bw = rb && Number(rb.w) > 0 ? Number(rb.w) : HUMANOID_RENDER_BOX.w;
  const bh = rb && Number(rb.h) > 0 ? Number(rb.h) : HUMANOID_RENDER_BOX.h;
  return {
    w: Math.round((size * bw) / HUMANOID_BOX_REF_TILE),
    h: Math.round((size * bh) / HUMANOID_BOX_REF_TILE),
  };
}

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
 * Resolves the tile theme for an overworld scene: `tile_themes.json` stores
 * scene palettes at the root keyed by theme id (`island_dawnreach`,
 * `town_havenreach`), outside the tower `levels` scan. Falls back to the root
 * theme when the id is unknown.
 * @param {string} themeId
 * @returns {object}
 */
export function sceneTheme(themeId) {
  const scene = themeId ? TILE_THEMES_CATALOG[themeId] : null;
  return scene || TILE_THEMES_CATALOG;
}

/**
 * Deterministic tile-coordinate hash (docs/art-direction-tower.md §3.3).
 * Integer-exact across runs; never Math.random().
 */
function tileHash(x, y) {
  return (((x * 73856093) ^ (y * 19349663)) >>> 0);
}

/** Integer-lattice hash with full 32-bit avalanche (value-noise corner). */
function latticeHash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Tiles per lattice cell for the grass colour field (low-frequency). */
const GRASS_LATTICE = 8;

/**
 * Deterministic, allocation-free low-frequency value noise in [0, 1) sampled at
 * tile coordinates (LIV-71). Smoothstep-interpolated lattice corners give broad
 * rolling features (~8 tiles) with no per-pixel work, no transient allocation,
 * and no parity/checkerboard term. Same tile always yields the same value.
 * @param {number} x @param {number} y
 * @returns {number}
 */
export function grassNoiseAt(x, y) {
  const gx = Math.floor(x / GRASS_LATTICE);
  const gy = Math.floor(y / GRASS_LATTICE);
  const fx = (x - gx * GRASS_LATTICE) / GRASS_LATTICE;
  const fy = (y - gy * GRASS_LATTICE) / GRASS_LATTICE;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = latticeHash(gx, gy) / 4294967296;
  const n10 = latticeHash(gx + 1, gy) / 4294967296;
  const n01 = latticeHash(gx, gy + 1) / 4294967296;
  const n11 = latticeHash(gx + 1, gy + 1) / 4294967296;
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/**
 * Index into a data-driven grass `shades` ramp for a tile (LIV-71). Replaces the
 * old `h % 2` fill/alt parity checkerboard with a smooth, deterministic blend of
 * the palette greens. Pure integer math, allocation-free (returns an index only).
 * @param {number} x @param {number} y
 * @param {number} count - number of authored shades
 * @returns {number}
 */
export function grassShadeIndex(x, y, count) {
  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n <= 1) return 0;
  const v = grassNoiseAt(x, y);
  return Math.min(n - 1, Math.max(0, Math.floor(v * n)));
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
 * Wall-feature dispatch table (keyed by theme feature name). Each handler draws
 * a 32x32-native castle motif with integer fillRect only. Unknown names are a
 * safe no-op, so a theme may declare a feature before its renderer ships.
 */
const WALL_FEATURE_RENDERERS = {
  sconce: (ctx, screenX, screenY, u, f) => {
    fillNative(ctx, screenX, screenY, u, 24, 10, 4, 10, f.sconce);
    fillNative(ctx, screenX, screenY, u, 24, 6, 4, 4, f.flame);
    fillNative(ctx, screenX, screenY, u, 25, 7, 2, 2, '#ffffff');
  },
  banner: (ctx, screenX, screenY, u, f) => {
    fillNative(ctx, screenX, screenY, u, 15, 4, 1, 20, f.bannerTrim);
    fillNative(ctx, screenX, screenY, u, 10, 4, 12, 18, f.banner);
    fillNative(ctx, screenX, screenY, u, 10, 4, 12, 2, f.bannerTrim);
    fillNative(ctx, screenX, screenY, u, 10, 20, 12, 2, f.bannerTrim);
  },
  window: (ctx, screenX, screenY, u, f, theme) => {
    fillNative(ctx, screenX, screenY, u, 10, 4, 12, 18, theme.wall.topHighlight);
    fillNative(ctx, screenX, screenY, u, 12, 6, 8, 14, f.window);
    fillNative(ctx, screenX, screenY, u, 15, 6, 2, 14, theme.wall.gridLine);
  },
};

/**
 * Draws a 32x32-native castle motif on a wall tile using integer fillRect only.
 * @param {CanvasRenderingContext2D} ctx
 * @param {'sconce'|'banner'|'window'} name
 */
export function drawWallFeature(ctx, name, screenX, screenY, size, theme) {
  const renderer = WALL_FEATURE_RENDERERS[name];
  if (!renderer) return;
  renderer(ctx, screenX, screenY, size / 32, theme.features || {}, theme);
}

/**
 * Data-driven prop id for a ground item: keys resolve by `keyTier`, chests by
 * `chestTier` (falling back to `tier`). Type -> tier-map field is a dispatch
 * table, so a new prop type is a catalog + table entry, never a branch.
 * @returns {string|null}
 */
const PROP_TYPE_FIELD = {
  key: 'key',
  chest: 'chest',
};

export function resolvePropId(item) {
  if (!item) return null;
  const field = PROP_TYPE_FIELD[item.type];
  if (!field) return null;
  const tier = item.keyTier || item.chestTier || item.tier;
  const map = tier && PROP_IDS_BY_TIER[tier];
  return map ? map[field] || null : null;
}

/**
 * Blits an authored prop frame into a tile rect, falling back to a raw pixel
 * fill when no canvas is available (node). Returns true when a prop was drawn.
 */
function drawPropFrame(ctx, def, frameId, dx, dy, size) {
  if (!def || !def.frames || !def.frames[frameId] || !def.palette) return false;
  // LIV-115 (Fix 4) / LIV-121: derive the blit scale from the def's ATOMIC native
  // tile, not its canvas width. A multi-tile prop (e.g. a 2x1 net = 64 native px
  // per tile at N64) then blits its whole canvas at the engine SCALE instead of
  // collapsing to one tile; single-tile N32 props are unchanged (64 / 32 == 2),
  // and an N64 prop renders 1:1 (64 / 64 == 1).
  const scale = SpriteRenderer.scaleForSize(size, atomicNative(def));
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

/**
 * Resolves a prop frame's top-left blit origin in screen space from its
 * data-authored `placement.align` (LIV-142). `"bottom-center"` places the
 * sprite's bottom-centre on the placement square — the correct anchor for
 * multi-tile upright props (palms, rock piles) whose artwork extends above the
 * tile it stands on. The default keeps the legacy footprint top-left so
 * wide/floor pieces (nets, dock) are unchanged. Falls back safely for defs
 * without placement metadata.
 */
export function propBlitOrigin(def, screenX, screenY, size = CONFIG.GRID_SIZE) {
  const align = def && def.placement && def.placement.align;
  if (align !== 'bottom-center') return { dx: screenX, dy: screenY };
  const scale = SpriteRenderer.scaleForSize(size, atomicNative(def));
  const nw = ((def.native && def.native.w) || SPRITE_NATIVE) * scale;
  const nh = ((def.native && def.native.h) || SPRITE_NATIVE) * scale;
  return {
    dx: Math.round(screenX + (size - nw) / 2),
    dy: Math.round(screenY + size - nh),
  };
}

/**
 * Blits one authored frame into an arbitrary destination rect using the engine's
 * single integer SCALE (LIV-109). This is the sprite-backed building-silhouette
 * path: a multi-tile building sprite (native == tiles*32) fills the footprint
 * rect `dw x dh`, which is already `tiles * GRID_SIZE` because GRID_SIZE is the
 * 32px native tile at the shared 2x scale. No new placement model and no
 * per-tile slicing — one blitted bitmap, exactly like actor/prop sprites.
 * Returns false when the def/frame is missing or the destination is not a
 * uniform integer multiple of the native size (caller falls back).
 */
export function drawSpriteFrameInto(ctx, def, frameId, dx, dy, dw, dh) {
  if (!def || !def.frames || !def.frames[frameId] || !def.palette) return false;
  const nw = def.native?.w || SPRITE_NATIVE;
  const nh = def.native?.h || SPRITE_NATIVE;
  const sx = dw / nw, sy = dh / nh;
  if (!Number.isFinite(sx) || sx <= 0 || Math.abs(sx - Math.round(sx)) > 1e-6) return false;
  if (Math.abs(sy - Math.round(sx)) > 1e-6) return false;
  const scale = Math.round(sx);
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

/**
 * Per-tile palette lookup for the overworld scene tiles. Scene themes carry a
 * `tiles` map keyed by tile-type name (tile_themes.json `island_dawnreach` /
 * `town_havenreach`). Missing entries fall back to a neutral `{}` so a partial
 * theme never throws on the render path.
 */
function sceneTilePalette(theme, name) {
  return (theme && theme.tiles && theme.tiles[name]) || {};
}

/**
 * Resolves a door/gated-door palette across theme shapes. Tower themes author a
 * root `door` block; scene themes author per-tile palettes under `tiles`
 * (`GATED_DOOR` / `DOOR`). Each field falls back to the canonical literal, so a
 * scene theme that omits `door` can never throw on the render path (LIV-65).
 */
function doorPalette(theme, name) {
  const tower = (theme && theme.door) || {};
  const scene = sceneTilePalette(theme, name);
  return {
    fill: scene.fill || tower.fill || '#4a2f1b',
    border: scene.border || tower.border || '#2d1c10',
  };
}

const TILE_RENDERERS = {
  [TILE_TYPES.WALL]: (ctx, screenX, screenY, size, theme, opts = {}) => {    const u = size / 32;

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
    const p = doorPalette(theme, 'DOOR');

    ctx.fillStyle = p.fill;
    ctx.fillRect(screenX, screenY, size, size);
    ctx.strokeStyle = p.border;
    ctx.lineWidth = 2 * u;
    ctx.strokeRect(screenX + 2 * u, screenY + 2 * u, size - 4 * u, size - 4 * u);
  },
  [TILE_TYPES.GATED_DOOR]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const u = size / 32;
    const p = doorPalette(theme, 'GATED_DOOR');

    // Tier art: blit the authored closed/open gated-door prop (data-driven by
    // `tier`). Falls back to the procedural lock affordance when absent.
    const tierMap = opts.tier && PROP_IDS_BY_TIER[opts.tier];
    const propDef = tierMap ? PROP_CATALOG[tierMap.door] : null;
    if (drawPropFrame(ctx, propDef, opts.open ? 'open' : 'closed', screenX, screenY, size)) return;

    ctx.fillStyle = p.fill;
    ctx.fillRect(screenX, screenY, size, size);
    ctx.strokeStyle = p.border;
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
  // ---- Overworld scene tiles (LIV-59 P1) -------------------------------
  // Palettes come from the scene theme's `tiles` map; placement is a pure
  // integer hash. Integer fillRect only — no per-frame allocation.
  [TILE_TYPES.GRASS]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'GRASS');
    const u = size / 32;
    const x = opts.x || 0;
    const y = opts.y || 0;
    const h = tileHash(x, y);
    // Natural per-tile variation (LIV-71): a low-frequency value-noise field
    // indexes the authored `shades` ramp so neighbouring tiles roll between the
    // palette greens instead of alternating on a parity checkerboard. Falls back
    // to the flat fill when a theme authors no ramp.
    const shades = p.shades;
    if (Array.isArray(shades) && shades.length > 1) {
      ctx.fillStyle = shades[grassShadeIndex(x, y, shades.length)];
    } else {
      ctx.fillStyle = p.fill || '#2b4a24';
    }
    ctx.fillRect(screenX, screenY, size, size);
    ctx.fillStyle = p.blade || '#4a7d3f';
    ctx.fillRect(screenX + (6 + (h % 3) * 8) * u, screenY + (9 + ((h >> 3) % 3) * 7) * u, 2 * u, 6 * u);
    ctx.fillRect(screenX + (17 + ((h >> 5) % 3) * 4) * u, screenY + (16 + ((h >> 7) % 3) * 5) * u, 2 * u, 5 * u);
  },
  [TILE_TYPES.WATER]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'WATER');
    const u = size / 32;
    const h = tileHash(opts.x || 0, opts.y || 0);
    ctx.fillStyle = p.fill || '#14324a';
    ctx.fillRect(screenX, screenY, size, size);
    ctx.fillStyle = p.crest || '#2f6f9e';
    for (let i = 0; i < 2; i++) {
      const yy = (7 + i * 11 + (h % 6)) * u;
      ctx.fillRect(screenX + (4 + (h % 7)) * u, screenY + yy, 9 * u, 2 * u);
      ctx.fillRect(screenX + (18 + ((h >> 4) % 6)) * u, screenY + yy + 5 * u, 7 * u, 2 * u);
    }
    ctx.fillStyle = p.foam || '#8fd3ff';
    ctx.fillRect(screenX + (20 + ((h >> 2) % 5) * 2) * u, screenY + (20 + ((h >> 6) % 4)) * u, 3 * u, 2 * u);
  },
  [TILE_TYPES.SAND]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'SAND');
    const u = size / 32;
    const h = tileHash(opts.x || 0, opts.y || 0);
    ctx.fillStyle = p.fill || '#c9b177';
    ctx.fillRect(screenX, screenY, size, size);
    ctx.fillStyle = p.dark || '#a88f57';
    ctx.fillRect(screenX + (5 + (h % 5) * 3) * u, screenY + (8 + ((h >> 3) % 5) * 4) * u, 3 * u, 2 * u);
    ctx.fillStyle = p.shell || '#e6d6a8';
    ctx.fillRect(screenX + (14 + ((h >> 5) % 6) * 2) * u, screenY + (20 + ((h >> 7) % 3) * 3) * u, 2 * u, 2 * u);
  },
  [TILE_TYPES.PATH]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'PATH');
    const u = size / 32;
    const h = tileHash(opts.x || 0, opts.y || 0);
    ctx.fillStyle = p.fill || '#8a7250';
    ctx.fillRect(screenX, screenY, size, size);
    ctx.fillStyle = p.dark || '#6d5a3e';
    ctx.fillRect(screenX + (4 + (h % 4) * 5) * u, screenY + (6 + ((h >> 3) % 4) * 5) * u, 4 * u, 2 * u);
    ctx.fillRect(screenX + (16 + ((h >> 5) % 4) * 3) * u, screenY + (20 + ((h >> 7) % 3) * 3) * u, 3 * u, 2 * u);
    if (p.edge) {
      ctx.strokeStyle = p.edge;
      ctx.lineWidth = HAIRLINE(u);
      ctx.strokeRect(screenX + 0.5, screenY + 0.5, size - 1, size - 1);
    }
  },
  [TILE_TYPES.TREE]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'TREE');
    const outside = (theme && theme.outside) || DEFAULT_OUTSIDE;
    const u = size / 32;
    // LIV-142: a tree/prop tile stands on the SAME grass art as the surrounding
    // overworld (the LIV-71 shade ramp), never a bespoke `outside.grass` fill.
    // Delegating to the GRASS renderer keeps the two in lockstep for every theme,
    // so a prop-backed palm/rock sits directly on the shared gradient grass.
    TILE_RENDERERS[TILE_TYPES.GRASS](ctx, screenX, screenY, size, theme, opts);
    // LIV-137: a scene theme may declare the TREE tile's art is prop-backed
    // (`tiles.TREE.art === "prop"`). The 2D canopy is then suppressed and a
    // 3D-baked palm/rock prop is scattered on top by the scene composer, so the
    // Dawnreach Isle trees read as the same 3D decor as Havenreach. The tile
    // itself stays solid, so walkability/collision is unchanged.
    if (p.art === 'prop') return;
    ctx.fillStyle = p.trunk || outside.treeTrunk;
    ctx.fillRect(screenX + 14 * u, screenY + 18 * u, 5 * u, 11 * u);
    ctx.fillStyle = p.canopy || outside.treeCanopy;
    ctx.fillRect(screenX + 5 * u, screenY + 4 * u, 22 * u, 17 * u);
    ctx.fillStyle = p.canopyLight || outside.treeCanopyLight;
    ctx.fillRect(screenX + 9 * u, screenY + 7 * u, 9 * u, 8 * u);
  },
  [TILE_TYPES.BRIDGE]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'BRIDGE');
    const u = size / 32;
    ctx.fillStyle = p.plank || '#6b4a2a';
    ctx.fillRect(screenX, screenY, size, size);
    ctx.fillStyle = p.plankDark || '#523720';
    for (let i = 1; i < 4; i++) ctx.fillRect(screenX, screenY + i * 8 * u, size, u);
    ctx.fillStyle = p.rail || '#3f2a18';
    ctx.fillRect(screenX, screenY, size, 3 * u);
    ctx.fillRect(screenX, screenY + size - 3 * u, size, 3 * u);
  },
  // Fishing-village dock/jetty decking (LIV-100): timber planks on posts with a
  // seafoam lap on the waterward edge. Palette from the scene theme's
  // `tiles.DOCK`; placement is a pure integer hash — no per-frame allocation.
  [TILE_TYPES.DOCK]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'DOCK');
    const u = size / 32;
    const h = tileHash(opts.x || 0, opts.y || 0);
    ctx.fillStyle = p.plank || '#8a6a42';
    ctx.fillRect(screenX, screenY, size, size);
    // Plank seams across the deck.
    ctx.fillStyle = p.plankDark || '#634726';
    for (let i = 1; i < 4; i++) ctx.fillRect(screenX, screenY + i * 8 * u, size, HAIRLINE(u));
    // A plank-end notch, hash-placed for texture.
    ctx.fillRect(screenX + ((h % 5) * 5 + 3) * u, screenY, 2 * u, size);
    // Corner posts.
    ctx.fillStyle = p.post || '#4a3520';
    ctx.fillRect(screenX, screenY, 3 * u, 3 * u);
    ctx.fillRect(screenX + size - 3 * u, screenY + size - 3 * u, 3 * u, 3 * u);
    // Seafoam lap on the waterward edge.
    ctx.fillStyle = p.foam || '#cdeee6';
    ctx.fillRect(screenX, screenY + size - 2 * u, size, 2 * u);
    if (p.edge) {
      ctx.strokeStyle = p.edge;
      ctx.lineWidth = HAIRLINE(u);
      ctx.strokeRect(screenX + 0.5, screenY + 0.5, size - 1, size - 1);
    }
  },
  [TILE_TYPES.BUILDING_WALL]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'BUILDING_WALL');
    const u = size / 32;
    ctx.fillStyle = p.fill || '#7a6a55';
    ctx.fillRect(screenX, screenY, size, size);
    ctx.fillStyle = p.roof || '#a8452e';
    ctx.fillRect(screenX, screenY, size, 8 * u);
    ctx.fillStyle = p.roofPeak || '#7d2f1f';
    ctx.fillRect(screenX, screenY, size, 2 * u);
    ctx.fillStyle = p.trim || '#d9b45a';
    ctx.fillRect(screenX, screenY + 8 * u, size, u);
    ctx.fillStyle = p.shade || '#5f5242';
    ctx.fillRect(screenX, screenY + size - 3 * u, size, 3 * u);
    ctx.fillStyle = p.window || '#ffcf7a';
    ctx.fillRect(screenX + 11 * u, screenY + 14 * u, 10 * u, 7 * u);
  },
  [TILE_TYPES.DOORWAY]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'DOORWAY');
    const u = size / 32;
    ctx.fillStyle = p.glow || '#ffd48a';
    ctx.fillRect(screenX, screenY, size, size);
    ctx.fillStyle = p.frame || '#2f1e10';
    ctx.fillRect(screenX, screenY, 4 * u, size);
    ctx.fillRect(screenX + size - 4 * u, screenY, 4 * u, size);
    ctx.fillRect(screenX, screenY, size, 4 * u);
    ctx.fillStyle = p.fill || '#5a3a1e';
    ctx.fillRect(screenX + 8 * u, screenY + 6 * u, 16 * u, 26 * u);
    ctx.fillStyle = '#facc15';
    ctx.fillRect(screenX + 20 * u, screenY + 18 * u, 2 * u, 2 * u);
  },
  [TILE_TYPES.TOWER_ENTRANCE]: (ctx, screenX, screenY, size, theme, opts = {}) => {
    const p = sceneTilePalette(theme, 'TOWER_ENTRANCE');
    const u = size / 32;
    ctx.fillStyle = p.fill || '#6b6f7a';
    ctx.fillRect(screenX, screenY, size, size);
    ctx.fillStyle = p.shade || '#4d515c';
    ctx.fillRect(screenX, screenY + size - 4 * u, size, 4 * u);
    ctx.fillStyle = p.glow || '#ffd48a';
    ctx.beginPath();
    ctx.arc(screenX + size / 2, screenY + size / 2, 6 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.orb || '#ffe9a8';
    ctx.beginPath();
    ctx.arc(screenX + size / 2, screenY + size / 2, 3 * u, 0, Math.PI * 2);
    ctx.fill();
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
  mode: 'grass',
  grass: ['#1b2e1c', '#1f3420', '#172817', '#1d311e'],
  grassBlade: '#243d24',
  bush: '#2c4a2c',
  bushLight: '#3a5f3a',
  treeTrunk: '#33261a',
  treeCanopy: '#1f3a22',
  treeCanopyLight: '#2c5230',
  water: {
    deep: '#0d2233',
    fill: '#14324a',
    crest: '#2f6f9e',
    foam: '#8fd3ff',
  },
};

/**
 * Off-map grass backdrop (town / default). Resolved deterministically per tile:
 * a grass base with sparse, hash-placed bush or tree. Colors come from the
 * theme's `outside` block (`mode: 'grass'` or the default).
 */
function drawOutsideGrass(ctx, screenX, screenY, size, x, y, o) {
  const u = size / 32;
  const h = tileHash(x, y);
  // Low-frequency value-noise shade ramp (LIV-74): reuse the same field the
  // island GRASS tile draws with so the town/tower exterior grass rolls between
  // palette greens instead of alternating on a coordinate-hash checkerboard.
  // Integer index only; allocation-free and deterministic.
  const grassRamp = o.grass && o.grass.length ? o.grass : DEFAULT_OUTSIDE.grass;
  ctx.fillStyle = grassRamp[grassShadeIndex(x, y, grassRamp.length)];
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

/**
 * Off-map water backdrop for island scenes (LIV-68): the visible area beyond the
 * authored tilemap reads as open sea, never grass. Deterministic per tile from
 * the coordinate hash; colors come from the theme's `outside.water` palette.
 */
function drawOutsideWater(ctx, screenX, screenY, size, x, y, o) {
  const u = size / 32;
  const h = tileHash(x, y);
  const w = o.water || DEFAULT_OUTSIDE.water;

  ctx.fillStyle = w.deep || DEFAULT_OUTSIDE.water.deep;
  ctx.fillRect(screenX, screenY, size, size);

  // A lighter swell band, offset per tile so the sea reads as moving water.
  ctx.fillStyle = w.fill || DEFAULT_OUTSIDE.water.fill;
  ctx.fillRect(screenX, screenY + ((h >> 3) % 6) * u, size, 12 * u);

  ctx.fillStyle = w.crest || DEFAULT_OUTSIDE.water.crest;
  ctx.fillRect(screenX + ((h >> 2) % 10) * 2 * u, screenY + (7 + ((h >> 5) % 4) * 5) * u, 9 * u, 2 * u);
  ctx.fillRect(screenX + ((h >> 6) % 12) * 2 * u, screenY + (22 + ((h >> 4) % 2) * 4) * u, 6 * u, u);

  ctx.fillStyle = w.foam || DEFAULT_OUTSIDE.water.foam;
  ctx.fillRect(screenX + (5 + ((h >> 7) % 9) * 3) * u, screenY + (11 + ((h >> 9) % 9) * 2) * u, 2 * u, u);
}

/**
 * Off-map backdrop dispatch keyed by `outside.mode`. Adding a backdrop is a
 * catalog `mode` value plus (when visually unique) one entry here; an unknown
 * mode falls back to grass rather than throwing.
 */
const OUTSIDE_RENDERERS = {
  grass: drawOutsideGrass,
  water: drawOutsideWater,
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

/**
 * Shared cultist robe silhouette. Shadow vs elite differ only by palette, so
 * each `MONSTER_RENDERERS` entry selects its own colors at dispatch time instead
 * of branching on the live monster type inside one renderer.
 */
function drawCultist(ctx, cx, cy, u, robe, hood) {
  ctx.fillStyle = robe;
  ctx.beginPath();
  ctx.moveTo(cx - 7 * u, cy + 12 * u);
  ctx.lineTo(cx + 7 * u, cy + 12 * u);
  ctx.lineTo(cx + 4 * u, cy - 4 * u);
  ctx.lineTo(cx - 4 * u, cy - 4 * u);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = hood;
  ctx.beginPath();
  ctx.arc(cx, cy - 6 * u, 6 * u, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#a855f7';
  ctx.beginPath();
  ctx.arc(cx - 2 * u, cy - 6 * u, 1.5 * u, 0, Math.PI * 2);
  ctx.arc(cx + 2 * u, cy - 6 * u, 1.5 * u, 0, Math.PI * 2);
  ctx.fill();
}

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
  shadow_cultist: (ctx, cx, cy, u) => drawCultist(ctx, cx, cy, u, '#1e1b4b', '#312e81'),
  elite_cultist: (ctx, cx, cy, u) => drawCultist(ctx, cx, cy, u, '#3b0764', '#6b21a8'),
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

/**
 * Resolves a monster's data-driven visual overrides (LIV-71): a per-monster fur
 * tint and an optional crown overlay. Reads the live runtime monster first, then
 * falls back to the `monsters.json` catalog entry keyed by `type`, so every
 * spawn path (scene or tower) renders the same look with no per-type JS. Returns
 * null when the monster declares no overrides (the shared sprite stays as-is).
 * @param {object} monster
 * @returns {{ furTint?: object, crown?: { color?: string, accent?: string } }|null}
 */
export function monsterVisualFor(monster) {
  if (!monster) return null;
  if (monster.visual && typeof monster.visual === 'object') return monster.visual;
  const def = monster.type ? MONSTERS_CATALOG[monster.type] : null;
  return (def && def.visual) || null;
}

/**
 * Draws the gold crown overlay on top of a monster sprite (LIV-71). Pure
 * integer geometry from the crown's authored colours; a monster without a
 * `crown` visual never calls this, so shared sprites are unchanged.
 */
function drawMonsterCrown(ctx, cx, topY, u, crown) {
  if (!crown) return;
  const color = crown.color || '#ffd700';
  const accent = crown.accent || '#b8860b';
  const half = 7 * u;
  // Band.
  ctx.fillStyle = accent;
  ctx.fillRect(cx - half, topY, half * 2, 2 * u);
  // Three peaks.
  ctx.fillStyle = color;
  for (let i = -1; i <= 1; i++) {
    const px = cx + i * half * 0.62;
    ctx.beginPath();
    ctx.moveTo(px - 2.5 * u, topY);
    ctx.lineTo(px + 2.5 * u, topY);
    ctx.lineTo(px, topY - 5 * u);
    ctx.closePath();
    ctx.fill();
  }
  // Gems on the band.
  ctx.fillStyle = '#7a1010';
  ctx.fillRect(cx - 4 * u, topY + 0.5 * u, 1.5 * u, 1.5 * u);
  ctx.fillRect(cx + 2.5 * u, topY + 0.5 * u, 1.5 * u, 1.5 * u);
}

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

function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Transform one hex colour through a LIV-49 tint spec. Order is data-authored:
 * optional grayscale desaturation toward its Rec.709 luminance, then a `darken`
 * multiply, then a final `tint`/`amount` wash. A legacy `{ hex, amount }` spec
 * (hit feedback) performs only the wash, so this is backward compatible.
 * @param {string} hex
 * @param {{ grayscale?: boolean, desaturate?: number, luminance?: {r:number,g:number,b:number}, darken?: number, hex?: string, amount?: number }} tint
 * @returns {string}
 */
export function applyTintToHex(hex, tint) {
  if (!hex || !tint) return hex;
  let r;
  let g;
  let b;
  [r, g, b] = hexToRgb(hex);
  const lum = tint.luminance;
  const desat = Number(tint.desaturate);
  if (tint.grayscale && lum && Number.isFinite(desat) && desat > 0) {
    const y = r * (lum.r ?? 0.2126) + g * (lum.g ?? 0.7152) + b * (lum.b ?? 0.0722);
    const t = Math.max(0, Math.min(1, desat));
    r += (y - r) * t; g += (y - g) * t; b += (y - b) * t;
  }
  const darken = Number(tint.darken);
  if (Number.isFinite(darken) && darken > 0) {
    const f = 1 - Math.max(0, Math.min(1, darken));
    r *= f; g *= f; b *= f;
  }
  let out = rgbToHex(r, g, b);
  const amount = Number(tint.amount);
  if (tint.hex && Number.isFinite(amount) && amount > 0) out = mixHex(out, tint.hex, Math.min(1, amount));
  return out;
}

/**
 * Build a tinted palette copy for a sprite definition. The result drives
 * `parseFrame` exactly as the untinted palette does. Exported as the pure seam
 * the LIV-49 downed-grayscale tests exercise.
 * @param {Record<string, string>} palette
 * @param {object} tint
 * @returns {Record<string, string|null>}
 */
export function applyTintToPalette(palette, tint) {
  const out = {};
  for (const [k, v] of Object.entries(palette || {})) out[k] = v ? applyTintToHex(v, tint) : null;
  return out;
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

/** Stable cache key for a tint spec (legacy wash + LIV-49 grayscale pipeline). */
function tintCacheKey(tint) {
  if (!tint) return '';
  const lum = tint.luminance;
  return [
    tint.hex || '', tint.amount ?? '',
    tint.grayscale ? 1 : 0, tint.desaturate ?? '', tint.darken ?? '',
    lum ? `${lum.r ?? ''},${lum.g ?? ''},${lum.b ?? ''}` : '',
  ].join('~');
}

export function resolveSpriteId(actor) {
  if (!actor) return null;
  // LIV-81: an NPC's own `npcSpriteId` wins over the shared vocation fallback.
  // An unknown/missing `npcSpriteId` simply falls through to `spriteId`, so the
  // migration is safe before every bespoke NPC asset has landed. Data-driven:
  // no per-NPC branch, just a precedence list.
  const candidates = [actor.npcSpriteId, actor.spriteId, actor.vocation, actor.type, actor.id];
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
  const palette = tint ? applyTintToPalette(def.palette, tint) : def.palette;
  const pix = parseFrame(rows, palette);
  // LIV-115 (Fix 1): a 3D-baked (Tier B) def opts out of the outline pass
  // (`outline:false`, emitted by the bake). Its colours end naturally at the
  // silhouette; Tier A flat sprites keep the 1px outline unchanged.
  const outlined = def.outline === false ? pix : applyOutline(pix, def.palette['0'] || OUTLINE_COLOR);
  return scalePixels(outlined, scale, flipX);
}

function getFrameCanvas(def, frameId, scale, flipX, tint) {
  const key = `${def.id}|${frameId}|${scale}|${flipX ? 1 : 0}|${tintCacheKey(tint)}`;
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

/* ---- Per-frame silhouette ground shadow (art-direction.md §7, LIV-121) ---- */

const _shadowCache = new Map();

/**
 * Builds the native-resolution squashed ground-shadow mask for one frame: the
 * frame's own opaque pixels compressed vertically about the bottom (ground) edge
 * by `style.squashY`, tinted to `style.color`. The result stays in the def's
 * native space (bottom row == ground edge); `renderShadowPixels` then applies the
 * display scale + mirror. Pure + deterministic (unit-testable). Returns
 * `{ w, h, data }` or null when the frame is missing.
 */
export function buildShadowMask(def, frameId, style = groundShadowStyle(def)) {
  const rows = def && def.frames && def.frames[frameId];
  if (!rows) return null;
  const src = parseFrame(rows, def.palette);
  const { w, h, data } = src;
  if (w <= 0 || h <= 0) return null;
  const squash = Math.max(0.01, Math.min(1, style.squashY));
  const bandH = Math.max(1, Math.round(h * squash));
  const base = h - 1;
  const [sr, sg, sb] = hexToRgb(style.color);
  const shadow = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const rel = h <= 1 ? 0 : y / (h - 1);
    const ny = base - Math.round((1 - rel) * (bandH - 1));
    const drow = ny * w * 4;
    const srow = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[srow + x * 4 + 3] === 0) continue;
      const di = drow + x * 4;
      shadow[di] = sr; shadow[di + 1] = sg; shadow[di + 2] = sb; shadow[di + 3] = 255;
    }
  }
  return { w, h, data: shadow };
}

/** Scales + mirrors a native shadow mask to the sprite's display canvas space. */
function renderShadowPixels(def, frameId, scale, flipX, style) {
  const mask = buildShadowMask(def, frameId, style);
  if (!mask) return null;
  return scalePixels(mask, scale, flipX);
}

function getShadowCanvas(def, frameId, scale, flipX, style) {
  const key = `shadow|${def.id}|${frameId}|${scale}|${flipX ? 1 : 0}|${style.color}|${style.squashY}`;
  if (_shadowCache.has(key)) return _shadowCache.get(key);
  const pixels = renderShadowPixels(def, frameId, scale, flipX, style);
  if (!pixels) { _shadowCache.set(key, null); return null; }
  const canvas = createCanvas(pixels.w, pixels.h);
  if (!canvas) { _shadowCache.set(key, null); return null; }
  const cctx = canvas.getContext('2d');
  if (!cctx) { _shadowCache.set(key, null); return null; }
  const img = cctx.createImageData(pixels.w, pixels.h);
  img.data.set(pixels.data);
  cctx.putImageData(img, 0, 0);
  _shadowCache.set(key, canvas);
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
   * Draws the backdrop that sits outside the authored tilemap. The fill is
   * theme/scene-driven via `theme.outside.mode`: islands render open **water**
   * so the visible area beyond the shore never reads as grass, while towns and
   * unthemed scenes keep the procedural grass nature (LIV-68). Tiles are
   * resolved deterministically from their coordinates. Falls back to grass on an
   * unknown/missing mode so a partial theme can never black the screen.
   * @param {number} x @param {number} y - world tile coordinates (may be negative)
   */
  static drawOutside(ctx, screenX, screenY, size = CONFIG.GRID_SIZE, x = 0, y = 0, theme = {}) {
    const o = (theme && theme.outside) || DEFAULT_OUTSIDE;
    const renderer = OUTSIDE_RENDERERS[o.mode] || OUTSIDE_RENDERERS[DEFAULT_OUTSIDE.mode];
    renderer(ctx, screenX, screenY, size, x, y, o);
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
      // Frame is chosen from the prop's authored frames, not the item type: a
      // prop with open/closed frames (chests) toggles on state; otherwise `icon`.
      const frames = propDef.frames || {};
      const hasToggleFrames = Boolean(frames.open || frames.closed);
      const frameId = hasToggleFrames ? ((opts.open || item.opened) ? 'open' : 'closed') : 'icon';
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

  /**
   * Native-aware display scale (art-direction.md §6, LIV-121): the largest integer
   * scale that fits the def's atomic native tile into the display tile. A 64-native
   * (N64, 3D-baked) sprite is 1:1 at the default 64 px tile; a 32-native (N32)
   * sprite keeps its ×2 path. `native` defaults to N32 so every legacy caller that
   * omits it is byte-for-byte unchanged.
   */
  static scaleForSize(size = CONFIG.GRID_SIZE, native = SPRITE_NATIVE) {
    const n = Number(native) || SPRITE_NATIVE;
    return Math.max(1, Math.floor(size / n));
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
   * frame resolved from `PROP_CATALOG[prop.propId]`. The frame is data-driven:
   * a scene prop may declare `frame` (e.g. a multi-facing fisher's net picks
   * `view_90`), defaulting to the flat `idle` art every existing prop uses.
   * Furniture uses the same tile-origin blit as chests (the authored art is
   * bottom-aligned); decor is authored at the tile origin. Falls back to a
   * procedural rim-lit block so the prop set can land incrementally (D4 §6.2/§6.4).
   * @param {CanvasRenderingContext2D} ctx
   * @param {{propId?:string, layer?:string, class?:string, frame?:string}} prop
   * @returns {boolean}
   */
  static drawProp(ctx, prop, screenX, screenY, size = CONFIG.GRID_SIZE) {
    if (!prop) return false;
    const def = prop.propId ? PROP_CATALOG[prop.propId] : null;
    const frameId = prop.frame || 'idle';
    const { dx, dy } = propBlitOrigin(def, screenX, screenY, size);
    if (drawPropFrame(ctx, def, frameId, dx, dy, size)) return true;

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
    // Native-aware: a 64-native (N64) sprite renders 1:1 at the default 64 px
    // tile; a 32-native (N32) sprite keeps its ×2 path (art-direction.md §6).
    const scale = SpriteRenderer.scaleForSize(size, def.native.w);
    if (!Number.isInteger(scale) || scale < 1) return null;

    const reduced = prefersReducedMotion();
    const anim = actor.anim || null;
    const { state, dir, frameId } = resolveSpriteFrame(def, anim);
    if (!frameId) return null;

    // LIV-142: a 3D-baked humanoid renders in a larger-than-tile box (72x96 at
    // the default tile), centre-bottom aligned to its tile. `null` keeps the
    // legacy tile-scale geometry for hand-authored actors.
    const box = actorRenderBox(def, size);
    const nw = box ? box.w : def.native.w * scale;
    const nh = box ? box.h : def.native.h * scale;
    const dx = Math.round(screenX + (size - nw) / 2);
    const dy = screenY + size - nh;

    const dim = typeof opts.dim === 'number' ? opts.dim : 1;
    ctx.save();
    // Preserve the caller's alpha when no dim is given (legacy behaviour); a dim
    // overrides it, exactly as before the shadow was added.
    const spriteAlpha = dim !== 1 ? Math.max(0, Math.min(1, dim)) : ctx.globalAlpha;
    if (dim !== 1) ctx.globalAlpha = spriteAlpha;

    // Hit feedback: a static tint under reduced motion, otherwise the same tint
    // baked into the frame (no per-frame shake, no alpha edge fades). An explicit
    // caller tint (the LIV-45/49 downed grey-out) wins and is baked the same way.
    // LIV-81: a bespoke NPC sprite already carries its own palette, so the
    // migration `renderTheme` tint is skipped once the NPC's own asset resolves.
    const bespoke = !!(actor.npcSpriteId && actor.npcSpriteId === id);
    const hitTint = (!reduced && state === 'hit') ? { hex: HIT_TINT, amount: 0.35 } : null;
    const tint = bespoke ? null : (opts.tint || hitTint);

    // LIV-49 on-back pose: rotate the baked frame about the tile centre. One
    // translate/rotate pair plus a pivot-relative blit keeps the per-frame path
    // allocation-free (no matrix objects).
    let drawX = dx;
    let drawY = dy;
    const rotDeg = Number(opts.rotationDeg);
    if (Number.isFinite(rotDeg) && rotDeg % 360 !== 0) {
      const pivotX = screenX + size / 2;
      const pivotY = screenY + size / 2;
      ctx.translate(pivotX, pivotY);
      ctx.rotate((rotDeg * Math.PI) / 180);
      drawX = dx - pivotX;
      drawY = dy - pivotY;
    }

    // Per-frame silhouette ground shadow (art-direction.md §7): the actor's own
    // alpha mask, squashed toward the ground edge and offset toward the key-light
    // bounce, drawn UNDER the sprite in the same layer. Data-driven style via
    // `def.groundShadow`; cached per (def, frame, scale, flip) so the hot path
    // stays allocation-free.
    const flip = dir === 'side' && !!anim?.flipX;
    const style = groundShadowStyle(def);
    if (style.enabled && typeof ctx.drawImage === 'function') {
      const shadow = getShadowCanvas(def, frameId, scale, flip, style);
      if (shadow) {
        const offNative = size / scale;
        const offX = Math.round(style.offset.x * offNative);
        const offY = Math.round(style.offset.y * offNative);
        ctx.globalAlpha = Math.max(0, Math.min(1, spriteAlpha * style.alpha));
        if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;
        // A larger-than-tile actor box scales the shadow mask to the same box.
        if (box) ctx.drawImage(shadow, drawX + offX, drawY + offY, nw, nh);
        else ctx.drawImage(shadow, drawX + offX, drawY + offY);
        ctx.globalAlpha = spriteAlpha;
      }
    }

    // LIV-140 procedural defeat squish: flatten the drawn frame toward its ground
    // point (bottom-centre of the sprite box) at draw time — never a re-bake. The
    // transform composes into the outer save/restore, so the caller's ctx is
    // untouched. Under reduced motion the squish snaps to its fully-flat pose
    // (a static defeated silhouette) rather than animating.
    if (Number.isFinite(Number(opts.squish)) && PROCEDURAL_SQUISH.enabled) {
      const { scaleX, scaleY } = squishScaleFor(reduced ? 1 : opts.squish, PROCEDURAL_SQUISH);
      const pivotX = drawX + nw / 2;
      const pivotY = drawY + nh;
      ctx.translate(pivotX, pivotY);
      ctx.scale(scaleX, scaleY);
      ctx.translate(-pivotX, -pivotY);
    }

    const canvas = getFrameCanvas(def, frameId, scale, flip, tint);
    if (canvas && typeof ctx.drawImage === 'function') {
      if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;
      if (box) ctx.drawImage(canvas, drawX, drawY, nw, nh);
      else ctx.drawImage(canvas, drawX, drawY);
    } else {
      const pixels = renderFramePixels(def, frameId, scale, flip, tint);
      if (!pixels) { ctx.restore(); return null; }
      if (typeof ctx.fillRect === 'function') drawPixels(ctx, pixels, drawX, drawY, scale);
    }
    ctx.restore();

    return { dx, dy, w: nw, h: nh, scale, id };
  }

  static drawPlayer(ctx, player, screenX, screenY, size = CONFIG.GRID_SIZE, opts = {}) {
    const u = size / 32;
    const cx = screenX + size / 2;
    const cy = screenY + size / 2;

    // `opts.dim` + `opts.tint` carry the LIV-45 downed grey-out; a downed body
    // projects no light, so its halo/glow is suppressed below.
    const geo = SpriteRenderer.drawActor(ctx, player, screenX, screenY, { size, ...opts });

    if (!geo) {
      // Procedural fallback (pre-sprite renderer). Routed through the same
      // ground-shadow style (art-direction.md §7.1.6) so tone/squash/offset match
      // the silhouette path; `shape:"ellipse"` when no frame mask exists.
      const style = groundShadowStyle(null);
      if (style.enabled) {
        const offX = style.offset.x * size;
        const offY = style.offset.y * size;
        const rx = 0.28 * size;
        const ry = 0.14 * size;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, style.alpha * (typeof opts.dim === 'number' ? opts.dim : 1)));
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.ellipse(cx + offX, cy + size / 2 - ry + offY, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

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

    // Paladin halo stays an effect, not baked into sprite pixels. A downed
    // member projects no light, so its halo is suppressed (LIV-45 readability).
    if (!opts.downed && (player.vocation || 'magician') === 'paladin') {
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
    return geo;
  }

  static drawMonster(ctx, monster, screenX, screenY, size = CONFIG.GRID_SIZE) {
    const u = size / 32;
    const cx = screenX + size / 2;
    const cy = screenY + size / 2;

    const isBoss = monster.isBoss === true;
    // Per-monster visual overrides (LIV-71): a data-driven fur tint replaces the
    // shared giant_rat look for named elites like The Gutter King; a crown
    // overlay is drawn above the sprite. Absent overrides leave the sprite intact.
    const visual = monsterVisualFor(monster);
    const furTint = visual && visual.furTint ? visual.furTint : null;
    const geo = SpriteRenderer.drawActor(ctx, monster, screenX, screenY, {
      size,
      dim: monster._dim,
      tint: furTint || undefined,
    });

    if (!geo) {
      const renderer = MONSTER_RENDERERS[monster.type] || (monster.isBoss ? MONSTER_RENDERERS.abyssal_overlord : MONSTER_RENDERERS.giant_rat);
      renderer(ctx, cx, cy, u, monster);
    }

    if (visual && visual.crown) {
      drawMonsterCrown(ctx, cx, (geo ? geo.dy : screenY) + 7 * u, u, visual.crown);
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
    return geo;
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
