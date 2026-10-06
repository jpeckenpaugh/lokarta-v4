/**
 * Lokarta: Come Into The Light - Multi-Modal Gesture Engine Subsystem
 */

import { CONFIG, EQUIPMENT_KEY_MAP } from './config.js';

export class GestureEngine {
  constructor(onGesture, onChargeUpdate) {
    this.onGestureCallback = onGesture || (() => {});
    this.onChargeUpdateCallback = onChargeUpdate || (() => {});
    this.trackers = new Map();
    this.animationFrameId = null;

    for (let i = 0; i < CONFIG.ACTIVE_SLOT_COUNT; i++) {
      this.trackers.set(i, {
        isDown: false,
        pressTimestamp: 0,
        lastReleaseTimestamp: 0,
        chargeRatio: 0,
      });
    }

    this.startChargeLoop();
  }

  /**
   * Active-item keys `1..N` -> `active_0..N-1` slot index. Returns null for any
   * other key (D1 §0.2/§2.6). The active count comes from `CONFIG`.
   */
  static keyToSlotIndex(key) {
    if (key >= '1' && key <= '9') {
      const idx = parseInt(key, 10) - 1;
      return idx < CONFIG.ACTIVE_SLOT_COUNT ? idx : null;
    }
    return null;
  }

  /**
   * Equipment keys `q/w/e/r` -> `main_hand|off_hand|armor|relic` (D1 §2.6),
   * resolved from `keybindings.json.keySlots.equipment`. Returns null otherwise.
   */
  static keyToEquipmentSlot(key) {
    if (key === undefined || key === null) return null;
    const raw = String(key);
    const letter = raw.length === 1 ? raw.toLowerCase() : (raw.startsWith('Key') ? raw.slice(3).toLowerCase() : raw.toLowerCase());
    return EQUIPMENT_KEY_MAP[letter] || null;
  }

  static slotIndexToHotkey(slotIndex) {
    if (slotIndex >= 0 && slotIndex < CONFIG.ACTIVE_SLOT_COUNT) {
      return `${slotIndex + 1}`;
    }
    return '';
  }

  handleInputDown(slotIndex) {
    const tracker = this.trackers.get(slotIndex);
    if (!tracker) return;

    if (tracker.isDown) return; // Prevent key repeat oscillation

    const now = performance.now();
    tracker.isDown = true;
    tracker.pressTimestamp = now;
    tracker.chargeRatio = 0;
  }

  handleInputUp(slotIndex) {
    const tracker = this.trackers.get(slotIndex);
    if (!tracker || !tracker.isDown) return;

    const now = performance.now();
    const duration = now - tracker.pressTimestamp;
    tracker.isDown = false;
    const previousRelease = tracker.lastReleaseTimestamp;
    tracker.lastReleaseTimestamp = now;

    // Reset charge visual
    tracker.chargeRatio = 0;
    this.onChargeUpdateCallback(slotIndex, 0);

    // Double-tap check: if tap duration < TAP_MAX_MS and previousRelease was within DOUBLE_TAP_MAX_MS
    if (duration < CONFIG.TAP_MAX_MS && previousRelease > 0 && (now - previousRelease) <= CONFIG.DOUBLE_TAP_MAX_MS) {
      this.onGestureCallback({
        slotIndex,
        gesture: 'double_tap',
        chargeDurationMs: duration,
        chargeRatio: 1.0,
      });
      tracker.lastReleaseTimestamp = 0;
      return;
    }

    // Hold / Charge check: held >= HOLD_MIN_MS
    if (duration >= CONFIG.HOLD_MIN_MS) {
      const chargeRatio = Math.min(
        1.0,
        Math.max(0.1, (duration - CONFIG.HOLD_MIN_MS) / (CONFIG.HOLD_MAX_MS - CONFIG.HOLD_MIN_MS))
      );
      this.onGestureCallback({
        slotIndex,
        gesture: 'hold',
        chargeDurationMs: duration,
        chargeRatio,
      });
      return;
    }

    // Standard Tap
    this.onGestureCallback({
      slotIndex,
      gesture: 'tap',
      chargeDurationMs: duration,
      chargeRatio: 0,
    });
  }

  startChargeLoop() {
    if (typeof requestAnimationFrame === 'undefined') return;

    const update = () => {
      const now = performance.now();
      for (const [slotIndex, tracker] of this.trackers.entries()) {
        if (tracker.isDown) {
          const duration = now - tracker.pressTimestamp;
          if (duration >= CONFIG.HOLD_MIN_MS) {
            const ratio = Math.min(
              1.0,
              (duration - CONFIG.HOLD_MIN_MS) / (CONFIG.HOLD_MAX_MS - CONFIG.HOLD_MIN_MS)
            );
            if (Math.abs(tracker.chargeRatio - ratio) > 0.01) {
              tracker.chargeRatio = ratio;
              this.onChargeUpdateCallback(slotIndex, ratio);
            }
          }
        }
      }
      this.animationFrameId = requestAnimationFrame(update);
    };

    this.animationFrameId = requestAnimationFrame(update);
  }

  destroy() {
    if (this.animationFrameId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
}
