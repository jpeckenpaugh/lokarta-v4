import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { SPRITE_CATALOG, SPRITE_MANIFEST, PROP_CATALOG, PROP_MANIFEST, PROP_IDS_BY_TIER } from '../assets/sprites/index.js';
import { PORTRAIT_CATALOG } from '../assets/portraits/index.js';
import { VOCATIONS_CATALOG, MONSTERS_CATALOG, TILE_THEMES_CATALOG, NPCS_CATALOG } from '../data/index.js';
import { CONFIG, TILE_TYPES } from '../engine/index.js';
import {
  SpriteRenderer,
  parseFrame,
  applyOutline,
  scalePixels,
  SPRITE_NATIVE,
  OUTLINE_COLOR,
  resolveSpriteId,
  resolveSpriteFrame,
  themeForFloor,
  wallFeatureFor,
  resolvePropId,
  wallShadeFor,
} from '../app/sprite-renderer.js';
import {
  resolvePortraitId,
  getPortraitDef,
  drawPortrait,
  PORTRAIT_NATIVE,
} from '../app/portrait-renderer.js';
import { exportPreviews } from '../../tools/render-sprite-preview.mjs';
import { validatePropAssets } from '../../tools/validate-prop-assets.mjs';
import {
  paletteCapFor,
  resolveRenderTier,
  validateSpriteDef,
  validateMultiTileDef,
  isMultiTile,
  validateCommittedMultiTileDefs,
  NATIVE_TILE,
  RENDER_TIERS,
} from '../../tools/validate-sprite-def.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SPRITES_DIR = path.join(ROOT, 'html', 'assets', 'sprites');
const PREVIEW_DIR = path.join(ROOT, 'docs', 'art', 'preview');
const FLOOR = '#1a1c23';

function srgbToLin(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
function alphaMask(rows, palette) {
  // Silhouette: which cells are non-transparent.
  return rows.map(row => [...row].map(ch => (palette[ch] ? '1' : '0')).join('')).join('\n');
}
function makeFakeCtx() {
  const calls = [];
  const noop = name => (...args) => { calls.push({ name, args }); };
  const ctx = {
    calls,
    canvas: { width: 256, height: 256 },
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save: noop('save'),
    restore: noop('restore'),
    fillRect: noop('fillRect'),
    strokeRect: noop('strokeRect'),
    fillText: noop('fillText'),
    beginPath: noop('beginPath'),
    closePath: noop('closePath'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    arc: noop('arc'),
    ellipse: noop('ellipse'),
    fill: noop('fill'),
    stroke: noop('stroke'),
    drawImage: noop('drawImage'),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.font = '';
  ctx.textAlign = 'left';
  Object.defineProperty(ctx, 'fillStyle', { get() { return '#000'; }, set() {} });
  return ctx;
}

test('Sprite assets', async t => {
  await t.test('1. manifest completeness for every catalog actor', () => {
    // Vocations always own a dedicated sprite.
    for (const id of Object.keys(VOCATIONS_CATALOG)) {
      assert.ok(SPRITE_MANIFEST.actors[id], `manifest missing actor ${id}`);
      assert.ok(SPRITE_CATALOG[id], `catalog missing actor ${id}`);
      const file = path.join(SPRITES_DIR, SPRITE_MANIFEST.actors[id].file);
      assert.ok(fs.existsSync(file), `sprite file missing for ${id}: ${file}`);
    }
    // Monsters resolve to their own sprite, or to a declared shared `spriteId`
    // (the renderer's own `resolveSpriteId` precedence), so a catalog opponent
    // can ship before it has bespoke art without breaking the art pipeline.
    for (const id of Object.keys(MONSTERS_CATALOG)) {
      const spriteId = resolveSpriteId(MONSTERS_CATALOG[id]) || id;
      assert.ok(SPRITE_MANIFEST.actors[spriteId], `manifest missing actor ${id} (sprite ${spriteId})`);
      assert.ok(SPRITE_CATALOG[spriteId], `catalog missing actor ${id} (sprite ${spriteId})`);
      const file = path.join(SPRITES_DIR, SPRITE_MANIFEST.actors[spriteId].file);
      assert.ok(fs.existsSync(file), `sprite file missing for ${id} (sprite ${spriteId}): ${file}`);
    }
  });

  await t.test('2. frame geometry matches native size', () => {
    for (const [id, def] of Object.entries(SPRITE_CATALOG)) {
      const { w, h } = def.native;
      assert.equal(def.id, id, `id mismatch for ${id}`);
      for (const [frameId, rows] of Object.entries(def.frames)) {
        assert.equal(rows.length, h, `${id}/${frameId} row count`);
        for (const row of rows) assert.equal(row.length, w, `${id}/${frameId} row width`);
      }
    }
  });

  await t.test('3. palette integrity (tier-aware cap, valid hex, used chars declared)', () => {
    for (const [id, def] of Object.entries(SPRITE_CATALOG)) {
      const cap = paletteCapFor(def);
      const entries = Object.entries(def.palette);
      assert.ok(entries.length <= cap, `${id} palette has ${entries.length} entries > ${cap} (${resolveRenderTier(def)})`);
      for (const [k, v] of entries) {
        assert.equal(k.length, 1, `${id} palette key ${k}`);
        if (v === null) { assert.equal(k, '.'); continue; }
        assert.match(v, /^#[0-9a-f]{6}$/i, `${id} palette ${k} = ${v}`);
      }
      for (const rows of Object.values(def.frames)) {
        for (const row of rows) {
          for (const ch of row) {
            assert.ok(ch === '.' || def.palette[ch], `${id} uses undeclared palette char "${ch}"`);
          }
        }
      }
    }
  });

  await t.test('4. required states/dirs and frame counts', () => {
    for (const [id, def] of Object.entries(SPRITE_CATALOG)) {
      const expectedDeath = id === 'abyssal_overlord' ? 6 : 4;
      for (const state of ['idle', 'walk', 'attack', 'hit', 'death']) {
        assert.ok(def.animations[state], `${id} missing animation ${state}`);
        for (const dir of ['down', 'up', 'side']) {
          assert.ok(Array.isArray(def.animations[state][dir]), `${id}.${state}.${dir}`);
          assert.ok(def.animations[state][dir].length > 0, `${id}.${state}.${dir} empty`);
          for (const fid of def.animations[state][dir]) assert.ok(def.frames[fid], `${id} missing frame ${fid}`);
        }
      }
      for (const dir of ['down', 'up', 'side']) {
        assert.equal(def.animations.idle[dir].length, 1, `${id} idle ${dir}`);
        assert.equal(def.animations.walk[dir].length, 2, `${id} walk ${dir}`);
        assert.equal(def.animations.attack[dir].length, 3, `${id} attack ${dir}`);
        assert.equal(def.animations.hit[dir].length, 1, `${id} hit ${dir}`);
        assert.equal(def.animations.death[dir].length, expectedDeath, `${id} death ${dir}`);
      }
      assert.equal(def.animations.walk.advanceOn, 'step', `${id} walk should advance on step`);
    }
  });

  await t.test('5. applyOutline adds a 1px outline and is idempotent', () => {
    const palette = { '.': null, x: '#ff0000' };
    const rows = [
      '.....',
      '.....',
      '..x..',
      '.....',
      '.....',
    ];
    const pix = parseFrame(rows, palette);
    const out = applyOutline(pix, OUTLINE_COLOR);
    const at = (x, y) => out.data[(y * out.w + x) * 4 + 3] > 0;
    // 4-neighbours of (2,2) become outline; diagonal corners stay transparent.
    assert.ok(at(1, 2) && at(3, 2) && at(2, 1) && at(2, 3), 'neighbours outlined');
    assert.equal(at(1, 1), false, 'diagonal not outlined');
    assert.equal(at(0, 0), false, 'far pixel untouched');
    const again = applyOutline(out, OUTLINE_COLOR);
    assert.deepEqual([...again.data], [...out.data], 'outline pass is idempotent');
  });

  await t.test('6. parseFrame + applyOutline are deterministic', () => {
    for (const def of Object.values(SPRITE_CATALOG)) {
      const rows = def.frames.idle_down;
      const a = applyOutline(parseFrame(rows, def.palette), OUTLINE_COLOR);
      const b = applyOutline(parseFrame(rows, def.palette), OUTLINE_COLOR);
      assert.deepEqual([...a.data], [...b.data]);
    }
  });

  await t.test('7. scale integrality', () => {
    assert.equal(CONFIG.GRID_SIZE % SPRITE_NATIVE, 0);
    const scale = SpriteRenderer.scaleForSize(CONFIG.GRID_SIZE);
    assert.ok(Number.isInteger(scale) && scale >= 1);
    const scaled = scalePixels(parseFrame(SPRITE_CATALOG.magician.frames.idle_down, SPRITE_CATALOG.magician.palette), scale);
    assert.equal(scaled.w, SPRITE_NATIVE * scale);
  });

  await t.test('8. every actor has a rim color with >= 3:1 contrast vs the floor', () => {
    for (const [id, def] of Object.entries(SPRITE_CATALOG)) {
      const best = Math.max(0, ...Object.values(def.palette).filter(Boolean).map(v => contrast(v, FLOOR)));
      assert.ok(best >= 3.0, `${id} best contrast ${best.toFixed(2)} < 3.0`);
    }
  });

  await t.test('9. cultist silhouettes differ and elite carries a non-color cue', () => {
    const shadow = SPRITE_CATALOG.shadow_cultist;
    const elite = SPRITE_CATALOG.elite_cultist;
    const a = alphaMask(shadow.frames.idle_down, shadow.palette);
    const b = alphaMask(elite.frames.idle_down, elite.palette);
    assert.notEqual(a, b, 'shadow/elite silhouettes must differ by shape');
    assert.ok(Object.values(elite.palette).includes('#facc15'), 'elite cultist must include gold trim');
  });

  await t.test('10. committed preview PNGs match a fresh export (no drift)', () => {
    assert.ok(fs.existsSync(PREVIEW_DIR), 'docs/art/preview must exist');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokarta-preview-'));
    exportPreviews(tmp);
    const committed = fs.readdirSync(PREVIEW_DIR).filter(f => f.endsWith('.png')).sort();
    const fresh = fs.readdirSync(tmp).filter(f => f.endsWith('.png')).sort();
    assert.deepEqual(fresh, committed, 'exported preview set differs from committed');
    for (const f of committed) {
      const a = fs.readFileSync(path.join(PREVIEW_DIR, f));
      const b = fs.readFileSync(path.join(tmp, f));
      assert.ok(a.equals(b), `preview drift: ${f}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('11. fallback safety: unknown ids do not throw and use procedural art', () => {
    const ctx = makeFakeCtx();
    assert.doesNotThrow(() => {
      SpriteRenderer.drawMonster(ctx, { type: 'not_a_monster', x: 0, y: 0, hp: 5, max_hp: 10 }, 0, 0);
    });
    assert.doesNotThrow(() => {
      SpriteRenderer.drawPlayer(ctx, { vocation: 'not_a_vocation' }, 0, 0);
    });
    assert.equal(ctx.calls.some(c => c.name === 'drawImage'), false, 'no sprite blit for unknown ids');
    assert.ok(ctx.calls.some(c => c.name === 'fill'), 'procedural fallback drew shapes');

    // Unknown id resolves to no sprite; a known id resolves and draws.
    assert.equal(resolveSpriteId({ type: 'not_a_monster' }), null);
    assert.equal(resolveSpriteId({ type: 'giant_rat' }), 'giant_rat');
    const ctx2 = makeFakeCtx();
    const geo = SpriteRenderer.drawActor(ctx2, { type: 'giant_rat', facing: 'left' }, 0, 0);
    assert.ok(geo && geo.w === SPRITE_NATIVE * SpriteRenderer.scaleForSize(CONFIG.GRID_SIZE));
    assert.ok(ctx2.calls.some(c => c.name === 'fillRect'), 'pixel path drew via fillRect');
  });

  await t.test('12. facing maps to three authored directions with left mirroring', () => {
    const def = SPRITE_CATALOG.paladin;
    for (const [facing, dir] of [['down', 'down'], ['up', 'up'], ['right', 'side'], ['left', 'side']]) {
      const r = resolveSpriteFrame(def, { state: 'walk', dir: dir, frame: 0 });
      assert.equal(r.dir, dir, `facing ${facing}`);
      assert.ok(def.frames[r.frameId]);
    }
    const death = resolveSpriteFrame(def, { state: 'death', dir: 'down', frame: 99 });
    assert.equal(death.frameId, def.animations.death.down[def.animations.death.down.length - 1], 'death frame clamps to last');
  });

  await t.test('13. full render pass runs without throwing and blits sprites after the mask', async () => {
    const { CanvasRenderer } = await import('../app/canvas-renderer.js');
    const { GridMap, createPlayer } = await import('../engine/index.js');
    const { createAnimState } = await import('../app/animation-state.js');

    const gridMap = new GridMap();
    const matrix = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => 0));
    gridMap.loadFromMatrix(matrix);

    const player = createPlayer('magician');
    player.x = 2; player.y = 2;
    player.anim = createAnimState('down');
    player.facing = 'down';

    const monster = {
      type: 'giant_rat', id: 'r1', name: 'Giant Rat', x: 3, y: 2,
      hp: 7, max_hp: 10, visible: true, facing: 'left', anim: createAnimState('left'),
    };

    const renderer = new CanvasRenderer(null);
    renderer.canvas = { width: 256, height: 256 };
    renderer.ctx = makeFakeCtx();

    assert.doesNotThrow(() => {
      renderer.render(gridMap, player, [monster], [], [], [], monster.id, [], []);
    });
    assert.ok(renderer.ctx.calls.some(c => c.name === 'fillRect'), 'render loop drew pixels');
    // Monster health bar (hp < max_hp) must be drawn.
    assert.ok(renderer.ctx.calls.filter(c => c.name === 'fillRect').length > 10, 'expected many fillRect calls');
  });
});

test('Prop & tower tile assets', async t => {
  await t.test('14. prop manifest covers keys, chests and gated doors per tier', () => {
    const expected = [
      'key_copper', 'key_silver', 'key_gold',
      'chest_copper', 'chest_silver', 'chest_gold',
      'gated_door_copper', 'gated_door_silver', 'gated_door_gold',
    ];
    for (const id of expected) {
      assert.ok(PROP_MANIFEST[id], `manifest missing prop ${id}`);
      assert.ok(PROP_CATALOG[id], `catalog missing prop ${id}`);
      const file = path.join(SPRITES_DIR, PROP_MANIFEST[id].file);
      assert.ok(fs.existsSync(file), `prop file missing for ${id}: ${file}`);
    }
    // Tier resolver stays in sync with the catalog.
    for (const [tier, ids] of Object.entries(PROP_IDS_BY_TIER)) {
      for (const id of Object.values(ids)) {
        assert.ok(PROP_CATALOG[id], `PROP_IDS_BY_TIER.${tier} -> ${id} not in catalog`);
      }
    }
  });

  await t.test('15. prop geometry, palette and per-tier rim contrast hold', () => {
    const { errors } = validatePropAssets({ spritesDir: SPRITES_DIR });
    assert.deepEqual(errors, [], `prop validator reported: ${errors.join('; ')}`);
  });

  await t.test('16. key/chest/door tiers differ structurally (non-color cue)', () => {
    const rows = d => Object.values(d.frames)[0];
    const count = (d, pred) => rows(d).reduce((n, r) => n + [...r].filter(pred).length, 0);
    // Doors: gold adds studs and a crown emblem; at least as many metal pixels as copper.
    const copperDoor = count(PROP_CATALOG.gated_door_copper, ch => ch === 'b');
    const goldDoor = count(PROP_CATALOG.gated_door_gold, ch => ch === 'b' || ch === 'c');
    assert.ok(goldDoor > copperDoor, 'gold door must add structural metal over copper');
    // Keys: gold ring carries a gem accent the lower tiers do not.
    assert.ok(PROP_CATALOG.key_gold.palette.i && PROP_CATALOG.key_gold.frames.icon.some(r => r.includes('i')), 'gold key gem accent');
  });

  await t.test('17. every tower level defines a full, distinct tile theme', () => {
    const levels = TILE_THEMES_CATALOG.levels;
    assert.ok(levels, 'tile_themes.levels missing');
    // The launch five levels are the level-scanned default tower themes; LIV-5
    // adds further named tower palettes (emberforge / rime aerie) resolved by
    // each tower's `theme.levelTheme` map.
    const keys = Object.keys(levels);
    assert.ok(keys.length >= 5, 'expected at least the 5 launch tower levels');
    const seen = new Set();
    for (const [n, lv] of Object.entries(levels)) {
      for (const key of ['wall', 'floor', 'stairs', 'door']) {
        assert.ok(lv[key], `level ${n} missing ${key} theme`);
      }
      assert.ok(lv.features && lv.features.banner && lv.features.sconce && lv.features.window, `level ${n} missing features`);
      assert.match(lv.floor.fill, /^#[0-9a-f]{6}$/i, `level ${n} floor not a hex`);
      // Actor rim gate: floor luminance must stay dark for >=3:1 actor rims.
      assert.ok(luminance(lv.floor.fill) <= 0.02, `level ${n} floor too bright (${luminance(lv.floor.fill)})`);
      seen.add(lv.wall.fill);
    }
    assert.equal(seen.size, keys.length, 'each level must have a distinct wall fill');
  });

  await t.test('18. committed props preview matches a fresh export (no drift)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokarta-props-'));
    exportPreviews(tmp);
    const propsPath = path.join(PREVIEW_DIR, 'props.png');
    assert.ok(fs.existsSync(propsPath), 'docs/art/preview/props.png missing');
    assert.ok(fs.readFileSync(propsPath).equals(fs.readFileSync(path.join(tmp, 'props.png'))), 'props preview drift');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('Tower art integration', async t => {
  await t.test('19. themeForFloor merges level theme over root and falls back', () => {
    const root = TILE_THEMES_CATALOG;
    const l3 = themeForFloor(3);
    assert.equal(l3.name, root.levels['3'].name, 'floor 3 must resolve its level theme');
    assert.equal(l3.wall.fill, root.levels['3'].wall.fill);
    assert.ok(l3.floor && l3.floor.fill, 'merged theme keeps root floor');
    // Every tower level resolves to a distinct wall fill.
    const fills = new Set([1, 2, 3, 4, 5].map(n => themeForFloor(n).wall.fill));
    assert.equal(fills.size, 5, 'per-level wall fills must be distinct');
    // Out-of-range floors fall back to the legacy root catalog.
    for (const bad of [0, -1, 6, 99, NaN, undefined, null]) {
      assert.equal(themeForFloor(bad), root, `floor ${bad} should fall back to root`);
    }
  });

  await t.test('20. wall motifs are deterministic and gated on tile context', () => {
    const level2 = themeForFloor(2);
    const first = wallFeatureFor(3, 4, level2, true, true, false);
    assert.equal(wallFeatureFor(3, 4, level2, true, true, false), first, 'pure hash: repeatable');
    assert.equal(wallFeatureFor(3, 4, TILE_THEMES_CATALOG, true, true, false), null, 'no features without decor');

    const find = (theme, flags, want) => {
      for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 60; x++) {
          const [below, adjacent, near] = flags;
          if (wallFeatureFor(x, y, theme, below, adjacent, near) === want) return { x, y };
        }
      }
      return null;
    };

    const sconce = find(level2, [true, true, false], 'sconce');
    const banner = find(level2, [true, true, false], 'banner');
    const windowTile = find(themeForFloor(3), [false, false, false], 'window');
    assert.ok(sconce, 'level 2 should place sconces on wall-with-floor-below');
    assert.ok(banner, 'level 2 should place banners away from doors');
    assert.ok(windowTile, 'level 3 should place windows on wall-without-floor-neighbour');

    // A door within 2 tiles suppresses the banner motif.
    assert.notEqual(wallFeatureFor(banner.x, banner.y, level2, true, true, true), 'banner');
    // Banners need a wall tile: they still require decor, not a floor tile below.
    assert.equal(wallFeatureFor(sconce.x, sconce.y, level2, true, true, false), 'sconce');
  });

  await t.test('21. gated doors blit the tier prop and fall back without a tier', () => {
    const level1 = themeForFloor(1);
    const ctx = makeFakeCtx();
    SpriteRenderer.drawTile(ctx, TILE_TYPES.GATED_DOOR, 0, 0, 64, { theme: level1, tier: 'gold', open: false });
    assert.ok(ctx.calls.filter(c => c.name === 'fillRect').length > 50, 'closed gold door should blit prop pixels');

    const ctxOpen = makeFakeCtx();
    SpriteRenderer.drawTile(ctxOpen, TILE_TYPES.GATED_DOOR, 0, 0, 64, { theme: level1, tier: 'gold', open: true });
    assert.ok(ctxOpen.calls.filter(c => c.name === 'fillRect').length > 50, 'open gold door should blit prop pixels');

    const ctxFallback = makeFakeCtx();
    SpriteRenderer.drawTile(ctxFallback, TILE_TYPES.GATED_DOOR, 0, 0, 64, { theme: level1 });
    assert.ok(ctxFallback.calls.filter(c => c.name === 'fillRect').length < 50, 'no tier should use procedural fallback');
  });

  await t.test('22. keys/chests resolve tier props; non-prop items fall back', () => {
    assert.equal(resolvePropId({ type: 'key', keyTier: 'silver' }), 'key_silver');
    assert.equal(resolvePropId({ type: 'chest', chestTier: 'gold' }), 'chest_gold');
    assert.equal(resolvePropId({ type: 'chest', tier: 'copper' }), 'chest_copper');
    assert.equal(resolvePropId({ type: 'key' }), null, 'missing tier must not resolve');
    assert.equal(resolvePropId({ type: 'consumable', item_id: 'health_potion' }), null);

    const keyCtx = makeFakeCtx();
    SpriteRenderer.drawItem(keyCtx, { type: 'key', item_id: 'key_copper', keyTier: 'copper', quantity: 1 }, 0, 0, 64);
    assert.ok(keyCtx.calls.filter(c => c.name === 'fillRect').length > 50, 'copper key should blit prop pixels');

    const chestCtx = makeFakeCtx();
    SpriteRenderer.drawItem(chestCtx, { type: 'chest', item_id: 'chest_silver', chestTier: 'silver', opened: true, quantity: 1 }, 0, 0, 64);
    assert.ok(chestCtx.calls.filter(c => c.name === 'fillRect').length > 50, 'open silver chest should blit prop pixels');

    const potionCtx = makeFakeCtx();
    assert.doesNotThrow(() => {
      SpriteRenderer.drawItem(potionCtx, { type: 'consumable', item_id: 'health_potion', quantity: 2 }, 0, 0, 64);
    });
    assert.equal(potionCtx.calls.some(c => c.name === 'drawImage'), false, 'no sprite blit for procedural items');
  });

  await t.test('23. full render pass applies the level theme and door tiers', async () => {
    const { CanvasRenderer } = await import('../app/canvas-renderer.js');
    const { GridMap, createPlayer } = await import('../engine/index.js');
    const { createAnimState } = await import('../app/animation-state.js');

    const gridMap = new GridMap();
    const matrix = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => TILE_TYPES.FLOOR));
    gridMap.loadFromMatrix(matrix);
    const gate = gridMap.getTile(3, 3);
    gate.type = TILE_TYPES.GATED_DOOR;
    gate.gateTier = 'silver';

    const player = createPlayer('magician');
    player.x = 1;
    player.y = 1;
    player.current_floor = 3;
    player.facing = 'down';
    player.anim = createAnimState('down');
    gridMap.tiles[1][1].isLit = true;
    gridMap.tiles[3][3].isLit = true;

    const renderer = new CanvasRenderer(null);
    renderer.canvas = { width: 256, height: 256 };
    renderer.ctx = makeFakeCtx();

    assert.doesNotThrow(() => {
      renderer.render(gridMap, player, [], [], [], [], null, [], []);
    });
    assert.ok(renderer.ctx.calls.filter(c => c.name === 'fillRect').length > 50, 'silver gate prop should blit');
  });
});

test('Wall shade variation', () => {
  const level2 = themeForFloor(2);
  // Deterministic by tile coordinate: same (x, y) always resolves the same shade.
  assert.equal(wallShadeFor(level2, 4, 7), wallShadeFor(level2, 4, 7), 'pure hash: repeatable');
  // The authored palette is used across a wall run.
  const seen = new Set();
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) seen.add(wallShadeFor(level2, x, y));
  assert.ok(seen.size >= 2, 'a wall run must show more than one shade');
  // Falls back to the flat fill when no palette is authored.
  assert.equal(wallShadeFor({ wall: { fill: '#123456' } }, 1, 2), '#123456');
  assert.equal(wallShadeFor(null, 0, 0), undefined);
});

test('NPC identity atlas (LIV-81)', async t => {
  const npcs = NPCS_CATALOG.npcs;

  await t.test('24. every NPC owns a registered actor sprite (manifest + catalog + file)', () => {
    for (const npc of npcs) {
      const id = npc.npcSpriteId;
      assert.ok(id, `${npc.id} must declare npcSpriteId`);
      assert.ok(SPRITE_CATALOG[id], `catalog missing NPC actor ${id}`);
      const meta = SPRITE_MANIFEST.actors[id];
      assert.ok(meta, `manifest missing NPC actor ${id}`);
      assert.equal(meta.kind, 'npc', `${id} manifest kind`);
      const file = path.join(SPRITES_DIR, meta.file);
      assert.ok(fs.existsSync(file), `npc sprite file missing for ${id}: ${file}`);
      // The renderer's precedence resolves the bespoke id over the vocation fallback.
      assert.equal(resolveSpriteId(npc), id, `${npc.id} must resolve to its own sprite`);
    }
  });

  await t.test('25. NPC frame geometry, palette and per-actor rim contrast hold', () => {
    for (const npc of npcs) {
      const def = SPRITE_CATALOG[npc.npcSpriteId];
      const { w, h } = def.native;
      assert.equal(w, SPRITE_NATIVE, `${def.id} native width`);
      assert.equal(h, SPRITE_NATIVE, `${def.id} native height`);
      for (const [frameId, rows] of Object.entries(def.frames)) {
        assert.equal(rows.length, h, `${def.id}/${frameId} row count`);
        for (const row of rows) assert.equal(row.length, w, `${def.id}/${frameId} row width`);
      }
      const entries = Object.entries(def.palette);
      assert.ok(entries.length <= paletteCapFor(def), `${def.id} palette has ${entries.length} entries`);
      assert.equal(def.palette['0'], OUTLINE_COLOR, `${def.id} must use the shared outline`);
      for (const [k, v] of entries) {
        assert.equal(k.length, 1, `${def.id} palette key ${k}`);
        if (v === null) { assert.equal(k, '.'); continue; }
        assert.match(v, /^#[0-9a-f]{6}$/i, `${def.id} palette ${k} = ${v}`);
      }
      for (const rows of Object.values(def.frames)) {
        for (const row of rows) {
          for (const ch of row) assert.ok(ch === '.' || def.palette[ch], `${def.id} uses undeclared palette char "${ch}"`);
        }
      }
      const best = Math.max(0, ...Object.values(def.palette).filter(Boolean).map(v => contrast(v, FLOOR)));
      assert.ok(best >= 3.0, `${def.id} best contrast ${best.toFixed(2)} < 3.0`);
      // Full 5-state x 3-dir contract.
      for (const state of ['idle', 'walk', 'attack', 'hit', 'death']) {
        for (const dir of ['down', 'up', 'side']) {
          assert.ok(Array.isArray(def.animations[state][dir]) && def.animations[state][dir].length > 0, `${def.id}.${state}.${dir}`);
          for (const fid of def.animations[state][dir]) assert.ok(def.frames[fid], `${def.id} missing frame ${fid}`);
        }
      }
      assert.equal(def.animations.idle.down.length, 1, `${def.id} idle down`);
      assert.equal(def.animations.walk.down.length, 2, `${def.id} walk down`);
      assert.equal(def.animations.attack.down.length, 3, `${def.id} attack down`);
      assert.equal(def.animations.death.down.length, 4, `${def.id} death down`);
      assert.equal(def.animations.walk.advanceOn, 'step', `${def.id} walk advance`);
    }
  });

  await t.test('26. no two NPCs share an idle_down silhouette (the point of I1)', () => {
    const masks = new Map();
    for (const npc of npcs) {
      const def = SPRITE_CATALOG[npc.npcSpriteId];
      const mask = alphaMask(def.frames.idle_down, def.palette);
      const clash = masks.get(mask);
      assert.ok(!clash, `${npc.npcSpriteId} silhouette matches ${clash}`);
      masks.set(mask, npc.npcSpriteId);
    }
    assert.equal(masks.size, npcs.length, 'every NPC silhouette must be distinct');
  });

  await t.test('27. NPC previews are committed and match a fresh export (no drift)', () => {
    assert.ok(fs.existsSync(PREVIEW_DIR), 'docs/art/preview must exist');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lokarta-npc-preview-'));
    exportPreviews(tmp);
    const expected = ['portraits.png', ...npcs.map(n => `${n.npcSpriteId}.png`)];
    for (const f of expected) {
      assert.ok(fs.existsSync(path.join(PREVIEW_DIR, f)), `committed preview missing: ${f}`);
      assert.ok(fs.existsSync(path.join(tmp, f)), `fresh export missing: ${f}`);
      assert.ok(
        fs.readFileSync(path.join(PREVIEW_DIR, f)).equals(fs.readFileSync(path.join(tmp, f))),
        `preview drift: ${f}`
      );
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('28. portrait catalog covers every portraits map value with a 48x48 bust', () => {
    const seen = new Set();
    for (const npc of npcs) {
      for (const expression of ['neutral', 'warm', 'urgent']) {
        const assetId = npc.portraits[expression];
        assert.ok(assetId, `${npc.id}.portraits.${expression}`);
        assert.ok(!seen.has(assetId), `${assetId} must be unique`);
        seen.add(assetId);
        const def = getPortraitDef(assetId);
        assert.ok(def, `portrait catalog missing ${assetId}`);
        assert.equal(def.native.w, PORTRAIT_NATIVE, `${assetId} native width`);
        assert.equal(def.native.h, PORTRAIT_NATIVE, `${assetId} native height`);
        assert.equal(def.expression, expression, `${assetId} expression`);
        const rows = def.frames.bust;
        assert.equal(rows.length, PORTRAIT_NATIVE, `${assetId} row count`);
        for (const row of rows) assert.equal(row.length, PORTRAIT_NATIVE, `${assetId} row width`);
        assert.ok(Object.keys(def.palette).length <= paletteCapFor(def), `${assetId} palette > cap`);
        for (const row of rows) {
          for (const ch of row) assert.ok(ch === '.' || def.palette[ch], `${assetId} uses undeclared char "${ch}"`);
        }
        const best = Math.max(0, ...Object.values(def.palette).filter(Boolean).map(v => contrast(v, FLOOR)));
        assert.ok(best >= 3.0, `${assetId} best contrast ${best.toFixed(2)} < 3.0`);
      }
    }
    assert.equal(seen.size, npcs.length * 3, 'portrait count');
  });

  await t.test('29. expression changes the bust silhouette (warm != urgent)', () => {
    for (const npc of npcs) {
      const masks = ['neutral', 'warm', 'urgent'].map((expr) => {
        const def = getPortraitDef(npc.portraits[expr]);
        return alphaMask(def.frames.bust, def.palette);
      });
      assert.notEqual(masks[0], masks[2], `${npc.id} neutral and urgent busts must differ by shape`);
      assert.notEqual(masks[1], masks[2], `${npc.id} warm and urgent busts must differ by shape`);
    }
  });

  await t.test('30. resolvePortraitId is data-only with safe fallbacks', () => {
    const halden = npcs.find(n => n.id === 'captain_halden');
    assert.equal(resolvePortraitId(halden.portraits, 'warm'), 'portrait_captain_halden_warm');
    assert.equal(resolvePortraitId(halden.portraits, 'urgent'), 'portrait_captain_halden_urgent');
    assert.equal(resolvePortraitId(halden.portraits, undefined), 'portrait_captain_halden_neutral', 'defaults to neutral');
    assert.equal(resolvePortraitId(halden.portraits, 'nope'), 'portrait_captain_halden_neutral', 'unknown expression falls back');
    assert.equal(resolvePortraitId(null, 'warm'), null, 'no map -> no asset');
    assert.equal(getPortraitDef('portrait_does_not_exist'), null, 'unknown asset -> fallback');
  });

  await t.test('31. drawPortrait blits a known bust and returns null for unknowns', () => {
    const ctx = makeFakeCtx();
    const geo = drawPortrait(ctx, 'portrait_captain_halden_warm', 0, 0, 96);
    assert.ok(geo && geo.w === PORTRAIT_NATIVE * geo.scale, 'portrait geometry');
    assert.ok(ctx.calls.filter(c => c.name === 'fillRect').length > 50, 'portrait blitted pixels');
    const ctx2 = makeFakeCtx();
    assert.equal(drawPortrait(ctx2, 'portrait_does_not_exist', 0, 0, 96), null, 'unknown asset draws nothing');
  });

  await t.test('32. resolveSpriteId prefers npcSpriteId and falls through when unknown', () => {
    assert.equal(resolveSpriteId({ npcSpriteId: 'npc_wick', spriteId: 'archer' }), 'npc_wick');
    // Migration safety: an unknown bespoke id falls back to the shared sprite.
    assert.equal(resolveSpriteId({ npcSpriteId: 'npc_not_authored', spriteId: 'fighter' }), 'fighter');
    assert.equal(resolveSpriteId({ npcSpriteId: 'npc_not_authored', vocation: 'paladin' }), 'paladin');
  });
});

// LIV-108 (Phase 0): land the Tier B "baked" contract + multi-tile footprint
// assertion so richer/bigger assets stay CI-validated. Tier A is unchanged.
test('Tier B sprite contract (LIV-108)', async t => {
  const hasErr = (def, re) => validateSpriteDef(def).errors.some(e => re.test(e));
  const mtDef = (over = {}) => {
    const tiles = over.tiles || { w: 4, h: 2 };
    const native = over.native || { w: tiles.w * NATIVE_TILE, h: tiles.h * NATIVE_TILE };
    return {
      id: 'synthetic_building',
      kind: 'building',
      native,
      anchor: { x: Math.floor(native.w / 2), y: Math.max(0, native.h - 2) },
      palette: { '.': null, '0': OUTLINE_COLOR },
      frames: { view_0: Array.from({ length: native.h }, () => '0'.repeat(native.w)) },
      tiles,
      placement: { mode: 'multi-tile-blit', footprint: [0, 0, tiles.w - 1, tiles.h - 1] },
      ...over,
    };
  };

  await t.test('33. palette cap is tier-aware (indexed 16 / baked 32); Tier A unchanged', () => {
    assert.deepEqual(RENDER_TIERS, ['indexed', 'baked']);
    assert.equal(resolveRenderTier({}), 'indexed', 'absent renderTier defaults to indexed');
    assert.equal(resolveRenderTier({ renderTier: 'baked' }), 'baked');
    assert.equal(paletteCapFor({}), 16);
    assert.equal(paletteCapFor({ renderTier: 'indexed' }), 16);
    assert.equal(paletteCapFor({ renderTier: 'baked' }), 32);

    // Tier A is the default: every committed actor stays indexed at the ≤16 cap
    // unless it is an explicit opt-in Tier B asset (LIV-110 integrated the baked
    // rukiya archer into the live catalog).
    const TIERB_ACTORS = new Set(['archer']);
    for (const [id, def] of Object.entries(SPRITE_CATALOG)) {
      if (TIERB_ACTORS.has(id)) {
        assert.equal(resolveRenderTier(def), 'baked', `${id} opts into Tier B`);
        assert.ok(Object.keys(def.palette).length <= 32, `${id} baked cap`);
      } else {
        assert.equal(resolveRenderTier(def), 'indexed', `${id} must stay Tier A`);
        assert.ok(Object.keys(def.palette).length <= 16, `${id} indexed cap`);
      }
    }

    // A 22-entry baked palette validates; the same def fails as indexed.
    const palette = { '.': null, '0': OUTLINE_COLOR };
    for (let i = 0; i < 20; i++) palette[i.toString(36)] = '#101010';
    const baked = { id: 'synthetic_baked', renderTier: 'baked', native: { w: 2, h: 2 }, palette, frames: { idle: ['00', '00'] } };
    assert.deepEqual(validateSpriteDef(baked).errors, [], 'a ≤32 baked palette is valid');
    const indexed = { ...baked, id: 'synthetic_indexed' };
    delete indexed.renderTier;
    assert.ok(hasErr(indexed, /palette \d+ > 16/), 'a >16 indexed palette is rejected');
    // An unknown tier is rejected, never silently treated as baked.
    assert.ok(hasErr({ ...baked, renderTier: 'ultra' }, /renderTier/), 'unknown renderTier is rejected');
  });

  await t.test('34. every catalog sprite validates through the shared schema', () => {
    for (const [id, def] of Object.entries(SPRITE_CATALOG)) {
      assert.deepEqual(validateSpriteDef(def, { label: id }).errors, [], id);
    }
  });

  await t.test('35. multi-tile defs: whole-tile native, ≤512×512, footprint span == tile span', () => {
    const { errors, count } = validateCommittedMultiTileDefs();
    assert.equal(errors.length, 0, `committed multi-tile defs: ${errors.join('; ')}`);
    assert.ok(count >= 2, `expected the committed 2×3 and 4×2 PoC defs, found ${count}`);

    // A 4×2 (128×64) building with a matching footprint validates cleanly.
    assert.deepEqual(validateMultiTileDef(mtDef()).errors, []);
    // A large landmark (LIV-113 longhouse: 12×4 = 384×128) now validates too;
    // the per-axis ceiling was generalised from 4 tiles to 16 (512px).
    assert.deepEqual(validateMultiTileDef(mtDef({ tiles: { w: 12, h: 4 } })).errors, [], '12×4 landmark validates');
    // native not a multiple of 32 (also != tiles*32).
    assert.ok(hasErr(mtDef({ native: { w: 100, h: 64 } }), /multiple of 32/), 'non-tile-multiple native rejected');
    // native wider than the 512px ceiling.
    assert.ok(hasErr(mtDef({ native: { w: 544, h: 32 }, tiles: { w: 17, h: 1 } }), /exceeds 512/), '>512px native rejected');
    // footprint span disagrees with the canvas tile span.
    assert.ok(hasErr(mtDef({ placement: { mode: 'multi-tile-blit', footprint: [0, 0, 1, 1] } }), /footprint span/), 'footprint mismatch rejected');
    // A non-multi-tile def is not silently accepted by the multi-tile guard.
    assert.ok(validateMultiTileDef({ id: 'one_tile', native: { w: 32, h: 32 }, palette: { '.': null } }).errors.length > 0);
  });
});
