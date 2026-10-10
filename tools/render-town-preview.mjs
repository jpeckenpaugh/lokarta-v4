#!/usr/bin/env node
/**
 * Lokarta town preview renderer (Node-only, zero dependencies).
 *
 * Browser-free, deterministic render of a catalog-authored town scene for
 * on-demand review (docs/engineering/agents.md §8: `tools/render-*.mjs` are a
 * self-serve smoke aid, not a gate). It composes the town through the engine's
 * own `composeSceneById` path, paints each tile from the town's `sceneTheme`
 * palette, then blits authored NPC/prop sprite frames (via the same
 * `parseFrame`/`applyOutline` pixel pipeline the runtime renderer uses).
 *
 * No gameplay is reimplemented here: tile matrix, spawn, props, NPCs, and
 * buildings all come from the JSON catalogs. Usage:
 *
 *   node tools/render-town-preview.mjs [sceneId] [outFile]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TILE_TYPES } from '../html/engine/config.js';
import { composeSceneById, isCodeWalkable } from '../html/services/scene-composer.js';
import { DEFAULT_TOWN_ID, getTownDefinition } from '../html/data/index.js';
import { SPRITE_CATALOG, PROP_CATALOG, BUILDING_CATALOG } from '../html/assets/sprites/index.js';
import { sceneTheme, parseFrame, applyOutline } from '../html/app/sprite-renderer.js';
import { encodePNG } from './render-sprite-preview.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CELL = 32; // native tile size in px
const SCALE = 2;

function hexToRgba(hex, alpha = 255) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), alpha];
}

/** Base paint color per tile code, resolved from the scene theme palette. */
function tileBaseColor(code, theme) {
  const t = theme.tiles || {};
  switch (code) {
    case TILE_TYPES.WATER: return t.WATER?.fill || '#1b4d58';
    case TILE_TYPES.GRASS: return t.GRASS?.fill || '#33552b';
    case TILE_TYPES.SAND: return t.SAND?.fill || '#c9b177';
    case TILE_TYPES.PATH: return t.PATH?.fill || '#8a7250';
    case TILE_TYPES.FLOOR: return t.PATH?.fill || '#8a7250';
    case TILE_TYPES.BRIDGE: return t.BRIDGE?.plank || '#7a5a34';
    case TILE_TYPES.DOCK: return t.DOCK?.plank || '#8a6a42';
    case TILE_TYPES.TREE: return t.TREE?.canopy || '#284a24';
    case TILE_TYPES.WALL: return t.BUILDING_WALL?.shade || '#5a4a37';
    case TILE_TYPES.BUILDING_WALL: return t.BUILDING_WALL?.fill || '#7d6b52';
    case TILE_TYPES.DOOR: return t.DOORWAY?.fill || '#5a3a1e';
    case TILE_TYPES.DOORWAY: return t.DOORWAY?.fill || '#5a3a1e';
    case TILE_TYPES.GATED_DOOR: return t.DOORWAY?.frame || '#2f1e10';
    case TILE_TYPES.SPRING: return '#4fd1c5';
    case TILE_TYPES.TOWN_GATE: return '#e5b95c';
    case TILE_TYPES.TOWER_ENTRANCE: return '#e5b95c';
    default: return '#1a1c23';
  }
}

function setPx(buf, W, H, x, y, rgba) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
}

function fillRect(buf, W, H, x0, y0, w, h, rgba) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) setPx(buf, W, H, x, y, rgba);
  }
}

/** Alpha-blend a sprite pixel object (already outlined) into the map buffer. */
function blit(buf, W, H, pix, ox, oy, scale) {
  for (let y = 0; y < pix.h; y++) {
    for (let x = 0; x < pix.w; x++) {
      const si = (y * pix.w + x) * 4;
      const a = pix.data[si + 3] / 255;
      if (a <= 0) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ox + x * scale + dx;
          const py = oy + y * scale + dy;
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          const di = (py * W + px) * 4;
          buf[di] = Math.round(pix.data[si] * a + buf[di] * (1 - a));
          buf[di + 1] = Math.round(pix.data[si + 1] * a + buf[di + 1] * (1 - a));
          buf[di + 2] = Math.round(pix.data[si + 2] * a + buf[di + 2] * (1 - a));
          buf[di + 3] = 255;
        }
      }
    }
  }
}

function spriteFrame(catalog, id, frameId) {
  const def = catalog[id];
  if (!def) return null;
  const frame = def.frames[frameId] || Object.values(def.frames)[0];
  if (!frame) return null;
  return applyOutline(parseFrame(frame, def.palette), def.palette['0'] || '#0b0d12');
}

export function renderTownPreview(sceneId = DEFAULT_TOWN_ID) {
  const scene = composeSceneById(sceneId);
  if (!scene) throw new Error(`renderTownPreview: unknown scene "${sceneId}"`);
  const theme = sceneTheme(scene.theme || getTownDefinition(sceneId)?.theme);

  const W = scene.width * CELL * SCALE;
  const H = scene.height * CELL * SCALE;
  const buf = Buffer.alloc(W * H * 4);
  const rect = (x0, y0, w, h, rgba) => fillRect(buf, W, H, x0, y0, w, h, rgba);
  const sprite = (pix, ox, oy) => blit(buf, W, H, pix, ox, oy, SCALE);
  const put = (x, y, rgba) => setPx(buf, W, H, x, y, rgba);
  rect(0, 0, W, H, [10, 11, 14, 255]);

  // 1. Tile layer.
  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      const code = scene.tiles[y][x];
      rect(x * CELL * SCALE, y * CELL * SCALE, CELL * SCALE, CELL * SCALE, hexToRgba(tileBaseColor(code, theme)));
      // Harbor shimmer: a crest band on water.
      if (code === TILE_TYPES.WATER) {
        rect(x * CELL * SCALE, y * CELL * SCALE + 6, CELL * SCALE, 3, hexToRgba(theme.tiles.WATER?.crest || '#3f8f96'));
      }
      // Impassable outlines so the walkable fabric reads at a glance.
      if (!isCodeWalkable(code)) {
        const px = x * CELL * SCALE; const py = y * CELL * SCALE; const s = CELL * SCALE;
        rect(px, py, s, 1, [11, 13, 18, 180]);
        rect(px, py + s - 1, s, 1, [11, 13, 18, 180]);
        rect(px, py, 1, s, [11, 13, 18, 180]);
        rect(px + s - 1, py, 1, s, [11, 13, 18, 180]);
      }
    }
  }

  // 2. Building silhouettes. A building that declares a `silhouette` present in
  //    BUILDING_CATALOG blits that Tier B multi-tile sprite into its footprint
  //    (the same path the runtime uses); otherwise a generic roof marker.
  const roof = hexToRgba(theme.tiles.BUILDING_WALL?.roof || '#8a6a45', 150);
  const ridge = hexToRgba(theme.tiles.BUILDING_WALL?.roofPeak || '#6b4a2a', 220);
  for (const b of scene.buildings || []) {
    if (!b.footprint) continue;
    const [x0, y0, x1, y1] = b.footprint;
    const px = x0 * CELL * SCALE; const py = y0 * CELL * SCALE;
    const w = (x1 - x0 + 1) * CELL * SCALE; const h = (y1 - y0 + 1) * CELL * SCALE;
    const def = BUILDING_CATALOG[b.silhouette] || BUILDING_CATALOG[b.id];
    if (def && def.native && def.frames) {
      const frameId = (def.placement && def.placement.defaultFrame) || 'view_0';
      const pix = spriteFrame(BUILDING_CATALOG, b.silhouette || b.id, frameId);
      const scale = w / def.native.w;
      if (pix && Number.isInteger(scale) && scale >= 1) { blit(buf, W, H, pix, px, py, scale); continue; }
    }
    rect(px, py, w, h, roof);
    rect(px, py + Math.floor(h / 2), w, 2, ridge);
    if (b.door) rect(b.door.x * CELL * SCALE, b.door.y * CELL * SCALE, CELL * SCALE, CELL * SCALE, hexToRgba(theme.tiles.DOORWAY?.glow || '#ffd48a'));
  }

  // 3. Authored props (sprite blit; falls back to a solid marker). A prop may
  //    select a facing frame via `frame` (the fisher's net ships four views).
  for (const p of scene.props || []) {
    const pix = spriteFrame(PROP_CATALOG, p.propId, p.frame || 'idle');
    const ox = p.x * CELL * SCALE;
    const oy = p.y * CELL * SCALE;
    if (pix) sprite(pix, ox, oy);
    else rect(ox + 8, oy + 8, CELL * SCALE - 16, CELL * SCALE - 16, hexToRgba('#d08a3a'));
  }

  // 4. NPCs (idle_down sprite blit; fallback marker).
  for (const npc of scene.npcs || []) {
    const pix = spriteFrame(SPRITE_CATALOG, npc.npcSpriteId, 'idle_down') || spriteFrame(SPRITE_CATALOG, npc.spriteId, 'idle_down');
    const ox = npc.x * CELL * SCALE;
    const oy = npc.y * CELL * SCALE;
    if (pix) sprite(pix, ox, oy);
    else rect(ox + 10, oy + 10, CELL * SCALE - 20, CELL * SCALE - 20, hexToRgba('#f0f4ff'));
  }

  // 5. Player spawn + scene portals/gates markers.
  const ring = (cx, cy, r, rgba) => {
    for (let a = 0; a < 360; a += 2) {
      const rad = (a * Math.PI) / 180;
      for (let t = 0; t < 3; t++) {
        put(Math.round(cx + Math.cos(rad) * (r + t)), Math.round(cy + Math.sin(rad) * (r + t)), rgba);
      }
    }
  };
  if (scene.spawn) ring(scene.spawn.x * CELL * SCALE + CELL, scene.spawn.y * CELL * SCALE + CELL, 20, [124, 227, 255, 255]);
  for (const portal of scene.portals || []) {
    ring(portal.x * CELL * SCALE + CELL, portal.y * CELL * SCALE + CELL, 22, [229, 185, 92, 255]);
  }

  return { W, H, buf, scene };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const sceneId = process.argv[2] && !process.argv[2].endsWith('.png') ? process.argv[2] : DEFAULT_TOWN_ID;
  const out = process.argv[3] || (process.argv[2] && process.argv[2].endsWith('.png') ? process.argv[2] : path.join(ROOT, 'tmp', `${sceneId}.png`));
  const { W, H, buf, scene } = renderTownPreview(sceneId);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePNG(W, H, buf));
  console.log(`Wrote ${out} (${W}x${H}, ${scene.npcs.length} NPCs, ${scene.props.length} props, ${scene.buildings.length} buildings)`);
}
