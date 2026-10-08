/**
 * Lokarta: Come Into The Light - Game Loop Controller
 */

import {
  CONFIG,
  TILE_TYPES,
  LightingSystem,
  EntityAI,
  CombatSystem,
  EconomySystem,
  ChestSystem,
  PartyAI,
  cycleActiveMember,
  ReviveSystem,
  updateNpcs,
  findBumpedNpc,
} from '../engine/index.js';
import {
  firstMonsterOnSegment,
  monstersCaughtByBeam,
} from '../engine/projectile-collision.js';
import { soundFX } from '../audio/index.js';
import { KEYBINDINGS_CATALOG, UI_CATALOG, VOCATIONS_CATALOG } from '../data/index.js';
import { setAnimState, advanceAnim } from './animation-state.js';
import { swapWithPartyMemberAt } from '../engine/party-swap.js';

const DIRECTION_VECTORS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

/**
 * Lifetime (seconds) of the Luminous Prayer orb VFX after each heal pulse
 *, resolved from `ui.json.playerVfx.luminousPrayer`.
 */
const LUMINOUS_PRAYER_VFX_SEC = Number(UI_CATALOG?.playerVfx?.luminousPrayer?.durationSec) || 1.6;

/**
 * Game loop and per-frame presentation: fixed-rate tick, animation clocks, and render.
 * Assigned onto `LokartaApp.prototype` from `app-controller.js`.
 */
export const gameLoopMethods = {
  startGameLoop() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isGameOver = false;
    this.isFloorCleared = false;

    this.tickTimer = window.setInterval(() => this.tick(), CONFIG.TICK_INTERVAL_MS);

    this.lastAnimTime = performance.now();
    const renderFrame = time => {
      const dt = time - this.lastAnimTime;
      this.lastAnimTime = time;
      this.updateAnimations(dt);
      this.render();
      if (this.options.showFps) this.updateFps(dt);

      if (this.isRunning) {
        this.animFrameId = requestAnimationFrame(renderFrame);
      }
    };
    this.animFrameId = requestAnimationFrame(renderFrame);
    this.updateHUD();
  },
  stopGameLoop() {
    this.isRunning = false;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  },
  tick() {
    if (!this.isRunning || this.isGameOver || this.isPaused || this.isFloorCleared) return;
    const deltaSec = CONFIG.TICK_INTERVAL_MS / 1000;

    // LIV-44 run clock + combat-idle accumulator. The revive start gate opens
    // only after `revive.idleSec` with no damage dealt/taken; any hit below
    // resets it. The player's post-revive grace window counts down here.
    this.elapsedSec = (this.elapsedSec || 0) + deltaSec;
    this.combatIdleSec = (this.combatIdleSec || 0) + deltaSec;
    // LIV-52: wall-clock anchor for smooth per-frame auto-revive ring drain.
    this._lastTickAtMs = this.nowMs();
    if (this.player.reviveGraceSec > 0) {
      this.player.reviveGraceSec = Math.max(0, this.player.reviveGraceSec - deltaSec);
    }

    // 0. Accumulate playtime for the slot card
    this.player.playtimeMs = (this.player.playtimeMs || 0) + CONFIG.TICK_INTERVAL_MS;

    // 1. Movement
    this.processMovementInput();

    // 2. Decrement cooldowns
    CombatSystem.decrementCooldowns(this.player, deltaSec);
    CombatSystem.decrementSpellTimers(this.player, deltaSec);

    // Holy Shield bubble decay: bubble pops when its duration hits 0.
    if (this.player.shieldDurationSec > 0) {
      this.player.shieldDurationSec = Math.max(0, this.player.shieldDurationSec - deltaSec);
      if (this.player.shieldDurationSec <= 0) {
        this.player.shieldAbsorb = 0;
      }
    }

    // Fortify Stance decay: -50% incoming damage for 10 s.
    if (this.player.fortifyTimer > 0) {
      this.player.fortifyTimer = Math.max(0, this.player.fortifyTimer - deltaSec);
      if (this.player.fortifyTimer <= 0) {
        this.player.fortifyActive = false;
      }
    }

    // Luminous Prayer orb VFX decay: presentation-only timer that
    // keeps the healing orbs visible briefly after each prayer pulse.
    if (this.player.luminousPrayerVfxSec > 0) {
      this.player.luminousPrayerVfxSec = Math.max(0, this.player.luminousPrayerVfxSec - deltaSec);
    }

    // Poison Tip buff expiry — the charge window (10s or 5 arrows)
    // closes when either the timer runs out or the last charged arrow is spent.
    if (this.player.poisonTipTimer > 0) {
      this.player.poisonTipTimer = Math.max(0, this.player.poisonTipTimer - deltaSec);
      if (this.player.poisonTipTimer <= 0) this.player.poisonTipArrows = 0;
    }

    // Player status effects (catalog `attacks[].onHit`): burn/poison DoT plus
    // slow/stun control timers, advanced through the engine dispatch table.
    const statusResult = CombatSystem.tickPlayerStatusEffects(this.player, deltaSec);
    if (statusResult.damage > 0) {
      this.combatIdleSec = 0;
      if (statusResult.burnDamage > 0) {
        this.addFloatingText(`-${statusResult.burnDamage} burn`, this.player.x, this.player.y, '#f97316');
      }
      if (statusResult.poisonDamage > 0) {
        this.addFloatingText(`-${statusResult.poisonDamage} poison`, this.player.x, this.player.y, '#84cc16');
      }
      this.logCombat(`Status effects sear you for ${statusResult.damage} damage!`, 'warning');
      soundFX.play('playerHurt');
      setAnimState(this.player, 'hit', this.nowMs());
      this.updateHUD();
    }

    // Tick poison DoT + Hunter's Mark on monsters. Any enemy slain by
    // poison resolves through the normal death/loot/XP path.
    const poisonedDeaths = CombatSystem.tickStatusEffects(this.monsters, deltaSec);
    for (const dead of poisonedDeaths) {
      this.handleCombatResult({
        success: true,
        message: `${dead.name} succumbs to poison!`,
        defeatedMonsterId: dead.id,
        droppedLoot: CombatSystem.generateMonsterLoot(dead),
      }, null, null);
    }

    // Grey Stalker quiver arrow regen: +1 arrow per ammoRegenSec (5 s base)
    // while below capacity. The accumulator resets on regen and on quiver swap.
    const quiver = this.player.paperdoll?.off_hand;
    if (quiver !== this._lastQuiverRef) {
      this._lastQuiverRef = quiver;
      this.ammoRegenAccumulator = 0;
    }
    if (quiver && typeof quiver.arrowCount === 'number' && typeof quiver.arrowCapacity === 'number') {
      if (quiver.arrowCount < quiver.arrowCapacity) {
        const regenSec = (quiver.ammoRegenSec || 5);
        this.ammoRegenAccumulator += deltaSec;
        if (this.ammoRegenAccumulator >= regenSec) {
          const gained = Math.min(
            quiver.arrowCapacity - quiver.arrowCount,
            Math.floor(this.ammoRegenAccumulator / regenSec)
          );
          quiver.arrowCount += gained;
          this.ammoRegenAccumulator %= regenSec;
          this.addFloatingText(`+${gained} Arrow`, this.player.x, this.player.y, '#ddaa44');
        }
      } else {
        this.ammoRegenAccumulator = 0;
      }
    }

    // Passive HP/MP recovery: every character regenerates
    // ~1 HP and ~1 MP per 10s (catalog-driven via economy.passiveRecovery).
    const regen = EconomySystem.passiveRecovery();
    this.passiveRecoveryAccumulator += deltaSec;
    if (this.passiveRecoveryAccumulator >= regen.intervalSec) {
      this.passiveRecoveryAccumulator -= regen.intervalSec;
      const restored = EconomySystem.applyPassiveRecovery(this.player);
      if (restored.hp > 0) this.addFloatingText(`+${restored.hp} HP`, this.player.x, this.player.y, '#22c55e');
      if (restored.mp > 0) this.addFloatingText(`+${restored.mp} MP`, this.player.x, this.player.y, '#3b82f6');
      if (restored.hp > 0 || restored.mp > 0) this.updateHUD();
    }

    // Healing spring: while the active member stands on a square adjacent to a
    // fountain, the whole living party (catalog `economy.springs.healsParty`)
    // restores HP/MP each second, capped at max, ramping while the stay lasts
    // and resetting the moment the player steps away (LIV-74).
    this.updateSpringRegen(deltaSec);

    // Auto-Prayer Pulse (Luminous Amulet every 10 seconds)
    const equippedRelic = this.player.paperdoll?.relic;
    if (equippedRelic && equippedRelic.item_id === 'relic_luminous_amulet') {
      if (!this.prayerAccumulator) this.prayerAccumulator = 0;
      this.prayerAccumulator += deltaSec;
      if (this.prayerAccumulator >= 10.0) {
        this.prayerAccumulator -= 10.0;
        const rank = equippedRelic.itemLevel || 1;
        const pointsPool = rank * 2; // Rank 1: 2, Rank 2: 4, Rank 3: 6, Rank 4: 8, Rank 5: 10

        let hpNeeded = Math.max(0, this.player.max_hp - this.player.hp);
        let manaNeeded = Math.max(0, this.player.max_mana - this.player.mana);

        let hpRestored = 0;
        let manaRestored = 0;
        let poolRemaining = pointsPool;

        if (hpNeeded > 0 && poolRemaining > 0) {
          hpRestored = Math.min(hpNeeded, poolRemaining);
          poolRemaining -= hpRestored;
          this.player.hp += hpRestored;
        }

        if (manaNeeded > 0 && poolRemaining > 0) {
          manaRestored = Math.min(manaNeeded, poolRemaining);
          poolRemaining -= manaRestored;
          this.player.mana += manaRestored;
        }

        if (hpRestored > 0 || manaRestored > 0) {
          soundFX.play('holyChime');
          this.player.luminousPrayerVfxSec = LUMINOUS_PRAYER_VFX_SEC;
          let text = '';
          if (hpRestored > 0 && manaRestored > 0) text = `+${hpRestored} HP / +${manaRestored} MP`;
          else if (hpRestored > 0) text = `+${hpRestored} HP`;
          else text = `+${manaRestored} MP`;

          this.addFloatingText(text, this.player.x, this.player.y, '#f59e0b');
          this.logCombat(`Luminous Amulet Prayer restored ${text}.`, 'spell');
          this.updateHUD();
        }
      }
    }

    // Power Pulse (Apprentice's Cape armor)
    const equippedArmor = this.player.paperdoll?.armor;
    if (equippedArmor && equippedArmor.item_id === 'apprentice_cape') {
      if (!this.powerPulseAccumulator) this.powerPulseAccumulator = 0;
      this.powerPulseAccumulator += deltaSec;
      const rankCap = EconomySystem.maxRankForParty(this.player);
      const rank = Math.min(rankCap, Math.max(1, equippedArmor.itemLevel || 1));
      const intervalSec = Math.max(12, 22 - 2 * rank); // Rank 1: 20s, Rank 2: 18s, ... floors at 12s from Rank 5

      if (this.powerPulseAccumulator >= intervalSec) {
        this.powerPulseAccumulator -= intervalSec;
        const mpRestored = rank; // +1 MP at Rank 1 up to +5 MP at Rank 5

        if (this.player.mana < this.player.max_mana) {
          const actualRestored = Math.min(mpRestored, this.player.max_mana - this.player.mana);
          this.player.mana += actualRestored;
          soundFX.play('manaRegen');
          this.addFloatingText(`+${actualRestored} MP Pulse`, this.player.x, this.player.y, '#38bdf8');
          this.logCombat(`Apprentice's Cape Power Pulse restored +${actualRestored} MP!`, 'spell');
          this.updateHUD();
        }
      }
    }

    // 3. Update lighting. Outdoor scenes are ambient (fully lit); tower floors
    // keep the player-radius FOV unchanged (LIV-59 P1).
    if (this.scene && this.scene.lighting === 'ambient') {
      LightingSystem.applyAmbient(this.gridMap);
    } else {
      LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);
    }

    // 3b. Overworld roamers (LIV-60 P3, revised LIV-68): roamers are placed once
    //     on scene load and do NOT auto-respawn mid-visit — only quest elites
    //     flagged `respawnUntilTurnedIn` are re-placed here. Wake any roamer
    //     within aggro reach. Ambient scenes skip the tower FOV pass, so aggro
    //     is handled here. Tower floors are unaffected.
    if (this.scene) {
      this.updateSceneMonsters(deltaSec);
      this.updateSceneAggro();
    }

    // 4. Update monster AI (targets the nearest living party member)
    const positionsBefore = this.monsters.map(m => ({ m, x: m.x, y: m.y }));
    const aiResults = EntityAI.updateMonsters(
      this.monsters,
      this.player,
      this.gridMap,
      deltaSec,
      PartyAI.livingAllies(this.player)
    );
    for (const res of aiResults) {
      if ((res.damageToPlayer && res.damageToPlayer > 0) || (res.absorbed && res.absorbed > 0)) {
        this.combatIdleSec = 0;
      }
      const hitTarget = res.target || this.player;
      const isActiveTarget = hitTarget === this.player;
      if (res.message) this.logCombat(res.message, 'combat');
      if (res.projectiles) this.projectiles.push(...res.projectiles);
      // Catalog `onHit` status effects land on whichever member was struck.
      if (res.statusEffects) {
        for (const eff of res.statusEffects) {
          if (CombatSystem.applyPlayerStatus(hitTarget, eff)) {
            this.addFloatingText(eff.status.toUpperCase(), hitTarget.x, hitTarget.y, '#f97316');
          }
        }
      }
      // Catalog `summon` attacks spawn new opponents (built in the engine).
      if (res.spawns && res.spawns.length > 0) {
        for (const spawn of res.spawns) this.monsters.push(spawn);
      }
      if (res.sourceMonster && (res.dodged || (res.damageToPlayer && res.damageToPlayer > 0) || (res.absorbed && res.absorbed > 0))) {
        setAnimState(res.sourceMonster, 'attack', this.nowMs());
      }
      if (res.deflected) {
        soundFX.play('lightSpell');
        this.addFloatingText('DEFLECTED!', hitTarget.x, hitTarget.y, '#38bdf8');
      } else if (res.dodged) {
        soundFX.play('monsterAttack');
        this.addFloatingText('DODGE!', hitTarget.x, hitTarget.y, '#22c55e');
      } else if (res.damageToPlayer && res.damageToPlayer > 0) {
        soundFX.play('monsterAttack');
        if (isActiveTarget) soundFX.play('playerHurt');
        setAnimState(hitTarget, 'hit', this.nowMs());
        this.addFloatingText(`-${res.damageToPlayer}`, hitTarget.x, hitTarget.y, '#ef4444');
        if (res.absorbed && res.absorbed > 0 && isActiveTarget) {
          this.logCombat(`Your holy shield absorbed ${res.absorbed} of the blow.`, 'spell');
        }
      } else if (res.absorbed && res.absorbed > 0) {
        // Hit fully absorbed by the bubble — no HP lost.
        soundFX.play('monsterAttack');
        this.addFloatingText(`shield -${res.absorbed}`, hitTarget.x, hitTarget.y, '#38bdf8');
      }
    }
    // Walk cycles advance once per tile step (event-driven, not on a timer).
    for (const { m, x, y } of positionsBefore) {
      if (m.hp <= 0) continue;
      if (m.x !== x || m.y !== y) setAnimState(m, 'walk');
      else if (m.anim && m.anim.state === 'walk') setAnimState(m, 'idle');
    }

    // 4a. Neutral NPCs (LIV-60 P2): stationary/wander, catalog `aiType`. The
    //     occupancy set keeps NPCs off the player, living monsters, living
    //     allies, and each other. Scene-only, so tower ticks are untouched.
    if (Array.isArray(this.npcs) && this.npcs.length > 0) {
      const width = this.gridMap.width;
      // Reuse one occupancy set across ticks (clear, don't reallocate) to honor
      // the no-transient-allocation hot-path rule (agents.md §3).
      const occupied = this._npcOccupied || (this._npcOccupied = new Set());
      occupied.clear();
      occupied.add(this.player.y * width + this.player.x);
      for (const m of this.monsters) if (m.hp > 0) occupied.add(m.y * width + m.x);
      for (const a of PartyAI.livingAllies(this.player)) occupied.add(a.y * width + a.x);
      for (const n of this.npcs) occupied.add(n.y * width + n.x);
      updateNpcs(this.npcs, this.gridMap, deltaSec, occupied);
      // LIV-66 bump-to-talk: the trigger lives in `processMovementInput`'s
      // blocked-step branch (see above) — the player must attempt to walk onto
      // the NPC's tile. Standing adjacent never fires.
      this.updateInteractPrompt();
    }

    // 4b. Knockout seam (LIV-44): funnel any 0-HP member (active mirror
    //     included) through the single `markDowned` transition before the ally
    //     AI so the revive planner can see the downed body.
    ReviveSystem.markPartyDowned(this.player, {
      elapsedSec: this.elapsedSec,
      floor: this.player.current_floor,
    });

    // 4c. Party auto-AI (LIV-13/WS4): non-active members act after the player
    //     and monsters. Engine decides + applies movement/abilities; the app
    //     turns the returned events into sounds, log, float text and loot.
    this.updatePartyAllies(deltaSec);

    // 5. Party step (LIV-44): hand control off a downed active member, tick
    //    revive channels + self-stabilize, then evaluate the party wipe. Only a
    //    true simultaneous full-party knockout ends the run.
    const handoffFrom = { x: this.player.x, y: this.player.y };
    const partyStep = ReviveSystem.evaluateParty(this.player, {
      deltaSec,
      elapsedSec: this.elapsedSec,
      monsters: this.monsters,
      combatIdleSec: this.combatIdleSec,
      floor: this.player.current_floor,
      gridMap: this.gridMap,
    });
    if (partyStep.handoff) this.handleActiveHandoff(partyStep.handoff, handoffFrom);
    for (const ev of partyStep.events) this.applyPartyEvent(ev);
    if (partyStep.wiped && !this.isGameOver) {
      this.isGameOver = true;
      this.logCombat('The last of your party falls... The Light fails.', 'warning');
      this.onPartyWipe();
    }

    // 6. Stair traversal (E8): resolve the stair under the player against the
    //    active floor's authored dir/targetLevel, honoring the §9.3 arrival
    //    arming so a transition can never immediately re-trigger.
    if (!this.isFloorCleared && this.stairSystem) {
      this.stairSystem.syncArmed(this.player.x, this.player.y);
      const resolution = this.stairSystem.resolve(this.player.x, this.player.y);
      if (resolution) this.handleFloorClear(resolution);
    }

    // 7. Update HUD
    this.updateHUD();
  },
  /**
   * Advances the 1 Hz adjacent-spring regeneration. While the active member
   * stands beside a fountain the whole living party recovers catalog-scaled
   * HP/MP; a sustained stay ramps the amount (LIV-74) and the streak resets to
   * 0 the moment the player leaves. Returns true when anything was restored.
   * @param {number} deltaSec elapsed seconds since the previous tick
   * @returns {boolean}
   */
  updateSpringRegen(deltaSec) {
    if (!this.findAdjacentSpring()) {
      this.springRegenAccumulator = 0;
      this.springRegenStreak = 0;
      return false;
    }
    this.springRegenAccumulator += deltaSec;
    if (this.springRegenAccumulator < 1) return false;
    this.springRegenAccumulator -= Math.floor(this.springRegenAccumulator);
    this.springRegenStreak = (this.springRegenStreak || 0) + 1;
    const healed = this.applySpringRegenToParty(this.springRegenStreak);
    if (healed > 0) {
      soundFX.play('holyChime');
      this.updateHUD();
    }
    return healed > 0;
  },
  /**
   * Applies one second of healing-spring regen and floats the restored amounts.
   * Catalog rule `economy.springs.healsParty` (default true) restores every
   * living party member; `healsParty: false` keeps the legacy single-actor rule.
   * `consecutiveSeconds` carries the sustained-stay streak (LIV-74) so the
   * restore ramps while the player remains in contact.
   * @param {number} [consecutiveSeconds] defaults to the live streak (or 1)
   * @returns {number} how many members actually recovered HP or MP
   */
  applySpringRegenToParty(consecutiveSeconds) {
    const streak = Math.max(1, Math.floor(Number(consecutiveSeconds) || this.springRegenStreak || 1));
    if (!EconomySystem.springHealsParty()) {
      return this.applySpringRegenToMember(this.player, streak) ? 1 : 0;
    }
    const allies = PartyAI.livingAllies(this.player);
    let healed = 0;
    for (let i = 0; i < allies.length; i++) {
      if (this.applySpringRegenToMember(allies[i], streak)) healed++;
    }
    return healed;
  },
  /** Restores one member and floats its recovered HP/MP. Returns true when healed. */
  applySpringRegenToMember(member, consecutiveSeconds = 1) {
    if (!member) return false;
    const restored = EconomySystem.applySpringRegen(member, consecutiveSeconds);
    if (restored.hp > 0) this.addFloatingText(`+${restored.hp} HP`, member.x, member.y, '#22c55e');
    if (restored.mp > 0) this.addFloatingText(`+${restored.mp} MP`, member.x, member.y, '#3b82f6');
    return restored.hp > 0 || restored.mp > 0;
  },
  /**
   * Runs a full tick for every auto member and applies each returned intent:
   * per-member timers/status first, then the engine's `PartyAI.updateAllies`.
   * Empty party (legacy single-character save) is a no-op.
   */
  updatePartyAllies(deltaSec) {
    const members = PartyAI.inactiveMembers(this.player);
    if (!members || members.length === 0) return;

    const regen = EconomySystem.passiveRecovery();
    for (const member of members) {
      CombatSystem.tickActorTimers(member, deltaSec);

      if (member.shieldDurationSec > 0) {
        member.shieldDurationSec = Math.max(0, member.shieldDurationSec - deltaSec);
        if (member.shieldDurationSec <= 0) member.shieldAbsorb = 0;
      }
      if (member.fortifyTimer > 0) {
        member.fortifyTimer = Math.max(0, member.fortifyTimer - deltaSec);
        if (member.fortifyTimer <= 0) member.fortifyActive = false;
      }

      const status = CombatSystem.tickPlayerStatusEffects(member, deltaSec);
      if (status.damage > 0) {
        this.combatIdleSec = 0;
        this.addFloatingText(`-${status.damage}`, member.x, member.y, '#f97316');
        if (member.hp <= 0) this.addFloatingText('DOWN!', member.x, member.y, '#ef4444');
      }

      member._regenAccumulator = (member._regenAccumulator || 0) + deltaSec;
      if (member._regenAccumulator >= regen.intervalSec) {
        member._regenAccumulator -= regen.intervalSec;
        EconomySystem.applyPassiveRecovery(member);
      }
    }

    const events = PartyAI.updateAllies(this.player, {
      gridMap: this.gridMap,
      monsters: this.monsters,
      deltaSec,
      elapsedSec: this.elapsedSec,
      partyState: 'exploring',
      combatIdleSec: this.combatIdleSec,
    });
    for (const ev of events) this.applyPartyEvent(ev);
  },
  /**
   * LIV-44: a downed active member hands control to a living ally with no modal.
   * Drops held keys and any stale monster target so the new actor does not
   * inherit the previous member's input. LIV-50 layers the dramatic `beat` +
   * distinct cue, fluid position/camera move and destination flash on top.
   */
  handleActiveHandoff(member, from = {}) {
    this.keysDown.clear();
    this.selectedMonsterId = null;
    setAnimState(this.player, 'idle');
    const voc = VOCATIONS_CATALOG?.[member && member.vocation];
    const label = (voc && (voc.name || voc.renderTheme?.classLabel)) || (member && member.vocation) || 'an ally';
    this.logCombat(`The Light passes — control goes to ${label}.`, 'warning');
    const fx = Number.isFinite(from.x) ? from.x : this.player.x;
    const fy = Number.isFinite(from.y) ? from.y : this.player.y;
    this.addFloatingText('CONTROL → ALLY', fx, fy, '#fde68a');
    this.beginSwapFeedback(member, from, 'handoff');
    this.updateHUD();
  },
  /**
   * LIV-50: arm the control-swap presentation for the incoming `member`. Reads
   * all tuning from `ui.json.knockout.swap` (beat, position/camera durations,
   * easing, flash, cue names); `from` is the outgoing member's tile so the
   * camera can glide and the locator can travel instead of snapping. No-op when
   * the swap state object is absent (legacy/unit harnesses).
   */
  beginSwapFeedback(member, from = {}, kind = 'controlSwap') {
    const fb = this.swapFeedback;
    if (!fb || !member) return;
    const now = this.nowMs();
    const sx = Number.isFinite(from.x) ? from.x : this.player.x;
    const sy = Number.isFinite(from.y) ? from.y : this.player.y;
    fb.begin({
      kind,
      fromX: sx,
      fromY: sy,
      toX: member.x,
      toY: member.y,
      memberId: member.memberId,
      nowMs: now,
    });
    // A camera glide makes the swap read fluidly; the renderer clamps to zero
    // duration under reduced motion (snap).
    if (this.renderer && typeof this.renderer.startCameraGlide === 'function') {
      this.renderer.startCameraGlide(fb.cameraMs, fb.cfg.easing, now);
    }
    const cue = kind === 'handoff' ? fb.cfg.sfx.koHandoff : fb.cfg.sfx.controlSwap;
    if (cue) soundFX.play(cue);
  },
  /**
   * LIV-27 / FIX-12: hand control to the next (`direction` +1) or previous
   * (-1) living party member. Delegates the swap to the engine
   * `cycleActiveMember`, which keeps every non-active member on its
   * `party_ai.json` auto-AI profile. Returns true when control actually moved.
   */
  cycleControlledMember(direction) {
    const from = { x: this.player.x, y: this.player.y };
    const member = cycleActiveMember(this.player, direction);
    if (!member) return false;
    // Held keys belong to the previous actor; drop them, and clear any stale
    // monster target, so the new member does not inherit either on the next tick.
    this.keysDown.clear();
    this.selectedMonsterId = null;
    setAnimState(this.player, 'idle');
    const voc = VOCATIONS_CATALOG?.[member.vocation];
    const label = (voc && (voc.name || voc.renderTheme?.classLabel)) || member.vocation;
    this.logCombat(`Now controlling ${label}.`, 'system');
    this.beginSwapFeedback(member, from, 'controlSwap');
    this.updateHUD();
    this.persistSave();
    return true;
  },
  /**
   * LIV-22 — an auto ally collects any ground item it steps onto, routing it
   * through the same walk-over pipeline (and into the same shared party
   * backpack) the active member uses. No-op when its tile is empty. The pickup
   * persists in the background, exactly like the active member's walk-over.
   */
  handleAllyWalkoverPickup(member) {
    if (!member || !this.gridMap || !this.player) return;
    if (this.gridMap.getItems(member.x, member.y).length === 0) return;
    this.handlePickUp(member.x, member.y);
  },
  /** Turns one party-AI intent into animation, sound, log, float text and loot. */
  applyPartyEvent(ev) {
    if (!ev || !ev.member) return;
    const member = ev.member;
    if (ev.type === 'move') {
      // No footstep cue for auto allies: 3 members stepping every tick would
      // flood the audio channel. Only the player's own step plays.
      setAnimState(member, 'walk');
      // LIV-22: allies also collect walk-over drops into the shared backpack.
      this.handleAllyWalkoverPickup(member);
      return;
    }
    if (ev.type === 'idle') {
      if (member.anim && member.anim.state === 'walk') setAnimState(member, 'idle');
      return;
    }
    if (ev.type === 'ability') {
      setAnimState(member, 'attack', this.nowMs());
      this.resolvePartyAbilityResult(ev);
    }
    if (ev.type === 'potion') {
      this.resolvePartyPotionResult(ev);
    }
    // LIV-44 knockout/revive cues.
    if (ev.type === 'revive' && ev.phase === 'begin') {
      soundFX.play('lightSpell');
      if (ev.target) this.addFloatingText('REVIVING...', ev.target.x, ev.target.y, '#fde68a');
      return;
    }
    if (ev.type === 'revived') {
      soundFX.play('holyChime');
      this.addFloatingText('REVIVED', member.x, member.y, '#fde68a');
      this.logCombat(`${ev.member?.vocation ? String(ev.member.vocation).toUpperCase() : 'An ally'} is back on their feet.`, 'spell');
      this.updateHUD();
      this.persistSave();
      return;
    }
    if (ev.type === 'autoRevive') {
      // LIV-52: the pending timer elapsed — the member stands back up in place.
      soundFX.play('holyChime');
      this.addFloatingText('REVIVED', member.x, member.y, '#fde68a');
      const vocab = VOCATIONS_CATALOG?.[member.vocation];
      const nameOf = (vocab && vocab.name) || (member.vocation ? member.vocation.charAt(0).toUpperCase() + member.vocation.slice(1) : 'An ally');
      const cue = UI_CATALOG?.knockout?.autoReviveCue;
      this.logCombat(cue ? cue.replace('{member}', nameOf) : `${nameOf} pulls themselves back up.`, 'spell');
      this.updateHUD();
      this.persistSave();
    }
  },
  /** Applies an auto-ally potion drink: cue, log, float text, HUD + save. */
  resolvePartyPotionResult(ev) {
    const res = ev.result;
    if (!res || !res.success) return;
    soundFX.play('potionDrink');
    if (res.message) this.logCombat(res.message, 'loot');
    const label = ev.resource === 'mp' ? 'MP' : 'HP';
    const color = ev.resource === 'mp' ? '#38bdf8' : '#22c55e';
    if (res.restored > 0) {
      this.addFloatingText(`+${res.restored} ${label}`, ev.member.x, ev.member.y, color);
    }
    this.updateHUD();
    this.persistSave();
  },
  /** Resolves an auto-ally ability through the shared combat-result pipeline. */
  resolvePartyAbilityResult(ev) {
    const res = ev.result;
    if (!res || !res.success) return;
    const member = ev.member;
    this.playPartyAbilitySound(ev.actionKey);

    // Multi-target (Cleave): per-hit float text + shared defeat resolution.
    if (Array.isArray(res.hits) && res.hits.length > 0) {
      if (res.message) this.logCombat(res.message, 'combat');
      if (res.projectiles) this.projectiles.push(...res.projectiles);
      for (const hit of res.hits) {
        this.addFloatingText(`-${hit.damage}`, hit.monster.x, hit.monster.y, '#ffdd44');
        if (hit.defeated && hit.monster.id) {
          this.handleCombatResult({
            success: true,
            defeatedMonsterId: hit.monster.id,
            droppedLoot: CombatSystem.generateMonsterLoot(hit.monster),
          }, hit.monster.x, hit.monster.y);
        }
      }
      return;
    }

    // Ally heal: float the restored HP on the healed member.
    if (res.healAmount > 0 || res.hpRestored > 0) {
      if (res.message) this.logCombat(res.message, 'spell');
      const hx = res.targetX ?? member.x;
      const hy = res.targetY ?? member.y;
      if (res.healAmount > 0) this.addFloatingText(`+${res.healAmount} HP`, hx, hy, '#22c55e');
      if (res.hpRestored > 0) this.addFloatingText(`+${res.hpRestored} HP`, hx, hy, '#22c55e');
      return;
    }

    // Ally shield (LIV-25): float the ward on the shielded member.
    if (res.shieldAbsorb > 0) {
      if (res.message) this.logCombat(res.message, 'spell');
      const sx = res.targetX ?? member.x;
      const sy = res.targetY ?? member.y;
      this.addFloatingText(`shield +${res.shieldAbsorb}`, sx, sy, '#38bdf8');
      return;
    }

    // Single-target / projectile abilities share the player combat-result path.
    this.handleCombatResult(res, ev.target ? ev.target.x : member.x, ev.target ? ev.target.y : member.y);
  },
  /** Per-action sound cue for an auto-ally cast (`actionKey` from the catalog). */
  playPartyAbilitySound(actionKey) {
    const cues = {
      wand_spark: 'wandSpark',
      energy_beam: 'energyBeam',
      bow_shot: 'bowShot',
      power_shot: 'powerShot',
      slash: 'hit',
      cleave: 'hit',
      holy_strike: 'hit',
      healing_prayer: 'lightSpell',
      force_shield: 'holyChime',
    };
    const cue = cues[actionKey];
    if (cue) soundFX.play(cue);
  },
  render() {
    // LIV-52: drain each downed member's auto-revive window at render rate so the
    // countdown ring glides between the 10 Hz simulation ticks. The engine still
    // owns the authoritative window; this only refreshes the display scalar.
    if (this.isRunning && !this.isPaused && !this.isGameOver && !this.isFloorCleared) {
      this.updateAutoReviveCountdowns();
    }
    // The renderer resolves the scene theme + ambient mode from this handle.
    this.renderer.scene = this.scene || null;
    // Neutral NPCs + the interaction prompt target for this frame (LIV-60 P2).
    this.renderer.npcs = Array.isArray(this.npcs) ? this.npcs : null;
    this.renderer.interactPrompt = this.interactPromptTarget || null;
    this.renderer.render(
      this.gridMap,
      this.player,
      this.monsters,
      this.ambientLights,
      this.projectiles,
      this.floatingTexts,
      this.selectedMonsterId,
      this.particles,
      this.deathEffects,
      this.chests,
      this.props,
      this.player.party
    );
  },
  /**
   * Refreshes every downed member's `autoReviveRemainingSec` from the wall-clock
   * (sub-tick interpolation) for a smooth countdown ring. Reads/writes scalars
   * only — no allocation in the per-frame path.
   */
  updateAutoReviveCountdowns() {
    const party = this.player && this.player.party;
    if (!Array.isArray(party)) return;
    const now = this.nowMs();
    const anchor = Number.isFinite(this._lastTickAtMs) ? this._lastTickAtMs : now;
    const sinceTick = Math.max(0, Math.min(CONFIG.TICK_INTERVAL_MS, now - anchor)) / 1000;
    const renderElapsed = (this.elapsedSec || 0) + sinceTick;
    for (let i = 0; i < party.length; i++) {
      const m = party[i];
      if (!m) continue;
      if (m.combatState === 'downed' || m.lifeState === 'downed' || !(Number(m.hp) > 0)) {
        m.autoReviveRemainingSec = ReviveSystem.autoReviveRemainingSec(m, renderElapsed);
      }
    }
  },
  processMovementInput() {
    // Player control statuses (catalog `onHit`): stun skips input entirely;
    // slow accumulates toward a full step so cadence drops by `slowFactor`.
    if (this.player.stunTimer > 0) return;

    // LIV-50 KO-handoff beat: the incoming actor's input is held for the
    // dramatic beat while the world keeps simulating around them.
    if (this.swapFeedback && this.swapFeedback.inputLocked(this.nowMs())) return;

    let dx = 0;
    let dy = 0;
    let newFacing = this.player.facing;
    const moveBindings = KEYBINDINGS_CATALOG.movement;

    for (const [dir, keys] of Object.entries(moveBindings)) {
      if (keys.some(k => this.keysDown.has(k))) {
        const vec = DIRECTION_VECTORS[dir];
        if (vec) {
          dx = vec.dx;
          dy = vec.dy;
          newFacing = dir;
          break;
        }
      }
    }

    if ((dx !== 0 || dy !== 0) && this.player.slowTimer > 0) {
      this.player.slowAccumulator = (this.player.slowAccumulator || 0) + (this.player.slowFactor || 0.5);
      if (this.player.slowAccumulator < 1) return;
      this.player.slowAccumulator -= 1;
    }

    if (dx !== 0 || dy !== 0) {
      this.player.facing = newFacing;
      const targetX = this.player.x + dx;
      const targetY = this.player.y + dy;

      // Walking into a shut gated door is the open trigger: the closed
      // gate is not walkable, so collision — not standing on it — must spend the
      // earned key. If it opens, step through in the same input.
      const targetTile = this.gridMap.getTile(targetX, targetY);
      const isShutGate = targetTile && targetTile.type === TILE_TYPES.GATED_DOOR && !targetTile.gateOpen;
      if (isShutGate) {
        // Scene gates (the island Tide Gate) resolve through the data-driven
        // scene gate; tower-floor gates spend an earned key. Either just-opened
        // gate allows the step-through this turn.
        if (this.scene) this.openSceneGateAt(targetX, targetY);
        else this.openDoorUnderPlayer(targetX, targetY);
      }

      // Walk Thru Walls (debug option): allows in-bounds non-walkable tiles.
      // Occupancy rules below still keep the player off monsters and allies.
      if (this.gridMap.canStep(targetX, targetY, this.options?.walkThruWalls === true)) {
        const monsterAtTarget = this.monsters.find(m => m.x === targetX && m.y === targetY && m.hp > 0);
        const allyAtTarget = PartyAI.partyMemberAt(this.player, targetX, targetY);
        if (allyAtTarget) {
          // Party rule (LIV-8 T2 round 2): an allied body never blocks the
          // primary. Walking into an ally trades places — the ally steps onto
          // the tile the player just left, so neither can be pinned.
          const swapped = swapWithPartyMemberAt(this.player, targetX, targetY);
          if (swapped) {
            swapped.facing = EntityAI.getFacing(swapped.x, swapped.y, this.player.x, this.player.y);
            setAnimState(swapped, 'walk');
            soundFX.play('footstep');
            setAnimState(this.player, 'walk');
            if (this.resolvePlayerTileEntry()) return;
          }
        } else if (monsterAtTarget) {
          this.selectedMonsterId = monsterAtTarget.id;
          this.logCombat(`Target locked on ${monsterAtTarget.name} (${monsterAtTarget.hp}/${monsterAtTarget.max_hp} HP).`, 'system');
        } else {
          const bumpedNpc = findBumpedNpc(this.npcs, this.player.x, this.player.y, targetX, targetY);
          if (bumpedNpc) {
            // A neutral body blocks the step (LIV-60 P2). LIV-66: that blocked
            // step is the "bump" that opens its dialogue — merely standing next
            // to the NPC never does. The player turns toward it and the
            // interaction prompt refreshes either way.
            this.bumpTalk(bumpedNpc);
            this.updateInteractPrompt();
          } else {
            this.player.x = targetX;
            this.player.y = targetY;
            // A real step re-arms bump-talk so the next walk into an NPC fires.
            this._bumpTalkNpcId = null;
            soundFX.play('footstep');
            setAnimState(this.player, 'walk');
            if (this.resolvePlayerTileEntry()) return;
          }
        }
      }
    } else if (this.player) {
      setAnimState(this.player, 'idle');
    }
  },
  /**
   * Resolves the world interactions for the tile the active member just entered:
   * frictionless walkover auto-pickup, walk-on chest open, and the walk-on Town
   * Gate. Healing springs are impassable fountains whose effect is applied
   * per-second from an adjacent square in tick().
   * Returns true when the Town Gate fired so the caller can stop the tick.
   * @returns {boolean}
   */
  resolvePlayerTileEntry() {
    const items = this.gridMap.getItems(this.player.x, this.player.y);
    if (items.length > 0) {
      this.handlePickUp();
    }

    // Walk-on chest open (E4): chests are world entities, not tile items.
    // Opening also collects the contents in the same turn.
    if (ChestSystem.findChestAt(this.chests, this.player.x, this.player.y)) {
      this.handleOpenChest(this.player.x, this.player.y);
    }

    // Walk-on Tower Gate: step back to the Town.
    if (this.gridMap.isTownGate(this.player.x, this.player.y)) {
      this.handleTownGate(this.player.x, this.player.y);
      return true;
    }

    // Walkable overworld seams (LIV-59 P1): scene portals (town <-> island <->
    // tower entrance) fire before building doorways, then doorway interactions.
    if (this.scene) {
      // `reach` objectives fire on every tile entry (LIV-60 P3).
      this.fireQuestEvent({ type: 'reach', sceneId: this.scene.sceneId, x: this.player.x, y: this.player.y });
      this.updateInteractPrompt();
      // Walk-up/adjacency story beats (LIV-71), e.g. the Drowned Shrine auto-
      // triggering its rite. Fires once per approach; a fire halts the step.
      if (this.tryAutoTriggerSceneObjects()) return true;
      const portal = this.scenePortalAt(this.player.x, this.player.y);
      if (portal) return this.handleScenePortal(portal);
      const building = this.sceneBuildingAt(this.player.x, this.player.y);
      if (building) return this.handleSceneBuilding(building);
    }
    return false;
  },
  resolveWaveLandedMonsters(carriedMonsters, fX, fY) {
    if (!carriedMonsters || carriedMonsters.length === 0) return;

    // Filter surviving monsters
    const survivors = carriedMonsters.filter(c => c.monster && c.monster.hp > 0);
    if (survivors.length === 0) return;

    // Group survivors by target landing tile
    const occupiedTiles = new Set();
    // Track monsters that are already stationary on the map (not in the wave)
    for (const m of this.monsters) {
      if (m.hp > 0 && !survivors.some(s => s.monster.id === m.id)) {
        occupiedTiles.add(`${m.x},${m.y}`);
      }
    }

    for (const entry of survivors) {
      const m = entry.monster;
      const originalKey = `${m.x},${m.y}`;

      if (!occupiedTiles.has(originalKey)) {
        // Tile is free, keep monster here
        occupiedTiles.add(originalKey);
      } else {
        // Tile is occupied, find closest adjacent free walkable tile
        let placed = false;
        // Search directions: backwards along wave path first, then sides, then forwards
        const checkOffsets = [
          { dx: -fX, dy: -fY },
          { dx: -fY, dy: -fX },
          { dx: fY, dy: fX },
          { dx: fX, dy: fY },
          { dx: -fX * 2, dy: -fY * 2 },
        ];

        for (const off of checkOffsets) {
          const nx = m.x + off.dx;
          const ny = m.y + off.dy;
          const key = `${nx},${ny}`;
          if (this.gridMap.isWalkable(nx, ny) && !occupiedTiles.has(key)) {
            m.x = nx;
            m.y = ny;
            occupiedTiles.add(key);
            placed = true;
            break;
          }
        }

        if (!placed) {
          // Fallback: keep on original tile if no adjacent space exists
          occupiedTiles.add(originalKey);
        }
      }
    }

    // Extend stun effect for 0.5s after the wave ends for all carried monsters
    for (const entry of carriedMonsters) {
      if (entry.monster && entry.monster.hp > 0) {
        entry.monster.stunTimer = 0.5;
      }
    }
  },
  updateAnimations(dtMs) {
    const dtSec = dtMs / 1000;

    // LIV-50: retire the control-swap presentation once every sub-timeline ends.
    if (this.swapFeedback) this.swapFeedback.update(this.nowMs());

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];

      // Energy Beam Wave Animation
      if (p.type === 'energy_beam' && p.waves) {
        if (!p.carriedMonsters) {
          p.carriedMonsters = []; // Array of { monster, wallStopped: boolean }
        }

        p.elapsedMs += dtMs;
        const targetWaveIndex = Math.floor(p.elapsedMs / p.stepIntervalMs);

        if (targetWaveIndex > p.currentWaveIndex && targetWaveIndex < p.waves.length) {
          p.currentWaveIndex = targetWaveIndex;
          const stepIdx = targetWaveIndex;
          const wave = p.waves[stepIdx];
          const stepDmg = p.stepDamage?.[stepIdx] ?? 40;
          const stepVol = p.stepVolumes?.[stepIdx] ?? 1.0;

          // Play cast sound ONCE per wave step, diminishing per step
          soundFX.play('energyBeam', stepVol);

          const fX = p.fX || 0;
          const fY = p.fY || 0;

          // 1. Catch new monsters standing on the current wave front OR that
          //    walked back into an already-swept tile behind the front. The
          //    swept check prevents a monster from phasing through the beam by
          //    moving opposite the wave: it is always caught instead.
          for (const tile of wave.tiles) {
            if (tile.isWall) {
              const pxX = tile.x * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2;
              const pxY = tile.y * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2;
              this.triggerImpactBurst(pxX, pxY, p.visual, p.color);
            }
          }

          const carriedIds = p.carriedMonsters.map(c => c.monster.id);
          const caughtThisStep = monstersCaughtByBeam(
            this.monsters,
            wave.tiles,
            { originX: p.sourceX, originY: p.sourceY, fX, fY, frontIndex: stepIdx },
            carriedIds,
            (m) => CombatSystem.isHostile(this.player, m)
          );
          for (const hitMonster of caughtThisStep) {
            // Stunned while riding the wave; marked so it rides this tile.
            hitMonster.stunTimer = 10.0;
            p.carriedMonsters.push({ monster: hitMonster, wallStopped: false, caughtStepIdx: stepIdx });
          }

          // 2. Advance ALREADY CARRIED monsters (caught in prior steps) forward along the wave direction (if not wall-stopped)
          for (const entry of p.carriedMonsters) {
            if (entry.monster.hp <= 0 || entry.wallStopped) continue;
            if (entry.caughtStepIdx === stepIdx) continue; // Just caught in this step, riding this tile

            const nextX = entry.monster.x + fX;
            const nextY = entry.monster.y + fY;

            if (this.gridMap.isWall(nextX, nextY) || !this.gridMap.isInBounds(nextX, nextY)) {
              // Wall collision!
              entry.wallStopped = true;
              const wallDmg = 10;
              entry.monster.hp -= wallDmg;
              this.addFloatingText(`-${wallDmg} Wall Collide!`, entry.monster.x, entry.monster.y, '#ef4444');
              this.logCombat(`${entry.monster.name} crashed into a wall while riding the wave for ${wallDmg} collision damage!`, 'combat');

              if (entry.monster.hp <= 0) {
                const loot = CombatSystem.generateMonsterLoot(entry.monster);
                this.handleCombatResult({
                  success: true,
                  defeatedMonsterId: entry.monster.id,
                  droppedLoot: loot,
                }, entry.monster.x, entry.monster.y);
              }
            } else {
              entry.monster.x = nextX;
              entry.monster.y = nextY;
            }
          }

          // 3. Apply step damage & stack collision checks to all active carried monsters
          const activeCarried = p.carriedMonsters.filter(c => c.monster.hp > 0);

          for (const entry of activeCarried) {
            if (entry.wallStopped) continue; // Wall-stopped monsters only took wall collision damage on this step
            const m = entry.monster;
            m.hp -= stepDmg;
            setAnimState(m, 'hit', this.nowMs());
            const pxX = m.x * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2;
            const pxY = m.y * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2;
            this.triggerImpactBurst(pxX, pxY, p.visual, p.color);

            let combatMsg = `Arcane Beam (Wave ${stepIdx + 1}) swept up ${m.name} for ${stepDmg} magic damage!`;
            if (m.hp <= 0) {
              combatMsg += ` ${m.name} was slain!`;
              const loot = CombatSystem.generateMonsterLoot(m);
              this.handleCombatResult({
                success: true,
                defeatedMonsterId: m.id,
                droppedLoot: loot,
              }, m.x, m.y);
            }

            this.logCombat(combatMsg, 'combat');
            this.addFloatingText(`-${stepDmg}`, m.x, m.y, '#ff66dd');
          }

          // Check for co-located monsters riding the wave together (Stack Collision)
          const tileCounts = {};
          for (const entry of activeCarried) {
            if (entry.monster.hp <= 0) continue;
            const key = `${entry.monster.x},${entry.monster.y}`;
            tileCounts[key] = (tileCounts[key] || 0) + 1;
          }

          for (const entry of activeCarried) {
            if (entry.monster.hp <= 0) continue;
            const key = `${entry.monster.x},${entry.monster.y}`;
            if (tileCounts[key] > 1) {
              const stackDmg = 10;
              entry.monster.hp -= stackDmg;
              this.addFloatingText(`-${stackDmg} Stack Collide!`, entry.monster.x, entry.monster.y, '#f59e0b');
              this.logCombat(`${entry.monster.name} collided with another opponent in the wave for ${stackDmg} damage!`, 'combat');

              if (entry.monster.hp <= 0) {
                const loot = CombatSystem.generateMonsterLoot(entry.monster);
                this.handleCombatResult({
                  success: true,
                  defeatedMonsterId: entry.monster.id,
                  droppedLoot: loot,
                }, entry.monster.x, entry.monster.y);
              }
            }
          }
        }

        // Beam expires after final wave step completes; resolve landed positions
        if (p.elapsedMs >= (p.waves.length * p.stepIntervalMs + 100)) {
          if (p.carriedMonsters && p.carriedMonsters.length > 0) {
            this.resolveWaveLandedMonsters(p.carriedMonsters, p.fX || 0, p.fY || 0);
          }
          this.projectiles.splice(i, 1);
        }
        continue;
      }

      // Handle legacy duration-based projectiles
      if (!p.dirX && !p.dirY) {
        p.elapsedMs += dtMs;
        if (p.elapsedMs >= p.durationMs) {
          this.projectiles.splice(i, 1);
        }
        continue;
      }

      // Real-time continuous projectile physics (e.g. Wand Spark)
      const prevPxX = p.currentPxX;
      const prevPxY = p.currentPxY;
      p.currentPxX += p.dirX * p.speedPxPerSec * dtSec;
      p.currentPxY += p.dirY * p.speedPxPerSec * dtSec;

      const tileX = Math.floor(p.currentPxX / CONFIG.GRID_SIZE);
      const tileY = Math.floor(p.currentPxY / CONFIG.GRID_SIZE);

      // 1. Map Boundary check
      if (tileX < 0 || tileX >= this.gridMap.width || tileY < 0 || tileY >= this.gridMap.height) {
        this.triggerImpactBurst(p.currentPxX, p.currentPxY, p.visual, p.color);
        soundFX.playAt('wandSpark', tileX, tileY, this.player.x, this.player.y);
        this.projectiles.splice(i, 1);
        continue;
      }

      // 2. Swept collision across the whole tile span since the last frame, so
      //    a fast spark cannot skip over (phase through) a monster that moved
      //    into the corridor between the previous and current position. The
      //    wall check below is folded into the sweep: a wall stops the attack
      //    before anything behind it is considered.
      const startGX = Math.floor(prevPxX / CONFIG.GRID_SIZE);
      const startGY = Math.floor(prevPxY / CONFIG.GRID_SIZE);
      const sweep = firstMonsterOnSegment(
        this.monsters,
        startGX,
        startGY,
        tileX,
        tileY,
        (x, y) => this.gridMap.isWall(x, y),
        (m) => CombatSystem.isHostile(this.player, m)
      );

      if (sweep && sweep.stoppedByWall) {
        this.triggerImpactBurst(p.currentPxX, p.currentPxY, p.visual, p.color);
        soundFX.playAt('wandSpark', sweep.tile.x, sweep.tile.y, this.player.x, this.player.y);
        this.projectiles.splice(i, 1);
        continue;
      }

      if (sweep && sweep.monster) {
        const hitMonster = sweep.monster;
        const hitTile = sweep.tile;
        const payload = p.damagePayload || {};
        const dmg = payload.damage || 10;
        hitMonster.hp -= dmg;
        setAnimState(hitMonster, 'hit', this.nowMs());

        soundFX.playAt('wandSpark', hitTile.x, hitTile.y, this.player.x, this.player.y);
        this.triggerImpactBurst(p.currentPxX, p.currentPxY, p.visual, p.color);

        let combatMsg = `Wand Spark struck ${hitMonster.name} for ${dmg} magic damage!`;
        if (hitMonster.hp <= 0) {
          combatMsg += ` ${hitMonster.name} was slain!`;
          const loot = CombatSystem.generateMonsterLoot(hitMonster);
          this.handleCombatResult({
            success: true,
            defeatedMonsterId: hitMonster.id,
            droppedLoot: loot,
          }, hitTile.x, hitTile.y);
        }

        this.logCombat(combatMsg, 'combat');
        this.addFloatingText(`-${dmg}`, hitTile.x, hitTile.y, '#38bdf8');
        this.projectiles.splice(i, 1);
        continue;
      }

      // 3. Wall collision at the current tile (no monster in the span).
      if (this.gridMap.isWall(tileX, tileY)) {
        this.triggerImpactBurst(p.currentPxX, p.currentPxY, p.visual, p.color);
        soundFX.playAt('wandSpark', tileX, tileY, this.player.x, this.player.y);
        this.projectiles.splice(i, 1);
      }
    }

    if (this.particles) {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const pt = this.particles[i];
        pt.elapsedMs += dtMs;
        pt.x += (pt.vx * dtMs) / 1000;
        pt.y += (pt.vy * dtMs) / 1000;
        pt.vx *= 0.92;
        pt.vy *= 0.92;
        if (pt.elapsedMs >= pt.durationMs) {
          this.particles.splice(i, 1);
        }
      }
    }

    if (this.floatingTexts) {
      for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
        const t = this.floatingTexts[i];
        t.elapsedMs += dtMs;
        t.y -= (dtMs / 1000) * 20;
        if (t.elapsedMs >= t.durationMs) {
          this.floatingTexts.splice(i, 1);
        }
      }
    }

    // Presentation-only animation clocks (idle/walk are event-driven).
    if (this.player) advanceAnim(this.player, dtMs);
    if (this.player && Array.isArray(this.player.party)) {
      for (const member of this.player.party) {
        if (member && member.memberId !== this.player.activeMemberId) advanceAnim(member, dtMs);
      }
    }
    if (this.monsters) {
      for (const m of this.monsters) advanceAnim(m, dtMs);
    }
    if (this.deathEffects) {
      for (let i = this.deathEffects.length - 1; i >= 0; i--) {
        const fx = this.deathEffects[i];
        advanceAnim(fx, dtMs);
        if (fx.anim.elapsedMs >= (fx.totalMs || 680)) this.deathEffects.splice(i, 1);
      }
    }
  }
};
