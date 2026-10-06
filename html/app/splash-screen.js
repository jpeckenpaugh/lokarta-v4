/**
 * Lokarta: Come Into The Light - Studio Splash
 * Plays the "Livive.net Studios" lockup once per full page load. Skippable.
 */

import { UI_CATALOG } from '../data/index.js';

const SPLASH_DONE_EVENT = 'lokarta:splash-done';

/**
 * Shows the studio splash on the given overlay element.
 * The returned promise resolves when the overlay has been removed, so the
 * caller can overlap worker/IndexedDB warm-up with the splash.
 *
 * @param {HTMLElement|null} el - the #splash-overlay element
 * @param {{ reduceMotion?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function showSplash(el, { reduceMotion = false } = {}) {
  if (!el) return Promise.resolve();

  const cfg = UI_CATALOG.splash || {};
  const startTime = nowMs();
  let finished = false;
  let resolveDone;
  const finishedPromise = new Promise(resolve => { resolveDone = resolve; });
  const phaseTimers = [];

  const cleanup = () => {
    while (phaseTimers.length) clearTimeout(phaseTimers.pop());
    window.removeEventListener('keydown', onSkip, true);
    window.removeEventListener('pointerdown', onSkip, true);
    window.removeEventListener('touchstart', onSkip, true);
  };

  const complete = () => {
    if (finished) return;
    finished = true;
    cleanup();
    try {
      el.remove();
    } catch {
      el.style.display = 'none';
    }
    window.dispatchEvent(new Event(SPLASH_DONE_EVENT));
    resolveDone();
  };

  const fadeOut = skipped => {
    if (finished) return;
    const fadeMs = reduceMotion ? 0 : (skipped ? (cfg.skipFadeMs || 150) : (cfg.hideMs || 400));
    el.classList.remove('splash-visible');
    el.classList.add('splash-hide');
    if (fadeMs <= 0) {
      complete();
      return;
    }
    el.style.transitionDuration = `${fadeMs}ms`;
    phaseTimers.push(setTimeout(complete, fadeMs));
  };

  const onSkip = () => {
    if (nowMs() - startTime < (cfg.skipAfterMs || 150)) return;
    fadeOut(true);
  };

  const render = async () => {
    try {
      const res = await fetch('./assets/livive-studios-lockup.svg');
      if (res && res.ok) {
        el.innerHTML = await res.text();
        return;
      }
    } catch {
      // Fall through to the raster/mark fallback below.
    }
    el.innerHTML = '<img class="splash-logo splash-logo-fallback" src="./assets/livive-studios-mark.svg" alt="Livive.net Studios" />';
  };

  const play = () => {
    el.classList.add('splash-visible');
    window.addEventListener('keydown', onSkip, true);
    window.addEventListener('pointerdown', onSkip, true);
    window.addEventListener('touchstart', onSkip, true);

    if (reduceMotion) {
      phaseTimers.push(setTimeout(() => fadeOut(false), cfg.reducedHoldMs || 900));
    } else {
      phaseTimers.push(setTimeout(() => fadeOut(false), (cfg.showMs || 400) + (cfg.holdMs || 1500)));
    }
  };

  render().then(play).catch(play);

  return finishedPromise;
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
