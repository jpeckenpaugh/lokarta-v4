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
} from '../engine/index.js';
import {
  firstMonsterOnSegment,
  monstersCaughtByBeam,
} from '../engine/projectile-collision.js';
import { soundFX } from '../audio/index.js';
import { KEYBINDINGS_CATALOG, UI_CATALOG } from '../data/index.js';
import { setAnimState, advanceAnim } from './animation-state.js';

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

    // Healing spring: while the player stands on a square
    // adjacent to a fountain, restore +5 HP and +5 MP each second (capped).
    if (this.findAdjacentSpring()) {
      this.springRegenAccumulator += deltaSec;
      if (this.springRegenAccumulator >= 1) {
        this.springRegenAccumulator -= Math.floor(this.springRegenAccumulator);
        const springRestored = EconomySystem.applySpringRegen(this.player);
        if (springRestored.hp > 0) this.addFloatingText(`+${springRestored.hp} HP`, this.player.x, this.player.y, '#22c55e');
        if (springRestored.mp > 0) this.addFloatingText(`+${springRestored.mp} MP`, this.player.x, this.player.y, '#3b82f6');
        if (springRestored.hp > 0 || springRestored.mp > 0) {
          soundFX.play('holyChime');
          this.updateHUD();
        }
      }
    } else {
      this.springRegenAccumulator = 0;
    }

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
      const rank = Math.min(5, Math.max(1, equippedArmor.itemLevel || 1));
      const intervalSec = Math.max(12, 22 - 2 * rank); // Rank 1: 20s, Rank 2: 18s, Rank 3: 16s, Rank 4: 14s, Rank 5: 12s

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

    // 3. Update lighting
    LightingSystem.updateLighting(this.gridMap, this.player, this.ambientLights, this.monsters);

    // 4. Update monster AI
    const positionsBefore = this.monsters.map(m => ({ m, x: m.x, y: m.y }));
    const aiResults = EntityAI.updateMonsters(this.monsters, this.player, this.gridMap, deltaSec);
    for (const res of aiResults) {
      if (res.message) this.logCombat(res.message, 'combat');
      if (res.projectiles) this.projectiles.push(...res.projectiles);
      if (res.sourceMonster && (res.dodged || (res.damageToPlayer && res.damageToPlayer > 0) || (res.absorbed && res.absorbed > 0))) {
        setAnimState(res.sourceMonster, 'attack', this.nowMs());
      }
      if (res.deflected) {
        soundFX.play('lightSpell');
        this.addFloatingText('DEFLECTED!', this.player.x, this.player.y, '#38bdf8');
      } else if (res.dodged) {
        soundFX.play('monsterAttack');
        this.addFloatingText('DODGE!', this.player.x, this.player.y, '#22c55e');
      } else if (res.damageToPlayer && res.damageToPlayer > 0) {
        soundFX.play('monsterAttack');
        soundFX.play('playerHurt');
        setAnimState(this.player, 'hit', this.nowMs());
        this.addFloatingText(`-${res.damageToPlayer}`, this.player.x, this.player.y, '#ef4444');
        if (res.absorbed && res.absorbed > 0) {
          this.logCombat(`Your holy shield absorbed ${res.absorbed} of the blow.`, 'spell');
        }
      } else if (res.absorbed && res.absorbed > 0) {
        // Hit fully absorbed by the bubble — no HP lost.
        soundFX.play('monsterAttack');
        this.addFloatingText(`shield -${res.absorbed}`, this.player.x, this.player.y, '#38bdf8');
      }
    }
    // Walk cycles advance once per tile step (event-driven, not on a timer).
    for (const { m, x, y } of positionsBefore) {
      if (m.hp <= 0) continue;
      if (m.x !== x || m.y !== y) setAnimState(m, 'walk');
      else if (m.anim && m.anim.state === 'walk') setAnimState(m, 'idle');
    }

    // 5. Defeat check
    if (this.player.hp <= 0 && !this.isGameOver) {
      this.isGameOver = true;
      this.logCombat('You have fallen in the tower! Darkness consumes you...', 'warning');
      this.onPlayerDeath();
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
  render() {
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
      this.props
    );
  },
  processMovementInput() {
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

    if (dx !== 0 || dy !== 0) {
      this.player.facing = newFacing;
      const targetX = this.player.x + dx;
      const targetY = this.player.y + dy;

      // Walking into a shut gated door is the open trigger: the closed
      // gate is not walkable, so collision — not standing on it — must spend the
      // earned key. If it opens, step through in the same input.
      const targetTile = this.gridMap.getTile(targetX, targetY);
      const isShutGate = targetTile && targetTile.type === TILE_TYPES.GATED_DOOR && !targetTile.gateOpen;
      if (isShutGate && this.openDoorUnderPlayer(targetX, targetY)) {
        // Door just opened — allow the step-through this turn.
      }

      if (this.gridMap.isWalkable(targetX, targetY)) {
        const monsterAtTarget = this.monsters.find(m => m.x === targetX && m.y === targetY && m.hp > 0);
        if (monsterAtTarget) {
          this.selectedMonsterId = monsterAtTarget.id;
          this.logCombat(`Target locked on ${monsterAtTarget.name} (${monsterAtTarget.hp}/${monsterAtTarget.max_hp} HP).`, 'system');
        } else {
          this.player.x = targetX;
          this.player.y = targetY;
          soundFX.play('footstep');
          setAnimState(this.player, 'walk');

          // Frictionless walkover auto-pickup
          const items = this.gridMap.getItems(this.player.x, this.player.y);
          if (items.length > 0) {
            this.handlePickUp();
          }

          // Walk-on chest open (E4): chests are world entities, not tile items.
          // Opening also collects the contents in the same turn.
          if (ChestSystem.findChestAt(this.chests, this.player.x, this.player.y)) {
            this.handleOpenChest(this.player.x, this.player.y);
          }

          // Healing springs are impassable fountains; their
          // effect is applied per-second from an adjacent square in tick().

          // Walk-on Tower Gate: step back to the Town.
          if (this.gridMap.isTownGate(this.player.x, this.player.y)) {
            this.handleTownGate(this.player.x, this.player.y);
            return;
          }
        }
      }
    } else if (this.player) {
      setAnimState(this.player, 'idle');
    }
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
            carriedIds
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
        (x, y) => this.gridMap.isWall(x, y)
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
