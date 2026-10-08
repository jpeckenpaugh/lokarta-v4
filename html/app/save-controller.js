/**
 * Lokarta: Come Into The Light - Save & App Flow Controller
 */

import { ChestSystem, CombatSystem, canRecruit, nextRecruitVocation, ReviveSystem } from '../engine/index.js';
import { soundFX } from '../audio/index.js';
import { UI_CATALOG, DEFAULT_TOWN_ID } from '../data/index.js';
import {
  normalizeOptions,
  resolveReducedMotion,
  slotSummary,
  clampTowerFloor,
  snapshotFloorEntry,
} from '../services/save-slots.js';
import { ModalManager } from './modal-manager.js';

/**
 * App lifecycle: options, save slots, title/menu/defeat flow, and persistence.
 * Assigned onto `LokartaApp.prototype` from `app-controller.js`.
 */
export const saveControllerMethods = {
  hasSaves() {
    return this.slots.some(s => s && s.status === 'occupied');
  },
  async refreshSlots() {
    try {
      const res = await this.gameClient.listSlots();
      this.slots = res.slots || [];
    } catch (err) {
      console.warn('Failed to refresh save slots:', err);
    }
  },
  /** Applies the persisted options to the live UI. */
  applyOptions(options) {
    this.options = normalizeOptions(options);
    const o = this.options;

    soundFX.setEnabled(Boolean(o.soundEffects));
    soundFX.setVolume(Number(o.sfxVolume));
    this.updateAudioButton();

    this.applyReducedMotion();

    const uiScaleMap = UI_CATALOG?.options?.ranges?.uiScale || {};
    const uiScale = typeof uiScaleMap[o.uiScale] === 'number' ? uiScaleMap[o.uiScale] : 1;
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--ui-scale', String(uiScale));
    }

    const pixelMap = UI_CATALOG?.options?.ranges?.pixelScale || {};
    const zoom = typeof pixelMap[o.pixelScale] === 'number' ? pixelMap[o.pixelScale] : 64;
    this.renderer.setZoom(zoom);

    // Debug option (off by default): Tester's Strength scales incoming damage
    // for the whole party. Magnitude is authored in ui.json `options.debug`.
    const debugPct = Number(UI_CATALOG?.options?.debug?.testerStrengthDamageReductionPct) || 0;
    CombatSystem.setDebugIncomingDamageReductionPct(o.testerStrength ? debugPct : 0);

    this.updateFpsBadge();
  },
  /** Applies an options patch live and persists it through the worker. */
  async setOption(patch) {
    if (patch && patch.fullscreen !== undefined) {
      try {
        if (patch.fullscreen && !document.fullscreenElement) {
          await document.documentElement.requestFullscreen?.();
        } else if (!patch.fullscreen && document.fullscreenElement) {
          await document.exitFullscreen?.();
        }
      } catch (err) {
        console.warn('Fullscreen request was rejected:', err);
      }
    }

    this.applyOptions({ ...this.options, ...patch });

    try {
      const res = await this.gameClient.setOptions(patch);
      if (res && res.options) this.applyOptions(res.options);
    } catch (err) {
      console.warn('Failed to persist options:', err);
    }
  },
  applyReducedMotion() {
    const setting = this.options.reduceMotion;
    const mql = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    this.reduceMotionResolved = resolveReducedMotion(setting, mql ? mql.matches : false);
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('reduced-motion', this.reduceMotionResolved);
    }
    this.transition.setReducedMotion(this.reduceMotionResolved);

    if (mql) {
      if (this._mqlHandler) mql.removeEventListener('change', this._mqlHandler);
      this._mqlHandler = () => {
        if (this.options.reduceMotion !== 'system') return;
        this.applyReducedMotion();
        if (this.isInGameplay) return;
        if (this.modalOverlayEl.querySelector('.title-screen-modal')) this.startTitleAmbient();
      };
      mql.addEventListener('change', this._mqlHandler);
    }
  },
  syncFullscreenState() {
    const actual = typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false;
    if (actual === this.options.fullscreen) return;
    this.options = normalizeOptions({ ...this.options, fullscreen: actual });
    if (this.modalOverlayEl.querySelector('.options-modal')) {
      this.showOptionsModal(this.optionsReturnTo);
    }
  },
  showTitleScreen() {
    this.stopGameLoop();
    this.isInGameplay = false;
    this.isPaused = false;
    this.transition.forceRelease();
    ModalManager.hideTownScreen(this.townEl);

    ModalManager.showTitleScreen(this.modalOverlayEl, {
      slots: this.slots,
      hasSaves: this.hasSaves(),
      lastPlayedSlotIndex: this.lastPlayedSlotIndex,
    }, {
      onNewGame: () => this.openSlotSelect('create'),
      onContinue: () => this.openSlotSelect('load'),
      onOptions: () => this.showOptionsModal('title'),
      onGuide: () => this.showGuideModal(),
    });

    this.startTitleAmbient();
  },
  showCharacterSelectModal() {
    this.stopTitleAmbient();
    this.transition.run('titleToSelect', () => {
      ModalManager.showCharacterSelectModal(this.modalOverlayEl, async vocation => {
        await this.startNewGame(vocation);
      });
    });
  },
  showGuideModal() {
    const returnTo = this.isInGameplay ? 'pause' : 'title';
    ModalManager.showGuideModal(this.modalOverlayEl, {
      onClose: () => {
        if (returnTo === 'pause') this.openPauseMenu();
        else this.showTitleScreen();
      },
    });
  },
  openPauseMenu() {
    this.isPaused = true;
    ModalManager.showPauseModal(this.modalOverlayEl, {
      onResume: () => this.resumeGameplay(),
      onReturnToTown: () => this.leaveTower(),
      onOptions: () => this.showOptionsModal('pause'),
      onGuide: () => this.showGuideModal(),
      onReturnToTitle: () => this.returnToTitle(),
    });
  },
  resumeGameplay() {
    this.closeModal();
    this.isPaused = false;
  },
  showOptionsModal(returnTo = 'title') {
    this.optionsReturnTo = returnTo;
    this.stopTitleAmbient();
    ModalManager.showOptionsModal(this.modalOverlayEl, this.options, {
      onChange: patch => this.setOption(patch),
      onReset: () => this.confirmResetOptions(),
      onSaveData: () => this.openSlotSelect('manage'),
      onBack: () => this.returnFromOptions(),
      onRecruitCharacter: () => this.recruitCharacterDebug(),
    }, {
      canRecruitCharacter: this.canDebugRecruit(),
    });
  },
  /**
   * Whether the Options → Recruit Character debug action is offered. Only a
   * live game (pause/town, not the title screen) with room and a missing
   * vocation qualifies (LIV-29/FIX-14). Options can open from the title screen
   * with a stale player, so `isInGameplay` is required too.
   * @returns {boolean}
   */
  canDebugRecruit() {
    return Boolean(this.isInGameplay) && Boolean(this.player) && canRecruit(this.player);
  },
  /**
   * Debug action (Options → Recruit Character, FIX-14/LIV-29): auto-picks the
   * next catalog vocation not on the party, recruits it as the active member at
   * level 1 through the worker, then offers the Level-1 Fate Grant. Repeatable
   * until the party cap is reached; a full party is a guarded no-op.
   * @returns {Promise<void>}
   */
  async recruitCharacterDebug() {
    if (!this.canDebugRecruit()) return;
    const vocation = nextRecruitVocation(this.player);
    if (!vocation) return;

    let data;
    try {
      data = await this.gameClient.recruitMember(this.player.slotIndex, vocation);
    } catch (err) {
      console.error('Debug recruit error:', err);
      this.logCombat('Debug recruit failed — could not add a companion.', 'warning');
      return;
    }

    this.player = data.player || this.player;
    this.updateHUD();
    await this.persistSave(true);

    const name = String((data.member && data.member.vocation) || vocation).toUpperCase();
    this.logCombat(`Debug: ${name} joins the party at Level 1.`, 'victory');
    // Mirrors tower entry: the recruit's first Fate Grant is the Level-1 draft.
    this.showFateGrantModal(1);
  },
  returnFromOptions() {
    if (this.optionsReturnTo === 'pause') {
      this.openPauseMenu();
      return;
    }
    if (this.optionsReturnTo === 'town') {
      this.enterScene(DEFAULT_TOWN_ID);
      return;
    }
    this.showTitleScreen();
  },
  confirmResetOptions() {
    ModalManager.showConfirmModal(this.modalOverlayEl, {
      title: 'RESET OPTIONS?',
      body: 'All options return to their default values. Save slots are not affected.',
      confirmLabel: 'RESET',
      // Destructive to the user's saved preferences; the spec (§3.2) requires a
      // safe default focus on CANCEL.
      danger: true,
      onConfirm: async () => {
        let options = normalizeOptions(null);
        try {
          const res = await this.gameClient.resetOptions();
          if (res && res.options) options = res.options;
        } catch (err) {
          console.warn('Failed to reset options:', err);
        }
        this.applyOptions(options);
        this.showOptionsModal(this.optionsReturnTo);
      },
      onCancel: () => this.showOptionsModal(this.optionsReturnTo),
    });
  },
  openSlotSelect(mode = 'create') {
    this.slotSelectMode = mode;
    this.stopTitleAmbient();
    ModalManager.showSlotSelectModal(this.modalOverlayEl, {
      slots: this.slots,
      mode,
      lastPlayedSlotIndex: this.lastPlayedSlotIndex,
    }, {
      onNew: index => this.beginNewGame(index),
      onLoad: index => this.loadGame(index),
      onOverwrite: index => this.confirmOverwrite(index),
      onDelete: index => this.confirmDelete(index),
      onBack: () => {
        if (mode === 'manage') this.showOptionsModal(this.optionsReturnTo);
        else this.showTitleScreen();
      },
    });
  },
  beginNewGame(slotIndex) {
    const slot = this.slots.find(s => s.slotIndex === slotIndex);
    if (slot && slot.status === 'occupied') {
      this.confirmOverwrite(slotIndex);
      return;
    }
    this.pendingSlotIndex = slotIndex;
    this.showCharacterSelectModal();
  },
  confirmOverwrite(slotIndex) {
    const slot = this.slots.find(s => s.slotIndex === slotIndex) || { slotIndex };
    ModalManager.showConfirmModal(this.modalOverlayEl, {
      title: `OVERWRITE SLOT ${slotIndex}?`,
      body: `This permanently deletes ${slotSummary(slot)}. This cannot be undone.`,
      confirmLabel: 'OVERWRITE',
      danger: true,
      onConfirm: () => {
        this.pendingSlotIndex = slotIndex;
        this.showCharacterSelectModal();
      },
      onCancel: () => this.openSlotSelect(this.slotSelectMode),
    });
  },
  confirmDelete(slotIndex) {
    const slot = this.slots.find(s => s.slotIndex === slotIndex) || { slotIndex };
    ModalManager.showConfirmModal(this.modalOverlayEl, {
      title: `DELETE SLOT ${slotIndex}?`,
      body: `This permanently deletes ${slotSummary(slot)}. This cannot be undone.`,
      confirmLabel: 'DELETE',
      danger: true,
      onConfirm: async () => {
        try {
          await this.gameClient.deleteSlot(slotIndex);
        } catch (err) {
          console.error('Failed to delete slot:', err);
        }
        await this.refreshSlots();
        this.openSlotSelect(this.slotSelectMode);
      },
      onCancel: () => this.openSlotSelect(this.slotSelectMode),
    });
  },
  showLoadError(slotIndex) {
    ModalManager.showConfirmModal(this.modalOverlayEl, {
      title: `COULD NOT LOAD SLOT ${slotIndex}`,
      body: `Could not load Slot ${slotIndex}. Try again.`,
      confirmLabel: 'OK',
      cancelLabel: 'BACK',
      onConfirm: () => this.openSlotSelect(this.slotSelectMode),
      onCancel: () => this.openSlotSelect(this.slotSelectMode),
    });
  },
  adoptPlayer(player, floor) {
    this.closeModal();
    this.player = player;
    this.isGameOver = false;
    this.isFloorCleared = false;
    this.isPaused = false;
    this.applyDungeonData(floor);
    this.isInGameplay = true;
  },
  closeModal() {
    // Route through ModalManager so the modal-scoped keydown handler is always
    // removed with the modal (no stale Escape handler left on `window`).
    ModalManager._close(this.modalOverlayEl);
  },
  async startNewGame(vocation) {
    const slotIndex = this.pendingSlotIndex || 1;
    try {
      const data = await this.gameClient.createSlot(slotIndex, vocation);
      this.lastPlayedSlotIndex = slotIndex;
      await this.refreshSlots();

      await this.transition.run('selectToGame', async () => {
        this.adoptPlayer(data.player, data.floor);
        this.clearCombatLog();
        this.logCombat(`Welcome to Lokarta, brave ${(this.player.vocation || 'magician').toUpperCase()}!`, 'victory');
        this.logCombat('Fate calls upon you: Draft your starter cards.', 'spell');
        this.player.location = 'town';
        this.startGameLoop();
      });

      // A fresh save starts on foot in the Havenreach town scene (LIV-59 P1).
      await this.enterScene(DEFAULT_TOWN_ID);
    } catch (err) {
      console.error('Failed to start new game:', err);
      this.showLoadError(slotIndex);
    }
  },
  async loadGame(slotIndex) {
    try {
      const data = await this.gameClient.loadSlot(slotIndex);
      this.lastPlayedSlotIndex = slotIndex;
      await this.refreshSlots();

      await this.transition.run('selectToGame', async () => {
        this.adoptPlayer(data.player, data.floor);
        this.clearCombatLog();
        // LIV-44: a corrupt/interrupted all-down save routes to the wipe path
        // rather than loading an unplayable party.
        if (ReviveSystem.evaluateWipe(this.player)) {
          this.isGameOver = true;
          this.onPartyWipe();
          return;
        }
        this.logCombat(`Resumed the ascent on Floor ${this.player.current_floor || 1} (${this.currentFloorName}).`, 'system');
        this.player.location = this.player.location || 'tower';
        this.startGameLoop();
      });

      const isActionBarEmpty = this.player.action_bar?.every(s => s === null);
      if (this.player.location !== 'tower' || (isActionBarEmpty && this.player.level === 1)) {
        await this.enterScene(DEFAULT_TOWN_ID);
      }
    } catch (err) {
      console.error('Failed to load saved game:', err);
      this.showLoadError(slotIndex);
    }
  },
  returnToTitle() {
    this.transition.run('toTitle', async () => {
      this.stopTitleAmbient();
      this.showTitleScreen();
    });
  },
  /** Persists only the durable chest opened-state for the current floor. */
  async persistChests() {
    if (!this.player) return;
    try {
      await this.gameClient.saveFloorState(
        this.player,
        ChestSystem.serializeChestState(this.chests)
      );
    } catch (err) {
      console.warn('Chest state save error:', err);
    }
  },
  persistSave(immediate = false) {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }

    if (immediate) {
      return this._executeSave();
    }

    this.saveDebounceTimer = setTimeout(() => {
      this._executeSave();
    }, 500);
  },
  async _executeSave() {
    try {
      if (this.player) {
        await this.gameClient.saveCharacter(this.player);
      }
    } catch (err) {
      console.warn('Auto-save error:', err);
    }
  },
  /**
   * LIV-44 full-party wipe: the Temple of the Dawn restores every member and
   * resets re-entry to the tower's entry floor. Keys, level, gear, backpack,
   * gold, and tower completions are kept (`economy.wipe.goldPenaltyPct: 0`).
   * Supersedes the single-hero `onPlayerDeath`; only a true simultaneous
   * full-party knockout reaches here.
   */
  async onPartyWipe() {
    if (!this.player) return;
    const fromFloor = this.player.current_floor || 1;
    const towerId = this.player.towerId;
    // Entry floor is always the tower's first level (Spire of Light = 1).
    const entryFloor = clampTowerFloor(1, towerId);
    this.isPaused = true;

    const restore = (member) => {
      if (!member || typeof member !== 'object') return;
      member.hp = member.max_hp;
      member.mana = member.max_mana;
      member.combatState = 'active';
      member.lifeState = 'alive';
      member.downedAtSec = 0;
      member.reviveGraceSec = 0;
      member.autoReviveTotalSec = 0;
      member.autoReviveRemainingSec = 0;
      member.aiTargetId = null;
      member.aiRetargetTimer = 0;
      member._reviveTargetId = null;
      member._reviveProgressSec = 0;
      member._reviveBlocked = false;
    };

    if (Array.isArray(this.player.party)) {
      for (const member of this.player.party) restore(member);
    }
    restore(this.player);

    this.player.location = 'town';
    this.player.current_floor = entryFloor;
    this.location = 'town';
    // Refresh the floor-entry snapshot so re-entry lands on the entry floor.
    this.player.floorEntry = snapshotFloorEntry(this.player);

    try {
      await this.persistSave(true);
    } catch (err) {
      console.warn('Party-wipe save error:', err);
    }

    this.logCombat(`The party falls on Floor ${fromFloor}. The Temple of the Dawn draws you back to the tower gate.`, 'warning');
    this.showGameOverModal(fromFloor, entryFloor);
  },
  /** @deprecated Use `onPartyWipe`; kept for external callers/back-compat. */
  async onPlayerDeath() {
    return this.onPartyWipe();
  },
  /** Resumes play in the Town after a defeat. */
  resumeAfterDeath() {
    this.isGameOver = false;
    this.isFloorCleared = false;
    this.closeModal();
    this.enterScene(DEFAULT_TOWN_ID);
  },
  showVictoryModal() {
    ModalManager.showVictoryModal(this.modalOverlayEl, this.player, {
      onNewGame: () => this.openSlotSelect('create'),
      onReturnToTitle: () => this.returnToTitle(),
    });
  },
  showGameOverModal(fromFloor = this.player?.current_floor || 1, toFloor = fromFloor) {
    ModalManager.showGameOverModal(this.modalOverlayEl, this.player, {
      fromFloor,
      toFloor,
      // LIV-44 copy is catalog-driven; the Game Designer owns the wording.
      title: UI_CATALOG?.knockout?.partyWipeTitle,
      body: UI_CATALOG?.knockout?.partyWipeBody,
      onRetry: () => this.resumeAfterDeath(),
      onContinue: () => this.returnToTitle(),
    });
  }
};
