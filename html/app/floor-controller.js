/**
 * Lokarta: Come Into The Light - Floor Controller
 */

import {
  TILE_TYPES,
  LightingSystem,
  StairSystem,
  DoorSystem,
  isTowerUnlocked,
  recruitableVocations,
  ReviveSystem,
  FateGrantSystem,
  setReturnSpot,
  clearReturnSpot,
} from '../engine/index.js';
import { soundFX, ambientDirector } from '../audio/index.js';
import { TOWER_LEVEL_COUNT, getTowerLevelCount } from '../services/floor-generator.js';
import { listTowerDefinitions, getTowerDefinition, DEFAULT_TOWN_ID } from '../data/index.js';
import { createAnimState } from './animation-state.js';
import { ModalManager } from './modal-manager.js';

/**
 * Floor lifecycle and traversal: dungeon data load, stair/gate resolution, and town transitions.
 * Assigned onto `LokartaApp.prototype` from `app-controller.js`.
 */
export const floorControllerMethods = {
  applyDungeonData(floorData, options = {}) {
    // A tower floor replaces any walkable overworld scene (LIV-59 P1). Neutral
    // overworld NPCs and their prompt are scene-only (LIV-60 P2).
    this.scene = null;
    this.npcs = [];
    this.interactPromptTarget = null;
    this.currentFloorName = floorData.biome_name || 'The Gatehouse';
    this.gridMap.loadFromMatrix(floorData.tiles);

    // LIV-82: retarget the ambient bed to the floor's biome (catalog `tierId`
    // surfaced by floor-generator as `biome_id`). Falls back to the launch
    // Gatehouse tier when a floor carries no biome id.
    ambientDirector.setBiome(floorData.biome_id || 'crypt');

    // E8: retain the active floor's authored stair metadata + final-floor flag so
    // runtime traversal honors each stair's `dir`/`targetLevel` (D2 §3/§9.3)
    // instead of blindly advancing. The arrival tile is disarmed so stepping onto
    // it can never immediately re-trigger a transition.
    this.stairs = (floorData.stairs || []).map(stair => ({ ...stair }));
    // Track the active tower so final-floor detection and theming follow the
    // selected tower's level count, not the default tower's.
    this.towerId = floorData.tower_id || this.player?.towerId || null;
    this.towerLevelCount =
      Number(floorData.level_count) ||
      (this.towerId ? getTowerLevelCount(this.towerId) : TOWER_LEVEL_COUNT);
    this.isFinalFloor =
      floorData.is_final === true || (floorData.floor_number || 0) >= this.towerLevelCount;
    this.towerName = floorData.tower_name || null;
    this.bossName = (floorData.monsters || []).find(m => m.isBoss)?.name || 'the guardian';
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

    // Boss/mini-boss entrance sting: declared by catalog `isBoss` on the floor's
    // spawned monsters, never an id heuristic.
    if (this.monsters.some(m => m.isBoss === true)) soundFX.play('bossEntrance');

    // A new floor identity is a tower/level transition: the whole party must be
    // transported to the active member's arrival tile. Merely honoring a
    // member's old coordinates when they happen to be walkable on the new floor
    // (LIV-17) would leave a recruit behind at its previous map position.
    const floorKey = `${floorData.tower_id || this.towerId || ''}#${floorData.floor_number || ''}`;
    const floorChanged = this._partyFloorKey !== floorKey;
    this._partyFloorKey = floorKey;
    // LIV-76: a genuine teleport back into a tower/floor (town -> tower return
    // spot, tower select, portal entry) can land on a floor key we already
    // recorded, so `floorChanged` is false even though the party was relocated
    // across scenes. Callers flag those entries with `transportAll: true` so the
    // cluster is rebuilt and no member is stranded in a different room. A plain
    // same-floor reload (save/load, re-render) does NOT pass the flag and keeps
    // the party exactly where it stands.
    const transportAll = floorChanged || options.transportAll === true;
    // LIV-44: the between-floor mercy valve revives downed members on a genuine
    // floor transition only — never on a load/reload of the same floor. Callers
    // opt in explicitly (`handleFloorClear` / tower entry); the catalog
    // `revive.reviveOnFloorTransition` can turn the whole valve off.
    const config = ReviveSystem.resolveReviveConfig(this.player?.vocation);
    const reviveDowned = options.reviveDowned === true && config.reviveOnFloorTransition === true;
    this.layoutPartyOnFloor(transportAll, reviveDowned);
  },
  /**
   * Places and revives the non-active party on a freshly loaded floor
   * (LIV-13/WS4). Allies that fell on the previous floor recover between levels
   * so the party stays viable. On a genuine tower/level entry (`transportAll`)
   * every non-active member is moved to a free square hugging the active
   * member's arrival tile (LIV-17/LIV-76); otherwise a member is only relocated
   * when its stored coordinates are unusable on this floor (missing, blocked, or
   * occupied), so a plain same-floor reload never shuffles a valid formation.
   *
   * @param {boolean} [transportAll=false] - force-relocate every non-active member
   * @param {boolean} [reviveDowned=false] - true only on a genuine floor
   *   transition (`revive.reviveOnFloorTransition`); a reload keeps the body
   */
  layoutPartyOnFloor(transportAll = false, reviveDowned = false) {
    const player = this.player;
    if (!player || !Array.isArray(player.party)) return;
    const grid = this.gridMap;
    const activeId = player.activeMemberId;
    const occupied = new Set([`${player.x},${player.y}`]);

    for (const member of player.party) {
      if (!member || member.memberId === activeId) continue;

      if (ReviveSystem.isDowned(member)) {
        member.aiTargetId = null;
        member.aiRetargetTimer = 0;
        if (reviveDowned) {
          member.hp = member.max_hp;
          member.mana = member.max_mana;
          member.combatState = 'active';
          member.lifeState = 'alive';
          member.downedAtSec = 0;
          member.reviveGraceSec = 0;
          member._reviveTargetId = null;
          member._reviveProgressSec = 0;
        } else {
          // Same-floor reload: the body stays downed (LIV-44).
          member.combatState = 'downed';
          member.lifeState = 'downed';
          member.hp = 0;
        }
      }
      member.anim = createAnimState(member.facing || 'down');

      const usable =
        Number.isFinite(member.x) &&
        Number.isFinite(member.y) &&
        grid.isWalkable(member.x, member.y) &&
        !occupied.has(`${member.x},${member.y}`);
      if (transportAll || !usable) {
        const spot = this.findPartySpot(player.x, player.y, occupied);
        if (spot) {
          member.x = spot.x;
          member.y = spot.y;
        }
      }
      occupied.add(`${member.x},${member.y}`);
    }
  },
  /**
   * Nearest free walkable tile that hugs the active member (LIV-76).
   *
   * A breadth-first flood from (cx, cy) returns the closest tile **reachable
   * through walkable ground**, so every placed member is in the active member's
   * own connected room and the party reads as a contiguous group rather than a
   * scatter of Chebyshev-near-but-walled-off squares. Occupied tiles are walked
   * through (allies stand there) but never returned, and the caller accumulates
   * each placed member into `occupied` so successive members fan out cleanly.
   *
   * Runs only on floor load — allocations here are off the per-tick hot path.
   *
   * @param {number} cx active member x
   * @param {number} cy active member y
   * @param {Set<string>} occupied `"x,y"` tiles already claimed
   * @returns {{x:number,y:number}|null}
   */
  findPartySpot(cx, cy, occupied) {
    const grid = this.gridMap;
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    const seen = new Set([`${cx},${cy}`]);
    const queue = [{ x: cx, y: cy }];
    for (let head = 0; head < queue.length; head++) {
      const { x, y } = queue[head];
      for (let d = 0; d < dirs.length; d++) {
        const nx = x + dirs[d][0];
        const ny = y + dirs[d][1];
        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!grid.isWalkable(nx, ny)) continue;
        if (!occupied.has(key)) return { x: nx, y: ny };
        // A tile held by another ally is walkable: expand past it so later
        // members can still wrap the group without crossing a wall.
        queue.push({ x: nx, y: ny });
      }
    }
    return null;
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
    const finalFloor = this.isFinalFloor || currentFloor >= (this.towerLevelCount || TOWER_LEVEL_COUNT);
    const isSummit = kind === 'summit' || dir === 'summit';
    const targetLevel = resolution?.targetLevel ?? null;

    // D2 §9.3: the Summit stays sealed until the level-5 guardian is dead.
    if (isSummit && this.isGuardianAlive()) {
      const hint = `summit:${this.player.x},${this.player.y}`;
      if (this.stairHint !== hint) {
        this.stairHint = hint;
        this.logCombat(`The Summit is sealed until ${this.bossName} falls.`, 'warning');
        this.addFloatingText('SEALED', this.player.x, this.player.y, '#ef4444');
      }
      return;
    }

    const isVictory = isSummit || (targetLevel === null && finalFloor);

    if (isVictory) {
      // Non-terminal by default (LIV-10/WS2): clearing a tower's summit shows
      // Tower Complete and leads into Recruit; "Ultimate Victory" only fires
      // once every authored tower is complete.
      this.isFloorCleared = true;
      this.isPaused = true;
      await this.handleTowerCompletion();
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
        this.applyDungeonData(transition.floor, { reviveDowned: true, transportAll: true });
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
   * Non-terminal campaign completion (LIV-10/WS2). Records the cleared tower,
   * unlocks the next tower in order, then routes to either the terminal
   * Ultimate Victory screen (all towers done) or the Tower Complete + Recruit
   * flow. Falls back to the legacy victory screen if persistence fails so the
   * player is never stranded.
   */
  async handleTowerCompletion() {
    const towerId = this.towerId || this.player?.towerId || null;
    let data;
    try {
      await this.persistSave(true);
      data = await this.gameClient.completeTower(this.player.slotIndex, towerId);
    } catch (err) {
      console.error('Tower completion error:', err);
      soundFX.play('victory');
      this.showVictoryModal();
      return;
    }

    this.player = data.player || this.player;
    this.updateHUD();
    const towerLabel = (this.towerName || towerId || 'the tower').toUpperCase();

    if (data.allComplete) {
      soundFX.play('victory');
      this.logCombat('🎉 ALL TOWERS CONQUERED! LOKARTA IS FREE!', 'victory');
      this.addFloatingText('ULTIMATE VICTORY!', this.player.x, this.player.y, '#ffd700');
      this.showVictoryModal();
      return;
    }

    soundFX.play('victory');
    this.logCombat(`🎉 YOU CONQUERED ${towerLabel}! A new companion awaits.`, 'victory');
    this.addFloatingText('TOWER COMPLETE!', this.player.x, this.player.y, '#ffd700');
    this.showTowerCompleteModal(data);
  },
  /** Shows the Tower Complete card and leads into the recruit flow. */
  showTowerCompleteModal(data) {
    const nextTower = data?.nextTowerId ? getTowerDefinition(data.nextTowerId) : null;
    ModalManager.showTowerCompleteModal(this.modalOverlayEl, {
      towerName: this.towerName || this.towerId || 'the tower',
      nextTowerName: nextTower ? nextTower.name : null,
    }, {
      onContinue: () => this.promptRecruit(data),
      onReturnToTown: () => {
        this.isFloorCleared = false;
        this.rememberTowerExit();
        this.enterScene(DEFAULT_TOWN_ID);
      },
    });
  },
  /** Offers one remaining vocation; the player must pick one to continue. */
  promptRecruit(data) {
    const remaining = Array.isArray(data?.recruitableVocations) && data.recruitableVocations.length
      ? data.recruitableVocations
      : recruitableVocations(this.player);
    if (!remaining.length) {
      this.proceedToNextTower(data?.nextTowerId || null);
      return;
    }
    ModalManager.showRecruitModal(this.modalOverlayEl, remaining, {
      partyVocations: (this.player.party || []).map((m) => m.vocation),
    }, {
      onRecruit: (vocation) => this.finishRecruit(vocation, data?.nextTowerId || null),
    });
  },
  /** Persists the chosen recruit as the active member, then advances. */
  async finishRecruit(vocation, nextTowerId) {
    try {
      const data = await this.gameClient.recruitMember(this.player.slotIndex, vocation);
      this.player = data.player || this.player;
      this.updateHUD();
      const name = this.player.vocation ? this.player.vocation.toUpperCase() : String(vocation).toUpperCase();
      this.logCombat(`${name} joins your party!`, 'victory');
      await this.persistSave(true);
    } catch (err) {
      console.error('Recruit error:', err);
      this.isFloorCleared = false;
      this.rememberTowerExit();
      this.enterScene(DEFAULT_TOWN_ID);
      return;
    }
    this.proceedToNextTower(nextTowerId);
  },
  /**
   * Moves the active (newly recruited) member into the next unlocked tower,
   * or returns to the Town hub when the campaign has no next tower.
   */
  async proceedToNextTower(nextTowerId) {
    this.isFloorCleared = false;
    if (!nextTowerId || nextTowerId === this.player?.towerId) {
      this.rememberTowerExit();
      this.enterScene(DEFAULT_TOWN_ID);
      return;
    }
    try {
      const data = await this.gameClient.selectTower(this.player.slotIndex, nextTowerId);
      this.player = data.player;
      this.applyDungeonData(data.floor, { reviveDowned: true, transportAll: true });
      LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);
      this.updateHUD();
      await this.persistSave(true);
      this.enterTower();
    } catch (err) {
      console.error('Next-tower transition error:', err);
      this.enterScene(DEFAULT_TOWN_ID);
    }
  },
  /**
   * Walk-on Tower Gate: returns the player to the Town hub
   * from the floor's arrival room. `current_floor`, gold, and inventory persist.
   */
  handleTownGate(gridX, gridY) {
    if (this.location === 'town') return;
    soundFX.init();
    soundFX.play('teleport');
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
      onChooseTower: () => this.chooseTower(),
      onShop: () => this.openShop(),
      onTemple: () => this.openTemple(),
      onOptions: () => this.showOptionsModal('town'),
    });
  },
  /**
   * Opens the Town's tower picker. Selecting a different tower restarts the
   * current character at that tower's first floor (worker `selectTower`); picking
   * the active tower simply resumes it.
   */
  chooseTower() {
    const towers = listTowerDefinitions();
    ModalManager.showTowerSelectModal(this.modalOverlayEl, towers, this.player?.towerId || null, {
      progress: this.player?.towerProgress || null,
      onSelect: async (towerId) => {
        if (!isTowerUnlocked(this.player?.towerProgress, towerId)) {
          this.logCombat('That tower is sealed — clear the previous tower first.', 'warning');
          this.chooseTower();
          return;
        }
        const activeTowerId = this.player?.towerId || null;
        if (towerId === activeTowerId) {
          this.enterTower();
          return;
        }
        try {
          const data = await this.gameClient.selectTower(this.player.slotIndex, towerId);
          this.player = data.player;
          this.applyDungeonData(data.floor, { reviveDowned: true, transportAll: true });
          LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);
          this.updateHUD();
          await this.persistSave(true);
          this.enterTower();
        } catch (err) {
          console.error('Tower selection error:', err);
          this.showTown();
        }
      },
      onCancel: () => this.showTown(),
    });
  },
  /** Enter the tower from the Town: resume gameplay on the current floor. */
  enterTower() {
    this.location = 'tower';
    this.player.location = 'tower';
    // LIV-52: entering a tower (after leaving to Town / a party wipe / a tower
    // switch) resets each member's KO escalation counter to the 1st-down 10s.
    // Floor changes within a tower deliberately keep the count.
    ReviveSystem.resetAutoReviveCounts(this.player);
    ModalManager.hideTownScreen(this.townEl);
    this.closeModal();
    this.isPaused = false;
    this.logCombat('You step through the tower gate. The ascent begins.', 'system');
    soundFX.play('enterTower');
    // Fallback re-offer (LIV-64): only when the actor still has no primary
    // weapon. The first-quest accept grant equips the weapon to the paperdoll
    // but leaves the hotbar empty, so this guard prevents a duplicate grant.
    if (FateGrantSystem.needsStarterGrant(this.player, 1)) {
      this.showFateGrantModal(1);
    }
    this.updateHUD();
    this.persistSave();
  },
  /**
   * Remembers the tower + floor the player is leaving so the town return spot
   * (LIV-75) can re-enter it. Persisted on the shared run envelope; a no-op when
   * the active tower/floor is invalid (never records junk).
   */
  rememberTowerExit() {
    const towerId = this.towerId || this.player?.towerId || null;
    const floor = this.player?.current_floor;
    if (setReturnSpot(this.player, towerId, floor)) {
      this.persistSave?.(false);
    }
  },
  /**
   * Town return spot (LIV-75): re-enters the last-exited tower/floor through the
   * data-driven town teleporter. Reuses the existing tower-entry path (worker
   * access gate + `applyDungeonData` + `enterTower`). On any failure the spot is
   * cleared and the player stays in town — never a soft-lock.
   * @returns {Promise<boolean>} true when the tower was entered
   */
  async returnToTower() {
    const spot = this.returnSpot;
    if (!spot || this._returningToTower) return false;
    const slotIndex = this.player?.slotIndex;
    if (!slotIndex) return false;
    this._returningToTower = true;
    // Consume the spot immediately so a mid-transition tick cannot re-fire it.
    this.returnSpot = null;
    try {
      const data = await this.gameClient.enterTowerFloor(slotIndex, spot.towerId, spot.floor);
      this.player = data.player || this.player;
      this.scene = null;
      this.player.scene = null;
      this.npcs = [];
      this.applyDungeonData(data.floor, { reviveDowned: false, transportAll: true });
      LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);
      this.updateHUD();
      await this.persistSave(true);
      soundFX.play('teleport');
      this.enterTower();
      return true;
    } catch (err) {
      console.error('Tower return error:', err);
      // The remembered tower is no longer enterable: hide the spot and keep the
      // player in town rather than leaving a dead teleporter on the ground.
      clearReturnSpot(this.player);
      this.logCombat('The return gate is sealed — that tower cannot be entered yet.', 'warning');
      this.persistSave?.(false);
      return false;
    } finally {
      this._returningToTower = false;
    }
  },
  /** Leave the tower and return to the walkable Havenreach town scene. */
  leaveTower() {
    if (!this.isInGameplay) return;
    this.rememberTowerExit();
    this.player.location = 'town';
    this.transition.run('townVisit', () => this.enterScene(DEFAULT_TOWN_ID));
  }
};
