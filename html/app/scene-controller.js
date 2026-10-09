/**
 * Lokarta: Come Into The Light - Scene Controller
 *
 * Walkable overworld scenes (island/town) layered on top of the existing
 * `applyDungeonData` -> `GridMap` -> renderer/tick pipeline. A scene descriptor
 * comes from the worker `getScene` RPC (composed from catalog tilemaps by
 * `services/scene-composer.js`). Tower floors are untouched: scene handling is
 * entirely additive and only engages while `this.scene` is set (LIV-59 P1).
 *
 * LIV-60 P2/P3 adds neutral NPCs, the dialogue UI, and the data-driven quest
 * seams. Every branch here is a dispatch-table lookup keyed by catalog data
 * (`npcs.json`/`dialogues.json`/`quests.json`) — no per-NPC/per-quest JS.
 */

import {
  LightingSystem,
  evaluateTowerAccess,
  evaluateSceneGate,
  sceneGateAt,
  findInteractableNpc,
  spawnNpcsForScene,
  NPC_INTERACT_RADIUS,
  recordEvent,
  dialogueSnapshot,
  selectDialogueStage,
  acceptQuest,
  turnInQuest,
  ensureQuestState,
  getQuestStatus,
  getObjectiveCount,
  canAcceptQuest,
  canTurnIn,
  resolveReturnSpot,
} from '../engine/index.js';
import {
  UI_CATALOG,
  DEFAULT_TOWN_ID,
  DIALOGUES_CATALOG,
  ITEMS_CATALOG,
  getDialogueDefinition,
  getQuestDefinition,
  listQuestDefinitions,
} from '../data/index.js';
import { planSceneMonsters, makeSceneMonster } from '../services/scene-spawner.js';
import { soundFX, ambientDirector } from '../audio/index.js';
import { ModalManager } from './modal-manager.js';
import { createAnimState } from './animation-state.js';
import { resolvePortraitId } from './portrait-renderer.js';

/** Quest-elite respawn cadence (seconds) and roamer aggro reach, catalog copy. */
const SCENE_RESPAWN_SEC = Math.max(1, Number(UI_CATALOG?.island?.sceneRespawnSec) || 20);
const SCENE_AGGRO_RADIUS = Math.max(1, Number(UI_CATALOG?.island?.sceneAggroRadius) || 8);

/**
 * Building interaction dispatch table (towns.json `interaction.type`). Shop and
 * temple reuse the existing byte-identical DOM panels; dialogue is the P2 seam.
 * Adding an interaction is a catalog value plus one entry here.
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

/**
 * Scene world-object action dispatch table (`interactables[].action`). Lets a
 * catalog-placed object run a direct action instead of opening a dialogue —
 * adding one is a catalog value plus one entry here (LIV-75 return spot).
 */
const SCENE_OBJECT_ACTION_HANDLERS = {
  return_to_tower: (app) => app.returnToTower(),
};

/**
 * Dialogue action dispatch table (dialogues.json `actions[].type`). Unknown
 * actions simply close the dialogue, so a data typo can never strand the player.
 */
const DIALOGUE_ACTION_HANDLERS = {
  accept_quest: (app, action, ctx) => app.acceptQuestFromDialogue(action.questId, ctx),
  turn_in_quest: (app, action, ctx) => app.turnInQuestFromDialogue(action.questId, ctx),
  open_shop: (app) => app.openSceneShop(),
  open_temple: (app) => app.openSceneTemple(),
  rest: (app, action) => app.restParty(action.healPct),
  interact: (app, action, ctx) => app.handleWorldInteract(action, ctx),
};

/**
 * Dialogue action -> button label resolver (dispatch table, not a switch).
 * Each resolver reads the catalog `dialogue.ui` copy with a safe static
 * fallback; unknown action types use `dialogueActionLabel`'s default.
 */
const DIALOGUE_ACTION_LABELS = {
  accept_quest: (labels) => labels.acceptLabel || 'Accept',
  turn_in_quest: (labels) => labels.turnInLabel || 'Turn in',
  open_shop: () => 'Trade',
  open_temple: () => 'Pray',
  rest: () => 'Rest',
  interact: (labels) => UI_CATALOG?.island?.shrineRitePrompt || labels.continueLabel || 'Continue',
};

/**
 * Quest `onAccept` effect dispatch table (quests.json `onAccept[].type`). Runs
 * once on the inactive -> active transition, so accepting arms the player
 * immediately (LIV-64) and a re-accept/reload can never replay the grant.
 * Unknown effect types are ignored — a catalog typo strands no one.
 */
const QUEST_ON_ACCEPT_HANDLERS = {
  fate_grant: (app, effect) => {
    if (typeof app.showFateGrantModal === 'function') {
      app.showFateGrantModal(Math.max(1, Math.floor(Number(effect?.level) || 1)));
    }
  },
};

/** Formats UI copy with `{name}`/`{quest}`/`{item}` substitutions. */
function fmt(template, vars = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

/** Quest objectives of `kind` whose `itemId` matches, for ground-item gating. */
function fetchObjectiveFor(questDef, itemId) {
  return (questDef?.objectives || []).find((obj) => obj.type === 'fetch' && obj.itemId === itemId) || null;
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
    // Re-apply any scene gate whose quest has since been turned in (LIV-55 P4).
    this.syncSceneGates(scene);

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

    // LIV-82: retarget the ambient bed to the scene's biome (`dawnreach_isle`
    // / `havenreach_town`). The director reads the `ambience` block; a biome
    // with no authored bed simply goes silent.
    ambientDirector.setBiome(scene.biome || null);

    // LIV-60 P2: neutral NPCs. P3: quest ground items (fetch) + visible roaming
    // monsters (kill objectives) from the authored spawn zones/elites.
    this.npcs = typeof spawnNpcsForScene === 'function' ? spawnNpcsForScene(scene) : [];
    this.armContactTalk();
    this.armAutoTriggerObjects();
    this.refreshQuestMarkers();
    this.spawnSceneGroundItems(scene);
    this.spawnSceneMonsters(scene);
    this.activateReturnSpot(scene);
    this.updateInteractPrompt();

    // `reach` objectives resolve on scene entry and every subsequent step.
    if (this.player) {
      this.player.scene = { sceneId: scene.sceneId, spawn: { x: this.player.x, y: this.player.y } };
      this.fireQuestEvent({ type: 'reach', sceneId: scene.sceneId, x: this.player.x, y: this.player.y });
    }

    if (typeof this.updateHUD === 'function') this.updateHUD();
  },

  /**
   * Opens every scene gate whose `accessGate` is already satisfied (LIV-55 P4).
   * Runs on scene load so a gate the player unlocked last visit renders open
   * without a re-trigger. No-op when the scene authors no gates.
   * @param {object} scene
   */
  syncSceneGates(scene) {
    const gates = scene && scene.gates;
    if (!Array.isArray(gates) || !this.player) return;
    for (const gate of gates) {
      if (evaluateSceneGate(this.player, gate).open) this.setSceneGateTilesOpen(gate);
    }
  },

  /** Marks every tile of `gate` open on the live grid (idempotent). */
  setSceneGateTilesOpen(gate) {
    for (const tile of gate?.tiles || []) {
      const entry = this.gridMap?.getTile?.(tile[0], tile[1]);
      if (entry) entry.gateOpen = true;
    }
  },

  /**
   * Walking into a scene gate tile (`GATED_DOOR`): open it when its quest gate
   * is satisfied, otherwise show the authored locked prompt and block — never a
   * silent soft-lock (LIV-55 P4). Returns true when the gate opened this step.
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  openSceneGateAt(x, y) {
    if (!this.scene || !this.player) return false;
    const gate = sceneGateAt(this.scene, x, y);
    if (!gate) return false;
    const state = evaluateSceneGate(this.player, gate);
    if (state.open) {
      this.setSceneGateTilesOpen(gate);
      soundFX.play('keyJangle');
      return true;
    }
    const key = `sceneGate:${x},${y}`;
    if (this.stairHint !== key) {
      this.stairHint = key;
      this.logCombat(fmt(UI_CATALOG?.island?.tideGateLocked) || 'The way is sealed.', 'warning');
      this.addFloatingText('SEALED', x, y, '#ef4444');
      soundFX.play('uiBack');
    }
    return false;
  },

  /**
   * Places catalog `groundItems` for a scene, gated so a fetch target only
   * exists while its quest is active and the fetch is still outstanding. This
   * prevents an infinite pickup of a one-shot quest item across scene reloads.
   */
  spawnSceneGroundItems(scene) {
    if (!this.player || !Array.isArray(scene?.groundItems)) return;
    ensureQuestState(this.player);
    for (const groundItem of scene.groundItems) {
      const entry = ITEMS_CATALOG[groundItem.itemId];
      if (!entry) continue;
      if (groundItem.questId) {
        const def = getQuestDefinition(groundItem.questId);
        const status = getQuestStatus(this.player.questState, groundItem.questId);
        const fetchObj = fetchObjectiveFor(def, groundItem.itemId);
        const satisfied = fetchObj
          ? getObjectiveCount(this.player.questState, def.id, fetchObj.id) >= (Number(fetchObj.count) || 1)
          : false;
        if (status !== 'active' || satisfied) continue;
      }
      this.gridMap.addItem(groundItem.x, groundItem.y, {
        ...entry,
        item_id: entry.item_id || groundItem.itemId,
        quantity: 1,
        questId: groundItem.questId || null,
      });
    }
  },

  /** Builds a runtime monster (catalog stats + walk animation) from a spawn. */
  buildSceneMonster(spawn) {
    return {
      ...makeSceneMonster(spawn.type, spawn.x, spawn.y, spawn.id, {
        spawnZoneId: spawn.spawnZoneId || null,
        questSpawnId: spawn.questSpawnId || null,
        questId: spawn.questId || null,
      }),
      anim: createAnimState('down'),
    };
  },

  /**
   * Populates a scene with its authored roamers + eligible quest elites. Called
   * on every scene load; positions are deterministic for the scene id.
   */
  spawnSceneMonsters(scene) {
    this.monsters = [];
    this._sceneMonsterSeq = 0;
    this._sceneRespawnSec = 0;
    if (!this.player) return;
    ensureQuestState(this.player);
    const plan = planSceneMonsters(scene, this.player.questState, {
      idPrefix: `sm_${scene.sceneId}`,
      idSeq: 0,
    });
    this.monsters = plan.map((spawn) => this.buildSceneMonster(spawn));
    this._sceneMonsterSeq = plan.length;
  },

  /**
   * Activates the town return spot (LIV-75) from the scene's authored placement
   * plus the player's persisted last-exited tower/floor. Only engages when both
   * a valid exit record and a placed spot exist, so the teleporter never appears
   * without somewhere to go. The runtime object joins `scene.interactables` so
   * the existing prompt/tap/interact plumbing reaches it, and a walk-on check in
   * the movement path fires it too. Data-driven: placement comes from towns.json.
   * @param {object} scene
   */
  activateReturnSpot(scene) {
    this.returnSpot = null;
    const exit = resolveReturnSpot(this.player);
    const placement = scene && scene.returnSpot;
    if (!exit || !placement) return;
    if (!Number.isInteger(placement.x) || !Number.isInteger(placement.y)) return;
    const spot = {
      towerId: exit.towerId,
      floor: exit.floor,
      x: placement.x,
      y: placement.y,
      name: placement.name || 'Tower Return',
      promptText: placement.promptText || placement.name || 'Return to the Tower',
    };
    this.returnSpot = spot;
    if (Array.isArray(this.scene.interactables)) {
      this.scene.interactables.push({
        kind: 'object',
        id: 'tower_return_spot',
        name: spot.name,
        promptText: spot.promptText,
        action: 'return_to_tower',
        x: spot.x,
        y: spot.y,
      });
    }
  },

  /**
   * Re-places the catalog quest elites authored `respawnUntilTurnedIn` while
   * their quest is active, on the catalog cadence. Spawn-zone roamers are placed
   * once on scene load (`spawnSceneMonsters`) and are never topped up mid-visit
   * (LIV-68): a killed roamer stays dead for the rest of the visit and only
   * returns when the player leaves and re-enters, which reloads the
   * deterministic pool. Tower floors are unaffected.
   */
  updateSceneMonsters(deltaSec) {
    if (!this.scene || !this.player) return;
    // Only quest elites opt into mid-visit respawn; with none authored the tick
    // is a pure no-op (roamers never auto-respawn).
    const questSpawns = Array.isArray(this.scene.questSpawns) ? this.scene.questSpawns : [];
    if (!questSpawns.some((qs) => qs.respawnUntilTurnedIn === true)) return;
    this._sceneRespawnSec = (this._sceneRespawnSec || 0) + deltaSec;
    if (this._sceneRespawnSec < SCENE_RESPAWN_SEC) return;
    this._sceneRespawnSec = 0;
    ensureQuestState(this.player);
    const occupied = new Set();
    const plan = planSceneMonsters(this.scene, this.player.questState, {
      existing: this.monsters,
      occupied,
      includeSpawnZones: false,
      idPrefix: `sm_${this.scene.sceneId}`,
      idSeq: this._sceneMonsterSeq || 0,
    });
    for (const spawn of plan) this.monsters.push(this.buildSceneMonster(spawn));
    this._sceneMonsterSeq = (this._sceneMonsterSeq || 0) + plan.length;
  },

  /** Wakes any roamer within the catalog aggro reach (ambient scenes never run
   *  the tower FOV pass that would otherwise set `isAggroed`). */
  updateSceneAggro() {
    if (!this.scene || !this.player) return;
    for (const monster of this.monsters) {
      if (monster.hp <= 0 || monster.isAggroed) continue;
      const d = Math.abs(monster.x - this.player.x) + Math.abs(monster.y - this.player.y);
      if (d <= SCENE_AGGRO_RADIUS) monster.isAggroed = true;
    }
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

  /** A world object (shrine/quest site) within `NPC_INTERACT_RADIUS`, or null. */
  sceneObjectInReach() {
    const interactables = this.scene?.interactables;
    if (!Array.isArray(interactables) || !this.player) return null;
    for (const it of interactables) {
      if (it.kind !== 'object') continue;
      const d = Math.abs(it.x - this.player.x) + Math.abs(it.y - this.player.y);
      if (d <= NPC_INTERACT_RADIUS) return it;
    }
    return null;
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
    if (!evaluateTowerAccess(this.player, towerId).unlocked) {
      this.logCombat(fmt(UI_CATALOG?.island?.tideGateLocked) || 'The way is sealed.', 'warning');
      this.addFloatingText('SEALED', this.player.x, this.player.y, '#ef4444');
      soundFX.play('uiBack');
      return;
    }
    try {
      const data = await this.gameClient.selectTower(this.player.slotIndex, towerId);
      this.player = data.player || this.player;
      this.scene = null;
      this.player.scene = null;
      this.npcs = [];
      this.applyDungeonData(data.floor, { reviveDowned: true, transportAll: true });
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

  // ---- Quest event seams (LIV-60 P3) -------------------------------------

  /** Dialogue/quest condition snapshot read from the live player. */
  getQuestSnapshot() {
    return dialogueSnapshot(this.player?.questState, this.player);
  },

  /**
   * Feeds one game event (kill/fetch/reach/interact/talk) to the quest system
   * and surfaces any objective/quest changes. Safe no-op when no quest state.
   * @returns {object[]} change records
   */
  fireQuestEvent(event) {
    if (!this.player) return [];
    ensureQuestState(this.player);
    const changes = recordEvent(this.player.questState, event);
    if (changes.length) this.applyQuestChanges(changes);
    return changes;
  },

  /** Emits HUD cues + a save for quest progress changes. */
  applyQuestChanges(changes) {
    const copy = UI_CATALOG?.quests || {};
    for (const change of changes) {
      if (change.completed) {
        this.logCombat(fmt(copy.completedCue, { quest: change.questName }) || `${change.questName} ready to turn in.`, 'spell');
      } else if (change.objectiveId) {
        this.logCombat(fmt(copy.updatedCue, { quest: change.questName }) || `${change.questName} updated.`, 'system');
      }
    }
    if (typeof this.updateHUD === 'function') this.updateHUD();
    this.refreshQuestMarkers();
    this.persistSave?.(false);
  },

  // ---- NPC / dialogue (LIV-60 P2) ----------------------------------------

  /** Resolves the interaction target the player is facing, or null. */
  findInteractTarget() {
    const npc = findInteractableNpc(this.npcs, this.player);
    if (npc) return { kind: 'npc', npc };
    const object = this.sceneObjectInReach();
    if (object) return { kind: 'object', object };
    return null;
  },

  /** Refreshes the cached interaction-prompt target the renderer draws. */
  updateInteractPrompt() {
    if (!this.scene) {
      this.interactPromptTarget = null;
      return;
    }
    const target = this.findInteractTarget();
    if (!target) {
      this.interactPromptTarget = null;
      return;
    }
    if (target.kind === 'npc') {
      this.interactPromptTarget = {
        x: target.npc.x,
        y: target.npc.y,
        text: fmt(UI_CATALOG?.island?.interactPrompt || 'Talk', { name: target.npc.name }),
      };
    } else {
      this.interactPromptTarget = {
        x: target.object.x,
        y: target.object.y,
        text: target.object.promptText
          || fmt(UI_CATALOG?.island?.interactExaminePrompt || 'Examine', { name: target.object.name }),
      };
    }
  },

  /**
   * Recomputes the quest marker (`available` | `turnin` | null) on every scene
   * NPC from the live quest state (LIV-55 P5). Purely data-driven: each quest's
   * `giverNpcId`/`turnInNpcId` is matched against the NPC's catalog id — no
   * per-NPC JS branch.
   */
  refreshQuestMarkers() {
    if (!Array.isArray(this.npcs) || !this.player) return;
    ensureQuestState(this.player);
    const state = this.player.questState;
    const defs = listQuestDefinitions();
    for (const npc of this.npcs) {
      if (!npc) continue;
      let marker = null;
      for (const def of defs) {
        if (def.turnInNpcId === npc.npcId && canTurnIn(state, def.id)) { marker = 'turnin'; break; }
      }
      if (!marker) {
        for (const def of defs) {
          if (def.giverNpcId === npc.npcId && canAcceptQuest(state, this.player, def.id).ok) { marker = 'available'; break; }
        }
      }
      npc.questMarker = marker;
    }
  },

  /** Interact key / tap entry point: talk to an NPC or examine a world object. */
  interact() {
    if (!this.isInGameplay || this.isPaused || this.isGameOver || this.isFloorCleared) return false;
    const target = this.findInteractTarget();
    if (!target) return false;
    if (target.kind === 'npc') return this.openNpcDialogue(target.npc);
    return this.interactWithSceneObject(target.object);
  },

  /** Opens the dialogue tree bound to `npc` and records the `talk` objective. */
  openNpcDialogue(npc) {
    if (!npc) return false;
    const dialogueId = npc.defaultDialogueId || npc.interact?.dialogueId;
    this.fireQuestEvent({ type: 'talk', npcId: npc.npcId });
    if (!dialogueId) return false;
    return this.openDialogue(dialogueId, {
      targetId: npc.npcId,
      name: npc.name,
      portraits: npc.portraits || null,
      portraitEmoji: npc.portraitEmoji,
    });
  },

  /**
   * Clears the bump-talk latch for the freshly loaded scene (LIV-66) so the
   * first deliberate bump of an NPC opens its dialogue. Arriving adjacent to an
   * NPC never triggers talk on its own — only a blocked step does — so no
   * spawn-contact suppression is required (that was the retired LIV-63 model).
   */
  armContactTalk() {
    this._bumpTalkNpcId = null;
  },

  /**
   * Clears the auto-trigger latch for the freshly loaded scene (LIV-71) so the
   * first approach to an `autoTrigger` world object (the Drowned Shrine) fires
   * its beat. The latch is a reused Set keyed by object id — never rebuilt on
   * the walk path, so the per-step check stays allocation-free.
   */
  armAutoTriggerObjects() {
    this._autoTriggeredObjectIds = new Set();
  },

  /**
   * Bump-to-talk (LIV-66): opens `npc`'s default dialogue after the player
   * attempted to step onto its tile and was blocked by collision. The call site
   * is the blocked-step branch of `processMovementInput`; merely standing next
   * to, or walking past, an NPC never triggers it. Fires once per bump: while
   * the player keeps pressing into the same NPC it will not reopen, and the
   * latch is cleared by the next successful step or on scene load
   * (`armContactTalk`). Data-driven — the caller only ever passes a blocking NPC
   * (`findBumpedNpc`), so there are no per-NPC branches.
   * @param {object} npc
   * @returns {boolean} true when a dialogue opened on this bump
   */
  bumpTalk(npc) {
    if (!npc) return false;
    if (!this.isInGameplay || this.isPaused || this.isGameOver || this.isFloorCleared) return false;
    if (npc.npcId === this._bumpTalkNpcId) return false;
    this._bumpTalkNpcId = npc.npcId;
    return this.openNpcDialogue(npc) !== false;
  },

  /**
   * Runs a scene object's direct action (e.g. the return spot) when it declares
   * one, otherwise opens its world-prompt dialogue (e.g. the Drowned Shrine).
   */
  interactWithSceneObject(entry) {
    if (!entry) return false;
    if (entry.action) {
      const handler = SCENE_OBJECT_ACTION_HANDLERS[entry.action];
      if (handler) return handler(this) !== false;
    }
    const dialogueId = entry.promptKey || entry.dialogueId || entry.interaction?.dialogueId;
    if (!dialogueId) return false;
    return this.openDialogue(dialogueId, {
      targetId: entry.id,
      name: entry.name,
      requiresItem: entry.requiresItem || null,
    });
  },

  /**
   * Auto-triggers any `autoTrigger` world object the player walks onto or
   * adjacent to (LIV-71) — the "approach" seam, mirroring bump-to-talk. Called
   * once per successful step from `resolvePlayerTileEntry`. Fires once per
   * approach: the object id is latched while the player remains in reach and is
   * released the moment they step away, so lingering never reopens the beat and
   * leaving/re-entering re-arms it. An object whose `requiresItem` is unmet does
   * NOT latch — it stays a prompt (`updateInteractPrompt`) until the item is
   * held, so gating reads as "Examine", never a locked beat.
   * Data-driven: only catalog entries carrying `autoTrigger: true` participate;
   * no per-object JS branch.
   * @returns {boolean} true when an object beat opened on this step
   */
  tryAutoTriggerSceneObjects() {
    if (!this.scene || !this.player) return false;
    const interactables = this.scene.interactables;
    if (!Array.isArray(interactables)) return false;
    if (!(this._autoTriggeredObjectIds instanceof Set)) this._autoTriggeredObjectIds = new Set();
    let fired = false;
    for (const it of interactables) {
      if (!it || it.kind !== 'object' || it.autoTrigger !== true) continue;
      const d = Math.abs(it.x - this.player.x) + Math.abs(it.y - this.player.y);
      const inReach = d <= NPC_INTERACT_RADIUS;
      if (!inReach) {
        this._autoTriggeredObjectIds.delete(it.id);
        continue;
      }
      if (this._autoTriggeredObjectIds.has(it.id)) continue;
      if (it.requiresItem && !this.partyHasItem(it.requiresItem)) continue;
      this._autoTriggeredObjectIds.add(it.id);
      if (this.interactWithSceneObject(it)) fired = true;
    }
    return fired;
  },

  /**
   * Opens a dialogue by id: evaluates the tree's stages against the live quest
   * snapshot, renders the matching stage, and routes actions through the
   * dialogue-action dispatch table. Pauses the simulation while open.
   */
  openDialogue(dialogueId, context = {}) {
    const def = getDialogueDefinition(dialogueId);
    if (!def) return false;
    const stage = selectDialogueStage(def, this.getQuestSnapshot());
    if (!stage) return false;
    const ctx = { ...context, dialogueId };
    // LIV-81: pick the bust for the stage's expression from the NPC's portrait
    // map. Data-only resolution; an absent asset leaves `portraitId` null so the
    // modal keeps the emoji fallback.
    const portraitId = resolvePortraitId(ctx.portraits, stage.expression);
    const lines = (stage.lines || []).map((line) => fmt(line, ctx));
    const actions = (stage.actions || []).map((action) => ({
      ...action,
      label: this.dialogueActionLabel(action, def, ctx),
    }));
    this._sceneInteraction = true;
    this.isPaused = true;
    ModalManager.showDialogueModal(this.modalOverlayEl, {
      speaker: def.speaker || ctx.name || '',
      portraitId,
      portraitEmoji: ctx.portraitEmoji || null,
      lines,
      actions,
      labels: DIALOGUES_CATALOG?.ui || {},
      anchor: this.dialogueAnchorFor(ctx),
      viewport: this.dialogueViewport(),
      onAction: (action) => this.handleDialogueAction(action, ctx),
      onClose: () => this.closeInteraction(),
    });
    return true;
  },

  /**
   * Viewport-space anchor for the speaking NPC (LIV-67), so the dialogue renders
   * as a speech bubble above them. Returns null when there is no NPC target or
   * no live canvas/renderer (world prompts / tests) — the modal then falls back
   * to its centered panel. `x` is the NPC's on-screen center; `top`/`bottom`
   * are its tile edges, mapped through the canvas rect to viewport coords.
   * @returns {{x:number, top:number, bottom:number, height:number}|null}
   */
  dialogueAnchorFor(context) {
    const targetId = context && context.targetId;
    if (!targetId || !Array.isArray(this.npcs)) return null;
    let npc = null;
    for (const candidate of this.npcs) {
      if (candidate && candidate.npcId === targetId) { npc = candidate; break; }
    }
    const renderer = this.renderer;
    const canvas = this.canvas;
    if (!npc || !renderer || !canvas || typeof canvas.getBoundingClientRect !== 'function') return null;
    const size = Number(renderer.tileSize) || 0;
    if (size <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    const tileX = npc.x * size - (Number(renderer.cameraX) || 0);
    const tileY = npc.y * size - (Number(renderer.cameraY) || 0);
    return {
      x: rect.left + tileX + size / 2,
      top: rect.top + tileY,
      bottom: rect.top + tileY + size,
      height: size,
    };
  },

  /** Viewport size for speech-bubble clamping, or null off-DOM. */
  dialogueViewport() {
    if (typeof window === 'undefined') return null;
    return { width: window.innerWidth || 0, height: window.innerHeight || 0 };
  },

  /** Player-facing label for a dialogue action, catalog-driven. */
  dialogueActionLabel(action, def, ctx) {
    const labels = DIALOGUES_CATALOG?.ui || {};
    const resolver = action && DIALOGUE_ACTION_LABELS[action.type];
    if (resolver) return resolver(labels);
    return labels.continueLabel || 'Continue';
  },

  /** Dispatches a dialogue action; unknown actions close the dialogue. */
  handleDialogueAction(action, context) {
    if (!action) {
      this.closeInteraction();
      return;
    }
    const handler = DIALOGUE_ACTION_HANDLERS[action.type];
    if (!handler) {
      this.closeInteraction();
      return;
    }
    handler(this, action, context);
  },

  /** Accepts a quest from a dialogue and replays the tree at its new stage. */
  acceptQuestFromDialogue(questId, context = {}) {
    const res = acceptQuest(this.player.questState, this.player, questId);
    if (res.ok) {
      const copy = UI_CATALOG?.quests || {};
      this.logCombat(fmt(copy.newQuestCue, { quest: getQuestDefinition(questId)?.name || questId }), 'spell');
      this.updateHUD();
      this.refreshQuestMarkers();
      this.persistSave?.(false);
      // Data-driven accept-time effects (LIV-64): a quest that arms the player
      // on accept closes the dialogue and hands off to the effect handler (the
      // Fate Grant) so the player is equipped before the first fight. A quest
      // with no `onAccept` keeps the replay-the-dialogue path below.
      if (Array.isArray(res.onAccept) && res.onAccept.length) {
        this.closeInteraction();
        this.applyQuestOnAccept(res.onAccept);
        return;
      }
      if (context.dialogueId) {
        this.openDialogue(context.dialogueId, context);
        return;
      }
    }
    this.closeInteraction();
  },

  /** Dispatches accept-time quest effects through the catalog-keyed table. */
  applyQuestOnAccept(effects) {
    for (const effect of Array.isArray(effects) ? effects : []) {
      const handler = QUEST_ON_ACCEPT_HANDLERS[effect?.type];
      if (typeof handler === 'function') handler(this, effect);
    }
  },

  /** Turns in a completed quest, grants rewards, and shows the epilogue stage. */
  turnInQuestFromDialogue(questId, context = {}) {
    const res = turnInQuest(this.player.questState, this.player, questId);
    if (res.ok) {
      const copy = UI_CATALOG?.quests || {};
      this.logCombat(fmt(copy.turnedInCue, { quest: getQuestDefinition(questId)?.name || questId }), 'spell');
      this.announceRewards(res.rewards);
      this.updateHUD();
      this.refreshQuestMarkers();
      this.persistSave?.(false);
      if (context.dialogueId) {
        this.openDialogue(context.dialogueId, context);
        return;
      }
    }
    this.closeInteraction();
  },

  /** Logs a human-readable line per granted reward (catalog copy). */
  announceRewards(rewards) {
    const copy = UI_CATALOG?.quests || {};
    for (const reward of rewards || []) {
      if (reward.type === 'xp') this.logCombat(`${copy.rewardXp || 'XP'}: +${reward.amount}`, 'loot');
      else if (reward.type === 'gold') this.logCombat(`${copy.rewardGold || 'Gold'}: +${reward.amount}`, 'loot');
      else if (reward.type === 'item' && reward.success) this.logCombat(`${copy.rewardItem || '{item}'}`.replace('{item}', reward.name || reward.itemId), 'loot');
      else if (reward.type === 'unlock_tower') this.logCombat((copy.rewardUnlock || 'Unlocked: {tower}').replace('{tower}', reward.towerId), 'spell');
      else if (reward.type === 'set_flag') this.logCombat(copy.rewardFlag || 'The world shifts.', 'system');
    }
  },

  /** World interact action (dialogues.json `type: interact`), e.g. the shrine rite. */
  handleWorldInteract(action, context = {}) {
    if (action.requiresItem && !this.partyHasItem(action.requiresItem)) {
      this.logCombat(fmt(UI_CATALOG?.island?.shrineNeedsItem, { item: action.requiresItem }) || `You need ${action.requiresItem}.`, 'warning');
      this.closeInteraction();
      return;
    }
    if (context.targetId) {
      this.fireQuestEvent({ type: 'interact', targetId: context.targetId });
    }
    this.closeInteraction();
  },

  /** True when any party container holds at least one of `itemId`. */
  partyHasItem(itemId) {
    if (!this.player || !itemId) return false;
    const containers = [this.player.action_bar, this.player.backpack];
    const paperdoll = this.player.paperdoll || {};
    for (const slot of Object.values(paperdoll)) if (slot) containers.push([slot]);
    for (const list of containers) {
      if (!Array.isArray(list)) continue;
      for (const slot of list) {
        if (slot && slot.item_id === itemId && (slot.quantity || 1) > 0) return true;
      }
    }
    return false;
  },

  /** Rest action: heals the whole living party to full (inn/rest). */
  restParty() {
    if (!this.player) return;
    const members = [this.player, ...(Array.isArray(this.player.party) ? this.player.party : [])];
    for (const member of members) {
      if (!member || member.hp <= 0) continue;
      member.hp = member.max_hp;
      member.mana = member.max_mana;
    }
    this.logCombat('You rest. The party is restored.', 'spell');
    this.updateHUD();
    this.persistSave?.(false);
    this.closeInteraction();
  },

  /**
   * P1-era alias used by building interactions; now routes to the real dialogue.
   */
  showSceneDialogue(entry) {
    if (!entry) return;
    if (entry.npcId) {
      const npc = (this.npcs || []).find((n) => n.npcId === entry.npcId);
      if (npc) {
        this.openNpcDialogue(npc);
        return;
      }
    }
    if (entry.interaction?.dialogueId) {
      this.openDialogue(entry.interaction.dialogueId, { targetId: entry.id, name: entry.name });
      return;
    }
    if (entry.dialogueId) {
      this.openDialogue(entry.dialogueId, { targetId: entry.id, name: entry.name });
    }
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
