/**
 * Lokarta: Come Into The Light - Scene Controller
 *
 * Walkable overworld scenes (island/town) layered on top of the existing
 * `applyDungeonData` -> `GridMap` -> renderer/tick pipeline. A scene descriptor
 * comes from the worker `getScene` RPC (composed from catalog tilemaps by
 * `services/scene-composer.js`). Tower floors are untouched: scene handling is
 * entirely additive and only engages while `this.scene` is set (LIV-59 P1).
 */

import { LightingSystem, isTowerUnlocked } from '../engine/index.js';
import { UI_CATALOG, DEFAULT_TOWN_ID } from '../data/index.js';
import { soundFX } from '../audio/index.js';
import { ModalManager } from './modal-manager.js';

/**
 * Building interaction dispatch table (towns.json `interaction.type`). Shop and
 * temple reuse the existing byte-identical DOM panels; dialogue is a P2 seam.
 * Adding an interaction is a catalog value plus one entry here — never a
 * per-building branch.
 */
const BUILDING_INTERACTION_HANDLERS = {
  shop: (app) => app.openSceneShop(),
  temple: (app) => app.openSceneTemple(),
  dialogue: (app, entry) => app.showSceneDialogue(entry),
  heal: (app) => app.openSceneTemple(),
  quest_turnin: (app, entry) => app.showSceneDialogue(entry),
};

/** Portal dispatch table (island/town `portals[].type`). */
const PORTAL_HANDLERS = {
  scene: (app, portal) => app.enterScene(portal.target?.sceneId, portal.target?.spawn || null),
  tower: (app, portal) => app.enterTowerFromScene(portal),
};

/** Formats UI copy with `{name}` substitutions; missing copy resolves to ''. */
function fmt(template, vars = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

export const sceneControllerMethods = {
  /**
   * Loads a composed scene descriptor onto the live grid and places the party.
   * Does not start the loop or change save state; callers do that.
   * @param {object} scene
   * @param {{x:number,y:number}|null} [spawn]
   */
  applySceneData(scene, spawn = null) {
    if (!scene || !Array.isArray(scene.tiles)) return;
    this.scene = scene;
    this.currentFloorName = scene.name || 'The World';

    this.gridMap.loadFromMatrix(scene.tiles);

    // Scenes carry no tower floor systems.
    this.stairs = [];
    this.stairSystem = null;
    this.isFinalFloor = false;
    this.towerName = null;
    this.bossName = null;
    this.chests = [];
    this.props = [];
    this.springs = [];
    this.ambientLights = [];
    this.monsters = [];
    this.projectiles = [];
    this.particles = [];
    this.floatingTexts = [];
    this.deathEffects = [];
    this.selectedMonsterId = null;

    const entry = spawn && Number.isInteger(spawn.x) && Number.isInteger(spawn.y)
      ? spawn
      : scene.spawn;
    if (this.player && entry) {
      this.player.x = entry.x;
      this.player.y = entry.y;
      this.player.facing = this.player.facing || 'down';
    }
    // Transport the whole party around the arrival tile on a scene change.
    if (typeof this.layoutPartyOnFloor === 'function') {
      this.layoutPartyOnFloor(true, false);
    }

    // Outdoors is daylight; no player-radius FOV.
    LightingSystem.applyAmbient(this.gridMap);

    this.location = scene.sceneKind === 'town' ? 'town' : 'island';
    if (this.player) this.player.location = this.location;

    if (typeof this.updateHUD === 'function') this.updateHUD();
  },

  /**
   * Loads and enters a walkable scene by id (RPC `getScene`). Starts the game
   * loop when needed and immediately receives player input.
   * @param {string} sceneId
   * @param {{x:number,y:number}|null} [spawn]
   * @returns {Promise<boolean>}
   */
  async enterScene(sceneId, spawn = null) {
    const id = sceneId || DEFAULT_TOWN_ID;
    if (!id) return false;
    let scene;
    try {
      scene = await this.gameClient.getScene({ sceneId: id });
    } catch (err) {
      console.error('Scene load error:', err);
      return false;
    }
    if (!scene) return false;

    this.closeModal();
    ModalManager.hideTownScreen(this.townEl);
    this.isGameOver = false;
    this.isFloorCleared = false;
    this._sceneInteraction = false;
    this.applySceneData(scene, spawn);
    this.isPaused = false;
    this.isInGameplay = true;
    if (!this.isRunning) this.startGameLoop();
    this.logCombat(fmt(UI_CATALOG?.island?.arrived, { scene: scene.name }) || `You arrive at ${scene.name}.`, 'system');
    this.persistSave?.(false);
    return true;
  },

  /** The portal sitting on (x, y) in the active scene, or null. */
  scenePortalAt(x, y) {
    const portals = this.scene?.portals;
    if (!Array.isArray(portals)) return null;
    return portals.find((p) => p.x === x && p.y === y) || null;
  },

  /** The building interaction occupying doorway (x, y), or null. */
  sceneBuildingAt(x, y) {
    const interactables = this.scene?.interactables;
    if (!Array.isArray(interactables)) return null;
    return interactables.find((i) => i.kind === 'building' && i.x === x && i.y === y) || null;
  },

  /** Dispatches a scene portal through the portal table. */
  handleScenePortal(portal) {
    if (!portal) return false;
    const handler = PORTAL_HANDLERS[portal.type] || (portal.target?.sceneId ? PORTAL_HANDLERS.scene : null);
    if (!handler) return false;
    handler(this, portal);
    return true;
  },

  /** Dispatches a building doorway interaction through the table. */
  handleSceneBuilding(entry) {
    if (!entry) return false;
    const type = entry.interaction?.type;
    const handler = BUILDING_INTERACTION_HANDLERS[type];
    if (!handler) return false;
    handler(this, entry);
    return true;
  },

  /**
   * Entering the island's tower-entrance portal. The tower gate is data-driven:
   * a locked tower names the required quest instead of soft-locking. On unlock
   * the existing tower flow runs unchanged.
   */
  async enterTowerFromScene(portal) {
    const towerId = portal?.towerId || portal?.target?.towerId || this.player?.towerId;
    if (!towerId) return;
    if (!isTowerUnlocked(this.player?.towerProgress, towerId)) {
      this.logCombat(fmt(UI_CATALOG?.island?.tideGateLocked) || 'The way is sealed.', 'warning');
      this.addFloatingText('SEALED', this.player.x, this.player.y, '#ef4444');
      soundFX.play('uiBack');
      return;
    }
    try {
      const data = await this.gameClient.selectTower(this.player.slotIndex, towerId);
      this.player = data.player || this.player;
      this.scene = null;
      this.applyDungeonData(data.floor, { reviveDowned: true });
      LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);
      this.updateHUD();
      await this.persistSave(true);
      this.enterTower();
    } catch (err) {
      console.error('Tower entrance error:', err);
      this.enterScene(DEFAULT_TOWN_ID);
    }
  },

  /** Opens the shop panel from a town doorway; back resumes the walkable town. */
  openSceneShop() {
    this._sceneInteraction = true;
    this.isPaused = true;
    this.openShop();
  },

  /** Opens the temple panel from a town doorway; back resumes the walkable town. */
  openSceneTemple() {
    this._sceneInteraction = true;
    this.isPaused = true;
    this.openTemple();
  },

  /**
   * Dialogue placeholder for P1 (NPC dialogue UI ships in P2/LIV-60). Copy is a
   * catalog key — no literal JS strings.
   */
  showSceneDialogue(entry) {
    const prompt = UI_CATALOG?.island?.interactPrompt || 'Talk';
    const name = entry?.name || '';
    this.logCombat(name ? `${name}: ${prompt}` : prompt, 'system');
  },

  /**
   * Closes a scene interaction panel and resumes the walkable scene, or falls
   * back to the DOM town hub when the panel was opened from there.
   */
  closeInteraction() {
    if (this._sceneInteraction) {
      this._sceneInteraction = false;
      ModalManager.hideTownScreen(this.townEl);
      this.isPaused = false;
      this.persistSave?.(false);
      return;
    }
    this.showTown();
  }
};
