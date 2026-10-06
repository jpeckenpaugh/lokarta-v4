/**
 * Lokarta: Come Into The Light - Party Auto-AI
 *
 * Pure, browser-free decision engine for non-active party members introduced by
 * LIV-13 (WS4 of Dev Sprint 001). Each tick the app hands this module the live
 * party, monster list and grid; it returns one intent event per auto ally:
 *
 *   - `ability`: a career ability from the member's `party_ai.json` profile was
 *     cast through the actor-generalized `CombatSystem` (per-member cooldowns and
 *     mana, friendly-fire safe).
 *   - `move`: the member stepped one tile (A* on the shared binary MinHeap).
 *   - `idle`: nothing to do this tick.
 *
 * Design rules (docs/engineering/agents.md):
 *   - No vocation/ability names are hardcoded: profiles come from
 *     `party_ai.json` and abilities from `abilities.json`; the only dispatch key
 *     is the declared `actionKey`.
 *   - Unknown abilities / actionKeys are skipped, never guessed.
 *   - No DOM, worker, storage or timers. A* and LOS helpers are reused from the
 *     existing engine so nothing new is allocated on the render path.
 */

import { ABILITIES_CATALOG, PARTY_AI_CATALOG } from '../data/index.js';
import { CombatSystem } from './combat-system.js';
import { EntityAI } from './entity-ai.js';
import { LightingSystem } from './lighting-system.js';
import { isHostile, sameActor } from './faction.js';

/** Safe baseline profile when a vocation has no authored entry. */
export const DEFAULT_AI_PROFILE = Object.freeze({
  preferredAbilities: [],
  followDistance: 2,
  engageRadius: 5,
  castRange: 4,
  retreatHpPct: 0.25,
  retargetSec: 1.5,
  healAlliesWhenHurt: false,
});

/**
 * Resolved auto-AI profile for a vocation. Missing vocations fall back to the
 * catalog `default` overlaid on `DEFAULT_AI_PROFILE`.
 * @param {string} vocation
 * @returns {object}
 */
export function profileForVocation(vocation) {
  const base = { ...DEFAULT_AI_PROFILE, ...(PARTY_AI_CATALOG && PARTY_AI_CATALOG.default ? PARTY_AI_CATALOG.default : {}) };
  const key = String(vocation || '').toLowerCase();
  const profile = PARTY_AI_CATALOG && PARTY_AI_CATALOG.profiles ? PARTY_AI_CATALOG.profiles[key] : null;
  return profile ? { ...base, ...profile } : base;
}

/**
 * Ability dispatch table keyed by the catalog-declared `actionKey`. A new
 * auto-castable ability needs an `abilities.json` entry plus (when it needs a
 * new combat seam) a handler here; an ability with no handler is skipped.
 *
 * `line` marks a straight-line attack (Beam) that only pays off when the target
 * is roughly cardinal-aligned. `heal` marks an ally-aware support cast.
 */
const ABILITY_HANDLERS = {
  wand_spark: {
    execute: (actor, target, ctx) => CombatSystem.executeWandSpark(actor, target, ctx.gridMap),
  },
  energy_beam: {
    line: true,
    execute: (actor, target, ctx) => {
      const facing = target ? EntityAI.getFacing(actor.x, actor.y, target.x, target.y) : actor.facing;
      actor.facing = facing;
      return CombatSystem.executeEnergyBeam(actor, facing, ctx.gridMap, ctx.monsters);
    },
  },
  bow_shot: {
    execute: (actor, target, ctx) =>
      CombatSystem.executeBowShot(actor, target, ctx.gridMap, null, { freeAmmo: true }),
  },
  power_shot: {
    execute: (actor, target, ctx) =>
      CombatSystem.executePowerShot(actor, target, ctx.gridMap, null, { freeAmmo: true }),
  },
  slash: {
    execute: (actor, target, ctx) =>
      CombatSystem.executeSlash(actor, target, ctx.gridMap, {
        monsters: ctx.monsters,
        facing: actor.facing,
      }),
  },
  cleave: {
    execute: (actor, target, ctx) => CombatSystem.executeCleave(actor, ctx.gridMap, ctx.monsters),
  },
  holy_strike: {
    execute: (actor, target, ctx) =>
      CombatSystem.executeHolyStrike(actor, target, ctx.gridMap, {
        monsters: ctx.monsters,
        facing: actor.facing,
      }),
  },
  healing_prayer: {
    heal: true,
    execute: (actor, target, ctx) => CombatSystem.executeHealingPrayer(actor, ctx.allies),
  },
};

/** Resolve a catalog ability to a ready spec + handler, or null when unsupported. */
function resolveAbility(abilityId) {
  const spec = ABILITIES_CATALOG[abilityId];
  if (!spec || !spec.actionKey) return null;
  const handler = ABILITY_HANDLERS[spec.actionKey];
  if (!handler) return null;
  return { spec, handler };
}

function missingHpFraction(actor) {
  if (!actor || !(actor.max_hp > 0) || typeof actor.hp !== 'number') return 0;
  const missing = actor.max_hp - actor.hp;
  return missing > 0 ? missing / actor.max_hp : 0;
}

/** True when the ability's gates (cooldown/mana/range/LOS/line) all pass. */
function isAbilityReady(actor, profile, spec, handler, target, dist, ctx) {
  if (((actor.cooldowns && actor.cooldowns[spec.actionKey]) || 0) > 0) return false;
  if (Number(spec.manaCost || 0) > Number(actor.mana || 0)) return false;

  if (spec.type === 'heal') {
    if (profile.healAlliesWhenHurt !== true) return false;
    const radius = Number(spec.healRadius) || 0;
    return Boolean(CombatSystem.selectHealTarget(actor, ctx.allies, radius));
  }

  if (!target) return false;
  const range = Number(spec.range) || 1;
  if (dist > range + 0.5) return false;
  const minRange = Number(spec.minRange) || 0;
  if (dist < minRange - 0.5) return false;
  if (!LightingSystem.hasLineOfSight(ctx.gridMap, actor.x, actor.y, target.x, target.y)) return false;

  // Beam is a line: only commit when the target is roughly on-axis.
  if (handler.line) {
    const dx = Math.abs(target.x - actor.x);
    const dy = Math.abs(target.y - actor.y);
    const offAxis = Math.min(dx, dy);
    const onAxis = Math.max(dx, dy) || 1;
    if (offAxis > 0 && offAxis / onAxis > 0.5) return false;
  }
  return true;
}

/** First ready ability in the profile's declared preference order, or null. */
function pickAbility(actor, profile, target, dist, ctx) {
  const ids = Array.isArray(profile.preferredAbilities) ? profile.preferredAbilities : [];
  for (let i = 0; i < ids.length; i++) {
    const resolved = resolveAbility(ids[i]);
    if (!resolved) continue;
    if (isAbilityReady(actor, profile, resolved.spec, resolved.handler, target, dist, ctx)) {
      return resolved;
    }
  }
  return null;
}

/** Closest visible hostile within `radius` with line of sight, or null. */
function nearestHostile(actor, ctx, radius) {
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  const monsters = ctx.monsters;
  for (let i = 0; i < monsters.length; i++) {
    const m = monsters[i];
    if (!m || m.hp <= 0 || m.visible === false) continue;
    if (!isHostile(actor, m)) continue;
    const d = Math.hypot(m.x - actor.x, m.y - actor.y);
    if (d > radius || d >= bestDist) continue;
    if (!LightingSystem.hasLineOfSight(ctx.gridMap, actor.x, actor.y, m.x, m.y)) continue;
    best = m;
    bestDist = d;
  }
  return best;
}

/**
 * Acquires/keeps an engagement target. A committed target (still alive and in
 * leash range) is held until `retargetSec` expires so allies do not thrash.
 */
function acquireTarget(actor, profile, ctx) {
  if (actor.aiRetargetTimer > 0) {
    actor.aiRetargetTimer = Math.max(0, actor.aiRetargetTimer - ctx.deltaSec);
  }
  const committed = actor.aiTargetId
    ? ctx.monsters.find((m) => m && m.id === actor.aiTargetId && m.hp > 0)
    : null;
  const leash = (Number(profile.engageRadius) || DEFAULT_AI_PROFILE.engageRadius) * 1.5;
  if (committed && actor.aiRetargetTimer > 0 && Math.hypot(committed.x - actor.x, committed.y - actor.y) <= leash) {
    return committed;
  }
  const next = nearestHostile(actor, ctx, Number(profile.engageRadius) || DEFAULT_AI_PROFILE.engageRadius);
  if (next) {
    actor.aiTargetId = next.id;
    actor.aiRetargetTimer = Number(profile.retargetSec) || DEFAULT_AI_PROFILE.retargetSec;
    return next;
  }
  actor.aiTargetId = null;
  actor.aiRetargetTimer = 0;
  return null;
}

/** True when any living actor (monster/ally) other than `self` stands on the tile. */
function isTileOccupied(ctx, x, y, self) {
  const monsters = ctx.monsters;
  for (let i = 0; i < monsters.length; i++) {
    const m = monsters[i];
    if (m && m.hp > 0 && m.x === x && m.y === y) return true;
  }
  const allies = ctx.allies;
  for (let i = 0; i < allies.length; i++) {
    const a = allies[i];
    if (a && a !== self && a.hp > 0 && !sameActor(a, self) && a.x === x && a.y === y) return true;
  }
  return false;
}

/** Living actors an ally must not path through or stand on (excludes `self`). */
function blockersFor(self, ctx) {
  const blockers = [];
  for (let i = 0; i < ctx.monsters.length; i++) {
    const m = ctx.monsters[i];
    if (m && m.hp > 0) blockers.push(m);
  }
  for (let i = 0; i < ctx.allies.length; i++) {
    const a = ctx.allies[i];
    if (a && a !== self && a.hp > 0 && !sameActor(a, self)) blockers.push(a);
  }
  return blockers;
}

/** One A* step toward (targetX, targetY), or null when blocked/adjacent. */
function stepToward(member, targetX, targetY, ctx) {
  const next = EntityAI.findNextStepAStar(
    { x: member.x, y: member.y },
    { x: targetX, y: targetY },
    ctx.gridMap,
    blockersFor(member, ctx)
  );
  if (!next || (next.x === member.x && next.y === member.y)) return null;
  if (!ctx.gridMap.isWalkable(next.x, next.y)) return null;
  if (isTileOccupied(ctx, next.x, next.y, member)) return null;
  return next;
}

/** One walkable step that increases distance from `threat`, or null. */
function stepAwayFrom(member, threat, ctx) {
  let best = null;
  let bestDist = Math.hypot(member.x - threat.x, member.y - threat.y);
  const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  for (let i = 0; i < dirs.length; i++) {
    const nx = member.x + dirs[i][0];
    const ny = member.y + dirs[i][1];
    if (!ctx.gridMap.isWalkable(nx, ny)) continue;
    if (isTileOccupied(ctx, nx, ny, member)) continue;
    const d = Math.hypot(nx - threat.x, ny - threat.y);
    if (d > bestDist + 0.001) {
      bestDist = d;
      best = { x: nx, y: ny };
    }
  }
  return best;
}

function applyStep(member, step) {
  member.facing = EntityAI.getFacing(member.x, member.y, step.x, step.y);
  member.x = step.x;
  member.y = step.y;
}

function moveEvent(member, fromX, fromY) {
  return { member, type: 'move', from: { x: fromX, y: fromY }, to: { x: member.x, y: member.y } };
}

function idleEvent(member) {
  return { member, type: 'idle' };
}

/** Decide + apply one auto member's action for this tick. */
function updateMember(member, ctx) {
  const profile = profileForVocation(member.vocation);
  const target = acquireTarget(member, profile, ctx);
  const distToTarget = target ? Math.hypot(target.x - member.x, target.y - member.y) : Number.POSITIVE_INFINITY;

  // 1. Disengage when badly hurt while threatened.
  if (target && Number(profile.retreatHpPct) > 0 && missingHpFraction(member) >= Number(profile.retreatHpPct)) {
    const step = stepAwayFrom(member, target, ctx);
    if (step) {
      const fromX = member.x;
      const fromY = member.y;
      applyStep(member, step);
      return moveEvent(member, fromX, fromY);
    }
    return idleEvent(member);
  }

  // 2. Cast the first ready ability (heals included); per-actor gated.
  const ability = pickAbility(member, profile, target, distToTarget, ctx);
  if (ability) {
    const result = ability.handler.execute(member, target, ctx);
    if (result && result.success) {
      return {
        member,
        type: 'ability',
        abilityId: ability.spec.id,
        actionKey: ability.spec.actionKey,
        target: target || null,
        result,
      };
    }
  }

  // 3. Close to preferred combat distance while engaged.
  if (target) {
    const castRange = Math.max(1, Number(profile.castRange) || 1);
    if (distToTarget > castRange + 0.5) {
      const step = stepToward(member, target.x, target.y, ctx);
      if (step) {
        const fromX = member.x;
        const fromY = member.y;
        applyStep(member, step);
        return moveEvent(member, fromX, fromY);
      }
    }
    return idleEvent(member);
  }

  // 4. Follow the active member at formation distance.
  const active = ctx.active;
  if (active && !sameActor(active, member)) {
    const followDistance = Math.max(1, Number(profile.followDistance) || 1);
    const d = Math.hypot(active.x - member.x, active.y - member.y);
    if (d > followDistance + 0.001) {
      const step = stepToward(member, active.x, active.y, ctx);
      if (step) {
        const fromX = member.x;
        const fromY = member.y;
        applyStep(member, step);
        return moveEvent(member, fromX, fromY);
      }
    }
  }
  return idleEvent(member);
}

export class PartyAI {
  /** Living, non-active, auto-mode members (the allies this module drives). */
  static inactiveMembers(player) {
    const party = player && Array.isArray(player.party) ? player.party : null;
    if (!party || party.length === 0) return [];
    const out = [];
    for (let i = 0; i < party.length; i++) {
      const member = party[i];
      if (!member || member.hp <= 0) continue;
      if (member.aiMode === 'manual') continue;
      if (sameActor(player, member)) continue;
      out.push(member);
    }
    return out;
  }

  /**
   * Every living friendly actor as the top-level player plus the non-active
   * members. The live active state lives on the top-level player, so its stale
   * `party` mirror is excluded to avoid double-counting.
   */
  static livingAllies(player) {
    const out = [];
    if (player && player.hp > 0) out.push(player);
    const party = player && Array.isArray(player.party) ? player.party : null;
    if (party) {
      for (let i = 0; i < party.length; i++) {
        const member = party[i];
        if (!member || member.hp <= 0) continue;
        if (sameActor(player, member)) continue;
        out.push(member);
      }
    }
    return out;
  }

  /** Living non-active member occupying a tile, or null (ally collision). */
  static partyMemberAt(player, x, y) {
    const party = player && Array.isArray(player.party) ? player.party : null;
    if (!party) return null;
    for (let i = 0; i < party.length; i++) {
      const member = party[i];
      if (!member || member.hp <= 0) continue;
      if (sameActor(player, member)) continue;
      if (member.x === x && member.y === y) return member;
    }
    return null;
  }

  /**
   * Drives every auto ally once. Mutates member positions/timers/cooldowns and
   * applies ability effects through `CombatSystem`. Returns one event per member
   * so the app can play sounds, log, float damage and route defeated monsters.
   *
   * @param {object} player Top-level (active-authoritative) player.
   * @param {{ gridMap: object, monsters?: object[], deltaSec?: number }} ctx
   * @returns {Array<object>}
   */
  static updateAllies(player, ctx = {}) {
    if (!player || !ctx.gridMap) return [];
    const members = PartyAI.inactiveMembers(player);
    if (members.length === 0) return [];

    const fullCtx = {
      gridMap: ctx.gridMap,
      monsters: Array.isArray(ctx.monsters) ? ctx.monsters : [],
      deltaSec: Number(ctx.deltaSec) || 0,
      allies: PartyAI.livingAllies(player),
      active: player,
    };

    const events = [];
    for (let i = 0; i < members.length; i++) {
      events.push(updateMember(members[i], fullCtx));
    }
    return events;
  }
}
