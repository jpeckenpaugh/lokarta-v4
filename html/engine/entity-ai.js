/**
 * Lokarta: Come Into The Light - Entity AI & Pathfinding Subsystem
 */

import { CONFIG } from './config.js';
import { LightingSystem } from './lighting-system.js';
import { MONSTERS_CATALOG } from '../data/index.js';
import { CombatSystem } from './combat-system.js';

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
};

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
        const damage = Math.floor(Math.random() * (maxDmg - minDmg + 1)) + minDmg;
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
      const damage = Math.floor(Math.random() * (maxDmg - minDmg + 1)) + minDmg;
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
