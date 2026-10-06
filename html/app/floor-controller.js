/**
 * Lokarta: Come Into The Light - Floor Controller
 */

import {
  TILE_TYPES,
  LightingSystem,
  StairSystem,
  DoorSystem,
} from '../engine/index.js';
import { soundFX } from '../audio/index.js';
import { TOWER_LEVEL_COUNT } from '../services/floor-generator.js';
import { createAnimState } from './animation-state.js';
import { ModalManager } from './modal-manager.js';

/**
 * Floor lifecycle and traversal: dungeon data load, stair/gate resolution, and town transitions.
 * Assigned onto `LokartaApp.prototype` from `app-controller.js`.
 */
export const floorControllerMethods = {
  applyDungeonData(floorData) {
    this.currentFloorName = floorData.biome_name || 'The Gatehouse';
    this.gridMap.loadFromMatrix(floorData.tiles);

    // E8: retain the active floor's authored stair metadata + final-floor flag so
    // runtime traversal honors each stair's `dir`/`targetLevel` (D2 §3/§9.3)
    // instead of blindly advancing. The arrival tile is disarmed so stepping onto
    // it can never immediately re-trigger a transition.
    this.stairs = (floorData.stairs || []).map(stair => ({ ...stair }));
    this.isFinalFloor =
      floorData.is_final === true || (floorData.floor_number || 0) >= TOWER_LEVEL_COUNT;
    this.stairSystem = new StairSystem(
      this.stairs,
      this.player?.current_floor || floorData.floor_number || 1,
      this.player ? { x: this.player.x, y: this.player.y } : null
    );
    this.stairHint = null;

    // Tag gated-door tiles with their tier so the renderer can resolve the
    // copper/silver/gold prop (data-driven; no per-level renderer branches).
    for (const [tier, gate] of Object.entries(floorData.gates || {})) {
      for (const t of gate.tiles || []) {
        const tile = this.gridMap.getTile(t.x, t.y);
        if (tile) {
          tile.gateTier = tier;
          tile.gateOpen = false;
        }
      }
    }

    // E3: reopen any gate whose key the player already earned on this level, so
    // re-entering a cleared level can never soft-lock behind an earned key.
    DoorSystem.syncPlayerGates(this.gridMap, this.player, this.player?.current_floor);

    for (const item of floorData.items || []) {
      this.gridMap.addItem(item.x, item.y, item);
    }

    // Chests are world entities, not tile items. Restore persisted opened-state
    // so a save/load keeps opened chests empty (E4 persistence).
    this.chests = (floorData.chests || []).map(chest => ({ ...chest }));

    // D4 room props/decor. Placed furniture props block
    // movement, while floor decor (rugs) stays walk-over. Dropped items and
    // chests are never marked blocked, so they remain walkable.
    this.props = (floorData.props || []).map(p => ({ ...p }));
    for (const prop of this.props) {
      if (prop.layer === 'prop') this.gridMap.blockTile(prop.x, prop.y, true);
    }

    // Healing springs are impassable fountains in each floor's
    // stair room; standing on an adjacent square regenerates +5 HP/+5 MP per
    // second (applied in the fixed tick below).
    this.springs = (floorData.springs || []).map(s => ({ ...s }));

    this.ambientLights = [];
    this.monsters = (floorData.monsters || []).map(s => ({
      ...s,
      isAggroed: false,
      moveCooldown: 0,
      attackCooldown: 0,
      attackCadence: s.attackCadence ?? 1.5,
      visible: false,
      anim: createAnimState(s.facing || 'down'),
    }));
    if (this.player) this.player.anim = createAnimState(this.player.facing || 'down');
  },
  /**
   * Resolves a floor-clear event. `resolution` comes from `StairSystem.resolve`
   * and carries the authored stair `dir`/`targetLevel`, so traversal honors the
   * two-way shaft (up -> previous level, down -> next level) instead of always
   * advancing. A `summit` resolves to victory, but only after the final floor's
   * guardian falls (D2 §9.3). Called with no arguments by the boss-death path,
   * which resolves through the catalog-driven final-floor check.
   */
  async handleFloorClear(resolution = null) {
    if (this.isFloorCleared) return;

    const dir = resolution?.dir || null;
    const kind = resolution?.kind || null;
    const currentFloor = this.player?.current_floor || 1;
    const finalFloor = this.isFinalFloor || currentFloor >= TOWER_LEVEL_COUNT;
    const isSummit = kind === 'summit' || dir === 'summit';
    const targetLevel = resolution?.targetLevel ?? null;

    // D2 §9.3: the Summit stays sealed until the level-5 guardian is dead.
    if (isSummit && this.isGuardianAlive()) {
      const hint = `summit:${this.player.x},${this.player.y}`;
      if (this.stairHint !== hint) {
        this.stairHint = hint;
        this.logCombat('The Summit is sealed until the Spire Warden falls.', 'warning');
        this.addFloatingText('SEALED', this.player.x, this.player.y, '#ef4444');
      }
      return;
    }

    const isVictory = isSummit || (targetLevel === null && finalFloor);

    if (isVictory) {
      this.isFloorCleared = true;
      this.isPaused = true;
      soundFX.play('victory');
      this.logCombat('🎉 YOU CONQUERED THE CROWN SPIRE! THE TOWER IS LIT!', 'victory');
      this.addFloatingText('CAMPAIGN COMPLETED!', this.player.x, this.player.y, '#ffd700');
      await this.persistSave(true);
      this.showVictoryModal();
      return;
    }

    if (targetLevel === null) {
      // Missing/unknown direction: no-op with a one-shot feedback cue (§9.3).
      const hint = `noop:${this.player.x},${this.player.y}`;
      if (this.stairHint !== hint) {
        this.stairHint = hint;
        this.logCombat('These stairs lead nowhere yet.', 'warning');
      }
      return;
    }

    this.isFloorCleared = true;
    this.isPaused = true;

    try {
      const nextFloor = targetLevel;
      const descending = dir === 'up';

      // Traversing stairs grants no XP (the old 50*floor bonus
      // was exploitable). XP comes only from defeating monsters.
      soundFX.play('stairs');
      this.logCombat(
        `Stepped on stairway! ${descending ? 'Descended' : 'Climbed'} to Floor ${nextFloor}.`,
        'victory'
      );
      this.addFloatingText(`FLOOR ${nextFloor}`, this.player.x, this.player.y, '#38bdf8');

      await this.transition.run('floorAdvance', async () => {
        const transition = await this.gameClient.advanceFloor(this.player, nextFloor);
        this.player = transition.player;
        this.applyDungeonData(transition.floor);
        LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);
        this.updateHUD();
        await this.persistSave(true);
      }, { skippable: false, label: `${descending ? 'DESCENDING TO' : 'ASCENDING TO'} FLOOR ${nextFloor}` });
    } catch (err) {
      console.error('Floor transition error:', err);
    } finally {
      this.isFloorCleared = false;
      if (this.modalOverlayEl.classList.contains('hidden')) {
        this.isPaused = false;
      }
    }
  },
  /**
   * Walk-on Tower Gate: returns the player to the Town hub
   * from the floor's arrival room. `current_floor`, gold, and inventory persist.
   */
  handleTownGate(gridX, gridY) {
    if (this.location === 'town') return;
    soundFX.init();
    soundFX.play('uiBack');
    this.logCombat('The Tower Gate hums — you return to the Town of Lokarta.', 'system');
    this.addFloatingText('TOWN', gridX, gridY, '#e5b95c');
    this.leaveTower();
  },
  /**
   * Opens a shut gated door by spending the per-level key earned for its tier
   *. The trigger is walking *into* the closed door (collision), which
   * is the only way to reach a gate — a closed gate is not walkable, so the
   * player can never stand on it before it opens.
   *
   * @param {number} [targetX=this.player?.x] - the tile the player is walking into
   * @param {number} [targetY=this.player?.y]
   * @returns {boolean} true when a door was opened
   */
  openDoorUnderPlayer(targetX = this.player?.x, targetY = this.player?.y) {
    const x = targetX;
    const y = targetY;
    const tile = this.gridMap?.getTile?.(x, y);
    if (!tile || tile.type !== TILE_TYPES.GATED_DOOR || tile.gateOpen) return false;

    const tier = tile.gateTier;
    if (!tier) return false;
    if (!DoorSystem.hasKey(this.player, tier, this.player?.current_floor)) {
      // Only nag once per attempt while blocked at the door.
      const hint = `door:${x},${y}`;
      if (this.stairHint !== hint) {
        this.stairHint = hint;
        this.logCombat(`The ${tier} door is shut — its key is still missing.`, 'warning');
        this.addFloatingText(`${tier.toUpperCase()} LOCKED`, x, y, '#ef4444');
      }
      return false;
    }

    const opened = DoorSystem.openTierGates(this.gridMap, tier);
    if (opened > 0) {
      soundFX.init();
      soundFX.play('keyJangle');
      this.logCombat(`You turn the ${tier} key — the door swings open!`, 'system');
      this.addFloatingText(`${tier.toUpperCase()} DOOR OPEN`, x, y, '#facc15');
      this.stairHint = null;
      this.updateHUD();
      this.persistSave(true);
      return true;
    }
    return false;
  },
  /**
   * Returns the healing fountain on one of the four squares adjacent to the
   * player, or null. Springs are impassable, so adjacency is
   * the only trigger surface.
   */
  findAdjacentSpring() {
    if (!this.player || !this.gridMap) return null;
    const x = this.player.x;
    const y = this.player.y;
    if (this.gridMap.isSpring(x + 1, y) || this.gridMap.isSpring(x - 1, y)
      || this.gridMap.isSpring(x, y + 1) || this.gridMap.isSpring(x, y - 1)) {
      return (this.springs || []).find(s => Math.abs(s.x - x) + Math.abs(s.y - y) === 1) || { id: 'spring' };
    }
    return null;
  },
  /**
   * Shows the Town hub. The game loop keeps rendering the
   * current floor behind the modal; gameplay input is paused.
   */
  showTown() {
    this.location = 'town';
    this.isPaused = true;
    // Clear any modal (pause/defeat) so the persistent Town screen is the only
    // surface; the canvas keeps rendering the current floor behind it.
    this.closeModal();
    ModalManager.renderTownHub(this.townEl, this, {
      onEnterTower: () => this.enterTower(),
      onShop: () => this.openShop(),
      onTemple: () => this.openTemple(),
      onOptions: () => this.showOptionsModal('town'),
    });
  },
  /** Enter the tower from the Town: resume gameplay on the current floor. */
  enterTower() {
    this.location = 'tower';
    this.player.location = 'tower';
    ModalManager.hideTownScreen(this.townEl);
    this.closeModal();
    this.isPaused = false;
    this.logCombat('You step through the tower gate. The ascent begins.', 'system');
    if (this.player.level === 1 && this.player.action_bar?.every(s => s === null)) {
      this.showFateGrantModal(1);
    }
    this.updateHUD();
    this.persistSave();
  },
  /** Leave the tower and return to the Town hub. */
  leaveTower() {
    if (!this.isInGameplay) return;
    this.player.location = 'town';
    this.transition.run('townVisit', () => this.showTown());
  }
};
