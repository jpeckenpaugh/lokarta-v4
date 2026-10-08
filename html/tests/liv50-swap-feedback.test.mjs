/**
 * LIV-50 — KO grayscale/on-back visual, swap beat, fluid swap + destination
 * flash.
 *
 * Locks the LIV-49 swap tokens as consumed by the engine/renderer: the downed
 * grayscale + 90° draw options, the input-locked handoff beat, the fluid camera
 * glide, the destination flash envelope, and the swap VFX draw seam. Tuning is
 * data-driven through `ui.json.knockout`, so these assertions read the catalog.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../engine/index.js';
import { UI_CATALOG } from '../data/index.js';
import { CanvasRenderer, downedDrawOpts } from '../app/canvas-renderer.js';
import { applyTintToHex, applyTintToPalette } from '../app/sprite-renderer.js';
import { SwapFeedback, SWAP_TOKENS, resolveEasing } from '../app/swap-feedback.js';

/** Counts draw primitives and tolerates the transform/composite setters. */
function makeCtxSpy() {
  const calls = { fills: 0, strokes: 0, total: 0, composite: null, alphas: [] };
  const ctx = {
    save() { calls.total++; },
    restore() { calls.total++; },
    beginPath() { calls.total++; },
    closePath() { calls.total++; },
    arc() { calls.total++; },
    fill() { calls.fills++; calls.total++; },
    stroke() { calls.strokes++; calls.total++; },
    fillRect() { calls.fills++; calls.total++; },
    translate() { calls.total++; },
    rotate() { calls.total++; },
    set globalAlpha(v) { calls.alphas.push(v); },
    set fillStyle(v) {},
    set strokeStyle(v) {},
    set lineWidth(v) {},
    set globalCompositeOperation(v) { calls.composite = v; },
  };
  return { ctx, calls };
}

const saturation = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return Math.max(r, g, b) - Math.min(r, g, b);
};

test('LIV-50 downed draw options consume the LIV-49 grayscale + on-back tokens', () => {
  const d = UI_CATALOG.knockout.visuals.downed;
  const opts = downedDrawOpts();
  assert.equal(opts.downed, true);
  assert.equal(opts.rotationDeg, d.rotationDeg, 'reads the authored rotation');
  assert.equal(opts.rotationDeg, 90, 'the body reads on its back');
  assert.equal(opts.dim, d.alpha);
  assert.equal(opts.tint.grayscale, true);
  assert.ok(opts.tint.desaturate >= 0.9, 'near-full grayscale');
  assert.equal(opts.tint.darken, d.darken);
  assert.equal(opts.tint.hex, d.tint);
  assert.deepEqual(opts.tint.luminance, d.luminance);
  // The options object is shared (no per-frame allocation on the render path).
  assert.equal(downedDrawOpts(), opts);
});

test('LIV-50 downed tint desaturates toward Rec.709 luminance then darkens', () => {
  const opts = downedDrawOpts();
  const before = '#ff0000';
  const after = applyTintToHex(before, opts.tint);
  assert.ok(saturation(after) < 30, `near-grayscale, got ${after}`);
  assert.ok(saturation(after) < saturation(before) / 5, 'saturation collapses');
  assert.notEqual(after, before);

  const palette = applyTintToPalette({ a: '#ff0000', b: '#00ff00', c: null }, opts.tint);
  assert.ok(palette.a && palette.b);
  assert.ok(saturation(palette.a) < 30);
  assert.ok(saturation(palette.b) < 30);
  assert.equal(palette.c, null, 'transparent palette slots stay null');
});

test('LIV-50 system 90° rotation is the authored token', () => {
  assert.equal(UI_CATALOG.knockout.visuals.downed.rotationDeg, 90);
  assert.equal(UI_CATALOG.knockout.visuals.downed.rotateOrigin, 'tileCenter');
});

test('LIV-50 handoff beat holds input for the token duration, then releases', () => {
  const fb = new SwapFeedback({ reduced: false });
  const start = 1000;
  fb.begin({ kind: 'handoff', fromX: 0, fromY: 0, toX: 5, toY: 5, nowMs: start });

  assert.equal(fb.beatMs, SWAP_TOKENS.beatMs);
  assert.ok(SWAP_TOKENS.beatMs > 0);
  assert.equal(fb.inputLocked(start), true, 'locked at the instant of handoff');
  assert.equal(fb.inputLocked(start + SWAP_TOKENS.beatMs - 1), true);
  assert.equal(fb.inputLocked(start + SWAP_TOKENS.beatMs), false, 'released on the beat boundary');
});

test('LIV-50 manual control-swap never locks input', () => {
  const fb = new SwapFeedback({ reduced: false });
  fb.begin({ kind: 'controlSwap', fromX: 0, fromY: 0, toX: 5, toY: 5, nowMs: 0 });
  assert.equal(fb.beatMs, 0);
  assert.equal(fb.inputLocked(0), false);
  assert.equal(fb.cfg.sfx.controlSwap, UI_CATALOG.knockout.swap.sfx.controlSwap);
});

test('LIV-50 destination flash ramps from peak and eases out over the token', () => {
  const fb = new SwapFeedback({ reduced: false });
  const flash = UI_CATALOG.knockout.swap.destinationFlash;
  const start = 5000;
  fb.begin({ kind: 'controlSwap', toX: 2, toY: 3, nowMs: start });

  const atStart = fb.flash(start);
  assert.equal(atStart.active, true);
  assert.equal(atStart.alpha, flash.peakAlpha, 'peaks at the authored alpha');
  assert.equal(atStart.mode, 'additive');
  assert.equal(atStart.color, flash.color);

  const mid = fb.flash(start + flash.durationMs / 2);
  assert.ok(mid.alpha > 0 && mid.alpha < flash.peakAlpha, 'eases down mid-flash');

  const after = fb.flash(start + flash.durationMs + 1);
  assert.equal(after.active, false);
  assert.equal(after.alpha, 0);
});

test('LIV-50 reduced motion collapses the beat/animation and dims the flash', () => {
  const fb = new SwapFeedback({ reduced: true });
  fb.begin({ kind: 'handoff', fromX: 0, fromY: 0, toX: 3, toY: 3, nowMs: 0 });
  assert.equal(fb.beatMs, SWAP_TOKENS.reducedMotion.beatMs);
  assert.equal(fb.positionMs, SWAP_TOKENS.reducedMotion.positionAnimMs);
  assert.equal(fb.cameraMs, SWAP_TOKENS.reducedMotion.cameraAnimMs);
  assert.equal(fb.inputLocked(0), false, 'no beat hold');
  const flash = fb.flash(0);
  assert.equal(flash.alpha, SWAP_TOKENS.reducedMotion.flashPeakAlpha, 'dimmed single frame');
});

test('LIV-50 position locator interpolates from the outgoing to the incoming tile', () => {
  const fb = new SwapFeedback({ reduced: false });
  fb.begin({ kind: 'controlSwap', fromX: 0, fromY: 0, toX: 8, toY: 4, nowMs: 0 });
  const p0 = fb.position(0);
  assert.deepEqual([p0.x, p0.y], [0, 0], 'starts on the outgoing tile');
  const mid = fb.position(SWAP_TOKENS.positionAnimMs / 2);
  assert.ok(mid.x > 0 && mid.x < 8, 'travels toward the destination');
  assert.ok(mid.y > 0 && mid.y < 4);
  const end = fb.position(SWAP_TOKENS.positionAnimMs + 1);
  assert.equal(end.t, 1);
  assert.deepEqual([end.x, end.y], [8, 4], 'lands on the incoming tile');
});

test('LIV-50 camera glide interpolates instead of snapping, then settles', () => {
  const renderer = new CanvasRenderer(null);
  renderer.cameraX = 100;
  renderer.cameraY = 100;
  const player = { x: 10, y: 10 };
  const w = 640;
  const h = 480;
  const targetX = player.x * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 - w / 2;

  renderer.startCameraGlide(SWAP_TOKENS.cameraAnimMs, SWAP_TOKENS.easing, 0);
  renderer.updateCamera(player, w, h, 0);
  assert.equal(renderer.cameraX, 100, 'holds the outgoing frame at t=0');

  renderer.updateCamera(player, w, h, SWAP_TOKENS.cameraAnimMs / 2);
  assert.ok(
    renderer.cameraX > Math.min(100, targetX) && renderer.cameraX < Math.max(100, targetX),
    'glides between the outgoing and destination frames'
  );

  renderer.updateCamera(player, w, h, SWAP_TOKENS.cameraAnimMs);
  assert.equal(renderer.cameraX, Math.round(targetX), 'settles on the destination');
  assert.equal(renderer.cameraGlide, null, 'glide retires when complete');
});

test('LIV-50 renderSwapVfx draws the locator + flash only while active', () => {
  const renderer = new CanvasRenderer(null);
  const fb = new SwapFeedback({ reduced: false });
  const spy = makeCtxSpy();
  fb.begin({ kind: 'controlSwap', fromX: 1, fromY: 1, toX: 4, toY: 4, nowMs: 0 });
  renderer.renderSwapVfx(spy.ctx, fb, 0);
  assert.ok(spy.calls.fills > 0, 'flash core + locator fill');
  assert.ok(spy.calls.strokes > 0, 'flash ring strokes');
  assert.equal(spy.calls.composite, 'lighter', 'additive destination flash');

  const idle = makeCtxSpy();
  fb.clear();
  renderer.renderSwapVfx(idle.ctx, fb, 0);
  assert.equal(idle.calls.total, 0, 'nothing draws once the swap retires');
});

test('LIV-50 easing resolves the authored cubic-bezier and ease-out curves', () => {
  const ease = resolveEasing(UI_CATALOG.knockout.swap.easing);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  const mid = ease(0.5);
  assert.ok(mid > 0 && mid < 1);
  const out = resolveEasing('ease-out');
  assert.ok(out(0.5) > 0.5, 'ease-out front-loads progress');
  assert.equal(resolveEasing('nonsense')(0.25), 0.25, 'unknown easing falls back to linear');
});
