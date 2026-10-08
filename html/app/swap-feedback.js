/**
 * Lokarta: Come Into The Light - Control-swap feedback (LIV-50)
 *
 * Pure, browser-free state for the KO handoff / manual cycle presentation:
 *   - the input-locked dramatic `beat` before control transfers;
 *   - the fluid position interpolation from the outgoing to the incoming tile;
 *   - the destination activity flash envelope; and
 *   - the camera-glide timing the renderer consumes.
 *
 * All tuning comes from `ui.json.knockout.swap` (LIV-49 tokens): no magic
 * numbers live here. The module allocates only on `begin()` (a discrete event,
 * never per tick/frame) and its per-frame reads return cached scalars, so the
 * hot path stays GC-free.
 */

import { UI_CATALOG } from '../data/index.js';

/** Resolved LIV-49 swap tokens, read once so the per-frame path allocates nothing. */
export const SWAP_TOKENS = (() => {
  const s = UI_CATALOG?.knockout?.swap || {};
  const f = s.destinationFlash || {};
  const rm = s.reducedMotion || {};
  const n = (val, fallback) => (Number.isFinite(Number(val)) ? Number(val) : fallback);
  return {
    beatMs: n(s.beatMs, 0),
    beatLockInput: s.beatLockInput !== false,
    beatPauseWorld: s.beatPauseWorld === true,
    positionAnimMs: n(s.positionAnimMs, 0),
    cameraAnimMs: n(s.cameraAnimMs, 0),
    easing: s.easing || 'cubic-bezier(0.4,0,0.2,1)',
    reducedMotion: {
      beatMs: n(rm.beatMs, 0),
      positionAnimMs: n(rm.positionAnimMs, 0),
      cameraAnimMs: n(rm.cameraAnimMs, 0),
      flashPeakAlpha: n(rm.flashPeakAlpha, 0.25),
    },
    flash: {
      color: f.color || '#fde68a',
      coreColor: f.coreColor || '#fffbeb',
      durationMs: n(f.durationMs, 1000),
      easing: f.easing || 'ease-out',
      peakAlpha: n(f.peakAlpha, 0.7),
      mode: f.mode || 'additive',
      ringRadiusTiles: n(f.ringRadiusTiles, 0.75),
      ringLineWidthPx: n(f.ringLineWidthPx, 3),
      ringAlpha: n(f.ringAlpha, 0.9),
    },
    sfx: {
      koHandoff: (s.sfx && s.sfx.koHandoff) || 'koHandoff',
      controlSwap: (s.sfx && s.sfx.controlSwap) || 'controlSwap',
    },
  };
})();

/* ==================== Easing ==================== */

function cubicBezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = calc(t, x1, x2) - x;
      if (Math.abs(dx) < 1e-6) break;
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    t = Math.max(0, Math.min(1, t));
    return calc(t, y1, y2);
  };
}

const NAMED_EASINGS = {
  linear: (t) => t,
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
  'ease-in': cubicBezier(0.42, 0, 1, 1),
  'ease-out': cubicBezier(0, 0, 0.58, 1),
  'ease-in-out': cubicBezier(0.42, 0, 0.58, 1),
};

const _easingCache = new Map();

/**
 * Resolve a CSS-style easing spec (`ease-out` or `cubic-bezier(a,b,c,d)`) into a
 * pure `t -> eased` function. Unknown specs fall back to linear. Cached by spec.
 * @param {string} spec
 * @returns {(t: number) => number}
 */
export function resolveEasing(spec) {
  if (typeof spec === 'function') return spec;
  const key = String(spec || 'linear');
  const cached = _easingCache.get(key);
  if (cached) return cached;
  let fn = NAMED_EASINGS[key];
  if (!fn) {
    const m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(key);
    if (m) fn = cubicBezier(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
  }
  if (!fn) fn = NAMED_EASINGS.linear;
  _easingCache.set(key, fn);
  return fn;
}

/** Runtime prefers-reduced-motion check (false when matchMedia is absent). */
export function prefersReducedMotion() {
  try {
    return !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Control-swap presentation state machine. Create once; call `begin()` on a
 * handoff/cycle event and read scalars per frame.
 */
export class SwapFeedback {
  constructor(opts = {}) {
    this.cfg = opts.tokens || SWAP_TOKENS;
    this.reduced = opts.reduced !== undefined ? !!opts.reduced : prefersReducedMotion();
    this._ease = resolveEasing(this.cfg.easing);
    this._flashEase = resolveEasing(this.cfg.flash.easing);
    this.active = false;
    this.kind = null;
    this.memberId = null;
    this.fromX = 0;
    this.fromY = 0;
    this.toX = 0;
    this.toY = 0;
    this.startMs = 0;
    this.beatMs = 0;
    this.positionMs = 0;
    this.cameraMs = 0;
    this.flashMs = 0;
    this.flashPeak = 0;
  }

  /**
   * Start a new swap presentation. Discrete event — allocates a little; never
   * called from the per-tick/per-frame path.
   * @param {{ kind?: string, fromX?: number, fromY?: number, toX?: number, toY?: number, memberId?: string|null, nowMs?: number, reduced?: boolean }} ev
   * @returns {SwapFeedback}
   */
  begin(ev = {}) {
    const rm = ev.reduced !== undefined ? !!ev.reduced : this.reduced;
    const t = this.cfg;
    const rr = t.reducedMotion;
    this.reduced = rm;
    this.active = true;
    this.kind = ev.kind || 'controlSwap';
    this.memberId = ev.memberId != null ? ev.memberId : null;
    this.fromX = Number.isFinite(ev.fromX) ? ev.fromX : 0;
    this.fromY = Number.isFinite(ev.fromY) ? ev.fromY : 0;
    this.toX = Number.isFinite(ev.toX) ? ev.toX : this.fromX;
    this.toY = Number.isFinite(ev.toY) ? ev.toY : this.fromY;
    this.startMs = Number.isFinite(ev.nowMs) ? ev.nowMs : 0;
    // The input beat is a KO-handoff beat only; manual cycles never lock input.
    this.beatMs = this.kind === 'handoff' && t.beatLockInput ? (rm ? rr.beatMs : t.beatMs) : 0;
    this.positionMs = rm ? rr.positionAnimMs : t.positionAnimMs;
    this.cameraMs = rm ? rr.cameraAnimMs : t.cameraAnimMs;
    this.flashMs = rm ? 0 : t.flash.durationMs;
    this.flashPeak = rm ? rr.flashPeakAlpha : t.flash.peakAlpha;
    return this;
  }

  /** Seconds of a sub-timeline elapsed since `begin`, as 0..1 progress. */
  _progress(nowMs, durationMs) {
    if (!(durationMs > 0)) return 1;
    return clamp01((nowMs - this.startMs) / durationMs);
  }

  /** True while the incoming actor's input is held for the dramatic beat. */
  inputLocked(nowMs) {
    return this.active && this.beatMs > 0 && (nowMs - this.startMs) < this.beatMs;
  }

  /** Eased position progress + the interpolated tile, for the moving locator. */
  position(nowMs) {
    if (!this.active) return { active: false, t: 1, x: this.toX, y: this.toY };
    const raw = this._progress(nowMs, this.positionMs);
    const t = this._ease(raw);
    return {
      active: true,
      t: raw,
      progressed: t,
      x: this.fromX + (this.toX - this.fromX) * t,
      y: this.fromY + (this.toY - this.fromY) * t,
    };
  }

  /** Eased camera-glide progress (0..1) the renderer can read if it does not own timing. */
  camera(nowMs) {
    return this._ease(this._progress(nowMs, this.cameraMs));
  }

  /** Destination flash envelope: alpha ramps to peak then eases out over `flashMs`. */
  flash(nowMs) {
    const f = this.cfg.flash;
    if (!this.active || !(nowMs - this.startMs <= this.flashMs) || this.flashMs < 0) {
      return { active: false, alpha: 0, progress: 1, ...f, peakAlpha: this.flashPeak };
    }
    if (this.flashMs === 0) {
      // Reduced motion: a single dim frame at the reduced peak.
      return { active: (nowMs - this.startMs) <= 0, alpha: this.flashPeak, progress: 0, ...f, peakAlpha: this.flashPeak };
    }
    const progress = clamp01((nowMs - this.startMs) / this.flashMs);
    const alpha = this.flashPeak * (1 - this._flashEase(progress));
    return { active: true, alpha, progress, ...f, peakAlpha: this.flashPeak };
  }

  /**
   * Expire the presentation once every sub-timeline is done. Cheap; safe to
   * call each tick/frame. Returns true while still active.
   */
  update(nowMs) {
    if (!this.active) return false;
    const done = (nowMs - this.startMs) >= Math.max(this.beatMs, this.positionMs, this.cameraMs, this.flashMs);
    if (done) this.active = false;
    return this.active;
  }

  clear() {
    this.active = false;
    return this;
  }
}
