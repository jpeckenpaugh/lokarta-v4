/**
 * Lokarta: Portrait Renderer (LIV-81/LIV-91, LIV-136)
 *
 * Resolves and draws the 48x48 dialogue busts authored in
 * `html/assets/portraits/`. Mirrors the sprite-renderer pixel pipeline
 * (integer nearest-neighbour scale) so a portrait reads with the same language
 * as the actor sprites. Since LIV-136 the busts are 3D-baked head stills, so a
 * def declaring `outline:false` drops the hand outline (Tier B, LIV-115); legacy
 * hand-authored busts keep the outline pass.
 *
 * Pure/headless-safe: `drawPortrait` works against any 2D context, so the T0
 * suite exercises it with a fake context. `portraitDataUrl` returns null when no
 * canvas host is available (Node), and callers fall back to `portraitEmoji`.
 */

import { parseFrame, applyOutline, scalePixels, OUTLINE_COLOR } from './sprite-renderer.js';
import { PORTRAIT_CATALOG } from '../assets/portraits/index.js';

export const PORTRAIT_NATIVE = 48;

/** The catalog entry for an asset id, or null when the asset is absent. */
export function getPortraitDef(assetId) {
  return assetId ? PORTRAIT_CATALOG[assetId] || null : null;
}

/**
 * Resolves the portrait asset id for an NPC's `portraits` map and a dialogue
 * stage `expression`. Data-only: any unknown/missing expression falls back to
 * `neutral`, then to null (the caller keeps the emoji fallback). No per-NPC
 * branch.
 */
export function resolvePortraitId(portraits, expression) {
  if (!portraits || typeof portraits !== 'object') return null;
  const expr = typeof expression === 'string' ? expression : 'neutral';
  return portraits[expr] || portraits.neutral || null;
}

function renderPortraitPixels(assetId, scale) {
  const def = getPortraitDef(assetId);
  if (!def) return null;
  const rows = def.frames.bust;
  if (!rows) return null;
  const pix = parseFrame(rows, def.palette);
  // LIV-136: a 3D-baked portrait (`outline:false`) drops the hand outline, exactly
  // like the Tier B actor bake (LIV-115). Legacy hand-authored busts keep it.
  const outlined = def.outline === false ? pix : applyOutline(pix, def.palette['0'] || OUTLINE_COLOR);
  return scalePixels(outlined, scale);
}

/**
 * Draws the portrait bust at `(dx, dy)` scaled to `size` px. Returns
 * `{ w, h, scale, id }` when a portrait was drawn, or null for the fallback.
 */
export function drawPortrait(ctx, assetId, dx, dy, size = PORTRAIT_NATIVE) {
  const def = getPortraitDef(assetId);
  if (!def || !ctx) return null;
  const scale = Math.max(1, Math.round(size / PORTRAIT_NATIVE));
  const pixels = renderPortraitPixels(assetId, scale);
  if (!pixels) return null;
  if (typeof ctx.fillRect === 'function') {
    for (let y = 0; y < pixels.h; y += scale) {
      for (let x = 0; x < pixels.w; x += scale) {
        const i = (y * pixels.w + x) * 4;
        if (pixels.data[i + 3] === 0) continue;
        ctx.fillStyle = `rgba(${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]},${pixels.data[i + 3] / 255})`;
        ctx.fillRect(dx + x, dy + y, scale, scale);
      }
    }
  }
  return { dx, dy, w: pixels.w, h: pixels.h, scale, id: assetId };
}

/**
 * Renders the portrait to a data URL for inline `<img>` use. Returns null when
 * no canvas host exists (e.g. the Node test runner), letting the dialogue modal
 * keep the `portraitEmoji` fallback.
 */
export function portraitDataUrl(assetId, scale = 2) {
  const pixels = renderPortraitPixels(assetId, scale);
  if (!pixels) return null;
  let canvas = null;
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      canvas = document.createElement('canvas');
    } else if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(pixels.w, pixels.h);
    }
  } catch {
    canvas = null;
  }
  if (!canvas) return null;
  canvas.width = pixels.w;
  canvas.height = pixels.h;
  const cctx = canvas.getContext('2d');
  if (!cctx || typeof cctx.putImageData !== 'function') return null;
  const img = cctx.createImageData(pixels.w, pixels.h);
  img.data.set(pixels.data);
  cctx.putImageData(img, 0, 0);
  return typeof canvas.toDataURL === 'function' ? canvas.toDataURL() : null;
}

export { renderPortraitPixels };
