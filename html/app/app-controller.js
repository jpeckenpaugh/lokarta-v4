/**
 * Lokarta: Come Into The Light - Main Application Controller
 */

import { GameClient } from '../worker/game-client.js';
import {
  GridMap,
  GestureEngine,
  EconomySystem,
  createPartyPlayer,
} from '../engine/index.js';
import { soundFX } from '../audio/index.js';
import { CanvasRenderer } from './canvas-renderer.js';
import { gameLoopMethods } from './game-loop.js';
import { hudFxMethods } from './hud-fx.js';
import { combatControllerMethods } from './combat-controller.js';
import { inventoryControllerMethods } from './inventory-controller.js';
import { shopControllerMethods } from './shop-controller.js';
import { floorControllerMethods } from './floor-controller.js';
import { saveControllerMethods } from './save-controller.js';
import { sceneControllerMethods } from './scene-controller.js';
import { ModalManager } from './modal-manager.js';
import { InputController } from './input-controller.js';
import { AbilityBar } from './ability-bar.js';
import { TransitionController } from './transition-controller.js';
import { SwapFeedback } from './swap-feedback.js';
import { normalizeOptions } from '../services/save-slots.js';
import { createAnimState } from './animation-state.js';


export class LokartaApp {
  constructor() {
    this.gameClient = new GameClient();
    this.player = createPartyPlayer('magician');
    this.gridMap = new GridMap();
    this.monsters = [];
    this.chests = [];
    this.props = [];
    this.ambientLights = [];
    this.projectiles = [];
    this.particles = [];
    this.floatingTexts = [];
    this.deathEffects = [];
    this.selectedMonsterId = null;
    this.player.anim = createAnimState(this.player.facing || 'down');

    this.isRunning = false;
    this.isGameOver = false;
    this.isFloorCleared = false;
    this.currentFloorName = 'The Gatehouse';
    // The player begins in the Town outside the tower.
    this.location = 'town';
    // Walkable overworld scene descriptor (island/town), or null while in a
    // tower floor. Populated by scene-controller.js (LIV-59 P1).
    this.scene = null;
    this._sceneInteraction = false;
    this.townConfig = EconomySystem.townConfig();
    this.passiveRecoveryAccumulator = 0;
    // Adjacency spring regen accumulator (1 Hz).
    this.springRegenAccumulator = 0;

    // E8: active-floor stair traversal state (dir/targetLevel + §9.3 arming).
    this.stairs = [];
    this.isFinalFloor = false;
    this.stairSystem = null;
    this.stairHint = null;

    this.tickTimer = null;
    this.animFrameId = null;
    this.lastAnimTime = 0;
    this.keysDown = new Set();
    this.regenAccumulator = 0;
    this.ammoRegenAccumulator = 0; // Grey Stalker quiver arrow regen (5 s cadence)
    this._lastQuiverRef = null; // quiver swap detection resets the accumulator

    this.canvas = document.getElementById('game-canvas');
    this.renderer = new CanvasRenderer(this.canvas);
    // LIV-50: one shared control-swap feedback state; the renderer reads it to
    // draw the position locator + destination flash.
    this.swapFeedback = new SwapFeedback();
    this.renderer.swapFeedback = this.swapFeedback;

    this.statusBarsEl = document.getElementById('status-bars-container');
    this.sidebarEl = document.getElementById('sidebar-hud');
    this.loadoutEl = document.getElementById('loadout-container');
    this.backpackEl = document.getElementById('backpack-container');
    this.abilityBarEl = document.getElementById('ability-bar');
    this.combatLogScrollEl = document.getElementById('log-entries-container');
    this.modalOverlayEl = document.getElementById('modal-overlay');
    this.townEl = document.getElementById('town-screen');
    this.splashOverlayEl = document.getElementById('splash-overlay');
    this.titleAmbientCanvas = document.getElementById('title-ambient-canvas');
    this.transitionOverlayEl = document.getElementById('screen-transition');
    this.transition = new TransitionController(this.transitionOverlayEl);

    this.slots = [];
    this.options = normalizeOptions(null);
    this.lastPlayedSlotIndex = null;
    this.reduceMotionResolved = false;
    this.pendingSlotIndex = null;
    this.slotSelectMode = 'create';
    this.optionsReturnTo = 'title';
    this.isInGameplay = false;
    this.fpsEl = null;
    this.fpsFrames = 0;
    this.fpsAccumMs = 0;
    this.fpsValue = 0;
    this._mqlHandler = null;
    this.splashPromise = null;

    this.gestureEngine = new GestureEngine(
      event => this.handleGestureEvent(event),
      (slotIndex, ratio) => this.handleChargeUpdate(slotIndex, ratio)
    );

    this.inputController = new InputController(this);
    this.abilityBar = new AbilityBar(this);

    this.init();
  }

  async init() {
    window.addEventListener('resize', () => this.renderer.resize());
    this.renderer.resize();
    this.inputController.bindInputs();
    this.abilityBar.mount({ abilityBarEl: this.abilityBarEl });
    this.bindChromeControls();

    let bootstrapData = null;
    try {
      bootstrapData = await this.gameClient.bootstrap();
    } catch (err) {
      console.error('Failed to bootstrap Lokarta:', err);
    }

    if (bootstrapData) {
      this.profile = bootstrapData.profile || null;
      this.options = normalizeOptions(bootstrapData.options);
      this.slots = bootstrapData.slots || [];
      this.lastPlayedSlotIndex = bootstrapData.lastPlayedSlotIndex ?? null;
    }

    this.applyOptions(this.options);

    if (this.splashPromise) {
      try {
        await this.splashPromise;
      } catch {
        // Splash failure must never block the title screen.
      }
    }

    this.showTitleScreen();
  }

  bindChromeControls() {
    document.getElementById('header-guide-btn')?.addEventListener('click', () => {
      soundFX.play('click');
      if (this.isInGameplay && !this.isGameOver) this.openPauseMenu();
      else this.showGuideModal();
    });

    const audioBtn = document.getElementById('audio-toggle-btn');
    audioBtn?.addEventListener('click', async () => {
      soundFX.init();
      await this.setOption({ soundEffects: !this.options.soundEffects });
    });
    this.updateAudioButton();

    document.addEventListener('fullscreenchange', () => this.syncFullscreenState());
  }











































  /** Monotonic-ish clock for animation locks. */
  nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }



  showFateGrantModal(level = 1) {
    ModalManager.showFateGrantModal(this.modalOverlayEl, this, level);
  }


































}

Object.assign(LokartaApp.prototype, saveControllerMethods);

Object.assign(LokartaApp.prototype, floorControllerMethods);

Object.assign(LokartaApp.prototype, sceneControllerMethods);

Object.assign(LokartaApp.prototype, shopControllerMethods);

Object.assign(LokartaApp.prototype, inventoryControllerMethods);

Object.assign(LokartaApp.prototype, combatControllerMethods);

Object.assign(LokartaApp.prototype, hudFxMethods);

Object.assign(LokartaApp.prototype, gameLoopMethods);
