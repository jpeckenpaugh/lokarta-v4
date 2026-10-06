/**
 * Lokarta: Come Into The Light - Title Ambient ("Emberfall Parallax")
 * A cheap, evocative canvas loop that mimics gameplay without simulating it.
 */

import { UI_CATALOG, TILE_THEMES_CATALOG } from '../data/index.js';

const TAU = Math.PI * 2;

function createRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TitleAmbient = {
  _state: null,

  /**
   * Starts the ambient loop on the given canvas.
   * @param {HTMLCanvasElement|null} canvas
   * @param {{ reduceMotion?: boolean }} [options]
   */
  start(canvas, { reduceMotion = false } = {}) {
    this.stop();
    if (!canvas) return;

    const cfg = UI_CATALOG.titleAmbient || {};
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const theme = TILE_THEMES_CATALOG || {};
    const dpr = Math.min(cfg.maxDpr || 1.5, (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
    const rng = createRng(1337);

    const state = {
      canvas,
      ctx,
      cfg,
      dpr,
      theme,
      width: 0,
      height: 0,
      timeSec: 0,
      farOffset: 0,
      nearOffset: 0,
      rafId: null,
      running: false,
      lastFrameMs: 0,
      accumulatorMs: 0,
      onResize: null,
      onVisibility: null,
      embers: [],
    };

    state.onResize = () => this._resize(state);
    state.onVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        this._pause(state);
      } else if (state.running && !state.rafId) {
        state.lastFrameMs = 0;
        state.rafId = requestAnimationFrame(ts => this._frame(state, ts));
      }
    };

    this._resize(state);
    this._seedEmbers(state, rng);
    canvas.classList.add('active');

    window.addEventListener('resize', state.onResize);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', state.onVisibility);
    }

    this._state = state;

    if (reduceMotion) {
      // Draw exactly one static frame and schedule no rAF.
      this._draw(state, 0);
      return;
    }

    state.running = true;
    state.lastFrameMs = 0;
    state.rafId = requestAnimationFrame(ts => this._frame(state, ts));
  },

  /** Stops the ambient loop and hides the canvas. */
  stop() {
    const state = this._state;
    if (!state) return;
    this._pause(state);
    if (state.onResize) window.removeEventListener('resize', state.onResize);
    if (state.onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', state.onVisibility);
    }
    state.canvas.classList.remove('active');
    this._state = null;
  },

  isRunning() {
    return Boolean(this._state && (this._state.running || this._state.rafId));
  },

  _pause(state) {
    state.running = false;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
  },

  _resize(state) {
    const parent = state.canvas.parentElement || state.canvas;
    const width = Math.max(1, parent.clientWidth || window.innerWidth || 1);
    const height = Math.max(1, parent.clientHeight || window.innerHeight || 1);
    state.width = width;
    state.height = height;
    state.canvas.width = Math.round(width * state.dpr);
    state.canvas.height = Math.round(height * state.dpr);
    state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  },

  _seedEmbers(state, rng) {
    const count = state.cfg.particleCount || 36;
    const embers = [];
    for (let i = 0; i < count; i += 1) {
      embers.push({
        x: rng(),
        y: rng(),
        radius: 1 + rng() * 1.5,
        rise: 12 + rng() * 16,
        sway: 0.1 + rng() * 0.2,
        phase: rng() * TAU,
        period: 4 + rng() * 3,
        offset: rng(),
      });
    }
    state.embers = embers;
  },

  _frame(state, timestampMs) {
    if (!state.running) return;
    if (!state.lastFrameMs) state.lastFrameMs = timestampMs;
    const elapsed = timestampMs - state.lastFrameMs;
    state.lastFrameMs = timestampMs;
    state.accumulatorMs += elapsed;

    const frameMs = 1000 / (state.cfg.targetFps || 30);
    if (state.accumulatorMs >= frameMs) {
      const steps = Math.min(3, Math.floor(state.accumulatorMs / frameMs));
      state.accumulatorMs -= steps * frameMs;
      const dtSec = (steps * frameMs) / 1000;
      state.timeSec += dtSec;
      state.farOffset += (state.cfg.parallaxFarPxPerSec || 4) * dtSec;
      state.nearOffset += (state.cfg.parallaxNearPxPerSec || 10) * dtSec;
      this._draw(state, state.timeSec);
    }

    state.rafId = requestAnimationFrame(ts => this._frame(state, ts));
  },

  _draw(state, timeSec) {
    const { ctx, width, height, theme, cfg } = state;
    if (!ctx) return;

    const bg = theme.background?.fill || '#0a0b10';
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    const wallFill = theme.wall?.fill || '#2a2f3b';
    const floorFill = theme.floor?.fill || '#1a1c23';

    // Layer 1: vault parallax silhouette bands.
    this._drawBand(state, state.nearOffset, height * 0.72, height * 0.18, wallFill);
    this._drawBand(state, state.farOffset, height * 0.62, height * 0.14, shade(wallFill, -0.35));
    this._drawBand(state, state.farOffset * 0.6, height * 0.84, height * 0.16, shade(floorFill, -0.2));

    // Layer 2: torch light pools.
    this._drawTorchPool(state, width * 0.18, height * 0.52, timeSec, '#e5b95c');
    this._drawTorchPool(state, width * 0.82, height * 0.52, timeSec + 0.6, '#f59e0b');

    // Layer 3: embers.
    this._drawEmbers(state, timeSec);
  },

  _drawBand(state, offset, baseY, bandHeight, color) {
    const { ctx, width } = state;
    const tile = 48;
    const startX = -((offset % tile) + tile);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    for (let x = startX; x < width + tile; x += tile) {
      const wobble = Math.sin((x + offset) * 0.01) * 3;
      const h = bandHeight * (0.55 + 0.45 * Math.abs(Math.sin((x * 0.37 + offset * 0.05))));
      ctx.fillRect(x, baseY - h + wobble, tile - 6, h);
    }
    ctx.globalAlpha = 1;
  },

  _drawTorchPool(state, cx, cy, timeSec, color) {
    const { ctx, cfg } = state;
    const pulse = 1 + 0.11 * Math.sin(timeSec * TAU * (cfg.torchPulseHz || 0.7));
    const radius = 180 * pulse;
    const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius);
    grad.addColorStop(0, hexToRgba(color, 0.22));
    grad.addColorStop(0.5, hexToRgba(color, 0.08));
    grad.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fill();
  },

  _drawEmbers(state, timeSec) {
    const { ctx, width, height } = state;
    for (const ember of state.embers) {
      const cycle = (ember.offset + timeSec / ember.period) % 1;
      const x = ember.x * width + Math.sin(timeSec * ember.sway + ember.phase) * 18;
      const y = height - cycle * height;
      const alpha = Math.sin(cycle * Math.PI);
      ctx.globalAlpha = Math.max(0, alpha) * 0.8;
      ctx.fillStyle = '#f5c76b';
      ctx.beginPath();
      ctx.arc(x, y, ember.radius, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
};

function hexToRgba(hex, alpha) {
  const clean = String(hex).replace('#', '');
  const value = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean.padEnd(6, '0').slice(0, 6);
  const r = parseInt(value.slice(0, 2), 16) || 0;
  const g = parseInt(value.slice(2, 4), 16) || 0;
  const b = parseInt(value.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function shade(hex, amount) {
  const clean = String(hex).replace('#', '');
  const value = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean.padEnd(6, '0').slice(0, 6);
  const channels = [0, 2, 4].map(i => {
    const base = parseInt(value.slice(i, i + 2), 16) || 0;
    const next = amount < 0 ? base * (1 + amount) : base + (255 - base) * amount;
    return Math.max(0, Math.min(255, Math.round(next)));
  });
  return `rgb(${channels.join(', ')})`;
}

export default TitleAmbient;
