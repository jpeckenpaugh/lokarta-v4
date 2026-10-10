/**
 * Lokarta: Come Into The Light - Viewport Canvas Renderer
 */

import { CONFIG, LightingSystem, TILE_TYPES, ReviveSystem, resolveTelegraphColor } from '../engine/index.js';
import { SpriteRenderer, themeForFloor, sceneTheme, drawSpriteFrameInto } from './sprite-renderer.js';
import { BUILDING_CATALOG } from '../assets/sprites/index.js';
import { UI_CATALOG, PARTY_AI_CATALOG } from '../data/index.js';
import { resolveEasing, prefersReducedMotion } from './swap-feedback.js';
import { tweenTileX, tweenTileY } from './actor-tween.js';

/** Static entity-bar token cache from `ui.json.entityBars` (D1 §3.2). */
const OUTLINE_COLOR = '#0b0d12';
const ENTITY_BARS = (() => {
  const b = UI_CATALOG?.entityBars || {};
  const lowPct = Number(b.lowHpPct);
  return {
    width: Number(b.widthPx) || 24,
    bossWidth: Number(b.bossWidthPx) || 32,
    height: Number(b.heightPx) || 3,
    gap: Number(b.gapPx) || 1,
    outline: Number(b.outlinePx) || 1,
    offset: Number(b.offsetAboveSpritePx) || 6,
    track: b.track || '#1e293b',
    hp: b.hpFill || '#ef4444',
    hpLow: b.hpFillLow || '#dc2626',
    mp: b.mpFill || '#3b82f6',
    lowHpPct: Number.isFinite(lowPct) && lowPct > 0 ? lowPct / 100 : 0.3,
    playerShowWhen: b.playerShowWhen || 'always',
    enemyShowWhen: b.enemyShowWhen || 'damaged',
  };
})();

/**
 * Cached presentation tokens for player status VFX: the silver Shock
 * Shield barrier and the Luminous Prayer healing orbs. Resolved once from
 * `ui.json.playerVfx` so the per-frame draw path allocates nothing.
 */
const PLAYER_VFX = (() => {
  const v = UI_CATALOG?.playerVfx || {};
  const s = v.shockShield || {};
  const p = v.luminousPrayer || {};
  const num = (val, fallback) => (Number.isFinite(Number(val)) ? Number(val) : fallback);
  return {
    shield: {
      color: s.color || '#e2e8f0',
      rimColor: s.rimColor || '#f8fafc',
      radiusScale: num(s.radiusScale, 0.62),
      lineWidthPx: num(s.lineWidthPx, 3),
      pulseHz: num(s.pulseHz, 1.4),
      baseAlpha: num(s.baseAlpha, 0.6),
      pulseAlpha: num(s.pulseAlpha, 0.3),
      fillAlpha: num(s.fillAlpha, 0.16),
    },
    prayer: {
      orbCount: Math.max(2, Math.floor(num(p.orbCount, 5))),
      orbRadiusPx: num(p.orbRadiusPx, 3.5),
      glowRadiusPx: num(p.glowRadiusPx, 9),
      orbitRadiusScale: num(p.orbitRadiusScale, 0.7),
      orbitHz: num(p.orbitHz, 0.9),
      bobScale: num(p.bobScale, 0.03),
      color: p.color || '#fde68a',
      coreColor: p.coreColor || '#fffbeb',
      fadeSec: num(p.fadeSec, 0.45),
    },
  };
})();

/**
 * Cached knockout/revive presentation tokens (LIV-45). Geometry/palette come
 * from `ui.json.knockout.visuals`; the E1 beacon's on/off, color and pulse come
 * from `party_ai.json.revive.callForHelp` (behavior source) so the world read
 * and the AI share one switch. Resolved once — the per-frame paths allocate
 * nothing.
 */
const KNOCKOUT = (() => {
  const v = UI_CATALOG?.knockout?.visuals || {};
  const d = v.downed || {};
  const b = v.beacon || {};
  const c = v.channel || {};
  const help = PARTY_AI_CATALOG?.revive?.callForHelp || {};
  const n = (val, fallback) => (Number.isFinite(Number(val)) ? Number(val) : fallback);
  return {
    downed: {
      tint: d.tint || '#4b5563',
      tintAmount: n(d.tintAmount, 0.35),
      grayscale: d.grayscale !== false,
      desaturate: n(d.desaturate, 0.92),
      luminance: d.luminance || { r: 0.2126, g: 0.7152, b: 0.0722 },
      darken: n(d.darken, 0.18),
      alpha: n(d.alpha, 0.9),
      rotationDeg: n(d.rotationDeg, 90),
      rotateOrigin: d.rotateOrigin || 'tileCenter',
    },
    beacon: {
      enabled: help.enabled !== false,
      color: help.color || '#fde68a',
      pulseHz: n(help.pulseHz, 1.2),
      ringMinTiles: n(b.ringMinTiles, 0.45),
      ringMaxTiles: n(b.ringMaxTiles, 1.7),
      lineWidthPx: n(b.lineWidthPx, 3),
      baseAlpha: n(b.baseAlpha, 0.75),
      pipSizeTiles: n(b.pipSizeTiles, 0.3),
    },
    channel: {
      color: c.color || '#fde68a',
      coreColor: c.coreColor || '#fffbeb',
      beamWidthPx: n(c.beamWidthPx, 4),
      tetherAlpha: n(c.tetherAlpha, 0.5),
      progressRadiusTiles: n(c.progressRadiusTiles, 0.42),
      progressLineWidthPx: n(c.progressLineWidthPx, 4),
    },
    // LIV-52 auto-revive countdown ring (ui.json.knockout.autoRevive). Data-only
    // geometry/palette; the remaining/total seconds come from the member fields
    // the engine stamps. Resolved once so the per-frame drain allocates nothing.
    autoRevive: (() => {
      const a = UI_CATALOG?.knockout?.autoRevive || {};
      const ring = a.ring || {};
      const num = a.numeric || {};
      const rm = a.reducedMotion || {};
      return {
        enabled: a.enabled !== false,
        radiusTiles: n(ring.radiusTiles, 0.6),
        lineWidthPx: n(ring.lineWidthPx, 4),
        trackColor: ring.trackColor || '#334155',
        trackAlpha: n(ring.trackAlpha, 0.85),
        sweepColor: ring.sweepColor || '#fde68a',
        sweepCoreColor: ring.sweepCoreColor || '#fffbeb',
        sweepAlpha: n(ring.sweepAlpha, 0.95),
        startAngleDeg: n(ring.startAngleDeg, -90),
        sweepDir: ring.sweepDir || 'clockwise',
        lineCap: ring.lineCap || 'round',
        tickMode: ring.tickMode || 'smooth',
        beatHz: n(ring.beatHz, 1.0),
        beatMinAlpha: n(ring.beatMinAlpha, 0.7),
        completeFlashMs: n(ring.completeFlashMs, 450),
        numeric: {
          show: num.show !== false,
          format: num.format || 'ceil',
          fontFamily: num.fontFamily || 'monospace',
          fontSizePx: n(num.fontSizePx, 16),
          fontWeight: n(num.fontWeight, 700),
          color: num.color || '#f8fafc',
          outlineColor: num.outlineColor || '#020617',
          outlineWidthPx: n(num.outlineWidthPx, 2),
          offsetBelowTiles: n(num.offsetBelowTiles, 0.72),
        },
        reducedMotion: {
          tickMode: rm.tickMode || 'step',
          beatHz: n(rm.beatHz, 0),
        },
      };
    })(),
  };
})();

/**
 * Frozen draw options for a downed body (LIV-49): near-full grayscale tint
 * (desaturate toward Rec.709 luminance, darken, then a cool wash) plus the
 * on-back rotation. Built once so the party render loop allocates nothing.
 */
const DOWNED_DRAW_OPTS = Object.freeze({
  downed: true,
  dim: KNOCKOUT.downed.alpha,
  rotationDeg: KNOCKOUT.downed.rotationDeg,
  rotateOrigin: KNOCKOUT.downed.rotateOrigin,
  tint: Object.freeze({
    grayscale: KNOCKOUT.downed.grayscale,
    desaturate: KNOCKOUT.downed.desaturate,
    luminance: KNOCKOUT.downed.luminance,
    darken: KNOCKOUT.downed.darken,
    hex: KNOCKOUT.downed.tint,
    amount: KNOCKOUT.downed.tintAmount,
  }),
});

/** The frozen downed-body draw options (pure test seam + renderer input). */
export function downedDrawOpts() {
  return DOWNED_DRAW_OPTS;
}

/** True when a party entry is downed (explicit state or a clamped-out HP). */
function isDownedEntry(entry) {
  if (!entry) return false;
  if (entry.combatState === 'downed' || entry.lifeState === 'downed') return true;
  return !(Number(entry.hp) > 0);
}

/** True when a party entry can act and light the way. */
function isLivingEntry(entry) {
  return Boolean(entry) && !isDownedEntry(entry);
}

/**
 * Painter's-order comparator for the shared actor pass (LIV-142). A larger
 * screen Y is nearer the camera and must draw last, so a character in front
 * occludes the one behind it. Module-level + pure so the per-frame sort
 * allocates nothing.
 */
function byActorDrawOrder(a, b) {
  return a._drawY - b._drawY;
}

/** True when a DOOR or GATED_DOOR tile sits within `radius` of (x, y). */
function isNearDoor(gridMap, x, y, radius) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (!gridMap.isInBounds(tx, ty)) continue;
      const type = gridMap.tiles[ty][tx].type;
      if (type === TILE_TYPES.DOOR || type === TILE_TYPES.GATED_DOOR) return true;
    }
  }
  return false;
}

/**
 * Presentation dispatch for catalog projectiles (LIV-2). A projectile resolves
 * through `renderKey`/`type`; unknown keys fall through to the generic
 * energy-trail renderer in `renderProjectiles`, so a new catalog attack needs
 * no renderer to function. Renderers are called with `this` bound to the
 * renderer instance (they read `this.cameraX` / `this.cameraY`).
 */
const PROJECTILE_RENDERERS = {
  telegraph(ctx, p) {
    const sw = CONFIG.GRID_SIZE;
    const cx = p.x * sw + sw / 2 - this.cameraX;
    const cy = p.y * sw + sw / 2 - this.cameraY;
    const radius = (p.radius || 1) * sw + sw / 2;
    const pulse = 0.4 + 0.28 * Math.sin((p.elapsedMs || 0) / 80);
    // I10: remap the authored telegraph colour through the active colour-blind
    // palette. A non-`none` mode also adds a dashed inner ring so shape, not
    // just hue, carries the threat cue.
    const colorBlind = this.colorBlindMode && this.colorBlindMode !== 'none';
    const color = resolveTelegraphColor(p.color || '#ef4444', colorBlind ? this.colorBlindMode : 'none');
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = Math.min(1, pulse + 0.35);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    if (colorBlind) {
      ctx.setLineDash([6, 5]);
      ctx.globalAlpha = Math.min(1, pulse + 0.2);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2, radius * 0.6), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  },
  aoe_burst(ctx, p) {
    const sw = CONFIG.GRID_SIZE;
    const cx = p.x * sw + sw / 2 - this.cameraX;
    const cy = p.y * sw + sw / 2 - this.cameraY;
    const progress = Math.min(1, (p.elapsedMs || 0) / (p.durationMs || 320));
    const radius = ((p.radius || 1) * sw + sw / 2) * (0.35 + 0.65 * progress);
    const burstColor = resolveTelegraphColor(p.color || '#ef4444', this.colorBlindMode || 'none');
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - progress);
    ctx.fillStyle = burstColor;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = Math.max(0, 0.9 - progress);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  },
};

/**
 * Per-building silhouette dispatch (LIV-100). A town building may declare a
 * `silhouette` in its catalog entry (towns.json); the lookup falls back to the
 * building `id`, so either keying works. Adding a silhouette is a catalog value
 * plus one entry here — never a per-building JS branch. A building with no
 * matching renderer simply keeps the generic tile look.
 *
 * Renderers receive `(ctx, building, left, top, width, height)` in screen space
 * for the building's footprint, so they can overlay an ark-hull roof ridge, a
 * steeple, etc. without touching per-tile wall drawing.
 */
const BUILDING_SILHOUETTE_RENDERERS = {
  // The ark-hull Longhouse: an inverted keel ridge spanning the footprint roof,
  // with exposed ribs. Colors are the coastal timber/driftwood palette.
  ark_hull(ctx, building, left, top, width, height) {
    const ridge = Math.min(height * 0.45, 28);
    const cx = left + width / 2;
    ctx.save();
    ctx.fillStyle = '#6b4a2a';
    ctx.beginPath();
    ctx.moveTo(left, top + ridge * 0.35);
    ctx.lineTo(left + width * 0.12, top - ridge);
    ctx.lineTo(cx, top - ridge * 1.25);
    ctx.lineTo(left + width * 0.88, top - ridge);
    ctx.lineTo(left + width, top + ridge * 0.35);
    ctx.lineTo(left + width, top + ridge * 0.35 + 3);
    ctx.lineTo(left, top + ridge * 0.35 + 3);
    ctx.closePath();
    ctx.fill();
    // Exposed ribs.
    ctx.strokeStyle = '#8a6a45';
    ctx.lineWidth = Math.max(1, width / 32);
    for (let i = 1; i < 6; i++) {
      const rx = left + (width * i) / 6;
      const ry = top - ridge * (1 - Math.abs(i - 3) / 4.5);
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx, top + ridge * 0.35 + 3);
      ctx.stroke();
    }
    ctx.restore();
  },
  // Tier B sprite-backed silhouette (LIV-109): blits a committed multi-tile
  // building sprite (native == tiles*32) into the building's footprint at the
  // engine's integer SCALE. The footprint rect already equals tiles * GRID_SIZE
  // (GRID_SIZE == 32 native px at 2x), so this needs no new placement model and
  // no per-tile slicing — one bitmap, exactly like actor/prop sprites. A missing
  // def/frame is a no-op so a partial catalog can never black the scene.
  //
  // LIV-110: the frame is data-driven via `placement.defaultFrame`, so the same
  // renderer serves every authored hut view/size (front, back, side, large)
  // without a per-view branch.
  spriteBuilding(ctx, building, left, top, width, height) {
    const def = BUILDING_CATALOG[building.silhouette] || BUILDING_CATALOG[building.id] || BUILDING_CATALOG.fishing_hut;
    if (!def) return;
    const frameId = (def.placement && def.placement.defaultFrame) || 'view_0';
    drawSpriteFrameInto(ctx, def, frameId, left, top, width, height);
  },
};
// Back-compat alias: the original single-hut key keeps dispatching to the shared
// sprite-building renderer.
BUILDING_SILHOUETTE_RENDERERS.fishing_hut = BUILDING_SILHOUETTE_RENDERERS.spriteBuilding;

export class CanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.cameraX = 0;
    this.cameraY = 0;
    this.tileSize = CONFIG.GRID_SIZE;
    // LIV-50 control-swap presentation: an optional SwapFeedback instance (set
    // by the app) and the in-flight camera glide state. Both start idle.
    this.swapFeedback = null;
    this.cameraGlide = null;
    // Reused actor draw list (LIV-142): the shared painter's-order pass sorts
    // monsters + NPCs + party + player by camera distance without allocating.
    this._actorDrawList = [];
  }

  /** Per-frame clock for camera-glide timing (overridable in tests). */
  _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /**
   * LIV-50: start a fluid camera glide to wherever `player` is. `durationMs` and
   * `easing` come from `ui.json.knockout.swap`; a non-positive duration (reduced
   * motion) leaves the camera snapping as before.
   */
  startCameraGlide(durationMs, easing, nowMs) {
    const d = Number(durationMs);
    if (!Number.isFinite(d) || d <= 0) { this.cameraGlide = null; return; }
    this.cameraGlide = {
      fromX: this.cameraX,
      fromY: this.cameraY,
      startMs: Number.isFinite(nowMs) ? nowMs : this._now(),
      durationMs: d,
      ease: resolveEasing(easing),
    };
  }

  /**
   * Sets the tile size used for draw and camera math (pixel-zoom option).
   * `auto` maps to the canonical 64 px tile.
   * @param {number} px
   * @returns {number} the applied tile size
   */
  setZoom(px) {
    const size = Number(px);
    if (!Number.isFinite(size) || size <= 0) return this.tileSize;
    this.tileSize = size;
    // Keep camera, projectile, and sprite math consistent with the chosen zoom.
    CONFIG.GRID_SIZE = size;
    return size;
  }

  resize() {
    if (!this.canvas) return;
    const parent = this.canvas.parentElement;
    if (parent) {
      this.canvas.width = parent.clientWidth;
      this.canvas.height = parent.clientHeight;
    }
  }

  updateCamera(player, width, height, nowMs = this._now()) {
    // LIV-139: follow the player's tweened (fractional) position so the world
    // glides with the sprite instead of jumping a whole tile per step.
    const targetX = tweenTileX(player) * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - width / 2;
    const targetY = tweenTileY(player) * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - height / 2;
    const g = this.cameraGlide;
    if (g) {
      const t = Math.max(0, Math.min(1, (nowMs - g.startMs) / g.durationMs));
      const e = g.ease(t);
      this.cameraX = Math.round(g.fromX + (targetX - g.fromX) * e);
      this.cameraY = Math.round(g.fromY + (targetY - g.fromY) * e);
      if (t >= 1) this.cameraGlide = null;
      return;
    }
    this.cameraX = Math.round(targetX);
    this.cameraY = Math.round(targetY);
  }

  render(
    gridMap,
    player,
    monsters,
    ambientLights,
    projectiles,
    floatingTexts,
    selectedMonsterId,
    particles = [],
    deathEffects = [],
    chests = [],
    props = [],
    party = []
  ) {
    if (!this.canvas || !this.ctx) return;
    const { width, height } = this.canvas;
    const ctx = this.ctx;
    const now = this._now();

    this.updateCamera(player, width, height, now);

    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, width, height);

    // Tile layer scans one tile beyond the viewport so the nature backdrop can be
    // drawn outside the tower footprint (negative / past-edge coordinates).
    const startTileX = Math.floor(this.cameraX / CONFIG.GRID_SIZE);
    const endTileX = Math.ceil((this.cameraX + width) / CONFIG.GRID_SIZE);
    const startTileY = Math.floor(this.cameraY / CONFIG.GRID_SIZE);
    const endTileY = Math.ceil((this.cameraY + height) / CONFIG.GRID_SIZE);
    // In-bounds bounds for entity layers (items/chests) that index the tile grid.
    const clampStartX = Math.max(0, startTileX);
    const clampEndX = Math.min(gridMap.width - 1, endTileX);
    const clampStartY = Math.max(0, startTileY);
    const clampEndY = Math.min(gridMap.height - 1, endTileY);

    // Resolve the tower floor theme once; per-level variation is data-driven.
    // Outdoors (island/town scenes) resolve their scene theme instead, and an
    // ambient lighting mode disables the unlit cull + fog mask (LIV-59 P1).
    const scene = this.scene || null;
    const ambient = Boolean(scene && scene.lighting === 'ambient');
    this._ambient = ambient;
    const theme = scene && scene.theme
      ? sceneTheme(scene.theme)
      : themeForFloor(player.current_floor || 1, player.towerId);
    const featureScan = !!(theme.decor && theme.decor.banner > 0);
    // Reused per-tile options object: no per-frame allocation in the tile loop.
    const tileOpts = {
      theme,
      x: 0,
      y: 0,
      tier: null,
      open: false,
      hasFloorBelow: false,
      adjacentFloor: false,
      nearDoor: false,
    };

    // 1. Tiles Layer
    for (let y = startTileY; y <= endTileY; y++) {
      for (let x = startTileX; x <= endTileX; x++) {
        const screenX = x * CONFIG.GRID_SIZE - this.cameraX;
        const screenY = y * CONFIG.GRID_SIZE - this.cameraY;

        // Outside the tower footprint: draw the nature backdrop.
        if (!gridMap.isInBounds(x, y)) {
          SpriteRenderer.drawOutside(ctx, screenX, screenY, CONFIG.GRID_SIZE, x, y, theme);
          continue;
        }

        const tile = gridMap.tiles[y][x];
        if (!tile.isLit && !ambient) continue;

        tileOpts.x = x;
        tileOpts.y = y;
        tileOpts.tier = tile.gateTier || null;
        tileOpts.open = !!tile.gateOpen;
        if (tile.type === TILE_TYPES.WALL) {
          tileOpts.hasFloorBelow = gridMap.isInBounds(x, y + 1) && gridMap.tiles[y + 1][x].type !== TILE_TYPES.WALL;
          tileOpts.adjacentFloor =
            tileOpts.hasFloorBelow ||
            (gridMap.isInBounds(x, y - 1) && gridMap.tiles[y - 1][x].type !== TILE_TYPES.WALL) ||
            (gridMap.isInBounds(x - 1, y) && gridMap.tiles[y][x - 1].type !== TILE_TYPES.WALL) ||
            (gridMap.isInBounds(x + 1, y) && gridMap.tiles[y][x + 1].type !== TILE_TYPES.WALL);
          tileOpts.nearDoor = featureScan ? isNearDoor(gridMap, x, y, 2) : false;
        }
        SpriteRenderer.drawTile(ctx, tile.type, screenX, screenY, CONFIG.GRID_SIZE, tileOpts);

        // Tower Gate: a gold arch marker on the arrival-room
        // tile that returns the player to Town when stepped on.
        if (tile.type === TILE_TYPES.TOWN_GATE) {
          const gx = screenX + CONFIG.GRID_SIZE / 2;
          const gy = screenY + CONFIG.GRID_SIZE / 2;
          ctx.fillStyle = 'rgba(229, 185, 92, 0.28)';
          ctx.fillRect(screenX + 4, screenY + 4, CONFIG.GRID_SIZE - 8, CONFIG.GRID_SIZE - 8);
          ctx.strokeStyle = '#e5b95c';
          ctx.lineWidth = 2;
          ctx.strokeRect(screenX + 6, screenY + 6, CONFIG.GRID_SIZE - 12, CONFIG.GRID_SIZE - 12);
          ctx.beginPath();
          ctx.arc(gx, screenY + CONFIG.GRID_SIZE * 0.6, CONFIG.GRID_SIZE * 0.22, Math.PI, 0);
          ctx.stroke();
          ctx.fillStyle = 'rgba(229, 185, 92, 0.9)';
          ctx.fillRect(gx - 2, gy - 4, 4, CONFIG.GRID_SIZE * 0.34);
        }

        // Healing fountain: a stone basin with an animated
        // water spout and droplets, replacing the old flat blue circle.
        if (tile.type === TILE_TYPES.SPRING) {
          const size = CONFIG.GRID_SIZE;
          const cx = screenX + size / 2;
          const cy = screenY + size * 0.62;
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          const phase = (now / 300) % 6.2831853;

          // Stone basin.
          ctx.fillStyle = '#4b5563';
          ctx.beginPath();
          ctx.ellipse(cx, cy, size * 0.36, size * 0.18, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#9ca3af';
          ctx.beginPath();
          ctx.ellipse(cx, cy - size * 0.02, size * 0.30, size * 0.14, 0, 0, Math.PI * 2);
          ctx.fill();

          // Water pool.
          ctx.fillStyle = 'rgba(56, 189, 248, 0.9)';
          ctx.beginPath();
          ctx.ellipse(cx, cy - size * 0.02, size * 0.24, size * 0.10, 0, 0, Math.PI * 2);
          ctx.fill();

          // Central spout with a gentle vertical bob.
          const bob = Math.sin(phase) * size * 0.04;
          ctx.fillStyle = 'rgba(125, 211, 252, 0.95)';
          ctx.fillRect(cx - size * 0.03, cy - size * 0.34 + bob, size * 0.06, size * 0.30);
          ctx.fillStyle = 'rgba(224, 242, 254, 0.95)';
          ctx.beginPath();
          ctx.arc(cx, cy - size * 0.36 + bob, size * 0.075, 0, Math.PI * 2);
          ctx.fill();

          // Two droplets arcing out of the spout.
          const dropY = cy - size * 0.30 + Math.cos(phase) * size * 0.06;
          ctx.fillStyle = 'rgba(191, 231, 255, 0.9)';
          ctx.fillRect(cx - size * 0.16, dropY, size * 0.03, size * 0.05);
          ctx.fillRect(cx + size * 0.13, dropY, size * 0.03, size * 0.05);
        }
      }
    }

    // 1a. Per-building silhouettes (LIV-100): overlays a catalog-declared
    //     building shape on its footprint (e.g. the ark-hull Longhouse). No-op
    //     for scenes with no silhouetted buildings, so tower/scene rendering is
    //     unchanged.
    this.renderBuildingSilhouettes(ctx);

    // 1a-2. Town return spot (LIV-75): a glowing ground teleporter back to the
    //       last-exited tower/floor. Data-placed; drawn only while the app
    //       exposes an active spot, so an empty town has no marker.
    if (this.returnSpot) this.drawReturnSpot(ctx, this.returnSpot);

    // 1b. Decor Layer (rugs): under ground items, so loot always draws on top.
    this.renderProps(ctx, props, 'decor', gridMap, clampStartX, clampEndX, clampStartY, clampEndY);

    // 2. Ground Items Layer
    for (let y = clampStartY; y <= clampEndY; y++) {
      for (let x = clampStartX; x <= clampEndX; x++) {
        const tile = gridMap.tiles[y][x];
        if ((!tile.isLit && !ambient) || tile.items.length === 0) continue;
        const screenX = x * CONFIG.GRID_SIZE - this.cameraX;
        const screenY = y * CONFIG.GRID_SIZE - this.cameraY;
        const topItem = tile.items[tile.items.length - 1];
        SpriteRenderer.drawItem(ctx, topItem, screenX, screenY);
      }
    }

    // 2b. Chests Layer: one per room, visible on first lighting, culled when
    //     unlit (chests are world entities, not tile items).
    for (const chest of chests) {
      if (!chest) continue;
      if (chest.x < clampStartX || chest.x > clampEndX || chest.y < clampStartY || chest.y > clampEndY) continue;
      const tile = gridMap.tiles[chest.y]?.[chest.x];
      if (!tile || (!tile.isLit && !ambient)) continue;
      SpriteRenderer.drawChest(
        ctx,
        chest,
        chest.x * CONFIG.GRID_SIZE - this.cameraX,
        chest.y * CONFIG.GRID_SIZE - this.cameraY
      );
    }

    // 2c. Furniture Props Layer: behind actors (a walk-over table is honestly
    //     drawn under the player), culled on unlit tiles like chests.
    this.renderProps(ctx, props, 'prop', gridMap, clampStartX, clampEndX, clampStartY, clampEndY);

    // 3. World light: fog hides unexplored space, not visible enemies. Actors    // and projectiles therefore draw after the mask (docs/art-direction.md §6.3).
    // Ambient outdoor scenes are fully lit — skip the fog mask entirely.
    if (!ambient) {
      this.renderLightMask(ctx, gridMap, player, ambientLights, width, height, projectiles);
    }

    // 4. Transient death effects (actors playing their collapse animation).
    //    LIV-140: an opponent with no authored death frames passes a procedural
    //    squish progress (0..1 over `totalMs`) so the existing artwork flattens
    //    toward the ground at draw time instead of snapping out.
    for (const fx of deathEffects) {
      if (!fx) continue;
      const total = Number(fx.totalMs) || 0;
      const squish = fx.procedural && total > 0
        ? Math.max(0, Math.min(1, (fx.anim?.elapsedMs || 0) / total))
        : undefined;
      SpriteRenderer.drawActor(
        ctx,
        { spriteId: fx.spriteId, vocation: fx.vocation, type: fx.type, facing: fx.facing || 'down', anim: fx.anim },
        fx.x * CONFIG.GRID_SIZE - this.cameraX,
        fx.y * CONFIG.GRID_SIZE - this.cameraY,
        { size: CONFIG.GRID_SIZE, squish }
      );
    }

    // 5. Actors Layer — monsters + NPCs + party + player in ONE painter's-order
    //    pass (LIV-142). Humanoid sprites render larger than their tile (72x96),
    //    so a character nearer the camera must overlap the one behind it: the
    //    actor with the greater screen Y draws last. This replaces the old fixed
    //    monster -> npc -> party -> player stacking, where the player was always
    //    on top regardless of position. The reused list + module-level comparator
    //    keep the per-frame path allocation-free.
    const playerRadius = Math.max(1, LightingSystem.computePlayerRadius(player));
    const playerScreenX = tweenTileX(player) * CONFIG.GRID_SIZE - this.cameraX;
    const playerScreenY = tweenTileY(player) * CONFIG.GRID_SIZE - this.cameraY;
    const npcs = this.npcs;
    const order = this._actorDrawList;
    order.length = 0;

    for (const monster of monsters) {
      if (!(monster && monster.visible && monster.hp > 0)) continue;
      monster._drawKind = 'monster';
      monster._drawY = tweenTileY(monster);
      order.push(monster);
    }
    if (Array.isArray(npcs)) {
      for (const npc of npcs) {
        if (!npc) continue;
        npc._drawKind = 'npc';
        npc._drawY = tweenTileY(npc);
        order.push(npc);
      }
    }
    if (Array.isArray(party) && party.length > 1) {
      for (const member of party) {
        if (!member) continue;
        // The live active member is the top-level player, so its stale `party`
        // mirror is skipped (matched by memberId).
        if (member.memberId && member.memberId === player.activeMemberId) continue;
        member._drawKind = 'party';
        member._drawY = tweenTileY(member);
        order.push(member);
      }
    }
    player._drawKind = 'player';
    player._drawY = tweenTileY(player);
    order.push(player);
    order.sort(byActorDrawOrder);

    for (const actor of order) {
      const screenX = tweenTileX(actor) * CONFIG.GRID_SIZE - this.cameraX;
      const screenY = tweenTileY(actor) * CONFIG.GRID_SIZE - this.cameraY;
      switch (actor._drawKind) {
        case 'monster': {
          // Distance-dimmed so silhouettes survive the fog edge.
          const isBoss = actor.isBoss === true;
          const d = Math.hypot(actor.x - player.x, actor.y - player.y) / playerRadius;
          actor._dim = isBoss ? 1 : Math.max(0.65, Math.min(1, 1 - 0.35 * d));
          const geo = SpriteRenderer.drawMonster(ctx, actor, screenX, screenY);

          // Enemy HP bar only when damaged, selected, or a boss (D1 §3.1).
          const damaged = actor.hp < actor.max_hp;
          const selected = selectedMonsterId === actor.id;
          if (isBoss || damaged || selected) {
            this.drawActorBars(ctx, actor, screenX, screenY, false, isBoss ? ENTITY_BARS.bossWidth : ENTITY_BARS.width, geo && geo.dy);
          }
          if (selected) {
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(
              screenX + CONFIG.GRID_SIZE / 2,
              screenY + CONFIG.GRID_SIZE / 2,
              CONFIG.GRID_SIZE / 2 + 3,
              0,
              Math.PI * 2
            );
            ctx.stroke();
          }
          break;
        }
        case 'npc': {
          // Scene-only, culled off-screen; the shared actor pipeline carries the
          // catalog `renderTheme` tint so no bespoke art is required (LIV-60 P2).
          if (screenX < -CONFIG.GRID_SIZE || screenY < -CONFIG.GRID_SIZE
            || screenX > width || screenY > height) break;
          const geo = SpriteRenderer.drawActor(ctx, actor, screenX, screenY, {
            size: CONFIG.GRID_SIZE,
            tint: actor.renderTheme || undefined,
          });
          // Quest marker (LIV-55 P5): `available` (!) / `turnin` (?). Anchored
          // above the sprite box so it clears the taller LIV-142 humanoid render.
          if (actor.questMarker) {
            this.drawQuestMarker(
              ctx,
              actor.questMarker,
              screenX + CONFIG.GRID_SIZE / 2,
              (geo ? geo.dy : screenY) - 4
            );
          }
          break;
        }
        case 'party': {
          // 5b. Party Allies Layer (LIV-13/WS4): a downed body (LIV-45) stays on
          // the board, greyed + darkened, with no light and no HP bar — it is a
          // rescue target, not a combatant.
          if (isDownedEntry(actor)) {
            SpriteRenderer.drawPlayer(ctx, actor, screenX, screenY, CONFIG.GRID_SIZE, DOWNED_DRAW_OPTS);
          } else {
            const geo = SpriteRenderer.drawPlayer(ctx, actor, screenX, screenY);
            this.drawActorBars(ctx, actor, screenX, screenY, true, ENTITY_BARS.width, geo && geo.dy);
          }
          break;
        }
        case 'player': {
          const geo = SpriteRenderer.drawPlayer(ctx, actor, screenX, screenY);
          this.drawActorBars(ctx, actor, screenX, screenY, true, ENTITY_BARS.width, geo && geo.dy);
          break;
        }
      }
    }

    // 6b. Player status VFX: Shock Shield silver barrier and Luminous Prayer
    //     healing orbs. Drawn after the actor pass so both read clearly over the
    //     lighting and any actor in front.
    this.renderPlayerVfx(ctx, player, playerScreenX, playerScreenY);

    // 6b-2. Interaction prompt (LIV-60 P2): a small label above the NPC / world
    //       object the player can talk to or examine right now.
    if (this.interactPrompt) this.renderInteractPrompt(ctx, this.interactPrompt);

    // 6c. Knockout VFX (LIV-45): the E1 "Call for Help" beacon over every downed
    //     body and the revive channel tether/progress arc. Drawn last so the
    //     rescue read survives the fog, bars and player sprite.
    this.renderKnockoutVfx(ctx, player, party, now);

    // 6d. Control-swap feedback (LIV-50): the fluid position locator plus the
    //     destination activity flash after a KO handoff / manual cycle.
    this.renderSwapVfx(ctx, this.swapFeedback, now);

    // 7. Projectiles & Impact Particles (after the mask, so they read at range)
    this.renderProjectiles(ctx, projectiles);
    this.renderParticles(ctx, particles);

    // 8. Floating Combat Damage & XP Numbers
    this.renderFloatingTexts(ctx, floatingTexts);
  }

  /**
   * Draws one prop layer (`decor` rugs or `prop` furniture) on lit, in-bounds
   * tiles. No per-frame allocation; props are static data (D4 §6.1/§6.3).
   */
  /**
   * Draws the interaction prompt bubble (`{x, y, text}` in grid space) above an
   * NPC/world object. Presentation-only; called at most once per frame and only
   * while a target is in reach (LIV-60 P2).
   */
  renderInteractPrompt(ctx, prompt) {
    const text = prompt && prompt.text;
    if (!text) return;
    const px = prompt.x * CONFIG.GRID_SIZE - this.cameraX + CONFIG.GRID_SIZE / 2;
    const py = prompt.y * CONFIG.GRID_SIZE - this.cameraY - 6;
    ctx.save();
    ctx.font = '600 12px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 12;
    const h = 18;
    ctx.fillStyle = 'rgba(5, 6, 8, 0.82)';
    ctx.fillRect(px - w / 2, py - h, w, h);
    ctx.strokeStyle = '#e5b95c';
    ctx.lineWidth = 1;
    ctx.strokeRect(px - w / 2, py - h, w, h);
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px, py - h / 2);
    ctx.restore();
  }

  /**
   * Draws a quest-status marker bubble above an NPC (LIV-55 P5):
   * `available` (!, gold) for a quest that can be accepted, `turnin` (?, green)
   * for a completed quest ready to hand in. Presentation-only, no allocation
   * beyond the cached literals.
   */
  drawQuestMarker(ctx, marker, centerX, topY) {
    const turnIn = marker === 'turnin';
    ctx.save();
    ctx.fillStyle = 'rgba(5, 6, 8, 0.85)';
    ctx.beginPath();
    ctx.arc(centerX, topY, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = turnIn ? '#34d399' : '#facc15';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = turnIn ? '#34d399' : '#facc15';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(turnIn ? '?' : '!', centerX, topY + 0.5);
    ctx.restore();
  }

  /**
   * Draws small HP (+MP for the player) bars above an actor. Pure fillRect()
   * primitives with cached tokens — no per-frame allocations, so the 60 FPS
   * loop stays GC-free (docs/agents.md §3).
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} actor - actor with hp/max_hp (and mana/max_mana for player)
   * @param {number} screenX @param {number} screenY
   * @param {boolean} withMana - draw the mana bar too (player only)
   * @param {number} [barWidth]
   * @param {number} [spriteTopY] - top of the drawn sprite box; anchors the bars
   *   above the taller LIV-142 humanoid render. Defaults to the tile top.
   */
  drawActorBars(ctx, actor, screenX, screenY, withMana, barWidth = ENTITY_BARS.width, spriteTopY) {
    if (!actor || !Number.isFinite(actor.max_hp) || actor.max_hp <= 0) return;
    const size = CONFIG.GRID_SIZE;
    const w = barWidth;
    const h = ENTITY_BARS.height;
    const outline = ENTITY_BARS.outline;
    const gap = ENTITY_BARS.gap;
    const x = Math.round(screenX + (size - w) / 2);
    const topY = Number.isFinite(spriteTopY) ? spriteTopY : screenY;
    let y = Math.round(topY - ENTITY_BARS.offset);

    const hpPct = Math.max(0, Math.min(1, actor.hp / actor.max_hp));
    const hpColor = hpPct <= ENTITY_BARS.lowHpPct ? ENTITY_BARS.hpLow : ENTITY_BARS.hp;

    // 1px frame for legibility on light floors, then track, then fill.
    ctx.fillStyle = OUTLINE_COLOR;
    ctx.fillRect(x - outline, y - outline, w + outline * 2, h + outline * 2);
    ctx.fillStyle = ENTITY_BARS.track;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = hpColor;
    ctx.fillRect(x, y, Math.max(0, Math.round(w * hpPct)), h);

    if (withMana && Number.isFinite(actor.max_mana) && actor.max_mana > 0) {
      y += h + gap;
      const mpPct = Math.max(0, Math.min(1, actor.mana / actor.max_mana));
      ctx.fillStyle = OUTLINE_COLOR;
      ctx.fillRect(x - outline, y - outline, w + outline * 2, h + outline * 2);
      ctx.fillStyle = ENTITY_BARS.track;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = ENTITY_BARS.mp;
      ctx.fillRect(x, y, Math.max(0, Math.round(w * mpPct)), h);
    }
  }

  /**
   * Draws the player's active status VFX with cached, allocation-free
   * canvas primitives:
   *
   *  - Shock Shield: a pulsing silver barrier ring while a deflect charge is
   *    armed (`player.shockShieldCharges > 0`). It disappears the moment the
   *    charge is consumed by a deflect (or the shield is otherwise cleared).
   *  - Holy/Sanctuary bubble: the exact same silver force-field is reused
   *    whenever a damage-absorbing bubble is active (`player.shieldAbsorb > 0`),
   *    covering the Paladin Aegis Shield, the Sanctuary Plate, and any future
   *    bubble source. It fades when the absorb pool or duration is exhausted.
   *  - Luminous Prayer: small glowing healing orbs orbiting the player while
   *    `player.luminousPrayerVfxSec > 0`, fading out over the final
   *    `fadeSec` before the timer reaches 0.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} player
   * @param {number} screenX @param {number} screenY
   */
  renderPlayerVfx(ctx, player, screenX, screenY) {
    if (!player) return;
    const size = CONFIG.GRID_SIZE;
    const cx = screenX + size / 2;
    const cy = screenY + size / 2;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    if (player.shockShieldCharges > 0 || player.shieldAbsorb > 0) {
      const s = PLAYER_VFX.shield;
      const pulse = 0.5 + 0.5 * Math.sin((now / 1000) * s.pulseHz * Math.PI * 2);
      const radius = size * s.radiusScale + size * 0.03 * pulse;
      const alpha = s.baseAlpha + s.pulseAlpha * pulse;

      ctx.save();
      // Translucent silver field inside the barrier.
      ctx.globalAlpha = alpha * s.fillAlpha;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      // Outer silver ring, then a brighter inner rim for a polished sheen.
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.lineWidthPx;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = Math.min(1, alpha + 0.15);
      ctx.strokeStyle = s.rimColor;
      ctx.lineWidth = Math.max(1, s.lineWidthPx * 0.5);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, radius - s.lineWidthPx * 0.6), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (player.luminousPrayerVfxSec > 0) {
      const p = PLAYER_VFX.prayer;
      const fade = Math.min(1, player.luminousPrayerVfxSec / p.fadeSec);
      const orbit = size * p.orbitRadiusScale;
      const spin = (now / 1000) * p.orbitHz * Math.PI * 2;
      const step = (Math.PI * 2) / p.orbCount;

      ctx.save();
      for (let i = 0; i < p.orbCount; i++) {
        const angle = spin + i * step;
        const ox = cx + Math.cos(angle) * orbit;
        const oy = cy + Math.sin(angle) * orbit + Math.sin(spin * 2 + i) * size * p.bobScale;

        ctx.globalAlpha = 0.35 * fade;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(ox, oy, p.glowRadiusPx, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = fade;
        ctx.fillStyle = p.coreColor;
        ctx.beginPath();
        ctx.arc(ox, oy, p.orbRadiusPx, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /**
   * LIV-45 knockout/revive world read. For every downed body it draws the E1
   * "Call for Help" beacon (a pulsing ring + a locator pip aimed at the nearest
   * living ally); for every living member mid-channel it draws the revive
   * tether and a progress arc. Allocation is kept to the same `save`/`restore`
   * and path primitives the other VFX use.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} player top-level active member (mirror)
   * @param {Array<object>} party
   * @param {number} now ms clock
   */
  renderKnockoutVfx(ctx, player, party, now) {
    if (!player || !Array.isArray(party) || party.length <= 1) return;

    // Revive channels (living reviver holding a downed target).
    for (const member of party) {
      if (!isLivingEntry(member) || !member._reviveTargetId) continue;
      const target = this._findEntryById(party, player, member._reviveTargetId);
      if (target && isDownedEntry(target)) this.drawReviveChannel(ctx, member, target);
    }

    // LIV-52 auto-revive countdown ring: drawn first (closest to the body) on its
    // opaque track, so the E1 beacon, tether and progress arc stay legible on
    // top. The remaining/total scalars are stamped by the engine each tick and
    // drained per frame by the app.
    const auto = KNOCKOUT.autoRevive;
    if (auto.enabled) {
      const reduced = prefersReducedMotion();
      for (const member of party) {
        if (!isDownedEntry(member)) continue;
        if (!(Number(member.autoReviveTotalSec) > 0)) continue;
        this.drawAutoReviveRing(ctx, member, now, reduced);
      }
    }

    // E1 beacon over each downed body (only while an ally can answer it).
    const beacon = KNOCKOUT.beacon;
    if (!beacon.enabled) return;
    for (const member of party) {
      if (!isDownedEntry(member)) continue;
      const ally = this.nearestLivingAlly(player, party, member.x, member.y);
      if (ally) this.drawCallForHelp(ctx, member, ally, now);
    }
  }

  /** Party entry with `memberId`, or the top-level player when it matches. */
  _findEntryById(party, player, memberId) {
    if (!memberId) return null;
    if (player && player.memberId === memberId) return player;
    for (const m of party) if (m && m.memberId === memberId) return m;
    return null;
  }

  /**
   * Nearest living ally to (x, y) — the top-level active member (live position)
   * plus non-active living party entries — or null when none stand.
   */
  nearestLivingAlly(player, party, x, y) {
    let best = null;
    let bestDist = Infinity;
    const consider = (entry) => {
      const d = Math.hypot(entry.x - x, entry.y - y);
      if (d < bestDist) { bestDist = d; best = entry; }
    };
    if (isLivingEntry(player)) consider(player);
    for (const m of party) {
      if (!m || !isLivingEntry(m)) continue;
      if (m.memberId && m.memberId === player.activeMemberId) continue;
      consider(m);
    }
    return best;
  }

  /** E1: pulsing beacon ring + locator pip pointing at the nearest living ally. */
  drawCallForHelp(ctx, downed, ally, now) {
    const b = KNOCKOUT.beacon;
    const size = CONFIG.GRID_SIZE;
    const cx = downed.x * size + size / 2 - this.cameraX;
    const cy = downed.y * size + size / 2 - this.cameraY;
    const phase = ((now / 1000) * b.pulseHz) % 1;
    const radius = (b.ringMinTiles + (b.ringMaxTiles - b.ringMinTiles) * phase) * size;

    ctx.save();
    ctx.globalAlpha = b.baseAlpha * (1 - phase);
    ctx.strokeStyle = b.color;
    ctx.lineWidth = b.lineWidthPx;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Locator pip rides the ring edge, aimed at the ally who can answer.
    const angle = Math.atan2(ally.y - downed.y, ally.x - downed.x);
    const px = cx + Math.cos(angle) * radius;
    const py = cy + Math.sin(angle) * radius;
    const s = b.pipSizeTiles * size;
    ctx.globalAlpha = Math.min(1, b.baseAlpha + 0.2);
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.moveTo(px + Math.cos(angle) * s, py + Math.sin(angle) * s);
    ctx.lineTo(px + Math.cos(angle + 2.5) * s, py + Math.sin(angle + 2.5) * s);
    ctx.lineTo(px + Math.cos(angle - 2.5) * s, py + Math.sin(angle - 2.5) * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Revive channel: tether beam + a progress arc that closes as the channel completes. */
  drawReviveChannel(ctx, reviver, target) {
    const c = KNOCKOUT.channel;
    const size = CONFIG.GRID_SIZE;
    const rx = reviver.x * size + size / 2 - this.cameraX;
    const ry = reviver.y * size + size / 2 - this.cameraY;
    const tx = target.x * size + size / 2 - this.cameraX;
    const ty = target.y * size + size / 2 - this.cameraY;
    const cfg = ReviveSystem.resolveReviveConfig(reviver.vocation);
    const frac = Math.max(0, Math.min(1, Number(reviver._reviveProgressSec || 0) / Math.max(0.01, cfg.channelSec)));
    const blocked = reviver._reviveBlocked === true;

    ctx.save();
    ctx.globalAlpha = c.tetherAlpha;
    ctx.strokeStyle = c.color;
    ctx.lineWidth = c.beamWidthPx;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    const radius = c.progressRadiusTiles * size;
    ctx.globalAlpha = blocked ? 0.4 : 0.9;
    ctx.strokeStyle = blocked ? '#94a3b8' : c.coreColor;
    ctx.lineWidth = c.progressLineWidthPx;
    ctx.beginPath();
    ctx.arc(tx, ty, radius, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * LIV-52 countdown ring on a downed body. Geometry/palette come from
   * `ui.json.knockout.autoRevive`; the remaining/total seconds come from the
   * member scalars the engine stamps. The slate track draws first, then a gold
   * sweep that starts at `ring.startAngleDeg` (12 o'clock) and drains
   * `ring.sweepDir` from full to empty as the timer elapses — the empty frame
   * coincides with the auto-revive. `ui.json.knockout.autoRevive.numeric` prints
   * `ceil` seconds below the body. Reduced motion swaps the smooth drain + beat
   * for a static once-per-second stepped arc.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} downed downed party entry
   * @param {number} now ms clock (for the beat)
   * @param {boolean} [reduced] prefers-reduced-motion
   */
  drawAutoReviveRing(ctx, downed, now, reduced = false) {
    const a = KNOCKOUT.autoRevive;
    const total = Math.max(0.0001, Number(downed.autoReviveTotalSec) || 0);
    if (!(total > 0)) return;
    let remaining = Math.max(0, Number(downed.autoReviveRemainingSec) || 0);
    if (remaining > total) remaining = total;

    const rm = reduced ? a.reducedMotion : null;
    const beatHz = rm ? rm.beatHz : a.beatHz;
    let frac = remaining / total;
    if (rm && rm.tickMode === 'step') {
      // Static arc that redraws only when the whole second changes.
      frac = Math.min(1, Math.ceil(remaining) / Math.max(1, Math.ceil(total)));
    }

    const size = CONFIG.GRID_SIZE;
    const cx = downed.x * size + size / 2 - this.cameraX;
    const cy = downed.y * size + size / 2 - this.cameraY;
    const radius = a.radiusTiles * size;
    const start = (a.startAngleDeg * Math.PI) / 180;
    const dir = a.sweepDir === 'counterclockwise' ? -1 : 1;
    const end = start + dir * frac * Math.PI * 2;
    const anticlockwise = dir < 0;

    ctx.save();
    ctx.lineCap = a.lineCap || 'round';

    // 1. Opaque track (closest to the body).
    ctx.globalAlpha = a.trackAlpha;
    ctx.strokeStyle = a.trackColor;
    ctx.lineWidth = a.lineWidthPx;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // 2. Gold sweep: full at down, empty at revive.
    if (frac > 0) {
      const beat = beatHz > 0
        ? a.beatMinAlpha + (1 - a.beatMinAlpha) * (0.5 + 0.5 * Math.cos((now / 1000) * beatHz * Math.PI * 2))
        : 1;
      ctx.globalAlpha = Math.min(1, a.sweepAlpha * beat);
      ctx.strokeStyle = a.sweepColor;
      ctx.lineWidth = a.lineWidthPx;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start, end, anticlockwise);
      ctx.stroke();

      ctx.strokeStyle = a.sweepCoreColor;
      ctx.lineWidth = Math.max(1, a.lineWidthPx * 0.4);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start, end, anticlockwise);
      ctx.stroke();
    }
    ctx.restore();

    // 3. Numeric ceil-seconds read below the body (guarded for headless spies).
    const numeric = a.numeric;
    if (numeric.show && typeof ctx.fillText === 'function') {
      const label = String(Math.ceil(remaining));
      ctx.save();
      ctx.font = `${numeric.fontWeight} ${numeric.fontSizePx}px ${numeric.fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = numeric.outlineWidthPx;
      ctx.strokeStyle = numeric.outlineColor;
      ctx.strokeText(label, cx, cy + numeric.offsetBelowTiles * size);
      ctx.fillStyle = numeric.color;
      ctx.fillText(label, cx, cy + numeric.offsetBelowTiles * size);
      ctx.restore();
    }
  }

  /**
   * LIV-50 control-swap world read. Draws the fluid position locator travelling
   * from the outgoing to the incoming tile over `ui.json.knockout.swap`
   * `positionAnimMs`, then the destination activity flash (additive core glow +
   * ring) as it ramps down over `destinationFlash.durationMs`. Allocation is
   * limited to the draw primitives; the timing lives in `SwapFeedback`.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./swap-feedback.js').SwapFeedback|null} feedback
   * @param {number} now ms clock
   */
  renderSwapVfx(ctx, feedback, now) {
    if (!feedback || !feedback.active) return;
    const size = CONFIG.GRID_SIZE;
    const pos = feedback.position(now);

    // 1. Position locator during the fluid move (fades as it reaches the target).
    if (pos.active && pos.t < 1) {
      const fx = pos.x * size + size / 2 - this.cameraX;
      const fy = pos.y * size + size / 2 - this.cameraY;
      ctx.save();
      ctx.globalAlpha = 0.9 * (1 - pos.t);
      ctx.fillStyle = feedback.cfg.flash.color;
      ctx.beginPath();
      ctx.arc(fx, fy, size * 0.14, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 2. Destination activity flash.
    const flash = feedback.flash(now);
    if (!flash.active || !(flash.alpha > 0)) return;
    const dx = feedback.toX * size + size / 2 - this.cameraX;
    const dy = feedback.toY * size + size / 2 - this.cameraY;
    ctx.save();
    if (flash.mode === 'additive') ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = flash.alpha;
    ctx.fillStyle = flash.coreColor;
    ctx.beginPath();
    ctx.arc(dx, dy, size * 0.38, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = flash.alpha * flash.ringAlpha;
    ctx.strokeStyle = flash.color;
    ctx.lineWidth = flash.ringLineWidthPx;
    ctx.beginPath();
    ctx.arc(dx, dy, flash.ringRadiusTiles * size, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  renderProps(ctx, props, layer, gridMap, startX, endX, startY, endY) {
    if (!props || props.length === 0) return;
    const wantDecor = layer === 'decor';
    for (const prop of props) {
      if (!prop) continue;
      const isDecor = prop.layer === 'decor';
      if (wantDecor !== isDecor) continue;
      if (prop.x < startX || prop.x > endX || prop.y < startY || prop.y > endY) continue;
      const tile = gridMap.tiles[prop.y] && gridMap.tiles[prop.y][prop.x];
      if (!tile || (!tile.isLit && !this._ambient)) continue;
      SpriteRenderer.drawProp(
        ctx,
        prop,
        prop.x * CONFIG.GRID_SIZE - this.cameraX,
        prop.y * CONFIG.GRID_SIZE - this.cameraY,
        CONFIG.GRID_SIZE
      );
    }
  }

  /**
   * Draws catalog-declared building silhouettes (LIV-100). Iterates the active
   * scene's `buildings`, resolves a renderer through `BUILDING_SILHOUETTE_
   * RENDERERS` keyed on `building.silhouette` (or its id), and hands it the
   * building's footprint in screen space. Buildings without a footprint or a
   * matching renderer are skipped, so the pass is a no-op unless content opts
   * in. Footprints fully off-screen are culled before any canvas call.
   * @param {CanvasRenderingContext2D} ctx
   */
  renderBuildingSilhouettes(ctx) {
    const buildings = this.scene && this.scene.buildings;
    if (!Array.isArray(buildings) || buildings.length === 0) return;
    const size = CONFIG.GRID_SIZE;
    const viewW = this.canvas ? this.canvas.width : 0;
    const viewH = this.canvas ? this.canvas.height : 0;
    for (const building of buildings) {
      if (!building) continue;
      const key = building.silhouette || building.id;
      // Any key backed by a committed BUILDING_CATALOG sprite dispatches through
      // the shared sprite-building renderer (LIV-110) — adding a building view is
      // a catalog entry, never a per-building JS branch.
      const draw = BUILDING_SILHOUETTE_RENDERERS[key]
        || (BUILDING_CATALOG[key] ? BUILDING_SILHOUETTE_RENDERERS.spriteBuilding : null);
      if (!draw || !Array.isArray(building.footprint) || building.footprint.length < 4) continue;
      const [x0, y0, x1, y1] = building.footprint;
      const left = x0 * size - this.cameraX;
      const top = y0 * size - this.cameraY;
      const width = (x1 - x0 + 1) * size;
      const height = (y1 - y0 + 1) * size;
      if (width <= 0 || height <= 0) continue;
      // Cull footprints entirely outside the viewport.
      if (viewW > 0 && (left + width < 0 || left > viewW)) continue;
      if (viewH > 0 && (top + height < 0 || top > viewH)) continue;
      draw(ctx, building, left, top, width, height);
    }
  }

  /**
   * Draws the town return teleporter (LIV-75): a pulsing gold ground ring with a
   * rising light beam. Reads `spot.x/y` (grid coords) and uses `globalAlpha` for
   * the pulse so no per-frame strings are allocated.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number}} spot
   */
  drawReturnSpot(ctx, spot) {
    const size = CONFIG.GRID_SIZE;
    const sx = spot.x * size - this.cameraX;
    const sy = spot.y * size - this.cameraY;
    const cx = sx + size / 2;
    const cy = sy + size / 2;
    const now = this._now();
    const pulse = 0.5 + 0.5 * Math.sin((now / 450) % 6.2831853);

    ctx.save();
    // Ground glow.
    ctx.globalAlpha = 0.18 + 0.14 * pulse;
    ctx.fillStyle = '#e5b95c';
    ctx.beginPath();
    ctx.ellipse(cx, cy + size * 0.12, size * 0.42, size * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    // Ring.
    ctx.globalAlpha = 0.55 + 0.35 * pulse;
    ctx.strokeStyle = '#f6d98a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy + size * 0.12, size * 0.30, size * 0.17, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Rising beam.
    ctx.globalAlpha = 0.22 + 0.22 * pulse;
    ctx.fillStyle = '#ffe9a8';
    ctx.fillRect(cx - size * 0.09, sy + size * 0.08, size * 0.18, size * 0.74);
    // Core.
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#fff6d5';
    ctx.beginPath();
    ctx.arc(cx, cy + size * 0.10, size * 0.09 + size * 0.02 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  renderProjectiles(ctx, projectiles) {
    for (const p of projectiles) {
      // Catalog presentation hook: a registered renderer wins; otherwise the
      // generic energy-trail/fade renderer below handles it.
      const custom = PROJECTILE_RENDERERS[p.renderKey || p.type];
      if (custom) {
        custom.call(this, ctx, p);
        continue;
      }
      if (p.type === 'energy_beam' && p.waves) {
        ctx.save();
        const stepColors = p.visual?.stepColors || ['#ff00aa', '#ff66dd', '#d946ef', '#a855f7'];

        // Render all wave steps that have started expanding
        for (let idx = 0; idx < p.waves.length; idx++) {
          const wave = p.waves[idx];
          if (p.elapsedMs < wave.delayMs) continue; // Not yet reached

          const ageMs = p.elapsedMs - wave.delayMs;
          const stepAlpha = Math.max(0.2, 1.0 - (idx * 0.15));
          const fadeAlpha = Math.max(0, 1.0 - ageMs / 400); // 400ms visible duration
          const alpha = stepAlpha * fadeAlpha;

          const stepColor = stepColors[idx] || stepColors[stepColors.length - 1];

          ctx.globalAlpha = alpha;
          for (const tile of wave.tiles) {
            const sx = tile.x * CONFIG.GRID_SIZE - this.cameraX;
            const sy = tile.y * CONFIG.GRID_SIZE - this.cameraY;

            if (tile.isWall) {
              ctx.fillStyle = 'rgba(255, 0, 170, 0.4)';
              ctx.fillRect(sx + 4, sy + 4, CONFIG.GRID_SIZE - 8, CONFIG.GRID_SIZE - 8);
            } else {
              // Radial Energy Wave Aura
              const cx = sx + CONFIG.GRID_SIZE / 2;
              const cy = sy + CONFIG.GRID_SIZE / 2;
              const auraGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, CONFIG.GRID_SIZE * 0.75);
              auraGrad.addColorStop(0, '#ffffff');
              auraGrad.addColorStop(0.4, stepColor);
              auraGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

              ctx.fillStyle = auraGrad;
              ctx.beginPath();
              ctx.arc(cx, cy, CONFIG.GRID_SIZE * 0.75, 0, Math.PI * 2);
              ctx.fill();

              // Glowing Square Border
              ctx.strokeStyle = stepColor;
              ctx.lineWidth = Math.max(1, 3 - idx * 0.5);
              ctx.strokeRect(sx + 3, sy + 3, CONFIG.GRID_SIZE - 6, CONFIG.GRID_SIZE - 6);
            }
          }
        }
        ctx.restore();
      } else if (p.type === 'swoosh') {
        this.renderSwoosh(ctx, p);
      } else {
        const startPixelX = p.sourceX * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraX;
        const startPixelY = p.sourceY * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraY;

        let curX, curY;
        if (typeof p.currentPxX === 'number' && typeof p.currentPxY === 'number') {
          curX = p.currentPxX - this.cameraX;
          curY = p.currentPxY - this.cameraY;
        } else {
          const progress = Math.min(1.0, p.elapsedMs / p.durationMs);
          const targetPixelX = p.targetX * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraX;
          const targetPixelY = p.targetY * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraY;

          curX = startPixelX + (targetPixelX - startPixelX) * progress;
          curY = startPixelY + (targetPixelY - startPixelY) * progress;
        }

        const v = p.visual || {};
        const trailType = v.trailType || 'solid';
        const mainColor = p.color || '#44ccff';
        const glowColor = v.glowColor || '#00eeff';
        const headRadius = v.headRadius || 5;

        // Capped Trail Tail Calculation (Max 5 tiles solid, fading over 2 tiles)
        const maxSolidPx = (v.maxTrailLengthTiles || 5.0) * CONFIG.GRID_SIZE;
        const fadePx = (v.trailFadeTiles || 2.0) * CONFIG.GRID_SIZE;
        const maxTotalTrailPx = maxSolidPx + fadePx;

        const totalDistPx = Math.hypot(curX - startPixelX, curY - startPixelY);
        const effectiveTrailPx = Math.min(totalDistPx, maxTotalTrailPx);

        let tailX = startPixelX;
        let tailY = startPixelY;
        if (totalDistPx > maxTotalTrailPx && totalDistPx > 0) {
          const ratio = (totalDistPx - maxTotalTrailPx) / totalDistPx;
          tailX = startPixelX + (curX - startPixelX) * ratio;
          tailY = startPixelY + (curY - startPixelY) * ratio;
        }

        ctx.save();

        if (trailType === 'electric') {
          const segments = v.trailSegments || 6;
          const jitter = v.trailJitterPx || 4;
          const trailWidth = v.trailWidth || 3;

          for (let i = 0; i < segments; i++) {
            const ratio1 = i / segments;
            const ratio2 = (i + 1) / segments;

            const p1x = tailX + (curX - tailX) * ratio1;
            const p1y = tailY + (curY - tailY) * ratio1;
            const p2x = tailX + (curX - tailX) * ratio2;
            const p2y = tailY + (curY - tailY) * ratio2;

            const distFromHead1 = (1 - ratio1) * effectiveTrailPx;
            const alpha1 = distFromHead1 <= maxSolidPx ? 1.0 : Math.max(0, 1.0 - (distFromHead1 - maxSolidPx) / fadePx);

            const offsetX = i < segments - 1 ? (Math.random() - 0.5) * jitter * 2 : 0;
            const offsetY = i < segments - 1 ? (Math.random() - 0.5) * jitter * 2 : 0;

            // Outer Glow Segment
            ctx.strokeStyle = glowColor;
            ctx.lineWidth = trailWidth + 2;
            ctx.globalAlpha = 0.4 * alpha1;
            ctx.beginPath();
            ctx.moveTo(p1x, p1y);
            ctx.lineTo(p2x + offsetX, p2y + offsetY);
            ctx.stroke();

            // White Core Segment
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(1, trailWidth - 1);
            ctx.globalAlpha = 0.95 * alpha1;
            ctx.beginPath();
            ctx.moveTo(p1x, p1y);
            ctx.lineTo(p2x + offsetX, p2y + offsetY);
            ctx.stroke();
          }
        } else {
          // Fallback solid trail
          ctx.strokeStyle = mainColor;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(tailX, tailY);
          ctx.lineTo(curX, curY);
          ctx.stroke();
        }

        // Projectile Head Radial Glow
        const glowRadius = v.glowRadiusPx || 14;
        const headGrad = ctx.createRadialGradient(curX, curY, 1, curX, curY, glowRadius);
        headGrad.addColorStop(0, '#ffffff');
        headGrad.addColorStop(0.3, glowColor);
        headGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = headGrad;
        ctx.beginPath();
        ctx.arc(curX, curY, glowRadius, 0, Math.PI * 2);
        ctx.fill();

        // Solid Core Head
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(curX, curY, Math.max(2, headRadius - 2), 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      }
    }
  }

  /**
   * Draws a basic melee "swoosh": an arc/swipe in front of the player oriented
   * toward the target, fading over the swing duration. Uses only existing
   * rendering primitives (no new art assets).
   */
  renderSwoosh(ctx, p) {
    const sw = CONFIG.GRID_SIZE;
    const cx = p.sourceX * sw + sw / 2 - this.cameraX;
    const cy = p.sourceY * sw + sw / 2 - this.cameraY;
    const tx = p.targetX * sw + sw / 2 - this.cameraX;
    const ty = p.targetY * sw + sw / 2 - this.cameraY;

    const progress = Math.min(1, p.elapsedMs / (p.durationMs || 280));
    const angle = Math.atan2(ty - cy, tx - cx);
    const v = p.visual || {};
    const sweep = ((v.arcSweepDeg ?? 90) * Math.PI) / 180;
    const radius = sw * (v.arcRadiusTiles ?? 0.9);
    const color = p.color || '#e2e8f0';
    const glowColor = v.glowColor || '#ffffff';
    const alpha = Math.max(0, 1 - progress);

    ctx.save();
    // Leading edge sweeps from the far side of the arc toward the target.
    const leadEnd = angle - sweep / 2 + sweep * Math.min(1, progress * 2.2);

    // Outer glow arc
    ctx.globalAlpha = alpha * 0.45;
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = sw * 0.2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angle - sweep / 2, angle + sweep / 2);
    ctx.stroke();

    // White core arc (grows along the swing)
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = sw * 0.09;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angle - sweep / 2, Math.max(angle - sweep / 2, leadEnd));
    ctx.stroke();

    // Colored tip accent at the leading edge
    ctx.globalAlpha = alpha * 0.8;
    ctx.strokeStyle = color;
    ctx.lineWidth = sw * 0.14;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.max(angle - sweep / 2, leadEnd - sweep * 0.18), leadEnd);
    ctx.stroke();
    ctx.restore();
  }

  renderParticles(ctx, particles) {
    if (!particles || particles.length === 0) return;
    ctx.save();
    for (const pt of particles) {
      const screenX = pt.x - this.cameraX;
      const screenY = pt.y - this.cameraY;
      const alpha = Math.max(0, 1.0 - pt.elapsedMs / pt.durationMs);

      ctx.globalAlpha = alpha;
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(screenX, screenY, pt.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  renderLightMask(ctx, gridMap, player, ambientLights, viewportWidth, viewportHeight, projectiles = []) {
    ctx.save();

    // Smooth continuous radial darkness dissolve over player FOV
    const playerRadius = LightingSystem.computePlayerRadius(player);
    // LIV-139: centre the light dissolve on the tweened position so the lit
    // pocket glides with the sprite instead of popping a tile per step.
    const playerScreenX = tweenTileX(player) * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraX;
    const playerScreenY = tweenTileY(player) * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraY;
    const maxRadiusPx = (playerRadius + 0.5) * CONFIG.GRID_SIZE;
    const innerClearRadiusPx = (playerRadius * 0.58) * CONFIG.GRID_SIZE;

    const darkGrad = ctx.createRadialGradient(
      playerScreenX,
      playerScreenY,
      innerClearRadiusPx,
      playerScreenX,
      playerScreenY,
      maxRadiusPx
    );
    darkGrad.addColorStop(0, 'rgba(5, 6, 8, 0.0)');
    darkGrad.addColorStop(0.35, 'rgba(5, 6, 8, 0.18)');
    darkGrad.addColorStop(0.70, 'rgba(5, 6, 8, 0.55)');
    darkGrad.addColorStop(0.95, 'rgba(5, 6, 8, 0.90)');
    darkGrad.addColorStop(1.0, 'rgba(5, 6, 8, 1.0)');

    ctx.fillStyle = darkGrad;
    ctx.fillRect(0, 0, viewportWidth, viewportHeight);

    // 3. Subtle aura for active light spells
    const hasActiveSpell = player.lightSpellTimer > 0;

    if (hasActiveSpell) {
      const auraRadius = 2.5 * CONFIG.GRID_SIZE;
      const auraColor = 'rgba(56, 189, 248, 0.22)';

      const grad = ctx.createRadialGradient(
        playerScreenX,
        playerScreenY,
        4,
        playerScreenX,
        playerScreenY,
        auraRadius
      );
      grad.addColorStop(0, auraColor);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(playerScreenX, playerScreenY, auraRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 4. Subtle tile lighting illumination around in-flight projectiles
    for (const p of projectiles) {
      if (p.visual?.illuminateTiles) {
        let curX, curY;
        if (typeof p.currentPxX === 'number' && typeof p.currentPxY === 'number') {
          curX = p.currentPxX - this.cameraX;
          curY = p.currentPxY - this.cameraY;
        } else {
          const progress = Math.min(1.0, p.elapsedMs / p.durationMs);
          const startPixelX = p.sourceX * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraX;
          const startPixelY = p.sourceY * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraY;
          const targetPixelX = p.targetX * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraX;
          const targetPixelY = p.targetY * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - this.cameraY;

          curX = startPixelX + (targetPixelX - startPixelX) * progress;
          curY = startPixelY + (targetPixelY - startPixelY) * progress;
        }

        const projRadiusPx = (p.visual.lightRadiusTiles || 1.5) * CONFIG.GRID_SIZE;

        const projGrad = ctx.createRadialGradient(curX, curY, 2, curX, curY, projRadiusPx);
        projGrad.addColorStop(0, 'rgba(100, 220, 255, 0.35)');
        projGrad.addColorStop(0.5, 'rgba(68, 204, 255, 0.15)');
        projGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = projGrad;
        ctx.beginPath();
        ctx.arc(curX, curY, projRadiusPx, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  renderFloatingTexts(ctx, floatingTexts) {
    for (const t of floatingTexts) {
      const screenX = t.x - this.cameraX;
      const screenY = t.y - this.cameraY;
      const alpha = Math.max(0, 1.0 - t.elapsedMs / t.durationMs);

      ctx.save();
      ctx.fillStyle = t.color;
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(t.text, screenX, screenY);
      ctx.restore();
    }
  }

  screenToGrid(screenX, screenY) {
    const worldX = screenX + this.cameraX;
    const worldY = screenY + this.cameraY;
    return {
      x: Math.floor(worldX / CONFIG.GRID_SIZE),
      y: Math.floor(worldY / CONFIG.GRID_SIZE),
    };
  }
}
