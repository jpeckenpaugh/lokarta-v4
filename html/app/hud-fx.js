/**
 * Lokarta: Come Into The Light - HUD & FX Controller
 */

import { CONFIG } from '../engine/index.js';
import { UI_CATALOG } from '../data/index.js';
import { HUDManager } from './hud-manager.js';
import { TitleAmbient } from './title-ambient.js';

/** Rotating sub-tile offsets that stagger floating pickup/combat text. */
const GROUND_DROP_OFFSETS = [
  [0, 0], [0, -1], [1, 0], [0, 1], [-1, 0],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
];

/** Presentation tunables for floating text. */
const FLOATING_TEXT = UI_CATALOG?.floatingText || {};
const FLOATING_DEFAULT_MS = Number(FLOATING_TEXT.defaultDurationMs) || 1200;
const FLOATING_STAGGER_PX = Number(FLOATING_TEXT.staggerPx) || 0;
const FLOATING_MAX_ACTIVE = Number(FLOATING_TEXT.maxActive) || 48;

/**
 * HUD refresh, combat log, FPS/audio chrome, floating text, and impact particles.
 * Assigned onto `LokartaApp.prototype` from `app-controller.js`.
 */
export const hudFxMethods = {
  updateAudioButton() {
    const audioBtn = document.getElementById('audio-toggle-btn');
    if (!audioBtn) return;
    const on = Boolean(this.options.soundEffects);
    audioBtn.textContent = on ? '🔊 Sound: ON' : '🔈 Sound: OFF';
    audioBtn.classList.toggle('muted', !on);
  },
  updateFpsBadge() {
    if (typeof document === 'undefined') return;
    const show = Boolean(this.options.showFps);
    if (show && !this.fpsEl) {
      this.fpsEl = document.createElement('span');
      this.fpsEl.id = 'fps-counter';
      this.fpsEl.className = 'fps-counter';
      const host = document.querySelector('.system-controls') || document.body;
      host.appendChild(this.fpsEl);
    } else if (!show && this.fpsEl) {
      this.fpsEl.remove();
      this.fpsEl = null;
    }
  },
  updateFps(dtMs) {
    this.fpsFrames += 1;
    this.fpsAccumMs += dtMs;
    if (this.fpsAccumMs >= 500) {
      this.fpsValue = Math.round((this.fpsFrames * 1000) / this.fpsAccumMs);
      this.fpsFrames = 0;
      this.fpsAccumMs = 0;
      if (this.fpsEl) this.fpsEl.textContent = `${this.fpsValue} FPS`;
    }
  },
  startTitleAmbient() {
    if (!this.titleAmbientCanvas) return;
    TitleAmbient.start(this.titleAmbientCanvas, { reduceMotion: this.reduceMotionResolved });
  },
  stopTitleAmbient() {
    TitleAmbient.stop();
  },
  triggerImpactBurst(pxX, pxY, visual, color) {
    const count = visual?.burstParticleCount || 14;
    const burstColor = visual?.burstColor || color || '#77e5ff';
    for (let k = 0; k < count; k++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 110;
      this.particles.push({
        x: pxX,
        y: pxY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 1.5 + Math.random() * 3,
        color: burstColor,
        elapsedMs: 0,
        durationMs: 300 + Math.random() * 200,
      });
    }
  },
  /**
   * Spawns a floating combat/pickup number. Each spawn gets a
   * rotating sub-tile offset and (for loot) a longer life so pickup and chest
   * messages spread around the player instead of piling on one pixel. The list
   * is ring-buffer capped so it can never grow unbounded.
   * @param {object} [opts] - `{ durationMs }` override
   */
  addFloatingText(text, gridX, gridY, color, opts = {}) {
    if (this.options && this.options.damageNumbers === false && /^-\d/.test(String(text))) return;
    const durationMs = Number(opts.durationMs) || FLOATING_DEFAULT_MS;
    this._floatingTextSeq = (this._floatingTextSeq || 0) + 1;
    const idx = (this._floatingTextSeq - 1) % GROUND_DROP_OFFSETS.length;
    const [ox, oy] = GROUND_DROP_OFFSETS[idx];
    this.floatingTexts.push({
      id: `ft_${Date.now()}_${Math.random()}`,
      text,
      x: gridX * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2 + ox * FLOATING_STAGGER_PX,
      y: gridY * CONFIG.GRID_SIZE - 6 + oy * FLOATING_STAGGER_PX,
      color,
      durationMs,
      elapsedMs: 0,
    });
    if (this.floatingTexts.length > FLOATING_MAX_ACTIVE) {
      this.floatingTexts.splice(0, this.floatingTexts.length - FLOATING_MAX_ACTIVE);
    }
  },
  updateHUD() {
    HUDManager.updateHUD(
      {
        statusBarsEl: this.statusBarsEl,
        sidebarEl: this.sidebarEl,
        loadoutEl: this.loadoutEl,
        backpackEl: this.backpackEl,
        questLogEl: this.questLogEl,
      },
      this
    );
    this.abilityBar.paint();
  },
  logCombat(message, category = 'system') {
    HUDManager.logCombat(this.combatLogScrollEl, message, category);
  },
  clearCombatLog() {
    HUDManager.clearCombatLog(this.combatLogScrollEl);
  }
};
