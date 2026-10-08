/**
 * Lokarta: Come Into The Light - Combat & Ability Subsystem
 */

import { CONFIG } from './config.js';
import { LightingSystem } from './lighting-system.js';
import { ABILITIES_CATALOG, MONSTERS_CATALOG, ITEMS_CATALOG } from '../data/index.js';
import { getEffectiveDamage, getEffectiveRange, getEffectiveManaCost, getEffectiveCooldown as projectCooldown } from './item-stats.js';
import { isFriendly, isHostile, sameActor, factionOf } from './faction.js';
import { reviverChannelDamageReduction } from './revive-system.js';

/**
 * Actor contract (LIV-11 WS3): every `executeX` method takes the **acting
 * combatant** as its first argument — the manual active member or an auto ally.
 * An actor is any `createPlayer`-shaped object plus `{ faction, memberId? }`,
 * carrying its own `cooldowns`, `hp/max_hp`, `mana/max_mana`, gear and position.
 * No method may read a global player: WS4 drives allies through the same API.
 */
export class CombatSystem {
  /** Actor whose timers advance every simulation tick (per member). */
  static tickActorTimers(actor, deltaSec) {
    if (!actor) return;
    CombatSystem.decrementCooldowns(actor, deltaSec);
    CombatSystem.decrementSpellTimers(actor, deltaSec);
    // LIV-44 revive grace window counts down per tick.
    if (actor.reviveGraceSec > 0) {
      actor.reviveGraceSec = Math.max(0, actor.reviveGraceSec - (Number(deltaSec) || 0));
    }
  }

  static decrementCooldowns(player, deltaSec) {
    if (!player.cooldowns) return;
    for (const key of Object.keys(player.cooldowns)) {
      if (player.cooldowns[key] > 0) {
        player.cooldowns[key] = Math.max(0, player.cooldowns[key] - deltaSec);
      }
    }
  }

  static decrementSpellTimers(player, deltaSec) {
    if (player.lightSpellTimer > 0) {
      player.lightSpellTimer = Math.max(0, player.lightSpellTimer - deltaSec);
    }
  }

  /** Declaration-backed friendly check between two combatants. */
  static isFriendly(a, b) {
    return isFriendly(a, b);
  }

  /** True when `a` may damage `b` (factionless entities are hostile). */
  static isHostile(a, b) {
    return isHostile(a, b);
  }

  /** True when both references denote the same party actor. */
  static sameActor(a, b) {
    return sameActor(a, b);
  }

  /**
   * Debug-only multiplier applied to every incoming party hit, driven by the
   * off-by-default `testerStrength` option (`ui.json` `options.debug`). `1`
   * is normal gameplay; a smaller value reduces attack and damage-over-time
   * damage alike. Held at class scope so newly recruited members inherit it
   * without per-actor bookkeeping.
   */
  static DEBUG_INCOMING_DAMAGE_MULTIPLIER = 1;

  /**
   * Sets the debug multiplier from a 0-100 reduction percentage (90 = Tester's
   * Strength takes 10% of incoming damage). Non-finite input resets to normal.
   * @param {number} pct
   */
  static setDebugIncomingDamageReductionPct(pct) {
    const n = Number(pct);
    const clamped = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
    CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER = 1 - clamped / 100;
  }

  static randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Sums a numeric stat across every equipped paperdoll slot (armor, relic,
   * main/off hand). Used to read defensive and utility stats that the LOK-12
   * Golden sets place on gear (dodgePct, mitigationPct, critChance, critMult,
   * healPowerPct). Returns 0 when nothing is equipped with the key.
   */
  static getEquippedStat(player, statKey) {
    if (!player?.paperdoll) return 0;
    let total = 0;
    for (const slotName of Object.keys(player.paperdoll)) {
      const equipped = player.paperdoll[slotName];
      if (equipped && typeof equipped[statKey] === 'number') {
        total += equipped[statKey];
      }
    }
    return total;
  }

  /**
   * Effective action cooldown for an equipped item's action
   * (e.g. vanguard_shield shield_bash). Each rank of an item carrying
   * `upgradeSpec.cooldownReductionSec` shortens the base `item.cooldown`:
   *   effectiveCooldown = max(1, base - sum(cooldownReductionSec per rank))
   * where "sum per rank" totals over every rank gained beyond 1.
   */
  static getEffectiveCooldown(item) {
    if (!item || typeof item.cooldown !== 'number') return null;
    // Delegate to the single rank-scaled projection so the authored
    // `rankCaps.cooldownReductionSec` ceiling is honored in one place.
    return projectCooldown(item);
  }

  /** Public alias so app code shares the engine's rank-scaled projection. */
  static itemDamage(item) {
    return getEffectiveDamage(item);
  }

  /** Public alias for the rank-scaled range projection. */
  static itemRange(item) {
    return getEffectiveRange(item);
  }

  /** Public alias for the rank-scaled mana-cost projection. */
  static itemManaCost(item) {
    return getEffectiveManaCost(item);
  }

  /**
   * Effective mana cost for an equipped item's active (e.g. aegis_shield
   * holy_shield, sanctuary_plate sanctuary). Delegates to the shared
   * rank-scaled projection in `item-stats.js`, which applies the authored
   * `shieldManaCostReduction`/`manaCostInc` deltas plus the 
   * promoted-item MP-1-per-rank rule. Floors at 0 MP.
   */
  static getEffectiveManaCost(item) {
    if (!item || typeof item.manaCost !== 'number') return null;
    return getEffectiveManaCost(item);
  }

  /**
   * Central incoming-damage application seam (LOK-12 Slice 0). Applies, in
   * order: the equipped dodge roll (chance to avoid the hit entirely), the
   * Fighter Fortify halving (while `player.fortifyActive`), the equipped flat
   * mitigation %, then the Paladin holy bubble absorb. The remainder lands on
   * player HP (clamped at 0).
   *
   * LIV-47: a member channeling a revive also scales damage by
   * `1 - revive.damageReductionPct` (Fighter Drag to Safety), read through the
   * data-driven revive resolver.
   *
   * @returns {{ damageToPlayer: number, absorbed: number, dodged: boolean, rawDamage: number }}
   */
  static applyIncomingDamage(player, damage, attacker = null) {
    if (!player || damage <= 0) {
      return { damageToPlayer: 0, absorbed: 0, dodged: false, deflected: false, rawDamage: damage || 0 };
    }

    // LIV-44 revive grace: a freshly revived member is invulnerable for
    // `reviveGraceSec` so a lingering DoT cannot instantly re-down it. Damage
    // sites only clamp hp; the downed transition lives in revive-system.js.
    if (Number(player.reviveGraceSec) > 0) {
      return {
        damageToPlayer: 0,
        absorbed: 0,
        dodged: false,
        deflected: false,
        rawDamage: damage,
        grace: true,
      };
    }

    // Friendly fire is impossible: a same-faction attacker is blocked before
    // any dodge/mitigation/absorb roll. Factionless legacy entities are not
    // "friendly" (see faction.js) and keep taking damage exactly as before.
    if (attacker && CombatSystem.isFriendly(attacker, player)) {
      return {
        damageToPlayer: 0,
        absorbed: 0,
        dodged: false,
        deflected: false,
        friendlyFire: true,
        rawDamage: damage,
      };
    }

    // 0. Shock Shield (Apprentice's Cape): deflect exactly one incoming
    //    attack (zero damage) and stun the attacker for the rank-scaled
    //    duration. The charge is consumed on the first hit only.
    if (player.shockShieldCharges > 0) {
      player.shockShieldCharges -= 1;
      const stunSec = player.shockShieldStunSec || 5;
      if (attacker) attacker.stunTimer = Math.max(attacker.stunTimer || 0, stunSec);
      return {
        damageToPlayer: 0,
        absorbed: 0,
        dodged: false,
        deflected: true,
        attackerStunSec: stunSec,
        rawDamage: damage,
      };
    }

    // 1. Dodge: chance to avoid the hit entirely from equipped dodgePct.
    const dodgePct = CombatSystem.getEquippedStat(player, 'dodgePct');
    if (dodgePct > 0 && Math.random() * 100 < dodgePct) {
      return { damageToPlayer: 0, absorbed: 0, dodged: true, deflected: false, rawDamage: damage };
    }

    let dmg = damage;

    // 1b. Tester's Strength (debug option): scale incoming damage before the
    //     class mitigations below so the toggle keeps the tester alive.
    if (CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER < 1 && dmg > 0) {
      dmg = Math.round(dmg * CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER);
    }

    // 1c. LIV-47 Fighter Vigil "Drag to Safety": a living member actively
    //     channeling a revive takes reduced incoming damage. The lever is data
    //     (`revive.damageReductionPct`, resolved per vocation) and is `0` for
    //     every other vocation, so this seam never needs a vocation branch.
    const reviveReductionPct = reviverChannelDamageReduction(player);
    if (reviveReductionPct > 0 && dmg > 0) {
      dmg = Math.round(dmg * (1 - reviveReductionPct));
    }

    // 2. Fortify Stance: halve incoming damage while active (10 s).
    if (player.fortifyActive) {
      dmg = Math.round(dmg * 0.5);
    }

    // 3. Mitigation: flat % reduction from equipped mitigationPct (plate_armor).
    const mitigationPct = CombatSystem.getEquippedStat(player, 'mitigationPct');
    if (mitigationPct > 0 && dmg > 0) {
      dmg -= Math.round(dmg * (mitigationPct / 100));
    }

    // 4. Holy bubble: absorb up to player.shieldAbsorb remaining damage.
    let absorbed = 0;
    if (player.shieldAbsorb > 0 && dmg > 0) {
      absorbed = Math.min(player.shieldAbsorb, dmg);
      player.shieldAbsorb -= absorbed;
      if (player.shieldAbsorb < 0) player.shieldAbsorb = 0;
      dmg -= absorbed;
    }

    const finalDamage = Math.max(0, Math.floor(dmg));
    player.hp = Math.max(0, player.hp - finalDamage);

    return {
      damageToPlayer: Math.min(finalDamage, player.hp === 0 && finalDamage > 0 ? finalDamage : finalDamage),
      absorbed,
      dodged: false,
      deflected: false,
      rawDamage: damage,
    };
  }

  /** Cardinal facing vectors used to orient melee free swings (LOK-9). */
  static FACING_VECTORS = {
    up: { dx: 0, dy: -1 },
    down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
  };

  /**
   * Finds the nearest living monster inside a melee damage area: within `reach`
   * tiles of the player AND inside the facing arc (90-degree sweep centered on
   * the facing direction). Requires line of sight when a gridMap is provided.
   * Used by swing-always melee to register damage without a pre-picked target.
   *
   * @param {object} player
   * @param {Array} monsters
   * @param {number} reach Reach in tiles (e.g. 2.5).
   * @param {string} facing 'up'|'down'|'left'|'right'.
   * @param {object|null} gridMap
   * @returns {object|null} nearest in-area monster, or null.
   */
  static findMonsterInMeleeArea(player, monsters = [], reach, facing = 'right', gridMap = null) {
    const fv = CombatSystem.FACING_VECTORS[facing] || CombatSystem.FACING_VECTORS.right;
    const facingAngle = Math.atan2(fv.dy, fv.dx);
    const sweepHalf = (90 * Math.PI) / 180 / 2;

    let best = null;
    let bestDist = Infinity;

    for (const m of monsters) {
      if (!m || m.hp <= 0) continue;
      if (!CombatSystem.isHostile(player, m)) continue; // never swing at an ally
      const dx = m.x - player.x;
      const dy = m.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > reach || dist < 0.001) continue;

      const dirAngle = Math.atan2(dy, dx);
      let diff = Math.abs(dirAngle - facingAngle);
      diff = Math.min(diff, Math.PI * 2 - diff);
      if (diff > sweepHalf) continue;

      if (gridMap && !LightingSystem.hasLineOfSight(gridMap, player.x, player.y, m.x, m.y)) continue;

      if (dist < bestDist) {
        bestDist = dist;
        best = m;
      }
    }

    return best;
  }

  static findArrowItem(player) {
    // Check Action Bar first
    if (player.action_bar) {
      for (let i = 0; i < player.action_bar.length; i++) {
        const item = player.action_bar[i];
        if (item && item.item_id === 'arrows' && item.quantity > 0) {
          return { inActionBar: true, index: i, item };
        }
      }
    }
    // Check Backpack
    if (player.backpack) {
      for (let i = 0; i < player.backpack.length; i++) {
        const item = player.backpack[i];
        if (item && item.item_id === 'arrows' && item.quantity > 0) {
          return { inBackpack: true, index: i, item };
        }
      }
    }
    return null;
  }

  static consumeArrow(player) {
    // 1. Prefer the equipped quiver's arrow reserve (Grey Stalker).
    //    Its arrowCount is consumed first; the action_bar/backpack fallback
    //    only engages while the quiver is empty.
    const quiver = player.paperdoll?.off_hand;
    if (quiver && typeof quiver.arrowCount === 'number' && quiver.arrowCount > 0) {
      quiver.arrowCount -= 1;
      return true;
    }

    // 2. Fall back to Action Bar / Backpack `arrows` stacks.
    const arrowSlot = CombatSystem.findArrowItem(player);
    if (!arrowSlot) return false;

    arrowSlot.item.quantity -= 1;
    if (arrowSlot.item.quantity <= 0) {
      if (arrowSlot.inActionBar) {
        player.action_bar[arrowSlot.index] = null;
      } else {
        player.backpack[arrowSlot.index] = null;
      }
    }
    return true;
  }

  /**
   * Executes Magician Wand Spark ability.
   */
  static executeWandSpark(player, target, gridMap, item = null) {
    if (player.cooldowns?.wand_spark > 0) {
      return { success: false, message: 'Spark Wand is on cooldown.' };
    }

    const manaCost = getEffectiveManaCost(item) || CONFIG.MAGICIAN_SPARK_MANA_COST;

    if (player.mana < manaCost) {
      return { success: false, message: 'Not enough Mana to use Spark Wand.' };
    }

    let dirX = 0;
    let dirY = 0;

    if (target) {
      const dx = target.x - player.x;
      const dy = target.y - player.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dirX = dx / len;
        dirY = dy / len;
      }
    }

    if (dirX === 0 && dirY === 0) {
      const facingVectors = {
        up: { x: 0, y: -1 },
        down: { x: 0, y: 1 },
        left: { x: -1, y: 0 },
        right: { x: 1, y: 0 },
      };
      const vec = facingVectors[player.facing] || facingVectors.right;
      dirX = vec.x;
      dirY = vec.y;
    }

    player.mana -= manaCost;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.wand_spark = CONFIG.MAGICIAN_SPARK_COOLDOWN_SEC;

    const mult = player.skillBoosts?.damageMultiplier || 1.0;
    const baseDmg = getEffectiveDamage(item) || CombatSystem.randomBetween(CONFIG.MAGICIAN_SPARK_DAMAGE_MIN, CONFIG.MAGICIAN_SPARK_DAMAGE_MAX);
    const damage = Math.round(baseDmg * mult);

    const abilitySpec = ABILITIES_CATALOG.magician_spark;
    const speedTilesPerSec = abilitySpec?.visual?.speedTilesPerSec || 10.0;
    const speedPxPerSec = speedTilesPerSec * CONFIG.GRID_SIZE;

    const startPxX = player.x * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2;
    const startPxY = player.y * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2;

    const projectile = {
      id: `proj_${Date.now()}_${Math.random()}`,
      abilityId: 'magician_spark',
      type: 'wand_spark',
      sourceX: player.x,
      sourceY: player.y,
      currentPxX: startPxX,
      currentPxY: startPxY,
      dirX,
      dirY,
      speedPxPerSec,
      damagePayload: {
        damage,
        vocation: player.vocation,
        casterId: player.id || 'player',
      },
      color: abilitySpec?.visual?.color || '#44ccff',
      visual: abilitySpec?.visual || null,
      active: true,
    };

    return {
      success: true,
      message: 'You cast Spark Wand!',
      damageDealt: damage,
      projectiles: [projectile],
    };
  }

  /**
   * Executes Magician Light Spell ability.
   */
  static executeLightSpell(player) {
    if (player.cooldowns?.light > 0) {
      return { success: false, message: 'Light spell is on cooldown.' };
    }

    if (player.mana < CONFIG.MAGICIAN_LIGHT_MANA_COST) {
      return { success: false, message: 'Not enough Mana to cast Light.' };
    }

    player.mana -= CONFIG.MAGICIAN_LIGHT_MANA_COST;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.light = CONFIG.MAGICIAN_LIGHT_COOLDOWN_SEC;
    player.lightSpellTimer = CONFIG.LIGHT_SPELL_DURATION_SEC;

    return {
      success: true,
      message: 'You cast Light! Darkness recedes for 30 seconds.',
    };
  }

  /**
   * Executes Magician Energy Beam piercing ability.
   */
  static executeEnergyBeam(player, facing = 'right', gridMap, monsters = [], item = null) {
    if (player.cooldowns?.energy_beam > 0) {
      return { success: false, message: 'Beam Staff is on cooldown.' };
    }

    const manaCost = getEffectiveManaCost(item) || CONFIG.MAGICIAN_BEAM_MANA_COST;
    const maxSteps = getEffectiveRange(item) || 4;

    if (player.mana < manaCost) {
      return { success: false, message: 'Not enough Mana to cast Beam Staff.' };
    }

    player.mana -= manaCost;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.energy_beam = CONFIG.MAGICIAN_BEAM_COOLDOWN_SEC;

    const mult = player.skillBoosts?.damageMultiplier || 1.0;

    const fVecs = {
      up: { fX: 0, fY: -1, pX: 1, pY: 0 },
      down: { fX: 0, fY: 1, pX: -1, pY: 0 },
      left: { fX: -1, fY: 0, pX: 0, pY: -1 },
      right: { fX: 1, fY: 0, pX: 0, pY: 1 },
    };
    const { fX, fY, pX, pY } = fVecs[facing] || fVecs.right;

    // Step offsets relative to facing direction vector:
    // Solid wave front generation for step 0..maxSteps-1 (all offsets from -s to +s)
    const stepOffsets = [];
    for (let s = 0; s < maxSteps; s++) {
      const offs = [];
      for (let o = -s; o <= s; o++) {
        offs.push(o);
      }
      stepOffsets.push(offs);
    }

    const waves = [];
    const blockedOffsets = new Set();

    for (let s = 0; s < maxSteps; s++) {
      const dist = s + 1;
      const offsets = stepOffsets[s];
      const waveTiles = [];

      for (const off of offsets) {
        if (blockedOffsets.has(off)) continue;

        const tx = player.x + (fX * dist) + (pX * off);
        const ty = player.y + (fY * dist) + (pY * off);

        if (!gridMap.isInBounds(tx, ty)) {
          blockedOffsets.add(off);
          continue;
        }

        if (gridMap.isWall(tx, ty)) {
          blockedOffsets.add(off);
          waveTiles.push({ x: tx, y: ty, isWall: true });
          continue;
        }

        waveTiles.push({ x: tx, y: ty, isWall: false });
      }

      waves.push({
        step: s,
        delayMs: s * 100, // 0.1s step interval
        tiles: waveTiles,
      });
    }

    const abilitySpec = ABILITIES_CATALOG.magician_beam;
    const rawStepDamage = abilitySpec?.visual?.stepDamage || [20, 15, 10, 5];
    const bonusDmg = item?.stepDamageBonus || 0;

    // Rank scaling: a ranked Beam Staff's `damage` baseline carries the
    // per-rank `stepDamageInc`, so scale each wave step relative to the rank-1
    // baseline instead of a flat stick. Unranked casts use scale 1.
    const effectiveDamage = getEffectiveDamage(item);
    const rankOneWaveDamage = (rawStepDamage[0] || 20) + bonusDmg;
    const damageScale =
      item && effectiveDamage > rankOneWaveDamage ? effectiveDamage / rankOneWaveDamage : 1;

    // Build step damage array for maxSteps
    const baseStepDamage = [];
    for (let s = 0; s < maxSteps; s++) {
      const raw = (s < rawStepDamage.length ? rawStepDamage[s] : Math.max(5, rawStepDamage[rawStepDamage.length - 1])) + bonusDmg;
      baseStepDamage.push(raw);
    }

    const stepVolumes = [];
    for (let s = 0; s < maxSteps; s++) {
      const vol = Math.max(0.1, 1.0 - s * 0.2);
      stepVolumes.push(vol);
    }

    // Compute step damage list scaled by vocation mastery and weapon rank.
    const stepDamage = baseStepDamage.map(base => Math.round(base * mult * damageScale));

    const projectile = {
      id: `proj_beam_${Date.now()}_${Math.random()}`,
      abilityId: 'magician_beam',
      type: 'energy_beam',
      sourceX: player.x,
      sourceY: player.y,
      facing,
      fX,
      fY,
      waves,
      currentWaveIndex: -1,
      elapsedMs: 0,
      stepIntervalMs: 100,
      hitMonsterIds: [],
      stepDamage,
      stepVolumes,
      damagePayload: {
        damage: stepDamage[0],
        vocation: player.vocation,
        casterId: player.id || 'player',
      },
      visual: abilitySpec?.visual || null,
      color: abilitySpec?.visual?.color || '#ff66dd',
      active: true,
    };

    return {
      success: true,
      message: 'You unleashed Arcane Beam!',
      damageDealt: stepDamage[0],
      projectiles: [projectile],
    };
  }

  /**
   * Executes Archer Bow Shot ability.
   */
  static executeBowShot(player, target, gridMap, item = null, opts = {}) {
    if (player.cooldowns?.bow_shot > 0) {
      return { success: false, message: 'Bow Shot is on cooldown.' };
    }

    const mult = player.skillBoosts?.damageMultiplier || 1.0;

    const bonusRng = player.skillBoosts?.bonusRange || 0;
    const itemRange = (item && typeof item.range === 'number') ? item.range : CONFIG.ARCHER_BOW_RANGE;

    const dist = Math.hypot(target.x - player.x, target.y - player.y);
    if (dist > (itemRange + bonusRng) + 0.5) {
      return { success: false, message: 'Target is out of range for Bow Shot.' };
    }

    if (!LightingSystem.hasLineOfSight(gridMap, player.x, player.y, target.x, target.y)) {
      return { success: false, message: 'Line of sight to target is blocked.' };
    }

    // Auto-mode allies (`opts.freeAmmo`) cast their kit without draining the
    // party's finite arrow stock; the manual active member never sets this.
    if (!opts.freeAmmo && !CombatSystem.consumeArrow(player)) {
      return { success: false, message: 'Out of arrows! Cannot fire bow.' };
    }

    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.bow_shot = CONFIG.ARCHER_BOW_COOLDOWN_SEC;

    // Damage parity (the executeWandSpark pattern): embedded item.damage first,
    // CONFIG fallback otherwise; crit roll reads equipped critChance/critMult.
    const baseDmg = (item && typeof item.damage === 'number')
      ? item.damage
      : CombatSystem.randomBetween(CONFIG.ARCHER_BOW_DAMAGE_MIN, CONFIG.ARCHER_BOW_DAMAGE_MAX);
    let damage = Math.round(baseDmg * mult) + CombatSystem.getEquippedStat(player, 'rangedDamageBonus');

    // Hunter's Mark (Ranger's Talisman) amplifies arrows on marked foes.
    const marked = target.hunterMarkTimer > 0;
    if (marked) damage = Math.round(damage * (CombatSystem.getEquippedStat(player, 'markDamageMult') || 1.5));

    const critChance = CombatSystem.getEquippedStat(player, 'critChance');
    const critMult = CombatSystem.getEquippedStat(player, 'critMult') || 1.0;
    let isCrit = false;
    if (critChance > 0 && Math.random() * 100 < critChance) {
      damage = Math.round(damage * critMult);
      isCrit = true;
    }

    target.hp -= damage;

    const poisoned = CombatSystem.applyArrowPoison(player, target);

    const projectile = {
      id: `proj_arrow_${Date.now()}_${Math.random()}`,
      type: 'bow_shot',
      sourceX: player.x,
      sourceY: player.y,
      targetX: target.x,
      targetY: target.y,
      currentX: player.x * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2,
      currentY: player.y * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2,
      durationMs: 200,
      elapsedMs: 0,
      color: '#ddaa44',
    };

    let defeatedMonsterId;
    let droppedLoot;
    let message = isCrit
      ? `CRITICAL! Your arrow pierces ${target.name} for ${damage} damage!`
      : `You fired an arrow at ${target.name} for ${damage} damage.`;
    if (marked) message += ' Marked target: bonus damage!';
    if (poisoned) message += ' Poison seeps into the wound!';

    if (target.hp <= 0) {
      defeatedMonsterId = target.id;
      droppedLoot = CombatSystem.generateMonsterLoot(target);
      message += ` ${target.name} was slain!`;
    }

    return {
      success: true,
      message,
      damageDealt: damage,
      isCrit,
      marked,
      poisoned,
      projectiles: [projectile],
      defeatedMonsterId,
      droppedLoot,
    };
  }

  /**
   * Executes Archer Power Shot ability.
   */
  static executePowerShot(player, target, gridMap, item = null, opts = {}) {
    if (player.cooldowns?.power_shot > 0) {
      return { success: false, message: 'Power Shot is on cooldown.' };
    }

    const mult = player.skillBoosts?.damageMultiplier || 1.0;

    const bonusRng = player.skillBoosts?.bonusRange || 0;
    const itemRange = (item && typeof item.range === 'number') ? item.range : CONFIG.ARCHER_POWER_SHOT_RANGE;

    const dist = Math.hypot(target.x - player.x, target.y - player.y);
    if (dist > (itemRange + bonusRng) + 0.5) {
      return { success: false, message: 'Target is out of range for Power Shot.' };
    }

    if (!LightingSystem.hasLineOfSight(gridMap, player.x, player.y, target.x, target.y)) {
      return { success: false, message: 'Line of sight to target is blocked.' };
    }

    // Auto-mode allies (`opts.freeAmmo`) cast their kit without draining the
    // party's finite arrow stock; the manual active member never sets this.
    if (!opts.freeAmmo && !CombatSystem.consumeArrow(player)) {
      return { success: false, message: 'Out of arrows! Cannot fire Power Shot.' };
    }

    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.power_shot = CONFIG.ARCHER_POWER_SHOT_COOLDOWN_SEC;

    // Damage parity: embedded item.damage first, CONFIG fallback, crit roll
    // from equipped critChance/critMult (Ranger's Talisman).
    const baseDmg = (item && typeof item.damage === 'number')
      ? item.damage
      : CombatSystem.randomBetween(CONFIG.ARCHER_POWER_SHOT_DAMAGE_MIN, CONFIG.ARCHER_POWER_SHOT_DAMAGE_MAX);
    let damage = Math.round(baseDmg * mult) + CombatSystem.getEquippedStat(player, 'rangedDamageBonus');

    const marked = target.hunterMarkTimer > 0;
    if (marked) damage = Math.round(damage * (CombatSystem.getEquippedStat(player, 'markDamageMult') || 1.5));

    const critChance = CombatSystem.getEquippedStat(player, 'critChance');
    const critMult = CombatSystem.getEquippedStat(player, 'critMult') || 1.0;
    let isCrit = false;
    if (critChance > 0 && Math.random() * 100 < critChance) {
      damage = Math.round(damage * critMult);
      isCrit = true;
    }

    target.hp -= damage;

    const poisoned = CombatSystem.applyArrowPoison(player, target);

    const projectile = {
      id: `proj_power_${Date.now()}_${Math.random()}`,
      type: 'power_shot',
      sourceX: player.x,
      sourceY: player.y,
      targetX: target.x,
      targetY: target.y,
      currentX: player.x * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2,
      currentY: player.y * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2,
      durationMs: 250,
      elapsedMs: 0,
      color: '#ff8800',
    };

    let defeatedMonsterId;
    let droppedLoot;
    let message = isCrit
      ? `CRITICAL! Power Shot strikes ${target.name} for ${damage} heavy damage!`
      : `Power Shot strikes ${target.name} for ${damage} heavy damage!`;
    if (marked) message += ' Marked target: bonus damage!';
    if (poisoned) message += ' Poison seeps into the wound!';

    if (target.hp <= 0) {
      defeatedMonsterId = target.id;
      droppedLoot = CombatSystem.generateMonsterLoot(target);
      message += ` ${target.name} was slain!`;
    }

    return {
      success: true,
      message,
      damageDealt: damage,
      isCrit,
      marked,
      poisoned,
      projectiles: [projectile],
      defeatedMonsterId,
      droppedLoot,
    };
  }

  /**
   * Executes Melee Slash for Fighter / Weapons.
   * Shared by Fighter and Paladin basic melee. Reach extends one space beyond
   * adjacent (threshold ~2.5 tiles) per the board's "melee reach +1" ask.
   *
   * Swing-always (LOK-9): the swing ALWAYS executes once cooldown permits —
   * `target` may be null (free swing). The swoosh is emitted oriented toward
   * `player.facing` when there is no target in reach. Damage only registers on
   * monsters inside the damage area (within reach and the facing arc); with no
   * enemy in range the swing still animates (e.g. "Your swing cuts the air.")
   * and still consumes the cooldown.
   *
   * @param {object} player
   * @param {object|null} target Pre-picked/selected enemy; nullable for free swings.
   * @param {object} gridMap
   * @param {object} [opts] Optional `{ monsters: [], facing: 'up'|'down'|'left'|'right' }`
   *   used to resolve damage for free swings (no target / out-of-reach target).
   */
  static executeSlash(player, target, gridMap, opts = {}) {
    if (player.cooldowns?.slash > 0) {
      return { success: false, message: 'Slash is on cooldown.' };
    }

    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.slash = CONFIG.FIGHTER_SLASH_COOLDOWN_SEC;

    const reach = 2.5;
    const facing = opts.facing || player.facing || 'right';
    const mult = player.skillBoosts?.damageMultiplier || 1.0;
    const weaponItem = opts.item || player.paperdoll?.main_hand || null;

    let hitMonster = null;
    if (target && CombatSystem.isHostile(player, target)
      && Math.hypot(target.x - player.x, target.y - player.y) <= reach) {
      hitMonster = target;
    } else {
      hitMonster = CombatSystem.findMonsterInMeleeArea(player, opts.monsters || [], reach, facing, gridMap);
    }

    let damage;
    let defeatedMonsterId;
    let droppedLoot;
    let message;
    let hitX = null;
    let hitY = null;

    if (hitMonster) {
      const baseDmg = (weaponItem && typeof weaponItem.damage === 'number')
        ? weaponItem.damage
        : CombatSystem.randomBetween(CONFIG.FIGHTER_SLASH_DAMAGE_MIN, CONFIG.FIGHTER_SLASH_DAMAGE_MAX);
      damage = Math.round(baseDmg * mult);
      hitMonster.hp -= damage;
      hitX = hitMonster.x;
      hitY = hitMonster.y;
      message = `You slashed ${hitMonster.name} for ${damage} physical damage.`;

      if (hitMonster.hp <= 0) {
        defeatedMonsterId = hitMonster.id;
        droppedLoot = CombatSystem.generateMonsterLoot(hitMonster);
        message += ` ${hitMonster.name} was slain!`;
      }
    } else {
      message = 'Your swing cuts the air.';
    }

    // Basic "swoosh" arc/swipe oriented toward the hit monster, or toward the
    // player's facing on a free swing. Arc radius spans the ~2-tile reach.
    const fv = CombatSystem.FACING_VECTORS[facing] || CombatSystem.FACING_VECTORS.right;
    const swooshTargetX = hitX ?? (player.x + fv.dx * reach);
    const swooshTargetY = hitY ?? (player.y + fv.dy * reach);

    const swoosh = {
      id: `swoosh_${Date.now()}_${Math.random()}`,
      type: 'swoosh',
      sourceX: player.x,
      sourceY: player.y,
      targetX: swooshTargetX,
      targetY: swooshTargetY,
      elapsedMs: 0,
      durationMs: 280,
      color: '#e2e8f0',
      visual: {
        glowColor: '#ffffff',
        arcRadiusTiles: 2.0,
        arcSweepDeg: 90,
      },
    };

    return {
      success: true,
      message,
      damageDealt: damage,
      projectiles: [swoosh],
      defeatedMonsterId,
      droppedLoot,
      hitX,
      hitY,
    };
  }

  /**
   * Executes Holy Strike for Paladin.
   * Paladin weapon parity (LOK-9): reach extends one space beyond adjacent
   * (same ~2.5 tiles as the fighter slash), the strike emits a swoosh, and the
   * swing always executes (target nullable, facing-oriented free swing). Mana
   * cost and cooldown are consumed on every executing swing.
   */
  static executeHolyStrike(player, target, gridMap, opts = {}) {
    if (player.cooldowns?.holy_strike > 0) {
      return { success: false, message: 'Holy Strike is on cooldown.' };
    }

    const weaponItem = opts.item || player.paperdoll?.main_hand || null;
    // The equipped weapon is the source of truth for its granted
    // ability's MP cost, reconciled with abilities.json (both 5 MP). A
    // promoted Warhammer then gets the shared MP-1-per-rank discount.
    const manaCost = (weaponItem && typeof weaponItem.manaCost === 'number')
      ? getEffectiveManaCost(weaponItem)
      : CONFIG.PALADIN_HOLY_STRIKE_MANA_COST;
    if (player.mana < manaCost) {
      return { success: false, message: `Not enough Mana for Holy Strike (${manaCost} MP).` };
    }

    player.mana -= manaCost;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.holy_strike = CONFIG.PALADIN_HOLY_STRIKE_COOLDOWN_SEC;

    const reach = 2.5;
    const facing = opts.facing || player.facing || 'right';
    const mult = player.skillBoosts?.damageMultiplier || 1.0;

    let hitMonster = null;
    if (target && CombatSystem.isHostile(player, target)
      && Math.hypot(target.x - player.x, target.y - player.y) <= reach) {
      hitMonster = target;
    } else {
      hitMonster = CombatSystem.findMonsterInMeleeArea(player, opts.monsters || [], reach, facing, gridMap);
    }

    let damage;
    let defeatedMonsterId;
    let droppedLoot;
    let message;
    let hitX = null;
    let hitY = null;

    if (hitMonster) {
      const baseDmg = (weaponItem && typeof weaponItem.damage === 'number')
        ? weaponItem.damage
        : CombatSystem.randomBetween(CONFIG.PALADIN_HOLY_STRIKE_DAMAGE_MIN, CONFIG.PALADIN_HOLY_STRIKE_DAMAGE_MAX);
      damage = Math.round(baseDmg * mult);
      hitMonster.hp -= damage;
      hitX = hitMonster.x;
      hitY = hitMonster.y;
      message = `Holy Strike smites ${hitMonster.name} for ${damage} holy damage.`;

      if (hitMonster.hp <= 0) {
        defeatedMonsterId = hitMonster.id;
        droppedLoot = CombatSystem.generateMonsterLoot(hitMonster);
        message += ` ${hitMonster.name} was slain!`;
      }
    } else {
      message = 'Your holy swing cuts the air.';
    }

    // Holy-looking swoosh, same shape as the fighter slash (holy gold accents).
    const fv = CombatSystem.FACING_VECTORS[facing] || CombatSystem.FACING_VECTORS.right;
    const swooshTargetX = hitX ?? (player.x + fv.dx * reach);
    const swooshTargetY = hitY ?? (player.y + fv.dy * reach);

    const swoosh = {
      id: `swoosh_${Date.now()}_${Math.random()}`,
      type: 'swoosh',
      sourceX: player.x,
      sourceY: player.y,
      targetX: swooshTargetX,
      targetY: swooshTargetY,
      elapsedMs: 0,
      durationMs: 280,
      color: '#fbbf24',
      visual: {
        glowColor: '#ffd700',
        arcRadiusTiles: 2.0,
        arcSweepDeg: 90,
      },
    };

    return {
      success: true,
      message,
      damageDealt: damage,
      projectiles: [swoosh],
      defeatedMonsterId,
      droppedLoot,
      hitX,
      hitY,
    };
  }

  /**
   * Chooses the most-injured friendly actor within `radius` tiles of `actor`,
   * always including the actor itself. Allies are gated by `isFriendly` (never
   * heal an enemy) and de-duplicated against the active mirror. Returns null
   * when nobody is missing HP.
   *
   * @param {object} actor
   * @param {object[]} [allies]
   * @param {number} [radius] Tiles; <= 0 disables the ally range gate.
   * @returns {object|null} the actor, an ally, or null.
   */
  static selectHealTarget(actor, allies = [], radius = 0) {
    if (!actor) return null;
    let best = null;
    let bestMissingFraction = 0;

    const consider = (candidate, isSelf) => {
      if (!candidate || typeof candidate.hp !== 'number' || typeof candidate.max_hp !== 'number') return;
      if (!isSelf) {
        if (!CombatSystem.isFriendly(actor, candidate)) return;
        if (radius > 0 && Math.hypot((candidate.x || 0) - (actor.x || 0), (candidate.y || 0) - (actor.y || 0)) > radius) return;
      }
      if (candidate.max_hp <= 0) return;
      const missing = candidate.max_hp - candidate.hp;
      if (missing <= 0) return;
      const fraction = missing / candidate.max_hp;
      if (fraction > bestMissingFraction) {
        bestMissingFraction = fraction;
        best = candidate;
      }
    };

    consider(actor, true);
    if (Array.isArray(allies)) {
      for (const ally of allies) {
        if (!ally || CombatSystem.sameActor(actor, ally)) continue;
        consider(ally, false);
      }
    }
    return best;
  }

  /**
   * Chooses the most-injured friendly actor within `radius` tiles of `actor`
   * that does not already carry an active shield, always including the actor
   * itself. Allies are gated by `isFriendly` (never ward an enemy) and
   * de-duplicated against the active mirror. When `hpBelowFraction > 0` only
   * actors at or below that HP fraction qualify, so a full-HP party is never
   * warded. Returns null when nobody qualifies — the anti-spam gate that stops
   * shield recasts while a bubble is already up.
   *
   * @param {object} actor The casting ally.
   * @param {object[]} [allies] Party members to consider.
   * @param {number} [radius] Tiles; <= 0 disables the ally range gate.
   * @param {number} [hpBelowFraction] 0-1 HP ceiling; <= 0 disables the gate.
   * @returns {object|null} the actor, an ally, or null.
   */
  static selectShieldTarget(actor, allies = [], radius = 0, hpBelowFraction = 0) {
    if (!actor) return null;
    let best = null;
    let bestHpFraction = Number.POSITIVE_INFINITY;

    const consider = (candidate, isSelf) => {
      if (!candidate || typeof candidate.hp !== 'number' || typeof candidate.max_hp !== 'number') return;
      if (candidate.max_hp <= 0 || candidate.hp <= 0) return;
      // Already warded: never re-arm (anti-spam) until the bubble drops.
      if ((candidate.shieldAbsorb || 0) > 0 && (candidate.shieldDurationSec || 0) > 0) return;
      if (!isSelf) {
        if (!CombatSystem.isFriendly(actor, candidate)) return;
        if (radius > 0 && Math.hypot((candidate.x || 0) - (actor.x || 0), (candidate.y || 0) - (actor.y || 0)) > radius) return;
      }
      const fraction = candidate.hp / candidate.max_hp;
      if (hpBelowFraction > 0 && fraction > hpBelowFraction) return;
      if (fraction < bestHpFraction) {
        bestHpFraction = fraction;
        best = candidate;
      }
    };

    consider(actor, true);
    if (Array.isArray(allies)) {
      for (const ally of allies) {
        if (!ally || CombatSystem.sameActor(actor, ally)) continue;
        consider(ally, false);
      }
    }
    return best;
  }

  /**
   * Executes the party auto-AI's ally-targeted "force shield" support ability
   * (LIV-25). The catalog `spec` declares `manaCost`, `cooldownSec`,
   * `shieldAbsorb` and `shieldDurationSec`; the cooldown is keyed on the
   * declared `actionKey`. On success it arms/refreshes the shared bubble seam
   * (`shieldAbsorb`/`shieldDurationSec`) on the chosen friendly `target`
   * without downgrading a stronger existing bubble (`Math.max`), so the exact
   * same damage intercept in `applyIncomingDamage` and bubble decay in the
   * party/main tick apply. Only friendly actors can be shielded.
   *
   * @param {object} actor The casting ally.
   * @param {object} target The friendly actor to ward (usually `selectShieldTarget`).
   * @param {object} [spec] The resolved `abilities.json` entry.
   */
  static executeForceShield(actor, target, spec = {}) {
    if (!actor || !target) {
      return { success: false, message: 'No ally to shield.' };
    }
    if (!CombatSystem.sameActor(actor, target) && !CombatSystem.isFriendly(actor, target)) {
      return { success: false, message: 'Force Shield only protects allies.' };
    }

    const actionKey = spec.actionKey || 'force_shield';
    if (actor.cooldowns?.[actionKey] > 0) {
      return { success: false, message: 'Force Shield is on cooldown.' };
    }

    const manaCost = Number(spec.manaCost) || 0;
    if (Number(actor.mana || 0) < manaCost) {
      return { success: false, message: 'Not enough Mana for Force Shield.' };
    }

    const absorb = Number(spec.shieldAbsorb) || 0;
    const duration = Number(spec.shieldDurationSec) || Number(spec.durationSec) || 0;
    if (absorb <= 0 || duration <= 0) {
      return { success: false, message: 'Force Shield has no ward to raise.' };
    }

    actor.mana -= manaCost;
    if (!actor.cooldowns) actor.cooldowns = {};
    actor.cooldowns[actionKey] = Number(spec.cooldownSec) || 0;
    target.shieldAbsorb = Math.max(target.shieldAbsorb || 0, absorb);
    target.shieldDurationSec = Math.max(target.shieldDurationSec || 0, duration);

    const shieldedAlly = !CombatSystem.sameActor(actor, target);
    return {
      success: true,
      message: `Force Shield raised! ${shieldedAlly ? `${target.name || target.vocation || 'An ally'} gains` : 'You gain'} a ${absorb}-damage ward for ${duration}s (${manaCost} MP).`,
      shieldAbsorb: absorb,
      shieldDurationSec: duration,
      manaCost,
      shieldedAlly,
      targetId: target.memberId || target.id || null,
      targetX: target.x,
      targetY: target.y,
    };
  }

  /**
   * Executes Healing Prayer for Paladin. Ally-aware (LIV-11): with a party, the
   * prayer lands on the most-injured friendly actor within the catalog
   * `paladin_heal.healRadius` (`targetsAllies`), falling back to self. A
   * one-member call behaves exactly as before.
   *
   * @param {object} player The acting member.
   * @param {object[]} [allies] Party members to consider as heal targets.
   */
  static executeHealingPrayer(player, allies = []) {
    if (player.cooldowns?.healing_prayer > 0) {
      return { success: false, message: 'Healing Prayer is on cooldown.' };
    }

    if (player.mana < CONFIG.PALADIN_HEAL_MANA_COST) {
      return { success: false, message: 'Not enough Mana for Healing Prayer.' };
    }

    const spec = ABILITIES_CATALOG.paladin_heal || {};
    const radius = Number(spec.healRadius) || 0;
    const targetsAllies = spec.targetsAllies === true || radius > 0;
    const target = targetsAllies
      ? CombatSystem.selectHealTarget(player, allies, radius)
      : (player.hp < player.max_hp ? player : null);

    if (!target) {
      return { success: false, message: 'Health is already full!' };
    }

    player.mana -= CONFIG.PALADIN_HEAL_MANA_COST;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.healing_prayer = CONFIG.PALADIN_HEAL_COOLDOWN_SEC;

    const mult = player.skillBoosts?.damageMultiplier || 1.0;
    const healPowerPct = CombatSystem.getEquippedStat(player, 'healPowerPct');
    const healBoost = 1 + (healPowerPct || 0) / 100;
    const baseHeal = CombatSystem.randomBetween(CONFIG.PALADIN_HEAL_MIN, CONFIG.PALADIN_HEAL_MAX);
    const healAmount = Math.round(baseHeal * mult * healBoost);
    const restored = Math.min(healAmount, target.max_hp - target.hp);
    target.hp = Math.min(target.max_hp, target.hp + healAmount);

    const healedAlly = !CombatSystem.sameActor(player, target);
    const message = healedAlly
      ? `Healing Prayer channeled! Restored +${restored} HP to ${target.name || target.vocation || 'an ally'} (${target.hp}/${target.max_hp}).`
      : `Healing Prayer channeled! Restored +${restored} HP (${player.hp}/${player.max_hp}).`;

    return {
      success: true,
      message,
      healAmount: restored,
      healedAlly,
      targetId: target.memberId || target.id || null,
      targetX: target.x,
      targetY: target.y,
    };
  }

  /**
   * Executes the Fighter's Vanguard Shield Bash (LOK-12 Golden Set).
   * Pushes every monster adjacent to the player (Manhattan distance 1, the
   * same adjacency `entity-ai.js` uses) `pushbackRange` tiles away from the
   * player, reusing `gridMap.isWalkable` and the monster occupancy rules
   * (monsters stop against walls / occupied tiles). Every adjacent monster is
   * stunned via the existing engine-wired `monster.stunTimer`.
   *
   * Cooldown-gated on `player.cooldowns.shield_bash`; the effective cooldown
   * is `item.cooldown` reduced by `cooldownReductionSec` per rank (rank 1:
   * 10 s, rank 5: 6 s).
   */
  static executeShieldBash(player, gridMap, monsters = [], item = null) {
    if (!item) {
      return { success: false, message: 'No shield equipped for Shield Bash.' };
    }

    const effectiveCooldown = CombatSystem.getEffectiveCooldown(item);
    if (player.cooldowns?.shield_bash > 0) {
      return { success: false, message: 'Shield Bash is on cooldown.' };
    }

    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.shield_bash = effectiveCooldown;

    const pushbackRange = item.pushbackRange || 1;
    const stunSec = item.stunSec || 1.0;

    const occupiedTiles = new Set();
    for (const m of monsters) {
      if (m && m.hp > 0) occupiedTiles.add(`${m.x},${m.y}`);
    }

    const affected = [];
    let pushedMonsters = 0;

    for (const m of monsters) {
      if (!m || m.hp <= 0) continue;
      if (!CombatSystem.isHostile(player, m)) continue; // never shove an ally
      const distManhattan = Math.abs(m.x - player.x) + Math.abs(m.y - player.y);
      if (distManhattan !== 1) continue;

      // Away direction from the player (per-axis sign; ants move cardinally).
      const dx = Math.sign(m.x - player.x);
      const dy = Math.sign(m.y - player.y);

      let moved = 0;
      let toX = m.x;
      let toY = m.y;
      for (let step = 0; step < pushbackRange; step++) {
        const nx = toX + dx;
        const ny = toY + dy;
        if (!gridMap.isWalkable(nx, ny)) break; // wall / out of bounds -> stop
        if (nx === player.x && ny === player.y) break; // never shove into the player
        if (occupiedTiles.has(`${nx},${ny}`)) break; // tile occupied by another monster
        occupiedTiles.delete(`${m.x},${m.y}`);
        toX = nx;
        toY = ny;
        occupiedTiles.add(`${toX},${toY}`);
        moved += 1;
      }

      if (moved > 0) {
        m.x = toX;
        m.y = toY;
        pushedMonsters += 1;
      }

      // Stun every adjacent (pushed OR wall-stopped) monster.
      m.stunTimer = Math.max(m.stunTimer || 0, stunSec);
      affected.push({ monster: m, pushed: moved > 0 });
    }

    const message = affected.length > 0
      ? `Shield Bash! ${pushedMonsters} monster${pushedMonsters === 1 ? '' : 's'} shoved back and stunned for ${stunSec.toFixed(1)}s (${effectiveCooldown}s CD).`
      : `Shield Bash! No monsters adjacent to shove (${effectiveCooldown}s CD).`;

    return { success: true, message, affected, pushedCount: pushedMonsters, cooldownSet: effectiveCooldown };
  }

  /**
   * Executes the Paladin's Aegis Holy Shield (LOK-12 Golden Set).
   * Mana-gated like `executeHolyStrike`: costs `item.manaCost` (15 base,
   * `shieldManaCostReduction` 2 per rank → 7 MP at rank 5). On success sets
   * `player.shieldAbsorb` and `player.shieldDurationSec`; the damage-intercept
   * seam lives in `CombatSystem.applyIncomingDamage` and the 30 s decay in
   * `app-controller.tick()`.
   */
  static executeHolyShield(player, item = null) {
    if (!item) {
      return { success: false, message: 'No shield equipped for Holy Shield.' };
    }

    const manaCost = CombatSystem.getEffectiveManaCost(item);
    if (player.mana < manaCost) {
      return { success: false, message: `Not enough Mana to cast Holy Shield (${manaCost} MP).` };
    }

    player.mana -= manaCost;
    player.shieldAbsorb = item.shieldAbsorb || 0;
    player.shieldDurationSec = item.shieldDuration || 0;

    return {
      success: true,
      message: `Holy Shield envelops you! Bubble absorbs ${player.shieldAbsorb} damage for ${player.shieldDurationSec}s (${manaCost} MP).`,
      shieldAbsorb: player.shieldAbsorb,
      shieldDurationSec: player.shieldDurationSec,
      manaCost,
    };
  }

  /**
   * Executes the Paladin's Sanctuary Plate active (armor, E key). A second
   * holy force-field source alongside `executeHolyShield`: mana- and
   * cooldown-gated, it arms/refreshes `player.shieldAbsorb` and
   * `player.shieldDurationSec`, so it reuses the exact same damage-intercept
   * seam and silver barrier VFX as the Aegis Shield / Apprentice's Cape. It
   * never downgrades an existing stronger bubble (`Math.max`).
   */
  static executeSanctuary(player, item = null) {
    if (!item) {
      return { success: false, message: 'No armor equipped for Sanctuary.' };
    }
    if (player.cooldowns?.sanctuary > 0) {
      return { success: false, message: 'Sanctuary is on cooldown.' };
    }

    const manaCost = CombatSystem.getEffectiveManaCost(item) ?? 0;
    if (player.mana < manaCost) {
      return { success: false, message: `Not enough Mana to cast Sanctuary (${manaCost} MP).` };
    }

    const absorb = item.shieldAbsorb || 0;
    const duration = item.shieldDuration || 0;
    player.mana -= manaCost;
    player.shieldAbsorb = Math.max(player.shieldAbsorb || 0, absorb);
    player.shieldDurationSec = Math.max(player.shieldDurationSec || 0, duration);

    const effectiveCooldown = CombatSystem.getEffectiveCooldown(item) ?? item.cooldown ?? 16;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.sanctuary = effectiveCooldown;

    return {
      success: true,
      message: `Sanctuary! A holy force-field absorbs ${absorb} damage for ${duration}s (${manaCost} MP, ${effectiveCooldown}s CD).`,
      shieldAbsorb: absorb,
      shieldDurationSec: duration,
      manaCost,
      cooldownSet: effectiveCooldown,
    };
  }

  /**
   * Executes the Paladin's Dawnlight Reliquary active (relic, R key).
   * Mana- and cooldown-gated restoration: heals a `healMin`..`healMax` roll
   * scaled by the equipped `healPowerPct` and restores `mpRestore` MP. Refuses
   * to cast when both pools are already full.
   */
  static executeBenediction(player, item = null, allies = []) {
    if (!item) {
      return { success: false, message: 'No relic equipped for Benediction.' };
    }
    if (player.cooldowns?.benediction > 0) {
      return { success: false, message: 'Benediction is on cooldown.' };
    }

    const manaCost = CombatSystem.getEffectiveManaCost(item) ?? 0;
    if (player.mana < manaCost) {
      return { success: false, message: `Not enough Mana to cast Benediction (${manaCost} MP).` };
    }

    // Ally-aware (LIV-11): the HP restore lands on the most-injured friendly
    // actor within the item's `healRadius` (falling back to self); the MP
    // restore always refills the caster. One-member calls are unchanged.
    const radius = Number(item.healRadius) || 0;
    const targetsAllies = item.targetsAllies === true || radius > 0;
    const healTarget = targetsAllies
      ? CombatSystem.selectHealTarget(player, allies, radius)
      : (player.hp < player.max_hp ? player : null);
    const mpMissing = Math.max(0, player.max_mana - player.mana);
    if (!healTarget && mpMissing <= 0) {
      return { success: false, message: 'Benediction finds nothing to restore — HP and MP are full.' };
    }

    player.mana -= manaCost;
    const effectiveCooldown = CombatSystem.getEffectiveCooldown(item) ?? item.cooldown ?? 18;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.benediction = effectiveCooldown;

    const healPowerPct = CombatSystem.getEquippedStat(player, 'healPowerPct');
    const healBoost = 1 + (healPowerPct || 0) / 100;
    const baseHeal = CombatSystem.randomBetween(item.healMin || 25, item.healMax || 35);
    const heal = Math.round(baseHeal * healBoost);
    const mpRestore = item.mpRestore || 15;

    const hpRestored = healTarget ? Math.min(heal, Math.max(0, healTarget.max_hp - healTarget.hp)) : 0;
    const mpRestored = Math.min(mpRestore, Math.max(0, player.max_mana - player.mana));
    if (healTarget) healTarget.hp = Math.min(healTarget.max_hp, healTarget.hp + heal);
    player.mana = Math.min(player.max_mana, player.mana + mpRestore);

    const healedAlly = Boolean(healTarget) && !CombatSystem.sameActor(player, healTarget);
    const hpPart = healedAlly
      ? `+${hpRestored} HP to ${healTarget.name || healTarget.vocation || 'an ally'}`
      : `+${hpRestored} HP`;
    return {
      success: true,
      message: `Benediction! Restored ${hpPart} and +${mpRestored} MP (${manaCost} MP, ${effectiveCooldown}s CD).`,
      hpRestored,
      mpRestored,
      manaCost,
      cooldownSet: effectiveCooldown,
      healedAlly,
      targetId: healTarget ? (healTarget.memberId || healTarget.id || null) : null,
      targetX: healTarget ? healTarget.x : player.x,
      targetY: healTarget ? healTarget.y : player.y,
    };
  }

  /**
   * Executes the Magician's Shock Shield (Apprentice's Cape active, `e` key).
   * Costs `item.manaCost` MP (2 base) and arms a one-charge electro shield:
   * the next incoming attack is deflected (0 damage) and its attacker is
   * stunned for `item.stunSec` seconds. The cooldown is rank-scaled through
   * `getEffectiveCooldown` (base 10 s, -1 s per rank, min 1 s); the stun is
   * bumped +1 s per rank via `upgradeSpec.stunInc` on rank-up.
   */
  static executeShockShield(player, item = null) {
    if (!item) {
      return { success: false, message: 'No armor equipped for Shock Shield.' };
    }

    if (player.cooldowns?.shock_shield > 0) {
      return { success: false, message: 'Shock Shield is on cooldown.' };
    }

    const manaCost = (typeof item.manaCost === 'number') ? getEffectiveManaCost(item) : 2;
    if (player.mana < manaCost) {
      return { success: false, message: `Not enough Mana to cast Shock Shield (${manaCost} MP).` };
    }

    const effectiveCooldown = CombatSystem.getEffectiveCooldown(item) ?? 10;
    const stunSec = item.stunSec || 5;

    player.mana -= manaCost;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.shock_shield = effectiveCooldown;
    player.shockShieldCharges = 1;
    player.shockShieldStunSec = stunSec;

    return {
      success: true,
      message: `Shock Shield crackles around you! Deflects the next hit and stuns the attacker for ${stunSec}s (${manaCost} MP, ${effectiveCooldown}s CD).`,
      manaCost,
      stunSec,
      cooldownSet: effectiveCooldown,
      charges: player.shockShieldCharges,
    };
  }

  /**
   * Executes the Luminous Amulet's Luminous Prayer active (`r` key).
   * Channels the amulet's stored light to restore `healPerRank` HP and MP per
   * item rank (5 per rank base), gated on its rank-scaled cooldown (base 20 s,
   * -2 s per rank via `upgradeSpec.cooldownReductionSec`). Costs 0 MP — the
   * relic draws on ambient light rather than the caster's mana pool.
   */
  static executeLuminousPrayer(player, item = null) {
    if (!item) {
      return { success: false, message: 'No relic equipped for Luminous Prayer.' };
    }

    if (player.cooldowns?.luminous_prayer > 0) {
      return { success: false, message: 'Luminous Prayer is on cooldown.' };
    }

    const manaCost = (typeof item.manaCost === 'number') ? item.manaCost : 0;
    if (player.mana < manaCost) {
      return { success: false, message: `Not enough Mana for Luminous Prayer (${manaCost} MP).` };
    }

    if (player.hp >= player.max_hp && player.mana >= player.max_mana) {
      return { success: false, message: 'Luminous Prayer finds nothing to mend — HP and MP are full.' };
    }

    const effectiveCooldown = CombatSystem.getEffectiveCooldown(item) ?? 20;
    const rank = item.itemLevel || 1;
    const heal = (item.healPerRank || 5) * rank;

    player.mana -= manaCost;
    const hpRestored = Math.min(heal, Math.max(0, player.max_hp - player.hp));
    const mpRestored = Math.min(heal, Math.max(0, player.max_mana - player.mana));
    player.hp = Math.min(player.max_hp, player.hp + hpRestored);
    player.mana = Math.min(player.max_mana, player.mana + mpRestored);

    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.luminous_prayer = effectiveCooldown;

    return {
      success: true,
      message: `Luminous Prayer channels sustaining light (+${hpRestored} HP / +${mpRestored} MP) [${effectiveCooldown}s CD].`,
      hpRestored,
      mpRestored,
      cooldownSet: effectiveCooldown,
    };
  }

  /**
   * Arms the Hunter's Quiver "Poison Tip" active (off-hand, W key). For the
   * next `poisonArrows` arrows (or until `poisonBuffSec` elapses), every arrow
   * that damages a living enemy applies a poison DoT. Mana- and
   * cooldown-gated; poison damage scales with `upgradeSpec.poisonDpsInc`.
   */
  static executePoisonTip(player, item = null) {
    if (!item) {
      return { success: false, message: 'No quiver equipped for Poison Tip.' };
    }
    if (player.cooldowns?.poison_tip > 0) {
      return { success: false, message: 'Poison Tip is on cooldown.' };
    }
    const manaCost = (typeof item.manaCost === 'number') ? getEffectiveManaCost(item) : 2;
    if (player.mana < manaCost) {
      return { success: false, message: `Not enough Mana to cast Poison Tip (${manaCost} MP).` };
    }
    const effectiveCooldown = CombatSystem.getEffectiveCooldown(item) ?? 8;
    const dps = item.poisonDps || 2;
    const durationSec = item.poisonDurationSec || 3;
    player.mana -= manaCost;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.poison_tip = effectiveCooldown;
    player.poisonTipArrows = item.poisonArrows || 5;
    player.poisonTipTimer = item.poisonBuffSec || 10;
    player.poisonTipDps = dps;
    player.poisonTipDurationSec = durationSec;
    return {
      success: true,
      message: `Poison Tip! Your next ${player.poisonTipArrows} arrows poison for ${dps} dmg/s over ${durationSec}s (${manaCost} MP, ${effectiveCooldown}s CD).`,
      manaCost,
      cooldownSet: effectiveCooldown,
      poisonDps: dps,
      arrows: player.poisonTipArrows,
      durationSec,
    };
  }

  /**
   * Applies the armed Poison Tip to a living enemy hit by an arrow. Consumes
   * one charged arrow and refreshes the target's poison DoT. No-op when the
   * buff is not armed or the target already died.
   */
  static applyArrowPoison(player, target) {
    const arrows = player.poisonTipArrows || 0;
    if (arrows <= 0 || !target || target.hp <= 0) return false;
    const quiver = player.paperdoll?.off_hand;
    const dps = player.poisonTipDps || quiver?.poisonDps || 2;
    const durationSec = player.poisonTipDurationSec || quiver?.poisonDurationSec || 3;
    target.poisonDps = Math.max(target.poisonDps || 0, dps);
    target.poisonTimer = Math.max(target.poisonTimer || 0, durationSec);
    player.poisonTipArrows = arrows - 1;
    if (player.poisonTipArrows <= 0) player.poisonTipTimer = 0;
    return true;
  }

  /**
   * Catalog-driven status-effect dispatch tables (LIV-2). An opponent's
   * `attacks[].onHit` descriptor (`{ status, durationSec, dps, factor }`) is
   * applied through `applyPlayerStatus` and advanced each tick through
   * `tickPlayerStatusEffects`. Adding a status is a new catalog value plus
   * (when it has real behavior) one applier/ticker entry — unknown statuses
   * are safe no-ops.
   */
  static STATUS_EFFECT_APPLIERS = {
    burn: (player, effect) => {
      player.burnTimer = Math.max(player.burnTimer || 0, effect.durationSec || 3);
      player.burnDps = Math.max(player.burnDps || 0, effect.dps || 1);
    },
    poison: (player, effect) => {
      player.poisonTimer = Math.max(player.poisonTimer || 0, effect.durationSec || 3);
      player.poisonDps = Math.max(player.poisonDps || 0, effect.dps || 1);
    },
    slow: (player, effect) => {
      player.slowTimer = Math.max(player.slowTimer || 0, effect.durationSec || 3);
      player.slowFactor = Math.min(player.slowFactor ?? 1, effect.factor ?? 0.5);
    },
    stun: (player, effect) => {
      player.stunTimer = Math.max(player.stunTimer || 0, effect.durationSec || 1);
    },
    bleed: (player, effect) => {
      player.bleedTimer = Math.max(player.bleedTimer || 0, effect.durationSec || 3);
      player.bleedDps = Math.max(player.bleedDps || 0, effect.dps || 1);
    },
    root: (player, effect) => {
      player.rootTimer = Math.max(player.rootTimer || 0, effect.durationSec || 1);
    },
  };

  /**
   * Applies one catalog `onHit` status descriptor. Returns false (safe no-op)
   * when the status has no registered applier.
   */
  static applyPlayerStatus(player, effect, attacker = null) {
    if (!player || !effect || !effect.status) return false;
    // Same-faction statuses never land: an ally cannot burn, poison, slow or
    // stun another party member.
    if (attacker && CombatSystem.isFriendly(attacker, player)) return false;
    const handler = CombatSystem.STATUS_EFFECT_APPLIERS[effect.status];
    if (!handler) return false;
    handler(player, effect);
    return true;
  }

  /**
   * Advances player DoT/control timers one tick. Damage-over-time accumulates
   * as whole HP (fractions never leak). Returns a small result object; allocates
   * at most once per tick, never per monster/frame.
   */
  static tickPlayerStatusEffects(player, deltaSec) {
    const result = { burnDamage: 0, poisonDamage: 0, bleedDamage: 0, damage: 0, slowed: false, stunned: false, rooted: false };
    if (!player) return result;

    if (player.burnTimer > 0) {
      player.burnTimer = Math.max(0, player.burnTimer - deltaSec);
      player.burnAccumulator = (player.burnAccumulator || 0) + (player.burnDps || 0) * deltaSec;
      const whole = Math.floor(player.burnAccumulator);
      if (whole > 0) {
        player.burnAccumulator -= whole;
        result.burnDamage = whole;
      }
      if (player.burnTimer <= 0) {
        player.burnDps = 0;
        player.burnAccumulator = 0;
      }
    }

    if (player.poisonTimer > 0) {
      player.poisonTimer = Math.max(0, player.poisonTimer - deltaSec);
      player.poisonAccumulator = (player.poisonAccumulator || 0) + (player.poisonDps || 0) * deltaSec;
      const whole = Math.floor(player.poisonAccumulator);
      if (whole > 0) {
        player.poisonAccumulator -= whole;
        result.poisonDamage = whole;
      }
      if (player.poisonTimer <= 0) {
        player.poisonDps = 0;
        player.poisonAccumulator = 0;
      }
    }

    if (player.bleedTimer > 0) {
      player.bleedTimer = Math.max(0, player.bleedTimer - deltaSec);
      player.bleedAccumulator = (player.bleedAccumulator || 0) + (player.bleedDps || 0) * deltaSec;
      const whole = Math.floor(player.bleedAccumulator);
      if (whole > 0) {
        player.bleedAccumulator -= whole;
        result.bleedDamage = whole;
      }
      if (player.bleedTimer <= 0) {
        player.bleedDps = 0;
        player.bleedAccumulator = 0;
      }
    }

    // Tester's Strength (debug option) also covers damage-over-time ticks.
    if (CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER < 1) {
      const m = CombatSystem.DEBUG_INCOMING_DAMAGE_MULTIPLIER;
      if (result.burnDamage > 0) result.burnDamage = Math.round(result.burnDamage * m);
      if (result.poisonDamage > 0) result.poisonDamage = Math.round(result.poisonDamage * m);
      if (result.bleedDamage > 0) result.bleedDamage = Math.round(result.bleedDamage * m);
    }
    result.damage = result.burnDamage + result.poisonDamage + result.bleedDamage;
    if (result.damage > 0) {
      player.hp = Math.max(0, player.hp - result.damage);
    }

    if (player.slowTimer > 0) {
      player.slowTimer = Math.max(0, player.slowTimer - deltaSec);
      if (player.slowTimer <= 0) player.slowFactor = 1;
      result.slowed = player.slowTimer > 0;
    }
    if (player.stunTimer > 0) {
      player.stunTimer = Math.max(0, player.stunTimer - deltaSec);
      result.stunned = player.stunTimer > 0;
    }
    if (player.rootTimer > 0) {
      player.rootTimer = Math.max(0, player.rootTimer - deltaSec);
      result.rooted = player.rootTimer > 0;
    }

    return result;
  }

  /**
   * Ticks poison DoT and Hunter's Mark timers on every monster. Poison damage
   * accumulates as whole HP so per-tick fractions do not leak. Returns the
   * monsters slain by poison this tick (caller resolves loot/XP).
   */
  static tickStatusEffects(monsters = [], deltaSec) {
    const defeated = [];
    for (const m of monsters) {
      if (!m || m.hp <= 0) continue;
      if (m.hunterMarkTimer > 0) {
        m.hunterMarkTimer = Math.max(0, m.hunterMarkTimer - deltaSec);
      }
      if (m.poisonTimer > 0) {
        const dps = m.poisonDps || 0;
        m.poisonAccumulator = (m.poisonAccumulator || 0) + dps * deltaSec;
        const whole = Math.floor(m.poisonAccumulator);
        if (whole > 0) {
          m.hp -= whole;
          m.poisonAccumulator -= whole;
        }
        m.poisonTimer = Math.max(0, m.poisonTimer - deltaSec);
        if (m.poisonTimer <= 0) {
          m.poisonDps = 0;
          m.poisonAccumulator = 0;
        }
        if (m.hp <= 0) {
          m.hp = 0;
          defeated.push(m);
        }
      }
    }
    return defeated;
  }

  /**
   * Executes the Vampiric Cloak "Life Siphon" active (armor, E key). Drains
   * `siphonHp` from every living monster within `siphonRadius` tiles and heals
   * the player for the total drained (capped at max HP). Mana- and
   * cooldown-gated; refuses to cast with no enemy in range.
   */
  static executeLifeSiphon(player, gridMap, monsters = [], item = null) {
    if (!item) {
      return { success: false, message: 'No armor equipped for Life Siphon.' };
    }
    if (player.cooldowns?.life_siphon > 0) {
      return { success: false, message: 'Life Siphon is on cooldown.' };
    }
    const manaCost = (typeof item.manaCost === 'number') ? getEffectiveManaCost(item) : 1;
    if (player.mana < manaCost) {
      return { success: false, message: `Not enough Mana to cast Life Siphon (${manaCost} MP).` };
    }
    const radius = item.siphonRadius || 2;
    const siphonHp = item.siphonHp || 5;
    const affected = [];
    let totalDrained = 0;
    for (const m of monsters) {
      if (!m || m.hp <= 0) continue;
      if (!CombatSystem.isHostile(player, m)) continue; // siphon only drains enemies
      const dist = Math.hypot(m.x - player.x, m.y - player.y);
      if (dist > radius) continue;
      const drained = Math.min(siphonHp, m.hp);
      m.hp -= drained;
      totalDrained += drained;
      affected.push({ monster: m, drained, defeated: m.hp <= 0 });
    }
    if (affected.length === 0) {
      return { success: false, message: `No enemies within ${radius} tiles to siphon.` };
    }
    const hpMissing = Math.max(0, player.max_hp - player.hp);
    const healed = Math.min(totalDrained, hpMissing);
    player.hp = Math.min(player.max_hp, player.hp + healed);
    player.mana -= manaCost;
    const effectiveCooldown = CombatSystem.getEffectiveCooldown(item) ?? 8;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.life_siphon = effectiveCooldown;
    return {
      success: true,
      message: `Life Siphon drains ${totalDrained} HP from ${affected.length} enem${affected.length === 1 ? 'y' : 'ies'} and heals you +${healed} HP (${manaCost} MP, ${effectiveCooldown}s CD).`,
      drained: totalDrained,
      healed,
      affected,
      manaCost,
      cooldownSet: effectiveCooldown,
    };
  }

  /**
   * Executes the Ranger's Talisman "Hunter's Mark" active (relic, R key).
   * Marks every living, visible enemy in line of sight within `markRange`
   * tiles for `markDurationSec` seconds; arrows then deal `markDamageMult`
   * bonus damage to marked targets. Mana- and cooldown-gated.
   */
  static executeHuntersMark(player, gridMap, monsters = [], item = null) {
    if (!item) {
      return { success: false, message: "No relic equipped for Hunter's Mark." };
    }
    if (player.cooldowns?.hunters_mark > 0) {
      return { success: false, message: "Hunter's Mark is on cooldown." };
    }
    const manaCost = (typeof item.manaCost === 'number') ? getEffectiveManaCost(item) : 3;
    if (player.mana < manaCost) {
      return { success: false, message: `Not enough Mana to cast Hunter's Mark (${manaCost} MP).` };
    }
    const range = item.markRange || 8;
    const durationSec = item.markDurationSec || 6;
    const marked = [];
    for (const m of monsters) {
      if (!m || m.hp <= 0 || m.visible === false) continue;
      if (!CombatSystem.isHostile(player, m)) continue; // never mark an ally
      const dist = Math.hypot(m.x - player.x, m.y - player.y);
      if (dist > range + 0.5) continue;
      if (gridMap && !LightingSystem.hasLineOfSight(gridMap, player.x, player.y, m.x, m.y)) continue;
      m.hunterMarkTimer = Math.max(m.hunterMarkTimer || 0, durationSec);
      marked.push(m);
    }
    if (marked.length === 0) {
      return { success: false, message: 'No enemies in line of sight to mark.' };
    }
    player.mana -= manaCost;
    const effectiveCooldown = CombatSystem.getEffectiveCooldown(item) ?? 15;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.hunters_mark = effectiveCooldown;
    return {
      success: true,
      message: `Hunter's Mark! ${marked.length} enem${marked.length === 1 ? 'y' : 'ies'} marked for ${durationSec}s — arrows deal bonus damage (${manaCost} MP, ${effectiveCooldown}s CD).`,
      marked,
      manaCost,
      durationSec,
      cooldownSet: effectiveCooldown,
      markDamageMult: item.markDamageMult || 1.5,
    };
  }

  /**
   * Executes the Fighter's Cleave — the advertised WIDE multi-target sweep
   * (previously mis-routed to the single-target `executeSlash`). Hits every
   * monster within the ~2.5-tile melee reach regardless of facing arc, dealing
   * heavy cleave damage to each. Mana- and cooldown-gated.
   *
   * @returns {{ success, message, damageDealt, hits: [{monster, damage, defeated}], projectiles }}
   */
  static executeCleave(player, gridMap, monsters = [], item = null) {
    if (player.cooldowns?.cleave > 0) {
      return { success: false, message: 'Cleave is on cooldown.' };
    }

    const manaCost = (item && typeof item.manaCost === 'number') ? getEffectiveManaCost(item) : CONFIG.FIGHTER_CLEAVE_MANA_COST;
    if (player.mana < manaCost) {
      return { success: false, message: 'Not enough Mana for Cleave.' };
    }

    player.mana -= manaCost;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.cleave = (item && typeof item.cooldown === 'number')
      ? (CombatSystem.getEffectiveCooldown(item) ?? item.cooldown)
      : CONFIG.FIGHTER_CLEAVE_COOLDOWN_SEC;

    const reach = 2.5;
    const mult = player.skillBoosts?.damageMultiplier || 1.0;

    const hits = [];
    let totalDamage = 0;
    for (const m of monsters) {
      if (!m || m.hp <= 0) continue;
      if (!CombatSystem.isHostile(player, m)) continue; // cleave never hits allies
      const dist = Math.hypot(m.x - player.x, m.y - player.y);
      if (dist > reach) continue;

      const baseDmg = CombatSystem.randomBetween(CONFIG.FIGHTER_CLEAVE_DAMAGE_MIN, CONFIG.FIGHTER_CLEAVE_DAMAGE_MAX);
      const damage = Math.round(baseDmg * mult);
      m.hp -= damage;
      totalDamage += damage;
      hits.push({ monster: m, damage, defeated: m.hp <= 0 });
    }

    // Wide-sweep swoosh arc (larger arc than the single-target slash).
    const swoosh = {
      id: `swoosh_cleave_${Date.now()}_${Math.random()}`,
      type: 'swoosh',
      sourceX: player.x,
      sourceY: player.y,
      targetX: player.x + (player.facing === 'left' ? -1 : 1) * reach,
      targetY: player.y + (player.facing === 'up' ? -1 : player.facing === 'down' ? 1 : 0) * reach,
      elapsedMs: 0,
      durationMs: 300,
      color: '#e2e8f0',
      visual: {
        glowColor: '#ffffff',
        arcRadiusTiles: 2.5,
        arcSweepDeg: 220,
      },
    };

    const message = hits.length > 0
      ? `Whirlwind Cleave! You swept ${hits.length} monster${hits.length === 1 ? '' : 's'} for ${totalDamage} total damage.`
      : 'Your cleave sweeps empty air.';

    return {
      success: true,
      message,
      damageDealt: totalDamage,
      hits,
      projectiles: [swoosh],
    };
  }

  /**
   * Executes the Fighter's Fortify Stance (-50% incoming damage / 10 s).
   * Previously advertised by `card_fighter_fortify` but not wired to any
   * handler; registered now as the missing LOK-12 engine seam. Mana- and
   * cooldown-gated; `player.fortifyActive` halves damage in
   * `CombatSystem.applyIncomingDamage` while `player.fortifyTimer` counts down
   * in `app-controller.tick()`.
   */
  static executeFortify(player, item = null) {
    if (player.cooldowns?.fortify > 0) {
      return { success: false, message: 'Fortify is on cooldown.' };
    }

    const manaCost = (item && typeof item.manaCost === 'number') ? getEffectiveManaCost(item) : 15;
    if (player.mana < manaCost) {
      return { success: false, message: 'Not enough Mana for Fortify.' };
    }

    player.mana -= manaCost;
    if (!player.cooldowns) player.cooldowns = {};
    player.cooldowns.fortify = (item && typeof item.cooldown === 'number')
      ? (CombatSystem.getEffectiveCooldown(item) ?? item.cooldown)
      : 12;

    player.fortifyActive = true;
    player.fortifyTimer = 10;

    return {
      success: true,
      message: 'Fortify Stance! Incoming damage reduced by 50% for 10 seconds.',
      fortifyTimer: player.fortifyTimer,
    };
  }

  /**
   * Generates loot dropped upon monster defeat based on MONSTERS_CATALOG lootTable rules.
   */
  static generateMonsterLoot(monster) {
    const loot = [];
    const monsterDef = MONSTERS_CATALOG[monster.type];
    if (!monsterDef || !monsterDef.lootTable) {
      return loot;
    }

    const roll = Math.random();
    for (const dropEntry of monsterDef.lootTable) {
      if (dropEntry.always || (roll >= dropEntry.minRoll && roll < dropEntry.maxRoll)) {
        loot.push({
          item_id: dropEntry.item_id,
          name: dropEntry.name,
          type: dropEntry.type,
          quantity: dropEntry.quantity,
          stat_bonus: dropEntry.stat_bonus,
        });
      }
    }

    return loot;
  }
}
