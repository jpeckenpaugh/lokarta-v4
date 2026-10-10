#!/usr/bin/env node
/**
 * Lokarta 3D-baked NPC dialogue portraits (LIV-136, Phase 3 of LIV-132).
 *
 * Replaces the hand-authored 48x48 busts with a head still rendered from the
 * SAME rigged human GLBs that `tools/bake-npc-actors.mjs` bakes the overworld
 * actors from (the LIV-133 mesh -> NPC mapping). The board directive
 * (LIV-132 comment `6ad62aea`): the dialogue-window head shot should be a still
 * of the 3D model's own head.
 *
 * Pipeline (mirrors the actor bake, `docs/art/3d-sprite-mapping.md`):
 *   - sample the rigged skeleton at the idle phase, front azimuth (az 0)
 *   - a HEAD-FOCUSED orthographic projection (centre on the Head joint, window
 *     from above the crown to below the shoulders) so the bust fills the canvas
 *   - baked 135-degree key + rim + exposure (the actor bake's light model)
 *   - the NPC's catalog `renderTheme` identity tint (npcs.json) so the two NPCs
 *     that share a mesh still read apart, without recolouring skin/hair
 *   - 512px software raster -> 48px box-downscale -> <=255-colour median-cut
 *   - NO outline (Tier B contract, LIV-115), exactly like the actor bake
 *
 * Unlike the overworld actor bake, the portrait keeps the model's real texture
 * colours (the board asked for "stills of the head of the 3d model itself"); the
 * actor's luma-ramp recolor is dropped because it washes out a large face. Only
 * a light `renderTheme` tint is applied for shared-mesh identity.
 *
 * Expression: the static mesh has no blend shapes, so the three dialogue
 * expressions are posed on the rig itself — data-declared head/neck rotations
 * (`EXPRESSION_POSES`) that shift the silhouette (a tilt for `warm`, a forward
 * set of the head for `urgent`). This keeps the spec §3 readability rule and the
 * "expression changes the bust silhouette" T0 assertion true while every still
 * remains a genuine render of the 3D head.
 *
 * Authoring-only + deterministic: identical GLB inputs -> byte-identical
 * artifacts. Writes committed artifacts under
 * `docs/art/3d-poc/phase4/portraits/`; `tools/integrate-npc-portraits.mjs` is
 * the GLB-free step that assembles `html/assets/portraits/portraits.json`, so
 * T0 stays GLB-free in CI.
 *
 * Usage: node tools/bake-npc-portraits.mjs [npcSpriteId ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseGLB, readAccessor, readClip, skinAtTime, jointPositionByName,
  renderWorld, downscale, medianCut, canonicalPaletteOrder, quantize,
  loadBaseColor, encodePNG,
  BAKED_ALPHABET, BAKED_OPAQUE_BUDGET,
} from './gltf-to-sprite.mjs';
import { NPC_SPECS, findGlb, ROOT, ACTOR_RISE, ACTOR_RIM, ACTOR_AMBIENT, ACTOR_EXPOSURE } from './bake-npc-actors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORTRAIT_ARTIFACT_DIR = path.join(ROOT, 'docs', 'art', '3d-poc', 'phase4', 'portraits');
const NPCS_CATALOG_PATH = path.join(ROOT, 'html', 'data', 'npcs.json');

/** Portrait native size (spec §3): the dialogue bust is a 48x48 still. */
export const PORTRAIT_SIZE = 48;
/** Head raster is rendered large then box-downscaled, like the actor bake. */
export const PORTRAIT_RENDER_RES = 512;
/** The three dialogue expressions, in the canonical order the catalog keys use. */
export const EXPRESSIONS = ['neutral', 'warm', 'urgent'];

/** Bones the head framing reads; named as authored in the lokarta-private rigs. */
export const HEAD_JOINTS = {
  head: 'mixamorig:Head',
  crown: 'mixamorig:HeadTop_End',
  leftShoulder: 'mixamorig:LeftShoulder',
  rightShoulder: 'mixamorig:RightShoulder',
};

/**
 * The bust window in head-heights: `crown` padding above the crown (headroom for
 * a hat) and `shoulder` drop below the shoulder line (upper chest). Both are
 * fractions of the Head -> crown bone length, so the framing scales with each
 * actor's head and needs no per-NPC constants.
 */
export const BUST_FRAME = { crown: 0.20, shoulder: 0.60, fill: 0.92 };

/**
 * Expression poses (data, not code). Each entry composes a rotation about a
 * local bone axis, so `neutral` stays the rig's idle head. Axes are in the
 * bone's local space: +X = nod (pitch), +Y = turn (yaw), +Z = tilt (roll).
 */
export const EXPRESSION_POSES = {
  neutral: [],
  warm: [
    { joint: HEAD_JOINTS.head, axis: [0, 0, 1], deg: 10 },
    { joint: HEAD_JOINTS.head, axis: [1, 0, 0], deg: -5 },
  ],
  urgent: [
    { joint: HEAD_JOINTS.head, axis: [1, 0, 0], deg: 14 },
  ],
};

/** Hamilton quaternion product (glTF [x,y,z,w] order). */
export function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Unit quaternion for `deg` degrees about `axis`. */
export function axisAngleQuat(axis, deg) {
  const r = (deg * Math.PI) / 180 / 2;
  const s = Math.sin(r);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(r)];
}

/**
 * Resolves the `poseOverrides` Map `skinAtTime` expects for one expression: the
 * base local rotation of each targeted bone composed with its declared deltas.
 * Returns null for an empty pose so the neutral bake stays a pure idle sample.
 */
export function poseOverridesFor(glb, expression) {
  const deltas = EXPRESSION_POSES[expression] || [];
  if (!deltas.length) return null;
  const byNode = new Map();
  for (const d of deltas) {
    const idx = glb.json.nodes.findIndex((n) => n.name === d.joint);
    if (idx < 0) continue;
    const base = glb.json.nodes[idx].rotation || [0, 0, 0, 1];
    const cur = byNode.get(idx) || base;
    byNode.set(idx, quatMultiply(cur, axisAngleQuat(d.axis, d.deg)));
  }
  const out = new Map();
  for (const [idx, rotation] of byNode) out.set(idx, { rotation });
  return out;
}

/** The GLB-free-safe render context for one NPC (primitive + skin + texture). */
export async function loadNpcRenderContext(glbPath) {
  const glb = parseGLB(glbPath);
  const j = glb.json;
  const skin = (j.skins || [])[0];
  if (!skin) throw new Error(`bake-npc-portraits: ${glbPath} has no skin (unrigged)`);
  const meshNode = j.nodes.findIndex((n) => n.mesh !== undefined);
  if (meshNode < 0) throw new Error(`bake-npc-portraits: no mesh node in ${glbPath}`);
  const prim = j.meshes[j.nodes[meshNode].mesh].primitives[0];
  const tex = await loadBaseColor(glb, prim.material);
  const ibm = readAccessor(glb, skin.inverseBindMatrices);
  const anim = readClip(glb, null, meshNode);
  const roots = j.scenes[j.scene || 0].nodes;
  const uv = prim.attributes.TEXCOORD_0 != null ? readAccessor(glb, prim.attributes.TEXCOORD_0) : null;
  const idx = prim.indices != null ? readAccessor(glb, prim.indices) : null;
  const count = readAccessor(glb, prim.attributes.POSITION).count;
  return { glb, j, skin, prim, tex, ibm, anim, roots, uv, idx, count };
}

/**
 * The head-focused projection for one NPC, derived from the idle pose joints so
 * every actor frames its own head. Returns `{ cx, cy, cz, scale, rise }` where
 * `(cx,cy,cz)` is the model-space point mapped to the canvas centre.
 */
export function headProjection(ctx) {
  const { glb, anim, prim, ibm, roots } = ctx;
  const idle = skinAtTime(glb, anim, 0, prim, ibm, 0, roots);
  const head = jointPositionByName(glb, HEAD_JOINTS.head, idle.world);
  const crown = jointPositionByName(glb, HEAD_JOINTS.crown, idle.world);
  const ls = jointPositionByName(glb, HEAD_JOINTS.leftShoulder, idle.world);
  const rs = jointPositionByName(glb, HEAD_JOINTS.rightShoulder, idle.world);
  if (!head || !crown || !ls || !rs) throw new Error('bake-npc-portraits: rig missing head/shoulder joints');
  const headH = Math.hypot(crown[0] - head[0], crown[1] - head[1], crown[2] - head[2]) || 1;
  const shoulderY = (ls[1] + rs[1]) / 2;
  const bustTop = crown[1] + BUST_FRAME.crown * headH;
  const bustBot = shoulderY - BUST_FRAME.shoulder * headH;
  const winH = Math.max(headH, bustTop - bustBot);
  const cy = (bustTop + bustBot) / 2;
  return { cx: head[0], cy, cz: head[2], scale: (PORTRAIT_RENDER_RES * BUST_FRAME.fill) / winH, rise: ACTOR_RISE };
}

/** Renders one expression to a 48x48 float RGBA buffer (pre-quantize). */
function renderExpression(ctx, proj, expression, renderRes = PORTRAIT_RENDER_RES) {
  const { glb, anim, prim, ibm, roots, uv, idx, count, tex } = ctx;
  const overrides = poseOverridesFor(glb, expression);
  const pose = skinAtTime(glb, anim, 0, prim, ibm, 0, roots, overrides);
  const riseRad = (proj.rise * Math.PI) / 180;
  const projection = {
    w: renderRes, h: renderRes, cx: proj.cx, cy: proj.cy, cz: proj.cz, scale: proj.scale,
    ca: 1, sa: 0, cr: Math.cos(riseRad), sr: Math.sin(riseRad),
  };
  const hi = renderWorld({
    pos: pose.pos, nrm: pose.nrm, uv, idx, count, tex, proj: projection,
    ambient: ACTOR_AMBIENT, exposure: ACTOR_EXPOSURE, rim: ACTOR_RIM, bounce: 0.35,
  });
  return downscale(hi, PORTRAIT_SIZE, PORTRAIT_SIZE);
}

function hex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** Linear RGB blend of a colour toward `hex` by `amount` (0..1). */
function mixToward(r, g, b, hexStr, amount) {
  const h = hexStr.replace('#', '');
  const tr = parseInt(h.slice(0, 2), 16), tg = parseInt(h.slice(2, 4), 16), tb = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, amount));
  return [r + (tr - r) * a, g + (tg - g) * a, b + (tb - b) * a];
}

/**
 * Reads the per-NPC `renderTheme` identity tints from the gameplay catalog. These
 * are the same `{ hex, amount }` washes the actor pipeline carries; the portrait
 * applies them so the two NPCs that share a mesh still read apart. Missing/empty
 * themes fall back to no tint (the model's raw texture).
 */
export function loadRenderThemes(catalogPath = NPCS_CATALOG_PATH) {
  const themes = {};
  try {
    const data = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    for (const npc of data.npcs || []) {
      const t = npc.renderTheme;
      if (t && t.hex && Number.isFinite(Number(t.amount)) && Number(t.amount) > 0) {
        themes[npc.id] = { hex: t.hex, amount: Number(t.amount) };
      }
    }
  } catch {
    // No catalog (e.g. a standalone bake) -> raw texture for every NPC.
  }
  return themes;
}

/** Bakes one NPC: 3 expression stills sharing one tint + palette + quantization. */
export async function bakePortrait(spec, themes = loadRenderThemes()) {
  const glbPath = findGlb(spec.glb);
  const ctx = await loadNpcRenderContext(glbPath);
  const proj = headProjection(ctx);
  const npcId = spec.id.replace(/^npc_/, '');
  const theme = themes[npcId] || null;
  const rendered = {};
  for (const expression of EXPRESSIONS) {
    const px = renderExpression(ctx, proj, expression);
    if (theme) {
      const n = px.w * px.h;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (px.rgba[o + 3] <= 0) continue;
        const c = mixToward(px.rgba[o], px.rgba[o + 1], px.rgba[o + 2], theme.hex, theme.amount);
        px.rgba[o] = c[0]; px.rgba[o + 1] = c[1]; px.rgba[o + 2] = c[2];
      }
    }
    rendered[expression] = px;
  }
  // One palette across all three expressions so the bust never shifts colour.
  const all = [];
  for (const px of Object.values(rendered)) {
    for (let i = 0; i < px.w * px.h; i++) {
      if (px.rgba[i * 4 + 3] > 128) all.push([px.rgba[i * 4], px.rgba[i * 4 + 1], px.rgba[i * 4 + 2]]);
    }
  }
  const palRGB = canonicalPaletteOrder(medianCut(all, BAKED_OPAQUE_BUDGET));
  const palette = { '.': null };
  palRGB.forEach((c, i) => { palette[BAKED_ALPHABET[i]] = hex(...c); });
  const frames = {};
  for (const [expression, px] of Object.entries(rendered)) frames[expression] = quantize(px, palRGB, BAKED_ALPHABET);
  return {
    def: {
      npcId: spec.id.replace(/^npc_/, ''),
      npcSpriteId: spec.id,
      kind: 'portrait',
      renderTier: 'baked',
      baked3d: true,
      outline: false,
      source: `${spec.glb} (glTF-Transform)`,
      method: `skinned-skeleton-sample(idle) -> head-ortho-software-raster@512 -> ${PORTRAIT_SIZE}px box-downscale${theme ? ` -> renderTheme tint ${theme.hex}@${theme.amount}` : ''} -> ${palRGB.length}-colour median-cut (<=${BAKED_OPAQUE_BUDGET}) -> no outline (Tier B)`,
      camera: { projection: 'orthographic', rise: ACTOR_RISE, azimuth: 0 },
      ...(theme ? { theme: { ...theme } } : {}),
      native: { w: PORTRAIT_SIZE, h: PORTRAIT_SIZE },
      quantize: { method: 'median-cut', budget: BAKED_OPAQUE_BUDGET },
      palette,
      expressions: frames,
    },
    palette: palRGB,
    rendered,
  };
}

/** Contact-sheet PNG of every baked NPC x expression, for review/evidence. */
function writeSheet(results, outDir) {
  const pad = 4;
  const tile = PORTRAIT_SIZE * 2;
  const cols = results.length;
  const W = cols * (tile + pad) + pad;
  const H = EXPRESSIONS.length * (tile + pad) + pad;
  const bg = [10, 11, 14, 255];
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255; }
  results.forEach((r, c) => {
    EXPRESSIONS.forEach((expr, row) => {
      const px = r.rendered[expr];
      const ox = c * (tile + pad) + pad;
      const oy = row * (tile + pad) + pad;
      for (let y = 0; y < PORTRAIT_SIZE; y++) {
        for (let x = 0; x < PORTRAIT_SIZE; x++) {
          const si = (y * PORTRAIT_SIZE + x) * 4;
          const a = px.rgba[si + 3] / 255;
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const di = ((oy + y * 2 + dy) * W + (ox + x * 2 + dx)) * 4;
            out[di] = Math.round(px.rgba[si] * a + bg[0] * (1 - a));
            out[di + 1] = Math.round(px.rgba[si + 1] * a + bg[1] * (1 - a));
            out[di + 2] = Math.round(px.rgba[si + 2] * a + bg[2] * (1 - a));
            out[di + 3] = 255;
          }
        }
      }
    });
  });
  fs.writeFileSync(path.join(outDir, 'npc_portraits_3d_sheet.png'), encodePNG(W, H, out));
}

export async function bakeAll(ids = null) {
  fs.mkdirSync(PORTRAIT_ARTIFACT_DIR, { recursive: true });
  const specs = ids && ids.length ? ids.map((id) => NPC_SPECS.find((s) => s.id === id)).filter(Boolean) : NPC_SPECS;
  const themes = loadRenderThemes();
  const results = [];
  for (const spec of specs) {
    const res = await bakePortrait(spec, themes);
    fs.writeFileSync(path.join(PORTRAIT_ARTIFACT_DIR, `${spec.id}.portrait.json`), JSON.stringify(res.def, null, 2) + '\n');
    results.push({ id: spec.id, palette: res.palette.length, rendered: res.rendered });
  }
  writeSheet(results, PORTRAIT_ARTIFACT_DIR);
  return results.map((r) => ({ id: r.id, palette: r.palette, expressions: EXPRESSIONS.length }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = await bakeAll(process.argv.slice(2));
  for (const r of out) console.log(`Wrote ${r.id}: ${r.expressions} expressions, ${r.palette}-colour palette -> docs/art/3d-poc/phase4/portraits`);
}
