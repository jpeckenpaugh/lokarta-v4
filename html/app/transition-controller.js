/**
 * Lokarta: Come Into The Light - Transition Controller
 *
 * Timed, whitelisted screen-transition controller. Every transition locks
 * input for its duration and always releases it (via try/finally plus a hard
 * timeout), so a dropped frame can never trap input.
 */

import { UI_CATALOG } from '../data/index.js';

export class TransitionController {
  /**
   * @param {HTMLElement|null} overlayEl - the #screen-transition element
   */
  constructor(overlayEl) {
    this.overlay = overlayEl;
    this.lockCount = 0;
    this.reducedMotion = false;
    this._phaseResolvers = [];
    this._phaseTimers = [];
    this._skipHandler = null;
  }

  /** @param {boolean} value */
  setReducedMotion(value) {
    this.reducedMotion = Boolean(value);
  }

  /** @returns {boolean} */
  isLocked() {
    return this.lockCount > 0;
  }

  /** Releases any active transition lock (used on hard teardown). */
  forceRelease() {
    this._finishPhase();
    this.lockCount = 0;
    this._applyLockClass();
  }

  /**
   * Runs a named transition around an optional swap callback.
   * @param {string} kind - key in UI_CATALOG.transitions
   * @param {Function} [swap] - async callback invoked at the midpoint
   * @param {{ skippable?: boolean }} [options]
   * @returns {Promise<void>} resolves when the incoming screen is interactive
   */
  async run(kind, swap, options = {}) {
    const config = (UI_CATALOG.transitions && UI_CATALOG.transitions[kind]) || { ms: 220, easing: 'ease-out', skippable: true };
    const skippable = options.skippable !== undefined ? options.skippable : config.skippable !== false;
    const totalMs = this.reducedMotion ? Math.min(config.ms || 220, 120) : (config.ms || 220);
    const half = Math.max(0, totalMs / 2);

    this._lock();

    // Hard timeout guarantees the lock releases even if a phase never settles.
    let hardTimer = null;
    const hardTimeout = new Promise(resolve => {
      hardTimer = setTimeout(resolve, totalMs + 400);
    });

    const transition = (async () => {
      try {
        if (this.overlay) {
          this.overlay.className = `screen-transition active transition-${kind}`;
          this.overlay.style.transitionDuration = `${half}ms`;
          this.overlay.innerHTML = options.label
            ? `<span class="transition-label">${options.label}</span>`
            : '';
          // Force a reflow so the fade-in transition applies.
          void this.overlay.offsetWidth;
          this.overlay.style.opacity = '1';
        }
        await this._phase(half);
        if (typeof swap === 'function') {
          await swap();
        }
        if (this.overlay) {
          this.overlay.style.opacity = '0';
        }
        await this._phase(Math.max(0, totalMs - half));
      } finally {
        this._finishPhase();
        this._unlock();
        if (this.overlay) {
          this.overlay.className = 'screen-transition';
          this.overlay.style.opacity = '';
          this.overlay.style.transitionDuration = '';
        }
      }
    })();

    if (skippable) {
      this._skipHandler = () => this._finishPhase();
      window.addEventListener('keydown', this._skipHandler, true);
      window.addEventListener('pointerdown', this._skipHandler, true);
    }

    try {
      await Promise.race([transition, hardTimeout]);
    } finally {
      clearTimeout(hardTimer);
      if (this._skipHandler) {
        window.removeEventListener('keydown', this._skipHandler, true);
        window.removeEventListener('pointerdown', this._skipHandler, true);
        this._skipHandler = null;
      }
      // Ensure the lock is released even if the hard timeout won the race.
      this._finishPhase();
      this._unlock();
      if (this.overlay) {
        this.overlay.className = 'screen-transition';
        this.overlay.style.opacity = '';
        this.overlay.style.transitionDuration = '';
      }
    }
  }

  _phase(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this._phaseResolvers = this._phaseResolvers.filter(r => r !== resolve);
        resolve();
      }, ms);
      this._phaseTimers.push(timer);
      this._phaseResolvers.push(resolve);
    });
  }

  _finishPhase() {
    while (this._phaseTimers.length) clearTimeout(this._phaseTimers.pop());
    const resolvers = this._phaseResolvers;
    this._phaseResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  _lock() {
    this.lockCount += 1;
    this._applyLockClass();
  }

  _unlock() {
    this.lockCount = Math.max(0, this.lockCount - 1);
    this._applyLockClass();
  }

  _applyLockClass() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    document.documentElement.classList.toggle('input-locked', this.isLocked());
  }
}

export default TransitionController;
