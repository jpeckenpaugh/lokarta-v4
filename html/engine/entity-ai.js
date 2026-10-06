/**
 * Lokarta: Come Into The Light - Entity AI & Pathfinding Subsystem
 */

import { CONFIG } from './config.js';
import { LightingSystem } from './lighting-system.js';
import { MONSTERS_CATALOG } from '../data/index.js';
import { CombatSystem } from './combat-system.js';
import { MONSTER_FACTION } from './faction.js';

/**
 * Attack-pattern dispatch (catalog `attacks[].kind` -> handler). Every handler
 * returns an action result or null when its gates (cooldown/range/LOS) fail.
 * Unknown kinds fall back to `melee` (see `tryAttack`), so a typo in the
 * catalog is a plain melee instead of a crash.
 */
const ATTACK_HANDLERS = {
  melee: (monster, player, gridMap, monsters, mData, atk) =>
    EntityAI.executeMeleeAttack(monster, player, mData, atk),
  projectile: (monster, player, gridMap, monsters, mData, atk) =>
    EntityAI.executeProjectileAttack(monster, player, mData, atk),
  aoe: (monster, player, gridMap, monsters, mData, atk) =>
    EntityAI.executeAoeAttack(monster, player, gridMap, monsters, mData, atk),
  dash: (monster, player, gridMap, monsters, mData, atk) =>
    EntityAI.executeDashAttack(monster, player, gridMap, monsters, mData, atk),
  summon: (monster, player, gridMap, monsters, mData, atk) =>
    EntityAI.executeSummonAttack(monster, player, gridMap, monsters, atk),
};

/**
 * Delayed (telegraphed) resolution dispatch. A wind-up stores
 * `monster.pendingAttack`; when its timer elapses the matching resolver here
 * applies the payload. Unknown kinds are dropped safely.
 */
const TELEGRAPH_RESOLVERS = {
  aoe: (monster, player, gridMap, monsters, atk, targetX, targetY) =>
    EntityAI.resolveAoeAttack(monster, player, gridMap, monsters, atk, targetX, targetY),
  dash: (monster, player, gridMap, monsters, atk) =>
    EntityAI.resolveDashAttack(monster, player, gridMap, monsters, atk),
};

/**
 * Positioning-behavior dispatch (catalog `aiType`). `chase`/`standoff` are the
 * original handlers (behavior frozen for the launch monsters); the ability
 * personalities below are catalog-driven. Unknown/missing `aiType` falls back
 * to `chase` in `updateMonsters`.
 */
const AI_HANDLERS = {
  standoff: (monster, player, gridMap, monsters, mData) =>
    EntityAI.updateCultist(monster, player, gridMap, monsters, mData),
  chase: (monster, player, gridMap, monsters, mData) => {
    // Catalog is authoritative; generic guards only cover an unknown monster type.
    const minDmg = mData?.damageMin ?? 1;
    const maxDmg = mData?.damageMax ?? minDmg;
    const moveCadence = mData?.moveCadence ?? 1.0;
    return EntityAI.updateMeleeMonster(monster, player, gridMap, monsters, minDmg, maxDmg, moveCadence);
  },
  ranged: (monster, player, gridMap, monsters, mData) =>
    EntityAI.updateCatalogCombatant(monster, player, gridMap, monsters, mData),
  bomber: (monster, player, gridMap, monsters, mData) =>
    EntityAI.updateCatalogCombatant(monster, player, gridMap, monsters, mData),
  summoner: (monster, player, gridMap, monsters, mData) =>
    EntityAI.updateCatalogCombatant(monster, player, gridMap, monsters, mData),
  charger: (monster, player, gridMap, monsters, mData) =>
    EntityAI.updateCharger(monster, player, gridMap, monsters, mData),
};

/** Cardinal-first adjacent offsets a summon can occupy (static, no per-tick alloc). */
const SUMMON_OFFSETS = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

class MinHeap {
  constructor() {
    this.nodes = [];
  }

  get size() {
    return this.nodes.length;
  }

  push(node) {
    this.nodes.push(node);
    this._bubbleUp(this.nodes.length - 1);
  }

  pop() {
    if (this.nodes.length === 0) return null;
    const top = this.nodes[0];
    const bottom = this.nodes.pop();
    if (this.nodes.length > 0) {
      this.nodes[0] = bottom;
      this._sinkDown(0);
    }
    return top;
  }

  updateItem(node) {
    const idx = this.nodes.indexOf(node);
    if (idx !== -1) {
      this._bubbleUp(idx);
      this._sinkDown(idx);
    }
  }

  _bubbleUp(n) {
    const element = this.nodes[n];
    while (n > 0) {
      const parentN = Math.floor((n - 1) / 2);
      const parent = this.nodes[parentN];
      if (element.f >= parent.f) break;
      this.nodes[parentN] = element;
      this.nodes[n] = parent;
      n = parentN;
    }
  }

  _sinkDown(n) {
    const length = this.nodes.length;
    const element = this.nodes[n];
    while (true) {
      const child2N = (n + 1) * 2;
      const child1N = child2N - 1;
      let swap = null;

      if (child1N < length) {
        const child1 = this.nodes[child1N];
        if (child1.f < element.f) swap = child1N;
      }
      if (child2N < length) {
        const child2 = this.nodes[child2N];
        if ((swap === null ? element.f : this.nodes[child1N].f) > child2.f) {
          swap = child2N;
        }
      }

      if (swap === null) break;
      this.nodes[n] = this.nodes[swap];
      this.nodes[swap] = element;
      n = swap;
    }
  }
}

export class EntityAI {
  /**
   * Updates all active monsters in the dungeon on a game simulation tick.
   * @param {Array<object>} monsters
   * @param {object} player
   * @param {import('./grid-map.js').GridMap} gridMap
   * @param {number} deltaSec
   * @returns {Array<object>}
   */
  static updateMonsters(monsters, player, gridMap, deltaSec) {
    const results = [];

    for (const monster of monsters) {
      if (monster.hp <= 0) continue;

      // Handle Stun status
      if (monster.stunTimer > 0) {
        monster.stunTimer = Math.max(0, monster.stunTimer - deltaSec);
        continue; // Stunned: skip movement and attack actions!
      }

      // Wind-up: a telegraphed attack holds the monster in place until the
      // timer elapses, then the catalog handler resolves the payload.
      if (monster.pendingAttack || monster.telegraphTimer > 0) {
        monster.telegraphTimer = Math.max(0, (monster.telegraphTimer || 0) - deltaSec);
        if (monster.telegraphTimer <= 0) {
          const action = EntityAI.resolvePendingAttack(monster, player, gridMap, monsters);
          if (action) results.push(action);
        }
        continue;
      }

      if (monster.attackCooldown > 0) {
        monster.attackCooldown = Math.max(0, monster.attackCooldown - deltaSec);
      }
      monster.moveCooldown = Math.max(0, (monster.moveCooldown || 0) - deltaSec);

      // If not yet aggroed, wander idly in darkness
      if (!monster.isAggroed) {
        if ((monster.moveCooldown || 0) <= 0) {
          monster.moveCooldown = 3.0 + Math.random() * 2.5;
          EntityAI.idleWander(monster, gridMap, monsters);
        }
        continue;
      }

      // Dispatch via AI_HANDLERS map driven by catalog metadata
      const mData = MONSTERS_CATALOG[monster.type] || (monster.type === 'boss_overlord' ? MONSTERS_CATALOG.abyssal_overlord : null);
      const aiType = mData?.aiType || 'chase';
      const handler = AI_HANDLERS[aiType] || AI_HANDLERS.chase;
      const action = handler(monster, player, gridMap, monsters, mData);
      if (action) results.push(action);
    }

    return results;
  }

  static idleWander(monster, gridMap, allMonsters) {
    if (Math.random() < 0.4) return;
    const directions = [
      { x: 0, y: -1, dir: 'up' },
      { x: 0, y: 1, dir: 'down' },
      { x: -1, y: 0, dir: 'left' },
      { x: 1, y: 0, dir: 'right' },
    ];
    const choice = directions[Math.floor(Math.random() * directions.length)];
    const nx = monster.x + choice.x;
    const ny = monster.y + choice.y;

    if (gridMap.isWalkable(nx, ny) && !allMonsters.some(m => m.id !== monster.id && m.hp > 0 && m.x === nx && m.y === ny)) {
      monster.facing = choice.dir;
      monster.x = nx;
      monster.y = ny;
    }
  }

  static updateMeleeMonster(monster, player, gridMap, allMonsters, minDmg, maxDmg, defaultMoveCadence) {
    const distManhattan = Math.abs(monster.x - player.x) + Math.abs(monster.y - player.y);

    // Adjacent -> Attack
    if (distManhattan === 1) {
      monster.facing = EntityAI.getFacing(monster.x, monster.y, player.x, player.y);
      if (monster.attackCooldown <= 0) {
        monster.attackCooldown = monster.attackCadence || 1.5;
        const damage = EntityAI.scaleDamage(
          monster,
          Math.floor(Math.random() * (maxDmg - minDmg + 1)) + minDmg
        );
        // LOK-12 damage-intercept seam: dodge / fortify / mitigation / bubble absorb.
        const hit = CombatSystem.applyIncomingDamage(player, damage, monster);
        let message;
        if (hit.deflected) {
          message = `Your Shock Shield deflects ${monster.name}! ${monster.name} is stunned for ${hit.attackerStunSec}s.`;
        } else if (hit.dodged) {
          message = `${monster.name} lunges at you, but you dodge it!`;
        } else {
          message = `${monster.name} attacks you for ${damage} physical damage!`;
        }
        return {
          damageToPlayer: hit.damageToPlayer,
          absorbed: hit.absorbed,
          dodged: hit.dodged,
          deflected: hit.deflected,
          attackerStunSec: hit.attackerStunSec,
          message,
          sourceMonster: monster,
        };
      }
      return null;
    }

    // Move towards player via A*
    if ((monster.moveCooldown || 0) <= 0) {
      monster.moveCooldown = (monster.moveCadence || defaultMoveCadence) + (Math.random() * 0.2 - 0.1);

      const nextStep = EntityAI.findNextStepAStar(
        { x: monster.x, y: monster.y },
        { x: player.x, y: player.y },
        gridMap,
        allMonsters.filter(m => m.id !== monster.id && m.hp > 0)
      );

      if (nextStep && (nextStep.x !== player.x || nextStep.y !== player.y)) {
        monster.facing = EntityAI.getFacing(monster.x, monster.y, nextStep.x, nextStep.y);
        monster.x = nextStep.x;
        monster.y = nextStep.y;
      }
    }

    return null;
  }

  static updateCultist(cultist, player, gridMap, allMonsters, mData = MONSTERS_CATALOG[cultist.type]) {
    const dist = Math.hypot(cultist.x - player.x, cultist.y - player.y);
    const hasLOS = LightingSystem.hasLineOfSight(gridMap, cultist.x, cultist.y, player.x, player.y);

    cultist.facing = EntityAI.getFacing(cultist.x, cultist.y, player.x, player.y);

    // 1. Attack if in range (<= 5) with LOS
    if (dist <= 5 && hasLOS && cultist.attackCooldown <= 0) {
      cultist.attackCooldown = cultist.attackCadence || 2.0;
      const minDmg = mData?.damageMin ?? 1;
      const maxDmg = mData?.damageMax ?? minDmg;
      const damage = EntityAI.scaleDamage(
        cultist,
        Math.floor(Math.random() * (maxDmg - minDmg + 1)) + minDmg
      );
      // LOK-12 damage-intercept seam: dodge / fortify / mitigation / bubble absorb.
      const hit = CombatSystem.applyIncomingDamage(player, damage, cultist);

      const projectile = {
        id: `proj_shadow_${Date.now()}_${Math.random()}`,
        type: 'shadow_bolt',
        sourceX: cultist.x,
        sourceY: cultist.y,
        targetX: player.x,
        targetY: player.y,
        currentX: cultist.x * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2,
        currentY: cultist.y * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2,
        durationMs: 300,
        elapsedMs: 0,
        color: '#9933ff',
      };

      const message = hit.deflected
        ? `Your Shock Shield deflects ${cultist.name}'s Shadow Bolt! ${cultist.name} is stunned for ${hit.attackerStunSec}s.`
        : hit.dodged
          ? `${cultist.name} hurls a Shadow Bolt at you, but you dodge it!`
          : `${cultist.name} casts Shadow Bolt at you for ${damage} dark damage!`;

      return {
        damageToPlayer: hit.damageToPlayer,
        absorbed: hit.absorbed,
        dodged: hit.dodged,
        deflected: hit.deflected,
        attackerStunSec: hit.attackerStunSec,
        message,
        projectiles: [projectile],
        sourceMonster: cultist,
      };
    }

    // 2. Reposition / Standoff management
    if ((cultist.moveCooldown || 0) <= 0) {
      cultist.moveCooldown = (cultist.moveCadence || mData?.moveCadence || 1.0) + (Math.random() * 0.3 - 0.1);

      const standoffMin = mData?.standoffMin ?? CONFIG.CULTIST_STANDOFF_MIN;
      const standoffMax = mData?.standoffMax ?? CONFIG.CULTIST_STANDOFF_MAX;

      if (dist < standoffMin) {
        const retreatStep = EntityAI.findRetreatStep(cultist, player, gridMap, allMonsters);
        if (retreatStep) {
          cultist.facing = EntityAI.getFacing(cultist.x, cultist.y, retreatStep.x, retreatStep.y);
          cultist.x = retreatStep.x;
          cultist.y = retreatStep.y;
        }
      } else if (dist > standoffMax) {
        const nextStep = EntityAI.findNextStepAStar(
          { x: cultist.x, y: cultist.y },
          { x: player.x, y: player.y },
          gridMap,
          allMonsters.filter(m => m.id !== cultist.id && m.hp > 0)
        );
        if (nextStep && (nextStep.x !== player.x || nextStep.y !== player.y)) {
          cultist.facing = EntityAI.getFacing(cultist.x, cultist.y, nextStep.x, nextStep.y);
          cultist.x = nextStep.x;
          cultist.y = nextStep.y;
        }
      }
    }

    return null;
  }

  /* ====================================================================== */
  /* Catalog-driven attack / ability framework (LIV-2)                       */
  /* ====================================================================== */

  /** Kinds with a registered attack handler; used by tests/catalog validation. */
  static ATTACK_KINDS = Object.keys(ATTACK_HANDLERS);

  /** Positioning personalities with a registered handler. */
  static AI_TYPES = Object.keys(AI_HANDLERS);

  static rollDamage(minDmg, maxDmg) {
    const lo = Math.min(minDmg, maxDmg);
    const hi = Math.max(minDmg, maxDmg);
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }

  /**
   * Applies a monster's floor damage multiplier (resolved by the floor
   * generator onto `damageScale`, the same `statScale.atk` used for
   * `monster.attack`) to a catalog-rolled damage value. Catalog
   * `damageMin`/`damageMax` stay floor-agnostic base values, mirroring
   * `baseHp`/`statScale.hp`. A missing scale means 1.0, so hand-built and
   * launch monsters are unchanged.
   */
  static scaleDamage(monster, damage) {
    const scale = monster && monster.damageScale;
    if (!scale || scale === 1) return damage;
    return Math.round(damage * scale);
  }

  /** Integer-keyed occupancy set (grid hashing, §3) for a monster list. */
  static occupiedHashSet(monsters, excludeId, width) {
    const set = new Set();
    for (let i = 0; i < monsters.length; i++) {
      const m = monsters[i];
      if (!m || m.hp <= 0) continue;
      if (excludeId && m.id === excludeId) continue;
      set.add(m.y * width + m.x);
    }
    return set;
  }

  /**
   * First catalog attack whose gates pass, or null. `kind` is the dispatch
   * key; an unknown kind falls back to `melee` per the golden rule.
   */
  static tryAttack(monster, player, gridMap, monsters, mData, dist, hasLOS) {
    const attacks = mData && mData.attacks;
    if (!attacks || attacks.length === 0) return null;
    if (monster.attackCooldown > 0) return null;

    for (let i = 0; i < attacks.length; i++) {
      const atk = attacks[i];
      const range = atk.range ?? 1;
      const minRange = atk.minRange ?? 1;
      if (dist > range + 0.001 || dist < minRange - 0.001) continue;
      if (atk.requiresLOS && !hasLOS) continue;
      const handler = ATTACK_HANDLERS[atk.kind] || ATTACK_HANDLERS.melee;
      const res = handler(monster, player, gridMap, monsters, mData, atk);
      if (res) return res;
    }
    return null;
  }

  /** Standoff-positioning personality for ranged/bomber/summoner opponents. */
  static updateCatalogCombatant(monster, player, gridMap, monsters, mData) {
    const dist = Math.hypot(player.x - monster.x, player.y - monster.y);
    const hasLOS = LightingSystem.hasLineOfSight(gridMap, monster.x, monster.y, player.x, player.y);
    monster.facing = EntityAI.getFacing(monster.x, monster.y, player.x, player.y);

    const attack = EntityAI.tryAttack(monster, player, gridMap, monsters, mData, dist, hasLOS);
    if (attack) return attack;

    if ((monster.moveCooldown || 0) > 0) return null;
    monster.moveCooldown = (monster.moveCadence || mData?.moveCadence || 1.0) + (Math.random() * 0.3 - 0.1);

    const standoffMin = mData?.standoffMin ?? 2;
    const standoffMax = mData?.standoffMax ?? 4;

    if (dist < standoffMin) {
      const retreatStep = EntityAI.findRetreatStep(monster, player, gridMap, monsters);
      if (retreatStep) {
        monster.facing = EntityAI.getFacing(monster.x, monster.y, retreatStep.x, retreatStep.y);
        monster.x = retreatStep.x;
        monster.y = retreatStep.y;
      }
    } else if (dist > standoffMax) {
      const nextStep = EntityAI.findNextStepAStar(
        { x: monster.x, y: monster.y },
        { x: player.x, y: player.y },
        gridMap,
        monsters
      );
      if (nextStep && (nextStep.x !== player.x || nextStep.y !== player.y)) {
        monster.facing = EntityAI.getFacing(monster.x, monster.y, nextStep.x, nextStep.y);
        monster.x = nextStep.x;
        monster.y = nextStep.y;
      }
    }
    return null;
  }

  /** Chase-positioning personality for dash/charge opponents (no retreat). */
  static updateCharger(monster, player, gridMap, monsters, mData) {
    const dist = Math.hypot(player.x - monster.x, player.y - monster.y);
    const hasLOS = LightingSystem.hasLineOfSight(gridMap, monster.x, monster.y, player.x, player.y);
    monster.facing = EntityAI.getFacing(monster.x, monster.y, player.x, player.y);

    const attack = EntityAI.tryAttack(monster, player, gridMap, monsters, mData, dist, hasLOS);
    if (attack) return attack;

    if ((monster.moveCooldown || 0) > 0) return null;
    monster.moveCooldown = (monster.moveCadence || mData?.moveCadence || 1.0) + (Math.random() * 0.2 - 0.1);

    const nextStep = EntityAI.findNextStepAStar(
      { x: monster.x, y: monster.y },
      { x: player.x, y: player.y },
      gridMap,
      monsters
    );
    if (nextStep && (nextStep.x !== player.x || nextStep.y !== player.y)) {
      monster.facing = EntityAI.getFacing(monster.x, monster.y, nextStep.x, nextStep.y);
      monster.x = nextStep.x;
      monster.y = nextStep.y;
    }
    return null;
  }

  /** Builds the shared action result from a damage-intercept seam result. */
  static buildHitResult(hit, monster, damage, atk, mData, extras) {
    const label = atk?.label || 'attack';
    const damageType = atk?.damageType || mData?.damageType || 'physical';
    let message;
    if (hit.deflected) {
      message = `Your Shock Shield deflects ${monster.name}'s ${label}! ${monster.name} is stunned for ${hit.attackerStunSec}s.`;
    } else if (hit.dodged) {
      message = `${monster.name} uses ${label}, but you dodge it!`;
    } else {
      message = `${monster.name} hits you with ${label} for ${damage} ${damageType} damage!`;
    }

    const result = {
      damageToPlayer: hit.damageToPlayer,
      absorbed: hit.absorbed,
      dodged: hit.dodged,
      deflected: hit.deflected,
      attackerStunSec: hit.attackerStunSec,
      message,
      sourceMonster: monster,
    };
    if (extras && extras.projectiles) result.projectiles = extras.projectiles;
    // Status only lands when the blow actually connected.
    if (!hit.dodged && !hit.deflected && atk?.onHit) result.statusEffects = [atk.onHit];
    return result;
  }

  static executeMeleeAttack(monster, player, mData, atk) {
    if (monster.attackCooldown > 0) return null;
    monster.attackCooldown = atk.cooldownSec || monster.attackCadence || 1.5;
    const minDmg = atk.damageMin ?? mData?.damageMin ?? 1;
    const maxDmg = atk.damageMax ?? mData?.damageMax ?? minDmg;
    const damage = EntityAI.scaleDamage(monster, EntityAI.rollDamage(minDmg, maxDmg));
    const hit = CombatSystem.applyIncomingDamage(player, damage, monster);
    return EntityAI.buildHitResult(hit, monster, damage, atk, mData);
  }

  static executeProjectileAttack(monster, player, mData, atk) {
    if (monster.attackCooldown > 0) return null;
    monster.attackCooldown = atk.cooldownSec || monster.attackCadence || 2;
    const minDmg = atk.damageMin ?? mData?.damageMin ?? 1;
    const maxDmg = atk.damageMax ?? mData?.damageMax ?? minDmg;
    const damage = EntityAI.scaleDamage(monster, EntityAI.rollDamage(minDmg, maxDmg));
    const hit = CombatSystem.applyIncomingDamage(player, damage, monster);
    const spec = atk.projectile || {};
    const projectile = {
      id: `proj_${spec.type || atk.key || 'bolt'}_${monster.id}_${Math.random()}`,
      type: spec.type || 'monster_bolt',
      renderKey: spec.renderKey || spec.type || null,
      sourceX: monster.x,
      sourceY: monster.y,
      targetX: player.x,
      targetY: player.y,
      currentX: monster.x * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2,
      currentY: monster.y * CONFIG.GRID_SIZE + CONFIG.GRID_SIZE / 2,
      durationMs: spec.durationMs || 300,
      elapsedMs: 0,
      color: spec.color || '#9933ff',
      visual: spec.visual || null,
    };
    return EntityAI.buildHitResult(hit, monster, damage, atk, mData, { projectiles: [projectile] });
  }

  static executeAoeAttack(monster, player, gridMap, monsters, mData, atk) {
    if (monster.attackCooldown > 0) return null;
    if ((atk.telegraphSec || 0) > 0) return EntityAI.beginTelegraph(monster, player, atk);
    return EntityAI.resolveAoeAttack(monster, player, gridMap, monsters, atk, player.x, player.y);
  }

  static executeDashAttack(monster, player, gridMap, monsters, mData, atk) {
    if (monster.attackCooldown > 0) return null;
    if ((atk.telegraphSec || 0) > 0) return EntityAI.beginTelegraph(monster, player, atk);
    return EntityAI.resolveDashAttack(monster, player, gridMap, monsters, atk);
  }

  static beginTelegraph(monster, player, atk) {
    monster.attackCooldown = atk.cooldownSec || monster.attackCadence || 3;
    monster.pendingAttack = { kind: atk.kind, atk, targetX: player.x, targetY: player.y };
    monster.telegraphTimer = atk.telegraphSec;
    return {
      sourceMonster: monster,
      telegraph: true,
      projectiles: [{
        id: `telegraph_${monster.id}`,
        type: 'telegraph',
        x: player.x,
        y: player.y,
        radius: atk.radius ?? 1,
        color: atk.telegraphColor || atk.projectile?.color || '#ef4444',
        durationMs: Math.max(1, Math.round(atk.telegraphSec * 1000)),
        elapsedMs: 0,
      }],
    };
  }

  static resolvePendingAttack(monster, player, gridMap, monsters) {
    const pending = monster.pendingAttack;
    monster.pendingAttack = null;
    monster.telegraphTimer = 0;
    if (!pending) return null;
    const resolver = TELEGRAPH_RESOLVERS[pending.kind];
    if (!resolver) return null;
    return resolver(monster, player, gridMap, monsters, pending.atk, pending.targetX, pending.targetY);
  }

  static resolveAoeAttack(monster, player, gridMap, monsters, atk, targetX, targetY) {
    if (!(monster.attackCooldown > 0)) {
      monster.attackCooldown = atk.cooldownSec || monster.attackCadence || 3;
    }
    const tx = targetX ?? player.x;
    const ty = targetY ?? player.y;
    const radius = atk.radius ?? 1;
    const label = atk.label || 'blast';
    const burst = {
      id: `aoe_${monster.id}_${Date.now()}`,
      type: 'aoe_burst',
      x: tx,
      y: ty,
      radius,
      color: atk.projectile?.color || '#ef4444',
      durationMs: atk.burstDurationMs || 320,
      elapsedMs: 0,
    };

    const dist = Math.hypot(player.x - tx, player.y - ty);
    if (dist > radius + 0.5) {
      return {
        message: `${monster.name}'s ${label} erupts, but you are clear of the blast!`,
        projectiles: [burst],
        sourceMonster: monster,
      };
    }

    const minDmg = atk.damageMin ?? 1;
    const maxDmg = atk.damageMax ?? minDmg;
    const damage = EntityAI.scaleDamage(monster, EntityAI.rollDamage(minDmg, maxDmg));
    const hit = CombatSystem.applyIncomingDamage(player, damage, monster);
    return EntityAI.buildHitResult(hit, monster, damage, atk, null, { projectiles: [burst] });
  }

  static resolveDashAttack(monster, player, gridMap, monsters, atk) {
    if (!(monster.attackCooldown > 0)) {
      monster.attackCooldown = atk.cooldownSec || monster.attackCadence || 3;
    }
    const dashTiles = atk.dashTiles || 2;
    const startX = monster.x;
    const startY = monster.y;
    // Monsters move cardinally: dash along the dominant axis toward the player.
    const useX = Math.abs(player.x - monster.x) >= Math.abs(player.y - monster.y);
    const moveX = useX ? Math.sign(player.x - monster.x) : 0;
    const moveY = useX ? 0 : Math.sign(player.y - monster.y);
    const blocked = EntityAI.occupiedHashSet(monsters, monster.id, gridMap.width);
    let moved = 0;

    for (let s = 0; s < dashTiles; s++) {
      const nx = monster.x + moveX;
      const ny = monster.y + moveY;
      if (!gridMap.isWalkable(nx, ny)) break;
      if (nx === player.x && ny === player.y) break;
      if (blocked.has(ny * gridMap.width + nx)) break;
      monster.x = nx;
      monster.y = ny;
      moved += 1;
    }
    monster.facing = EntityAI.getFacing(monster.x, monster.y, player.x, player.y);

    const label = atk.label || 'charge';
    const dashFx = {
      id: `dash_${monster.id}_${Date.now()}`,
      type: 'dash_trail',
      sourceX: startX,
      sourceY: startY,
      targetX: monster.x,
      targetY: monster.y,
      color: atk.projectile?.color || '#f97316',
      durationMs: atk.burstDurationMs || 260,
      elapsedMs: 0,
    };

    const adjacent = Math.abs(monster.x - player.x) + Math.abs(monster.y - player.y) <= 1;
    if (!adjacent) {
      return {
        message: `${monster.name} ${label}s toward you!`,
        projectiles: [dashFx],
        sourceMonster: monster,
      };
    }

    const minDmg = atk.damageMin ?? 1;
    const maxDmg = atk.damageMax ?? minDmg;
    const damage = EntityAI.scaleDamage(monster, EntityAI.rollDamage(minDmg, maxDmg));
    const hit = CombatSystem.applyIncomingDamage(player, damage, monster);
    const result = EntityAI.buildHitResult(hit, monster, damage, atk, null, { projectiles: [dashFx] });
    result.dashMoved = moved;
    return result;
  }

  static executeSummonAttack(monster, player, gridMap, monsters, atk) {
    if (monster.attackCooldown > 0) return null;
    const spec = atk.summon;
    if (!spec || !spec.type || !MONSTERS_CATALOG[spec.type]) return null;

    const maxActive = spec.maxActive ?? 3;
    let active = 0;
    for (let i = 0; i < monsters.length; i++) {
      const m = monsters[i];
      if (m && m.hp > 0 && m.type === spec.type && m.summonedBy === monster.id) active += 1;
    }
    if (active >= maxActive) return null;

    const spawn = EntityAI.createSummon(monster, spec.type, gridMap, monsters, player);
    if (!spawn) return null;
    monster.attackCooldown = atk.cooldownSec || 6;
    return {
      sourceMonster: monster,
      message: `${monster.name} summons ${spawn.name}!`,
      spawns: [spawn],
    };
  }

  static createSummon(source, type, gridMap, monsters, player) {
    const base = MONSTERS_CATALOG[type];
    if (!base) return null;
    const blocked = EntityAI.occupiedHashSet(monsters, null, gridMap.width);
    let sx = -1;
    let sy = -1;
    for (let i = 0; i < SUMMON_OFFSETS.length; i++) {
      const nx = source.x + SUMMON_OFFSETS[i][0];
      const ny = source.y + SUMMON_OFFSETS[i][1];
      if (nx === player.x && ny === player.y) continue;
      if (!gridMap.isWalkable(nx, ny)) continue;
      if (blocked.has(ny * gridMap.width + nx)) continue;
      sx = nx;
      sy = ny;
      break;
    }
    if (sx < 0) return null;

    source.summonCount = (source.summonCount || 0) + 1;
    const hp = base.baseHp;
    return {
      id: `${source.id}_summon_${source.summonCount}`,
      type,
      name: base.name,
      faction: base.faction || MONSTER_FACTION,
      room: source.room,
      x: sx,
      y: sy,
      hp,
      max_hp: hp,
      attack: base.baseAttack,
      damageScale: source.damageScale ?? 1,
      defense: base.baseDefense,
      facing: 'down',
      isAggroed: true,
      attackCooldown: base.attackCadence || 1.5,
      moveCooldown: 0,
      attackCadence: base.attackCadence,
      moveCadence: base.moveCadence,
      visible: true,
      isSummon: true,
      summonedBy: source.id,
      holdsKey: null,
    };
  }

  static findRetreatStep(monster, player, gridMap, allMonsters) {
    const directions = [
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ];

    let bestStep = null;
    let maxDist = Math.hypot(monster.x - player.x, monster.y - player.y);

    for (const dir of directions) {
      const nx = monster.x + dir.x;
      const ny = monster.y + dir.y;

      if (!gridMap.isWalkable(nx, ny)) continue;
      if (nx === player.x && ny === player.y) continue;
      if (allMonsters.some(m => m.id !== monster.id && m.hp > 0 && m.x === nx && m.y === ny)) continue;

      const d = Math.hypot(nx - player.x, ny - player.y);
      if (d > maxDist) {
        maxDist = d;
        bestStep = { x: nx, y: ny };
      }
    }

    return bestStep;
  }

  static findNextStepAStar(start, goal, gridMap, otherMonsters = []) {
    const width = gridMap.width;
    const toHash = (x, y) => y * width + x;

    const blockedMonsterSet = new Set();
    for (let i = 0; i < otherMonsters.length; i++) {
      const m = otherMonsters[i];
      if (m) blockedMonsterSet.add(toHash(m.x, m.y));
    }

    const openHeap = new MinHeap();
    const openMap = new Map();
    const closedSet = new Set();

    const startHash = toHash(start.x, start.y);
    const startH = Math.abs(start.x - goal.x) + Math.abs(start.y - goal.y);
    const startNode = {
      x: start.x,
      y: start.y,
      g: 0,
      h: startH,
      f: startH,
      parent: null,
    };

    openHeap.push(startNode);
    openMap.set(startHash, startNode);

    const goalHash = toHash(goal.x, goal.y);

    while (openHeap.size > 0) {
      const current = openHeap.pop();
      const currentHash = toHash(current.x, current.y);
      openMap.delete(currentHash);
      closedSet.add(currentHash);

      if (current.x === goal.x && current.y === goal.y) {
        return EntityAI.reconstructFirstStep(current);
      }

      const neighbors = [
        { x: current.x, y: current.y - 1 },
        { x: current.x, y: current.y + 1 },
        { x: current.x - 1, y: current.y },
        { x: current.x + 1, y: current.y },
      ];

      for (let i = 0; i < 4; i++) {
        const nx = neighbors[i].x;
        const ny = neighbors[i].y;

        if (!gridMap.isInBounds(nx, ny)) continue;
        const nHash = toHash(nx, ny);
        if (closedSet.has(nHash)) continue;

        if (nHash !== goalHash) {
          if (!gridMap.isWalkable(nx, ny) || blockedMonsterSet.has(nHash)) continue;
        }

        const gScore = current.g + 1;
        let neighborNode = openMap.get(nHash);

        if (!neighborNode) {
          const hScore = Math.abs(nx - goal.x) + Math.abs(ny - goal.y);
          neighborNode = {
            x: nx,
            y: ny,
            g: gScore,
            h: hScore,
            f: gScore + hScore,
            parent: current,
          };
          openHeap.push(neighborNode);
          openMap.set(nHash, neighborNode);
        } else if (gScore < neighborNode.g) {
          neighborNode.g = gScore;
          neighborNode.f = gScore + neighborNode.h;
          neighborNode.parent = current;
          openHeap.updateItem(neighborNode);
        }
      }
    }

    return null;
  }

  static reconstructFirstStep(node) {
    let curr = node;
    while (curr.parent && curr.parent.parent) {
      curr = curr.parent;
    }
    return { x: curr.x, y: curr.y };
  }

  static getFacing(fromX, fromY, toX, toY) {
    if (toX > fromX) return 'right';
    if (toX < fromX) return 'left';
    if (toY > fromY) return 'down';
    return 'up';
  }
}
