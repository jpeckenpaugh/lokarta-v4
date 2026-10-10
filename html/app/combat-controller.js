/**
 * Lokarta: Come Into The Light - Combat Controller
 */

import {
  CONFIG,
  CombatSystem,
  LightingSystem,
  ProgressionSystem,
  InventorySystem,
  EconomySystem,
  DoorSystem,
  awardPartyXp,
  applyAutoFateGrant,
  partyMemberName,
  recordFoeDiscovery,
} from '../engine/index.js';
import { soundFX } from '../audio/index.js';
import { ITEMS_CATALOG, UI_CATALOG } from '../data/index.js';
import { SPRITE_CATALOG } from '../assets/sprites/index.js';
import { TOWER_LEVEL_COUNT } from '../services/floor-generator.js';
import { setAnimState, dirFromFacing } from './animation-state.js';
import { resolveSpriteId } from './sprite-renderer.js';

/**
 * Lifetime (seconds) of the Luminous Prayer orb VFX after each heal pulse
 *, resolved from `ui.json.playerVfx.luminousPrayer`.
 */
const LUMINOUS_PRAYER_VFX_SEC = Number(UI_CATALOG?.playerVfx?.luminousPrayer?.durationSec) || 1.6;

/**
 * Player combat: gesture/action-slot dispatch, targeting, hit resolution, and death FX.
 * Assigned onto `LokartaApp.prototype` from `app-controller.js`.
 */
export const combatControllerMethods = {
  handleChargeUpdate(slotIndex, ratio) {
    const slotEl = document.querySelector(`.loadout-slot.active-slot[data-index="${slotIndex}"] .charge-fill`);
    if (slotEl) {
      slotEl.style.width = `${Math.round(ratio * 100)}%`;
    }
  },
  handleGestureEvent(event) {
    const { slotIndex, gesture } = event;
    const item = this.player.action_bar?.[slotIndex];
    if (!item) {
      this.logCombat(`Active Slot ${slotIndex + 1} is empty.`, 'warning');
      return;
    }

    soundFX.init();

    // 1. Consumable items (potions); dispatched on the catalog effect.
    if (InventorySystem.hasConsumableEffect(item)) {
      const res = InventorySystem.consumeItem(this.player, item, () => {
        if (item.quantity > 1) {
          item.quantity -= 1;
        } else {
          this.player.action_bar[slotIndex] = null;
        }
      });
      if (res.success) {
        soundFX.play('potionDrink');
        this.logCombat(res.message, 'loot');
        this.addFloatingText(`Used ${item.name}!`, this.player.x, this.player.y, '#38bdf8');
        this.updateHUD();
        this.persistSave();
      } else {
        this.logCombat(res.message, 'warning');
      }
      return;
    }

    // 2. Equippable items (spells, weapons, wands, staffs, offhand, armor, relic)
    // Pressing hotkeys 1..0 equips / swaps the item to its designated hand (Main Hand or Off Hand)
    const eqRes = InventorySystem.equipItem(this.player, 'action_bar', slotIndex);
    if (eqRes.success) {
      soundFX.play('equip');
      this.logCombat(eqRes.message, 'loot');
      LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);
      this.updateHUD();
      this.persistSave();
    } else {
      this.logCombat(eqRes.message, 'warning');
    }
  },
  executeHandCombat(hand = 'main_hand') {
    const item = this.player.paperdoll?.[hand];
    const handLabel = {
      main_hand: 'Main Hand (Q)',
      off_hand: 'Off Hand (W)',
      armor: 'Armor (E)',
      relic: 'Relic (R)',
    }[hand] || String(hand || '').replace('_', ' ');
    if (!item) {
      this.logCombat(`No item equipped in ${handLabel}.`, 'warning');
      return;
    }

    this.executeActionSlotCombat(item, 'tap');
  },
  executeActionSlotCombat(item, gesture) {
    const catalogItem = ITEMS_CATALOG[item.item_id];

    const affinity = item.vocationAffinity || catalogItem?.vocationAffinity;
    if (affinity && affinity !== 'neutral' && this.player?.vocation) {
      const vocationMatches = Array.isArray(affinity) ? affinity.includes(this.player.vocation) : affinity === this.player.vocation;
      if (!vocationMatches) {
        const label = Array.isArray(affinity)
          ? affinity.map(v => v.charAt(0).toUpperCase() + v.slice(1)).join('/')
          : (affinity.charAt(0).toUpperCase() + affinity.slice(1));
        this.logCombat(`Only a ${label} can use ${item.name}!`, 'warning');
        return;
      }
    }

    // Dispatch strictly on the catalog `actionKey` (declared in items.json).
    // No string heuristics: an item without an actionKey has no active ability.
    const actionKey = item.actionKey || catalogItem?.actionKey || null;

    const handlers = {
      wand_spark: () => {
        const target = this.getTargetMonster(CONFIG.MAGICIAN_SPARK_RANGE);
        soundFX.play('wandSpark');
        const res = CombatSystem.executeWandSpark(this.player, target, this.gridMap, item);
        this.handleCombatResult(res, null, null);
      },
      energy_beam: () => {
        const res = CombatSystem.executeEnergyBeam(this.player, this.player.facing, this.gridMap, this.monsters, item);
        if (res.success) {
          soundFX.play('energyBeam');
          this.handleCombatResult(res, this.player.x, this.player.y);
        } else {
          this.logCombat(res.message, 'warning');
        }
      },
      light_spell: () => {
        const res = CombatSystem.executeLightSpell(this.player);
        if (res.success) {
          soundFX.play('lightSpell');
          this.logCombat(res.message, 'spell');
          this.addFloatingText('Light Aura!', this.player.x, this.player.y, '#ffd700');
          LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);
        } else {
          this.logCombat(res.message, 'warning');
        }
      },
      power_shot: () => {
        const bow = this.player.paperdoll?.main_hand;
        const maxRange = CombatSystem.itemRange(bow) || CONFIG.ARCHER_POWER_SHOT_RANGE;
        const target = this.getTargetMonster(maxRange);
        if (!target) return this.logCombat('No enemy in range for Power Shot.', 'warning');
        soundFX.play('powerShot');
        const res = CombatSystem.executePowerShot(this.player, target, this.gridMap, bow);
        this.handleCombatResult(res, target.x, target.y);
      },
      bow_shot: () => {
        const bow = this.player.paperdoll?.main_hand;
        const maxRange = CombatSystem.itemRange(bow) || CONFIG.ARCHER_BOW_RANGE;
        const target = this.getTargetMonster(maxRange);
        if (!target) return this.logCombat('No enemy in range for Bow Shot.', 'warning');
        soundFX.play('bowShot');
        const res = CombatSystem.executeBowShot(this.player, target, this.gridMap, bow);
        this.handleCombatResult(res, target.x, target.y);
      },
      cleave: () => {
        soundFX.play('hit');
        const res = CombatSystem.executeCleave(this.player, this.gridMap, this.monsters, item);
        if (!res.success) {
          this.logCombat(res.message, 'warning');
          return;
        }
        this.logCombat(res.message, 'combat');
        if (res.projectiles) this.projectiles.push(...res.projectiles);
        for (const hit of res.hits || []) {
          this.addFloatingText(`-${hit.damage}`, hit.monster.x, hit.monster.y, '#ffdd44');
          if (hit.defeated && hit.monster.id) {
            this.handleCombatResult({
              success: true,
              defeatedMonsterId: hit.monster.id,
              droppedLoot: CombatSystem.generateMonsterLoot(hit.monster),
            }, hit.monster.x, hit.monster.y);
          }
        }
      },
      slash: () => {
        soundFX.play('hit');
        const target = this.getTargetMonster(2.5);
        const res = CombatSystem.executeSlash(this.player, target, this.gridMap, { monsters: this.monsters, item: this.player.paperdoll?.main_hand });
        this.handleCombatResult(res, res.hitX ?? null, res.hitY ?? null);
      },
      shield_bash: () => {
        soundFX.play('hit');
        const res = CombatSystem.executeShieldBash(this.player, this.gridMap, this.monsters, item);
        this.handleCombatResult(res, null, null);
      },
      holy_shield: () => {
        soundFX.play('lightSpell');
        const res = CombatSystem.executeHolyShield(this.player, item);
        this.handleCombatResult(res, null, null);
      },
      sanctuary: () => {
        soundFX.play('lightSpell');
        const res = CombatSystem.executeSanctuary(this.player, item);
        if (res.success) {
          this.logCombat(res.message, 'spell');
          this.addFloatingText('Sanctuary!', this.player.x, this.player.y, '#f8fafc');
        } else {
          this.logCombat(res.message, 'warning');
        }
      },
      benediction: () => {
        const res = CombatSystem.executeBenediction(this.player, item, this.player.party);
        if (res.success) {
          soundFX.play('holyChime');
          this.logCombat(res.message, 'spell');
          const healX = res.targetX ?? this.player.x;
          const healY = res.targetY ?? this.player.y;
          if (res.hpRestored > 0) this.addFloatingText(`+${res.hpRestored} HP`, healX, healY, '#22c55e');
          if (res.mpRestored > 0) this.addFloatingText(`+${res.mpRestored} MP`, this.player.x, this.player.y, '#3b82f6');
        } else {
          this.logCombat(res.message, 'warning');
        }
      },
      shock_shield: () => {
        soundFX.play('lightSpell');
        const res = CombatSystem.executeShockShield(this.player, item);
        if (res.success) {
          this.logCombat(res.message, 'spell');
          this.addFloatingText('Shock Shield!', this.player.x, this.player.y, '#38bdf8');
        } else {
          this.logCombat(res.message, 'warning');
        }
      },
      luminous_prayer: () => {
        const res = CombatSystem.executeLuminousPrayer(this.player, item);
        if (res.success) {
          soundFX.play('holyChime');
          this.player.luminousPrayerVfxSec = LUMINOUS_PRAYER_VFX_SEC;
          this.logCombat(res.message, 'spell');
          if (res.hpRestored > 0) this.addFloatingText(`+${res.hpRestored} HP`, this.player.x, this.player.y, '#22c55e');
          if (res.mpRestored > 0) this.addFloatingText(`+${res.mpRestored} MP`, this.player.x, this.player.y, '#3b82f6');
        } else {
          this.logCombat(res.message, 'warning');
        }
      },
      poison_tip: () => {
        const res = CombatSystem.executePoisonTip(this.player, item);
        if (res.success) {
          soundFX.play('hit');
          this.logCombat(res.message, 'spell');
          this.addFloatingText('Poison Tip!', this.player.x, this.player.y, '#84cc16');
        } else {
          this.logCombat(res.message, 'warning');
        }
      },
      life_siphon: () => {
        const res = CombatSystem.executeLifeSiphon(this.player, this.gridMap, this.monsters, item);
        if (!res.success) {
          this.logCombat(res.message, 'warning');
          return;
        }
        soundFX.play('holyChime');
        this.logCombat(res.message, 'spell');
        if (res.healed > 0) this.addFloatingText(`+${res.healed} HP`, this.player.x, this.player.y, '#22c55e');
        for (const hit of res.affected || []) {
          this.addFloatingText(`-${hit.drained}`, hit.monster.x, hit.monster.y, '#a855f7');
          if (hit.defeated && hit.monster.id) {
            this.handleCombatResult({
              success: true,
              defeatedMonsterId: hit.monster.id,
              droppedLoot: CombatSystem.generateMonsterLoot(hit.monster),
            }, hit.monster.x, hit.monster.y);
          }
        }
      },
      hunters_mark: () => {
        const res = CombatSystem.executeHuntersMark(this.player, this.gridMap, this.monsters, item);
        if (res.success) {
          soundFX.play('uiMove');
          this.logCombat(res.message, 'spell');
          for (const m of res.marked) this.addFloatingText('MARKED', m.x, m.y, '#f59e0b');
        } else {
          this.logCombat(res.message, 'warning');
        }
      },
      fortify: () => {
        soundFX.play('lightSpell');
        const res = CombatSystem.executeFortify(this.player, item);
        this.handleCombatResult(res, null, null);
      },
      healing_prayer: () => {
        const res = CombatSystem.executeHealingPrayer(this.player, this.player.party);
        if (res.success) {
          soundFX.play('lightSpell');
          this.logCombat(res.message, 'spell');
          this.addFloatingText(`+${res.healAmount} HP`, res.targetX ?? this.player.x, res.targetY ?? this.player.y, '#22c55e');
        } else {
          this.logCombat(res.message, 'warning');
        }
      },
      holy_strike: () => {
        soundFX.play('hit');
        const target = this.getTargetMonster(2.5);
        const res = CombatSystem.executeHolyStrike(this.player, target, this.gridMap, { monsters: this.monsters, item: this.player.paperdoll?.main_hand });
        this.handleCombatResult(res, res.hitX ?? null, res.hitY ?? null);
      },
    };

    if (actionKey && handlers[actionKey]) {
      setAnimState(this.player, 'attack', this.nowMs());
      handlers[actionKey]();
    }

    this.updateHUD();
  },
  getTargetMonster(maxRange) {
    const bonusRng = this.player.skillBoosts?.bonusRange || 0;
    const effectiveRange = maxRange + bonusRng;

    if (this.selectedMonsterId) {
      const monster = this.monsters.find(m => m.id === this.selectedMonsterId && m.hp > 0);
      if (monster && monster.visible) {
        const d = Math.hypot(monster.x - this.player.x, monster.y - this.player.y);
        if (d <= effectiveRange + 0.5) return monster;
      }
    }

    let closest = null;
    let minDist = effectiveRange + 1;

    for (const m of this.monsters) {
      if (m.hp <= 0 || !m.visible) continue;
      const d = Math.hypot(m.x - this.player.x, m.y - this.player.y);
      if (d <= effectiveRange + 0.5 && d < minDist) {
        if (LightingSystem.hasLineOfSight(this.gridMap, this.player.x, this.player.y, m.x, m.y)) {
          minDist = d;
          closest = m;
        }
      }
    }

    if (closest) {
      this.selectedMonsterId = closest.id;
    }
    return closest;
  },
  handleCombatResult(res, targetX, targetY) {
    if (!res.success) {
      if (res.message) this.logCombat(res.message, 'warning');
      return;
    }

    // LIV-44: dealing damage counts as combat activity, which resets the
    // revive idle gate (`revive.idleSec`).
    this.combatIdleSec = 0;
    if (res.message) this.logCombat(res.message, 'combat');
    if (res.damageDealt) {
      soundFX.play('hit');
      if (targetX !== null && targetX !== undefined && targetY !== null && targetY !== undefined) {
        this.addFloatingText(`-${res.damageDealt}`, targetX, targetY, '#ffdd44');
        if (!res.defeatedMonsterId) this.triggerMonsterHit(targetX, targetY);
      }
    }

    if (res.projectiles) this.projectiles.push(...res.projectiles);

    if (res.defeatedMonsterId) {
      const index = this.monsters.findIndex(m => m.id === res.defeatedMonsterId);
      if (index !== -1) {
        const deadMonster = this.monsters[index];
        // Boss identity is fully declarative: the generator/catalog stamp
        // `isBoss`/`isElite`; no id/health heuristics here. A boss or mini-boss
        // gets the defeat sting, a regular foe the generic death sweep.
        const isBoss = deadMonster.isBoss === true;
        const isElite = deadMonster.isElite === true;
        soundFX.play(isBoss || isElite ? 'bossDefeat' : 'monsterDeath');

        // I10 Bestiary: record the first defeat of this foe on the save envelope
        // (spoiler-safe — a foe only appears in the codex once beaten).
        const discovery = recordFoeDiscovery(this.player, deadMonster.type);
        if (discovery.isNew) {
          this.player = discovery.player;
          const cueTemplate = (UI_CATALOG && UI_CATALOG.codex && UI_CATALOG.codex.newEntryCue) || 'Bestiary updated: {foe}';
          this.logCombat(cueTemplate.split('{foe}').join(deadMonster.name), 'system');
        }
        this.persistSave();
        // First blood also introduces the codex in the onboarding sequence.
        this.maybeShowOnboarding?.('first_defeat');

        // Quest `kill` objective seam (LIV-60 P3): the catalog monster `type`
        // advances any active kill objective that targets it.
        if (typeof this.fireQuestEvent === 'function') {
          this.fireQuestEvent({ type: 'kill', monsterType: deadMonster.type, quantity: 1 });
        }

        // Items 4/5: every drop (equipment, potions, gold, keys) lands on
        // the ground and must be walked over to collect. Multi-item drops spread
        // across distinct adjacent squares instead of stacking one tile.
        const drops = [...(res.droppedLoot || [])];
        const goldDrop = EconomySystem.goldFromMonster(deadMonster);
        if (goldDrop > 0) {
          drops.push({ item_id: 'gold', name: 'Gold', type: 'currency', pickupType: 'currency', quantity: goldDrop });
        }
        if (deadMonster.holdsKey) {
          const keyDrop = DoorSystem.keyDropForMonster(deadMonster);
          if (keyDrop) drops.push(keyDrop);
        }
        if (drops.length > 0) {
          // Every drop lands on the nearest empty tile (adjacent
          // first, then expanding) so it never covers pre-existing loot. Only
          // stack in place when no free tile remains in the search radius.
          const reserved = new Set();
          for (const item of drops) {
            const free = InventorySystem.findFreeGroundTile(this.gridMap, deadMonster.x, deadMonster.y, reserved);
            const spot = free || { x: deadMonster.x, y: deadMonster.y };
            if (free) reserved.add(free.key);
            this.gridMap.addItem(spot.x, spot.y, { ...item, x: spot.x, y: spot.y });
            this.logCombat(`${deadMonster.name} dropped ${item.name}${item.quantity > 1 ? ` x${item.quantity}` : ''}.`, 'loot');
          }
          if (drops.some(d => d.pickupType === 'key')) soundFX.play('keyJangle');
        }

        this.spawnDeathEffect(deadMonster);
        const xpEarned = ProgressionSystem.getMonsterXp(deadMonster.type, this.player.current_floor || 1, isBoss);
        // Shared party XP (LIV-20): the active member and every living ally bank
        // the same amount. Only the active member's level-up pauses for the
        // interactive draft; allies auto-draft with a subtle cue (below).
        const partyXp = awardPartyXp(this.player, xpEarned);
        const lvlRes = partyXp.active;

        this.logCombat(`Gained +${xpEarned} XP from defeating ${deadMonster.name}.`, 'loot');
        this.addFloatingText(`+${xpEarned} XP`, deadMonster.x, deadMonster.y, '#fbbf24');

        if (lvlRes && lvlRes.leveledUp) {
          soundFX.play('levelUp');
          this.logCombat(
            `⭐ LEVEL UP! You reached Level ${lvlRes.newLevel}! (+${lvlRes.hpGained} Max HP, +${lvlRes.manaGained} Max MP)`,
            'spell'
          );
          this.addFloatingText(`⭐ LEVEL UP! [Lv. ${lvlRes.newLevel}]`, this.player.x, this.player.y, '#ffd700');
          this.persistSave();
          this.showFateGrantModal(lvlRes.newLevel);
        }

        this.handleAllyLevelUps(partyXp.allies);

        this.monsters.splice(index, 1);
        if (this.selectedMonsterId === res.defeatedMonsterId) {
          this.selectedMonsterId = null;
        }

        // E3 / The key holder's key now drops on the ground (see
        // the drops block above); walking over it grants the per-level key. The
        // grant does NOT open the gate — the player walks into the closed door.

        // E8: the catalog-driven final floor (not the retired 20-floor cave)
        // resolves the boss kill into the campaign ending.
        if (isBoss && (this.isFinalFloor || (this.player.current_floor || 1) >= (this.towerLevelCount || TOWER_LEVEL_COUNT))) {
          setTimeout(
            () => this.handleFloorClear({ kind: 'summit', dir: 'summit', targetLevel: null }),
            600
          );
        }
      }
    }
  },
  /**
   * Auto-progresses allies that banked a level from shared XP (LIV-20 / FIX-5):
   * applies a deterministic Fate Grant with no modal or pause and shows a subtle
   * in-world cue. The interactive draft is never opened for a non-active ally.
   */
  handleAllyLevelUps(levelUps) {
    if (!Array.isArray(levelUps) || levelUps.length === 0) return;
    // Cue copy is catalog-driven (`ui.json` → `party.allyLevelUpCue`, LIV-26)
    // with a safe fallback so the mechanic never depends on copy landing first.
    const cueTemplate = UI_CATALOG && UI_CATALOG.party && typeof UI_CATALOG.party.allyLevelUpCue === 'string'
      ? UI_CATALOG.party.allyLevelUpCue
      : null;
    for (const { member, result } of levelUps) {
      if (!member || !result) continue;
      // `this.player` holds the shared party backpack (LIV-22), so auto-granted
      // overflow lands in the party stash rather than a per-member grid.
      applyAutoFateGrant(member, result.newLevel, this.gridMap, this.player);
      const name = partyMemberName(member);
      this.addFloatingText(`${name} Lv.${result.newLevel}`, member.x, member.y, '#e2e8f0', { durationMs: 1500 });
      const cue = cueTemplate
        ? cueTemplate.split('{member}').join(name).split('{level}').join(String(result.newLevel))
        : `${name} reached Level ${result.newLevel}.`;
      this.logCombat(cue, 'spell');
    }
    this.persistSave();
  },
  /** Trigger a hit reaction on the monster occupying a tile (if any). */
  triggerMonsterHit(gridX, gridY) {
    if (!this.monsters) return;
    const m = this.monsters.find(mm => mm.hp > 0 && mm.x === gridX && mm.y === gridY);
    if (m) setAnimState(m, 'hit', this.nowMs());
  },
  /** Spawn a transient death effect for a defeated actor. */
  spawnDeathEffect(actor) {
    if (!actor) return;
    if (!this.deathEffects) this.deathEffects = [];
    // Frame count comes from the actor's authored death animation (sprite def),
    // falling back to a boss/non-boss default only when no sprite resolves.
    const spriteDef = SPRITE_CATALOG[resolveSpriteId(actor)] || null;
    const deathFrames = spriteDef?.animations?.death?.down?.length;
    const frames = deathFrames || (actor.isBoss ? 6 : 4);
    const facing = actor.facing || 'down';
    // LIV-140: an opponent without authored death frames (the 3D-baked creature
    // class) plays a runtime-only procedural squish instead of a no-op snap. The
    // eligibility is derived from the sprite def alone — no type/name heuristics.
    const procedural = !deathFrames;
    this.deathEffects.push({
      spriteId: actor.type || actor.vocation || actor.spriteId,
      type: actor.type,
      vocation: actor.vocation,
      procedural,
      facing,
      x: actor.x,
      y: actor.y,
      ageMs: 0,
      totalMs: frames * 120 + 200,
      anim: {
        state: 'death',
        dir: dirFromFacing(facing),
        frame: 0,
        elapsedMs: 0,
        flipX: false,
        lockedUntilMs: Number.POSITIVE_INFINITY,
      },
    });
  },
  /** True while the final floor's boss guardian is still alive (D2 §9.3). */
  isGuardianAlive() {
    return Boolean(this.monsters) && this.monsters.some(m => m.isBoss && m.hp > 0);
  }
};
