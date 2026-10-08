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
  isTowerUnlocked,
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
} from '../engine/index.js';
import {
  UI_CATALOG,
  DEFAULT_TOWN_ID,
  DIALOGUES_CATALOG,
  ITEMS_CATALOG,
  getDialogueDefinition,
  getQuestDefinition,
} from '../data/index.js';
import { planSceneMonsters, makeSceneMonster } from '../services/scene-spawner.js';
import { soundFX } from '../audio/index.js';
import { ModalManager } from './modal-manager.js';
import { createAnimState } from './animation-state.js';

/** Overworld roamer respawn cadence (seconds) and aggro reach, catalog copy. */
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

    // LIV-60 P2: neutral NPCs. P3: quest ground items (fetch) + visible roaming
    // monsters (kill objectives) from the authored spawn zones/elites.
    this.npcs = typeof spawnNpcsForScene === 'function' ? spawnNpcsForScene(scene) : [];
    this.spawnSceneGroundItems(scene);
    this.spawnSceneMonsters(scene);
    this.updateInteractPrompt();

    // `reach` objectives resolve on scene entry and every subsequent step.
    if (this.player) {
      this.fireQuestEvent({ type: 'reach', sceneId: scene.sceneId, x: this.player.x, y: this.player.y });
    }

    if (typeof this.updateHUD === 'function') this.updateHUD();
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
   * Tops each spawn zone back up to `maxAlive` and re-places a quest elite while
   * its quest is active. Run from the scene tick so roamers respawn forever.
   */
  updateSceneMonsters(deltaSec) {
    if (!this.scene || !this.player) return;
    this._sceneRespawnSec = (this._sceneRespawnSec || 0) + deltaSec;
    if (this._sceneRespawnSec < SCENE_RESPAWN_SEC) return;
    this._sceneRespawnSec = 0;
    ensureQuestState(this.player);
    const occupied = new Set();
    const plan = planSceneMonsters(this.scene, this.player.questState, {
      existing: this.monsters,
      occupied,
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
      this.npcs = [];
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
        text: fmt(UI_CATALOG?.island?.interactExaminePrompt || 'Examine', { name: target.object.name }),
      };
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
    return this.openDialogue(dialogueId, { targetId: npc.npcId, name: npc.name, portraitEmoji: npc.portraitEmoji });
  },

  /** Opens a scene object's world-prompt dialogue (e.g. the Drowned Shrine). */
  interactWithSceneObject(entry) {
    if (!entry) return false;
    const dialogueId = entry.promptKey || entry.dialogueId || entry.interaction?.dialogueId;
    if (!dialogueId) return false;
    return this.openDialogue(dialogueId, {
      targetId: entry.id,
      name: entry.name,
      requiresItem: entry.requiresItem || null,
    });
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
    const lines = (stage.lines || []).map((line) => fmt(line, ctx));
    const actions = (stage.actions || []).map((action) => ({
      ...action,
      label: this.dialogueActionLabel(action, def, ctx),
    }));
    this._sceneInteraction = true;
    this.isPaused = true;
    ModalManager.showDialogueModal(this.modalOverlayEl, {
      speaker: def.speaker || ctx.name || '',
      portraitEmoji: ctx.portraitEmoji || null,
      lines,
      actions,
      labels: DIALOGUES_CATALOG?.ui || {},
      onAction: (action) => this.handleDialogueAction(action, ctx),
      onClose: () => this.closeInteraction(),
    });
    return true;
  },

  /** Player-facing label for a dialogue action, catalog-driven. */
  dialogueActionLabel(action, def, ctx) {
    const labels = DIALOGUES_CATALOG?.ui || {};
    switch (action.type) {
      case 'accept_quest': return labels.acceptLabel || 'Accept';
      case 'turn_in_quest': return labels.turnInLabel || 'Turn in';
      case 'open_shop': return 'Trade';
      case 'open_temple': return 'Pray';
      case 'rest': return 'Rest';
      case 'interact': return UI_CATALOG?.island?.shrineRitePrompt || labels.continueLabel || 'Continue';
      default: return labels.continueLabel || 'Continue';
    }
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
      this.persistSave?.(false);
      if (context.dialogueId) {
        this.openDialogue(context.dialogueId, context);
        return;
      }
    }
    this.closeInteraction();
  },

  /** Turns in a completed quest, grants rewards, and shows the epilogue stage. */
  turnInQuestFromDialogue(questId, context = {}) {
    const res = turnInQuest(this.player.questState, this.player, questId);
    if (res.ok) {
      const copy = UI_CATALOG?.quests || {};
      this.logCombat(fmt(copy.turnedInCue, { quest: getQuestDefinition(questId)?.name || questId }), 'spell');
      this.announceRewards(res.rewards);
      this.updateHUD();
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
