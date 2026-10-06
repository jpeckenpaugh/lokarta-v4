/**
 * Lokarta: Come Into The Light - Mobile Ability Bar
 *
 * The on-screen mirror of the `q/w/e/r` + `1/2/3/4` keyboard slots, rendered
 * bottom-right on touch layouts. It reuses the existing dispatch paths so touch
 * and keyboard can never diverge:
 *
 *   - Equipment `q/w/e/r` -> `app.executeHandCombat(slot)`
 *   - Active `1/2/3/4`   -> `app.gestureEngine.handleInputDown/Up` (single tap)
 *                           and `app.handleGestureEvent(...)` (held once)
 *
 * Press behaviour: a short tap (< `autofire.holdMs`) performs the
 * existing single cast / use-equip. A long-press (>= `autofire.holdMs`) on an
 * equipment slot **toggles a persistent auto-fire armed state** for that slot —
 * releasing does not cancel. While armed, a ~5 Hz guarded tick fires the ability
 * whenever `canAutoFire` passes and parks in a visible waiting state otherwise
 * (cooldown / out of mana / no target), resuming automatically when the guard
 * passes again. Long-pressing the same slot again, unequipping/changing its
 * item, or ending the gameplay context (pause, modal, death, floor transition,
 * game over) disarms it. Active slots 1-4 never auto-fire.
 *
 * Armed state is per-slot, in-memory only (never persisted). The pure policy in
 * `autofire.js` (`classifyHold`, `canAutoFire`) remains the single source of
 * truth for the threshold and the resource guards.
 *
 * DOM is built once and diffed; state is repainted from the 10 Hz HUD refresh.
 */

import { UI_CATALOG, ITEMS_CATALOG } from '../data/index.js';
import { EQUIPMENT_KEY_MAP, ACTIVE_SLOT_KEYS } from '../engine/config.js';
import { HUDManager } from './hud-manager.js';
import {
  autofireTimings,
  resolveAbilityRef,
  isRepeatable,
  canAutoFire,
  evaluateGuard,
} from './autofire.js';

const CLASS_TINTS = ['voc-fighter', 'voc-paladin', 'voc-magician', 'voc-archer', 'voc-neutral'];
const STATE_CLASSES = [
  'slot-empty', 'slot-occupied', 'on-cooldown',
  'ability-btn--depleted', 'ability-btn--no-target',
];

/** Reasons whose button reads as "suppressed" (dimmed, non-firing). */
const SUPPRESSED_REASONS = new Set(['mana', 'ammo', 'no-target', 'active', 'dead', 'inactive']);

export class AbilityBar {
  constructor(app) {
    this.app = app;
    this.container = null;
    this.buttons = [];
    this.sessions = new Map(); // pointerId -> press session (tap vs long-press)
    this.armed = new Map(); // equipment slot -> { ref, itemRef, btn }
    this._tickTimer = null;
    this._built = false;
    this._bound = false;
  }

  // ---- Lifecycle ----------------------------------------------------------

  mount(elements = {}) {
    const container = elements.abilityBarEl
      || (typeof document !== 'undefined' ? document.getElementById('ability-bar') : null);
    if (!container) return;
    this.container = container;
    container.style.setProperty('--autofire-feedback-ms', `${autofireTimings().feedbackMs}ms`);
    if (!this._built) {
      this._build();
      this._built = true;
    }
    this.buttons = Array.from(container.querySelectorAll('.ability-btn'));
    this._bind();
  }

  destroy() {
    for (const session of this.sessions.values()) clearTimeout(session.thresholdTimer);
    this.sessions.clear();
    this._clearTick();
    this.armed.clear();
  }

  // ---- Build (once) -------------------------------------------------------

  _build() {
    const loadout = UI_CATALOG?.hud?.loadout || {};
    const activeKeys = Array.isArray(loadout.activeKeys) && loadout.activeKeys.length
      ? loadout.activeKeys.map(String)
      : ACTIVE_SLOT_KEYS;
    const equipmentKeys = Array.isArray(loadout.equipmentKeys) && loadout.equipmentKeys.length
      ? loadout.equipmentKeys.map(String)
      : Object.keys(EQUIPMENT_KEY_MAP);

    const activeHtml = activeKeys.map((key, i) => {
      const baseLabel = `Active slot ${key}, key ${key}`;
      return `
        <button type="button" class="ability-btn slot-empty" data-slot-kind="active" data-index="${i}" data-key="${key}"
                data-base-label="${baseLabel}" aria-label="${baseLabel}, empty">
          <span class="key-badge">${key}</span>
          <span class="slot-class-badge" aria-hidden="true"></span>
          <span class="ability-icon"></span>
          <span class="ability-qty"></span>
          <span class="cooldown-overlay" style="display:none;"></span>
          <span class="ability-flag" aria-hidden="true"></span>
        </button>`;
    }).join('');

    const equipmentHtml = equipmentKeys.map(key => {
      const slot = EQUIPMENT_KEY_MAP[key] || key;
      const label = HUDManager.slotLabel(slot);
      const upper = String(key).toUpperCase();
      const baseLabel = `${label}, key ${upper}`;
      return `
        <button type="button" class="ability-btn equip-btn slot-empty" data-slot-kind="equipment" data-slot="${slot}" data-key="${upper}"
                data-base-label="${baseLabel}" aria-label="${baseLabel}, empty">
          <span class="key-badge">${upper}</span>
          <span class="slot-class-badge" aria-hidden="true"></span>
          <span class="ability-icon"></span>
          <span class="ability-qty"></span>
          <span class="cooldown-overlay" style="display:none;"></span>
          <span class="ability-flag" aria-hidden="true"></span>
          <span class="ability-auto-badge" aria-hidden="true">AUTO</span>
        </button>`;
    }).join('');

    this.container.innerHTML = activeHtml + equipmentHtml;
  }

  // ---- Input binding ------------------------------------------------------

  _bind() {
    if (this._bound) return;
    this._bound = true;
    const c = this.container;
    const hasPointer = typeof window !== 'undefined' && 'PointerEvent' in window;
    if (hasPointer) {
      c.addEventListener('pointerdown', e => this._onDown(e));
      c.addEventListener('pointerup', e => this._onUp(e));
      c.addEventListener('pointercancel', e => this._onCancel(e.pointerId));
      c.addEventListener('lostpointercapture', e => this._onCancel(e.pointerId));
    } else {
      c.addEventListener('touchstart', e => this._onTouch('down', e), { passive: false });
      c.addEventListener('touchend', e => this._onTouch('up', e), { passive: false });
      c.addEventListener('touchcancel', e => this._onTouch('cancel', e), { passive: false });
    }
    // Android Chrome long-press on the item <img> would otherwise open the
    // native "Open image in new tab" menu instead of reaching autofire. Scope
    // the suppression to ability buttons; leave context menus elsewhere alone.
    c.addEventListener('contextmenu', e => this._onContextMenu(e));
  }

  _onContextMenu(e) {
    const btn = this._buttonFromEvent(e);
    if (btn) e.preventDefault();
  }

  _buttonFromEvent(e) {
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest('.ability-btn');
  }

  _refFor(btn) {
    return {
      kind: btn.dataset.slotKind,
      slot: btn.dataset.slot,
      index: Number(btn.dataset.index),
    };
  }

  _onDown(e) {
    const btn = this._buttonFromEvent(e);
    if (!btn) return;
    e.preventDefault();
    this._startSession(btn, e.pointerId, e);
  }

  _onUp(e) {
    const session = this.sessions.get(e.pointerId);
    if (!session) return;
    e.preventDefault();
    this._endSession(session, true);
  }

  _onTouch(kind, e) {
    e.preventDefault();
    const touch = (kind === 'down' ? e.changedTouches : e.changedTouches)?.[0];
    if (!touch) return;
    const pointerId = touch.identifier ?? touch.fingerId ?? 0;
    if (kind === 'down') {
      const btn = document.elementFromPoint?.(touch.clientX, touch.clientY)?.closest?.('.ability-btn');
      if (!btn) return;
      this._startSession(btn, pointerId, { target: btn });
      return;
    }
    const session = this.sessions.get(pointerId);
    if (session) this._endSession(session, kind === 'up');
  }

  _onCancel(pointerId) {
    const session = this.sessions.get(pointerId);
    if (session) this._endSession(session, false);
  }

  // ---- Press state machine (tap vs long-press toggle) ---------------------

  _startSession(btn, pointerId, e) {
    if (pointerId === undefined || this.sessions.has(pointerId)) return;
    const ref = this._refFor(btn);
    const { holdMs } = autofireTimings();

    const session = {
      pointerId,
      btn,
      ref,
      firedAtThreshold: false,
      thresholdTimer: null,
    };
    this.sessions.set(pointerId, session);
    btn.classList.add('ability-btn--charging');
    if (typeof btn.setPointerCapture === 'function' && e?.pointerId !== undefined) {
      try { btn.setPointerCapture(pointerId); } catch { /* capture is best-effort */ }
    }
    session.thresholdTimer = setTimeout(() => this._onThreshold(session), holdMs);
  }

  _onThreshold(session) {
    if (!this.sessions.has(session.pointerId)) return;
    session.firedAtThreshold = true;
    session.btn.classList.remove('ability-btn--charging');
    const ctx = resolveAbilityRef(this.app, session.ref);

    // Equipment abilities with a catalog actionKey toggle a persistent armed
    // state. Everything else (active slots 1-4, non-ability equipment) keeps
    // the original single activation at the threshold.
    if (isRepeatable(session.ref, ctx)) {
      this._toggleArmed(session.ref, session.btn, ctx);
      return;
    }

    session.btn.classList.add('ability-btn--single-locked');
    if (!ctx.item) this._dispatchSingle(session.ref);
    else this._dispatch(session.ref);
  }

  _endSession(session, dispatchIfBeforeThreshold) {
    if (!this.sessions.has(session.pointerId)) return;
    clearTimeout(session.thresholdTimer);
    this.sessions.delete(session.pointerId);
    session.btn.classList.remove('ability-btn--charging', 'ability-btn--single-locked');
    // Armed visuals persist after release; only the transient press visuals go.
    this._applyArmedVisual(session.btn);
    if (!session.firedAtThreshold && dispatchIfBeforeThreshold) {
      this._dispatchSingle(session.ref);
    }
  }

  // ---- Armed (persistent auto-fire) state --------------------------------

  /** Syncs the persistent armed visuals for one button from the armed map. */
  _applyArmedVisual(btn) {
    const ref = this._refFor(btn);
    const armed = ref.kind === 'equipment' && this.armed.has(ref.slot);
    btn.classList.toggle('ability-btn--active-fire', armed);
    if (!armed) btn.classList.remove('ability-btn--waiting');
  }

  _toggleArmed(ref, btn, ctx) {
    if (this.armed.has(ref.slot)) {
      this._disarm(ref.slot);
      return;
    }
    this.armed.set(ref.slot, { ref, itemRef: ctx.item, btn });
    this._ensureTick();
    this._applyArmedVisual(btn);
    // Fire immediately if the guard allows it (mirrors the old threshold cast).
    this._evaluateArmed(ref.slot);
  }

  _ensureTick() {
    if (this._tickTimer || this.armed.size === 0) return;
    const { repeatMs } = autofireTimings();
    this._tickTimer = setInterval(() => this._autoTick(), repeatMs);
  }

  _clearTick() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  _stopTickIfIdle() {
    if (this.armed.size === 0) this._clearTick();
  }

  _autoTick() {
    if (this.armed.size === 0) {
      this._clearTick();
      return;
    }
    if (this._contextEnded()) {
      this._disarmAll();
      return;
    }
    // forEach tolerates deletion of the current entry; no transient array.
    this.armed.forEach((_state, slot) => this._evaluateArmed(slot));
  }

  /** One guarded autofire tick for a single slot; stays armed when suppressed. */
  _evaluateArmed(slot) {
    const state = this.armed.get(slot);
    if (!state) return;
    const ctx = resolveAbilityRef(this.app, state.ref);
    if (!ctx.item || !isRepeatable(state.ref, ctx) || ctx.item !== state.itemRef) {
      this._disarm(slot);
      return;
    }
    const btn = state.btn;
    if (canAutoFire(this.app, state.ref)) {
      if (btn) btn.classList.remove('ability-btn--waiting');
      this._dispatch(state.ref);
    } else if (btn) {
      btn.classList.add('ability-btn--waiting');
    }
  }

  _disarm(slot) {
    const state = this.armed.get(slot);
    if (!state) return;
    this.armed.delete(slot);
    const btn = state.btn;
    if (btn) {
      btn.classList.remove('ability-btn--active-fire', 'ability-btn--waiting');
      const baseLabel = btn.dataset?.baseLabel || '';
      if (baseLabel) this._setAria(btn, baseLabel, '');
    }
    this._stopTickIfIdle();
  }

  _disarmAll() {
    const slots = [];
    this.armed.forEach((_state, slot) => slots.push(slot));
    for (const slot of slots) this._disarm(slot);
  }

  /**
   * True when the gameplay context has ended and auto-fire must be disarmed.
   * Covers pause, any open modal, death, floor transition, game over, and
   * tower cleared. After this the player must re-arm explicitly — we never
   * silently re-arm on resume.
   */
  _contextEnded() {
    const app = this.app;
    if (!app) return true;
    if (!app.isInGameplay || app.isPaused || app.isGameOver || app.isFloorCleared) return true;
    if (app.transition && typeof app.transition.isLocked === 'function' && app.transition.isLocked()) return true;
    const overlay = app.modalOverlayEl;
    if (overlay && overlay.classList && typeof overlay.classList.contains === 'function'
      && !overlay.classList.contains('hidden')) return true;
    if (!(app.player && app.player.hp > 0)) return true;
    return false;
  }

  // ---- Dispatch (reuses keyboard paths) ----------------------------------

  _dispatch(ref) {
    if (ref.kind === 'equipment') {
      this.app.executeHandCombat?.(ref.slot);
      return;
    }
    if (ref.kind === 'active') {
      this.app.handleGestureEvent?.({ slotIndex: ref.index, gesture: 'tap' });
    }
  }

  /** Sub-threshold release: an ordinary tap. Active slots keep the GestureEngine path. */
  _dispatchSingle(ref) {
    if (ref.kind === 'active' && this.app.gestureEngine) {
      this.app.gestureEngine.handleInputDown(ref.index);
      this.app.gestureEngine.handleInputUp(ref.index);
      return;
    }
    this._dispatch(ref);
  }

  // ---- Paint (from the 10 Hz HUD refresh) --------------------------------

  paint() {
    if (!this.buttons.length) return;
    for (const btn of this.buttons) this._paintButton(btn);
  }

  _paintButton(btn) {
    const ref = this._refFor(btn);
    const ctx = resolveAbilityRef(this.app, ref);
    const occupied = Boolean(ctx.item);
    const baseLabel = btn.dataset.baseLabel || btn.getAttribute('aria-label') || '';

    // An armed slot whose item vanished is disarmed immediately.
    if (!occupied && ref.kind === 'equipment') this._disarm(ref.slot);
    const armed = ref.kind === 'equipment' && this.armed.has(ref.slot);

    btn.classList.remove(...STATE_CLASSES, ...CLASS_TINTS);
    btn.classList.toggle('ability-btn--active-fire', armed);
    if (!armed) btn.classList.remove('ability-btn--waiting');

    const classBadge = btn.querySelector('.slot-class-badge');
    const iconEl = btn.querySelector('.ability-icon');
    const qtyEl = btn.querySelector('.ability-qty');

    if (!occupied) {
      btn.classList.add('slot-empty');
      if (iconEl && iconEl.dataset.iconItem !== '') {
        iconEl.innerHTML = '';
        iconEl.dataset.iconItem = '';
      }
      if (qtyEl && qtyEl.textContent) qtyEl.textContent = '';
      if (classBadge) {
        classBadge.textContent = '';
        classBadge.classList.remove('visible');
      }
      this._setCooldown(btn, false, null);
      btn.classList.remove('ability-btn--depleted', 'ability-btn--no-target');
      this._setAria(btn, baseLabel, 'empty');
      return;
    }

    btn.classList.add('slot-occupied');
    const classInfo = HUDManager._classInfo(ctx.item);
    btn.classList.add(`voc-${classInfo.key}`);
    if (classBadge) {
      const next = classInfo.label || '';
      if (classBadge.textContent !== next) classBadge.textContent = next;
      classBadge.classList.toggle('visible', Boolean(next));
    }
    if (iconEl && iconEl.dataset.iconItem !== (ctx.item.item_id || '')) {
      iconEl.innerHTML = HUDManager.renderItemIcon(ctx.item);
      iconEl.dataset.iconItem = ctx.item.item_id || '';
    }
    if (qtyEl) {
      const qty = ctx.item.quantity > 1 ? `x${ctx.item.quantity}` : '';
      if (qtyEl.textContent !== qty) qtyEl.textContent = qty;
    }

    if (ref.kind === 'active') {
      this._setCooldown(btn, false, null);
      this._setAria(btn, baseLabel, 'ready');
      return;
    }

    const { reason } = evaluateGuard(this.app, ref);
    const remaining = this._cooldownRemaining(ctx.actionKey);
    const onCooldown = reason === 'cooldown' || remaining > 0;
    const effectiveCooldown = this._effectiveCooldown(ctx.item);
    this._setCooldown(btn, onCooldown, onCooldown ? { remaining, effectiveCooldown } : null);

    btn.classList.toggle('ability-btn--depleted', reason === 'mana' || reason === 'ammo');
    btn.classList.toggle('ability-btn--no-target', SUPPRESSED_REASONS.has(reason) && reason !== 'mana' && reason !== 'ammo');

    const stateSuffix = this._stateSuffix(reason, ctx);
    const suffix = armed
      ? (stateSuffix ? `auto-fire on, ${stateSuffix}` : 'auto-fire on')
      : stateSuffix;
    this._setAria(btn, baseLabel, suffix);
  }

  _cooldownRemaining(actionKey) {
    if (!actionKey) return 0;
    const key = actionKey === 'light_spell' ? 'light' : actionKey;
    const value = this.app.player?.cooldowns?.[key];
    return Number(value) > 0 ? Number(value) : 0;
  }

  _effectiveCooldown(item) {
    const catalog = ITEMS_CATALOG[item.item_id];
    const base = typeof item.cooldown === 'number' ? item.cooldown : (catalog?.cooldown ?? null);
    if (typeof base !== 'number') return null;
    const rank = item.itemLevel || 1;
    const spec = catalog?.upgradeSpec || item.upgradeSpec || {};
    const perRank = spec.cooldownReductionSec || 0;
    return Math.max(1, base - perRank * (rank - 1));
  }

  _setCooldown(btn, active, info) {
    const overlay = btn.querySelector('.cooldown-overlay');
    if (!overlay) return;
    if (!active || !info) {
      btn.classList.remove('on-cooldown');
      if (overlay.style.display !== 'none') overlay.style.display = 'none';
      btn.style.removeProperty('--cd-inset');
      return;
    }
    const { remaining, effectiveCooldown } = info;
    const total = typeof effectiveCooldown === 'number' && effectiveCooldown > 0 ? effectiveCooldown : null;
    const progress = total ? Math.max(0, Math.min(1, 1 - remaining / total)) : 1;
    btn.style.setProperty('--cd-inset', `${(progress * 100).toFixed(1)}%`);
    if (overlay.style.display !== 'block') overlay.style.display = 'block';
    btn.classList.add('on-cooldown');
  }

  _setAria(btn, baseLabel, suffix) {
    const next = suffix ? `${baseLabel}, ${suffix}` : baseLabel;
    if (btn.getAttribute('aria-label') !== next) btn.setAttribute('aria-label', next);
  }

  _stateSuffix(reason, ctx) {
    switch (reason) {
      case 'cooldown': return 'recharging';
      case 'mana': return 'out of mana';
      case 'ammo': return 'out of ammo';
      case 'no-target': return 'no target';
      case 'active': return 'already active';
      case 'ok': return 'ready';
      default: return ctx.actionKey ? 'ready' : 'no ability';
    }
  }
}
