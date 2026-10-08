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
 * LIV-23 movement naturalness: steps are paced by the catalog `movement` block
 * (`cadenceSec`/`jitterSec`), offsets by a per-ally `staggerSec`, and settled
 * allies occasionally `wander` inside `wanderRadius`. All values are catalog
 * data (FIX-11 v2); the engine only supplies safe baselines.
 *
 * Design rules (docs/engineering/agents.md):
 *   - No vocation/ability names are hardcoded: profiles come from
 *     `party_ai.json` and abilities from `abilities.json`; the only dispatch key
 *     is the declared `actionKey`.
 *   - Unknown abilities / actionKeys are skipped, never guessed.
 *   - No DOM, worker, storage or timers. A* and LOS helpers are reused from the
 *     existing engine so nothing new is allocated on the render path.
 */

import { ABILITIES_CATALOG, PARTY_AI_CATALOG, ITEMS_CATALOG } from '../data/index.js';
import { CombatSystem } from './combat-system.js';
import { EntityAI } from './entity-ai.js';
import { InventorySystem } from './inventory-system.js';
import { LightingSystem } from './lighting-system.js';
import { isFriendly, isHostile, sameActor } from './faction.js';
import {
  ReviveSystem,
  isDowned as isMemberDowned,
  canStartRevive,
  hasReviveSource,
  beginRevive,
  orthogonalAdjacent,
  findPartyMemberById,
} from './revive-system.js';

/** Safe baseline profile when a vocation has no authored entry. */
export const DEFAULT_AI_PROFILE = Object.freeze({
  preferredAbilities: [],
  followDistance: 2,
  engageRadius: 5,
  castRange: 4,
  retreatHpPct: 0.25,
  retargetSec: 1.5,
  healAlliesWhenHurt: false,
  movement: null,
  potion: null,
  itemSearch: null,
  protect: null,
});

/**
 * LIV-23 movement-naturalness baseline. Catalog `party_ai.json` `movement`
 * objects are authoritative (FIX-11 v2 schema); this only covers a missing /
 * partial entry. `cadenceSec` paces steps, `staggerSec` is the per-ally phase
 * offset before it sets off, `jitterSec` de-aligns consecutive steps,
 * `wanderChance`/`wanderRadius`/`wanderCooldownSec` drive idle wandering.
 */
export const DEFAULT_AI_MOVEMENT = Object.freeze({
  cadenceSec: 0.2,
  staggerSec: 0,
  jitterSec: 0.06,
  wanderChance: 0.2,
  wanderRadius: 2,
  wanderCooldownSec: 4.0,
});

/** Cardinal adjacent offsets a wander step can take (static, no per-tick alloc). */
const WANDER_DIRECTIONS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/** Merge `movement` blocks (defaults <- catalog default <- vocation) field-wise. */
function resolveMovement(catalogDefault, profile) {
  const out = { ...DEFAULT_AI_MOVEMENT };
  const sources = [catalogDefault, profile];
  for (let s = 0; s < sources.length; s++) {
    const mv = sources[s] && sources[s].movement;
    if (!mv || typeof mv !== 'object') continue;
    for (const key of Object.keys(DEFAULT_AI_MOVEMENT)) {
      const value = Number(mv[key]);
      if (Number.isFinite(value)) out[key] = value;
    }
  }
  return out;
}

/**
 * LIV-25 support-cast baseline. Catalog `party_ai.json` `support` objects are
 * authoritative (FIX-11 v2 schema); this only covers a missing / partial entry.
 * `enabled` gates every support cast, `healPct` / `shieldPct` are the
 * most-injured-ally thresholds per support kind, `minManaFrac` is the caster
 * mana floor, `cooldownSec` is the shared per-member anti-spam cadence, `order`
 * ranks support kinds, and `abilities` lists the allowed support ability ids.
 */
export const DEFAULT_AI_SUPPORT = Object.freeze({
  enabled: false,
  healPct: 0.75,
  shieldPct: 0.9,
  minManaFrac: 0.2,
  cooldownSec: 2.0,
  order: ['heal', 'shield'],
  abilities: [],
});

/** Merge `support` blocks (defaults <- catalog default <- vocation) field-wise. */
function resolveSupport(catalogDefault, profile) {
  const out = { ...DEFAULT_AI_SUPPORT, order: DEFAULT_AI_SUPPORT.order.slice(), abilities: [] };
  const sources = [catalogDefault, profile];
  for (let s = 0; s < sources.length; s++) {
    const sp = sources[s] && sources[s].support;
    if (!sp || typeof sp !== 'object') continue;
    if (typeof sp.enabled === 'boolean') out.enabled = sp.enabled;
    for (const key of ['healPct', 'shieldPct', 'minManaFrac', 'cooldownSec']) {
      const value = Number(sp[key]);
      if (Number.isFinite(value)) out[key] = value;
    }
    if (Array.isArray(sp.order) && sp.order.length) out.order = sp.order.slice();
    if (Array.isArray(sp.abilities)) out.abilities = sp.abilities.slice();
  }
  return out;
}

/**
 * LIV-24 auto-potion baseline. Catalog `party_ai.json` `potion` objects are
 * authoritative (FIX-11 v2 schema); this only covers a missing / partial entry.
 * `enabled` gates auto-drinking, `hpPct` / `manaPct` are the per-resource
 * fractions at or below which the member drinks, `cooldownSec` is the
 * per-member anti-spam cadence, and `itemId` / `manaItemId` name the catalog
 * potions pulled from the shared party inventory (never hardcoded in JS).
 */
export const DEFAULT_AI_POTION = Object.freeze({
  enabled: true,
  hpPct: 0.5,
  manaPct: 0.5,
  cooldownSec: 8.0,
  itemId: 'health_potion',
  manaItemId: 'mana_potion',
});

/** Merge `potion` blocks (defaults <- catalog default <- vocation) field-wise. */
function resolvePotion(catalogDefault, profile) {
  const out = { ...DEFAULT_AI_POTION };
  const sources = [catalogDefault, profile];
  for (let s = 0; s < sources.length; s++) {
    const pt = sources[s] && sources[s].potion;
    if (!pt || typeof pt !== 'object') continue;
    for (const key of ['hpPct', 'manaPct', 'cooldownSec']) {
      const value = Number(pt[key]);
      if (Number.isFinite(value)) out[key] = value;
    }
    if (typeof pt.enabled === 'boolean') out.enabled = pt.enabled;
    if (typeof pt.itemId === 'string' && pt.itemId) out.itemId = pt.itemId;
    if (typeof pt.manaItemId === 'string' && pt.manaItemId) out.manaItemId = pt.manaItemId;
  }
  return out;
}

/**
 * LIV-33 ally ground-item search baseline. Catalog `party_ai.json` `itemSearch`
 * objects are authoritative; this only covers a missing / partial entry.
 * `enabled` gates out-of-combat looting and `radius` is the search leash in
 * tiles (0 disables scanning). Combat/retreat/support decisions always run
 * first, so item finding never competes with survival.
 */
export const DEFAULT_AI_ITEM_SEARCH = Object.freeze({
  enabled: true,
  radius: 6,
});

/** Merge `itemSearch` blocks (defaults <- catalog default <- vocation). */
function resolveItemSearch(catalogDefault, profile) {
  const out = { ...DEFAULT_AI_ITEM_SEARCH };
  const sources = [catalogDefault, profile];
  for (let s = 0; s < sources.length; s++) {
    const search = sources[s] && sources[s].itemSearch;
    if (!search || typeof search !== 'object') continue;
    if (typeof search.enabled === 'boolean') out.enabled = search.enabled;
    const radius = Number(search.radius);
    if (Number.isFinite(radius)) out.radius = radius;
  }
  return out;
}

/**
 * LIV-33 protector/retaliate baseline. Catalog `party_ai.json` `protect` objects
 * are authoritative; this only covers a missing / partial entry. When `enabled`,
 * a member prioritizes the hostile attacking another party member over the
 * nearest hostile. `radius` bounds how far it leaves formation to reach that
 * attacker. Only front-line protectors enable it.
 */
export const DEFAULT_AI_PROTECT = Object.freeze({
  enabled: false,
  radius: 8,
});

/** Merge `protect` blocks (defaults <- catalog default <- vocation). */
function resolveProtect(catalogDefault, profile) {
  const out = { ...DEFAULT_AI_PROTECT };
  const sources = [catalogDefault, profile];
  for (let s = 0; s < sources.length; s++) {
    const protect = sources[s] && sources[s].protect;
    if (!protect || typeof protect !== 'object') continue;
    if (typeof protect.enabled === 'boolean') out.enabled = protect.enabled;
    const radius = Number(protect.radius);
    if (Number.isFinite(radius)) out.radius = radius;
  }
  return out;
}

/**
 * Resolved auto-AI profile for a vocation. Missing vocations fall back to the
 * catalog `default` overlaid on `DEFAULT_AI_PROFILE`. The nested `movement`
 * block is resolved field-wise so a partial catalog entry cannot drop a baseline.
 * @param {string} vocation
 * @returns {object}
 */
export function profileForVocation(vocation) {
  const catalogDefault = PARTY_AI_CATALOG && PARTY_AI_CATALOG.default ? PARTY_AI_CATALOG.default : null;
  const base = { ...DEFAULT_AI_PROFILE, ...(catalogDefault || {}) };
  const key = String(vocation || '').toLowerCase();
  const profile = PARTY_AI_CATALOG && PARTY_AI_CATALOG.profiles ? PARTY_AI_CATALOG.profiles[key] : null;
  const resolved = profile ? { ...base, ...profile } : { ...base };
  resolved.movement = resolveMovement(catalogDefault, profile);
  resolved.support = resolveSupport(catalogDefault, profile);
  resolved.potion = resolvePotion(catalogDefault, profile);
  resolved.itemSearch = resolveItemSearch(catalogDefault, profile);
  resolved.protect = resolveProtect(catalogDefault, profile);
  // LIV-44: resolve the knockout/revive block (catalog default + per-vocation
  // override). The engine resolver owns the schema; no vocation branches here.
  resolved.revive = ReviveSystem.resolveReviveConfig(key);
  return resolved;
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
    execute: (actor, target, ctx) => CombatSystem.executeHealingPrayer(actor, ctx.allies),
  },
  force_shield: {
    execute: (actor, target, ctx, spec) => CombatSystem.executeForceShield(actor, target, spec),
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

function hpFraction(actor) {
  if (!actor || !(actor.max_hp > 0) || typeof actor.hp !== 'number') return 1;
  return Math.max(0, Math.min(1, actor.hp / actor.max_hp));
}

function manaFraction(actor) {
  if (!actor || !(actor.max_mana > 0) || typeof actor.mana !== 'number') return 1;
  return Math.max(0, Math.min(1, actor.mana / actor.max_mana));
}

/** True for the support kinds (ally heal / ally shield). */
function isSupportKind(spec) {
  return Boolean(spec) && (spec.type === 'heal' || spec.type === 'shield');
}

/**
 * Most-injured friendly actor a support ability would actually help, or null.
 * Heals must land at/below `support.healPct`; shields route through the combat
 * seam, which additionally refuses an already-warded actor and enforces
 * `support.shieldPct` — together the anti-spam gates for support casting.
 */
function supportTarget(actor, profile, spec, ctx) {
  const support = profile.support;
  if (!support || support.enabled !== true) return null;
  if (spec.type === 'heal') {
    const best = CombatSystem.selectHealTarget(actor, ctx.allies, Number(spec.healRadius) || 0);
    if (!best) return null;
    return hpFraction(best) <= support.healPct ? best : null;
  }
  if (spec.type === 'shield') {
    const radius = Number(spec.range || spec.healRadius) || 0;
    return CombatSystem.selectShieldTarget(actor, ctx.allies, radius, support.shieldPct);
  }
  return null;
}

/**
 * Candidate ability ids in cast order: the `support.abilities` list ranked by
 * `support.order`, then the vocation's combat `preferredAbilities`, de-duped.
 */
function candidateAbilityIds(profile) {
  const supportIds = [];
  const support = profile.support;
  if (support && support.enabled === true && Array.isArray(support.abilities)) {
    const order = Array.isArray(support.order) && support.order.length ? support.order : DEFAULT_AI_SUPPORT.order;
    const ranked = support.abilities.map((id, index) => {
      const spec = ABILITIES_CATALOG[id];
      const at = spec ? order.indexOf(spec.type) : -1;
      return { id, index, rank: at < 0 ? order.length : at };
    });
    ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
    for (let i = 0; i < ranked.length; i++) supportIds.push(ranked[i].id);
  }
  const combatIds = Array.isArray(profile.preferredAbilities) ? profile.preferredAbilities : [];
  const seen = new Set();
  const out = [];
  const all = supportIds.concat(combatIds);
  for (let i = 0; i < all.length; i++) {
    const id = all[i];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * First ready ability in the member's candidate order, with the target it would
 * act on: a friendly actor for support kinds (heal/shield), the engaged hostile
 * for attacks. Support casts additionally require the v2 `support` block to be
 * enabled, the caster mana fraction above `minManaFrac`, and the shared
 * per-member support cadence (`_supportTimer`) to have elapsed.
 */
function pickAbility(actor, profile, hostileTarget, dist, ctx) {
  const ids = candidateAbilityIds(profile);
  for (let i = 0; i < ids.length; i++) {
    const resolved = resolveAbility(ids[i]);
    if (!resolved) continue;
    const spec = resolved.spec;
    const handler = resolved.handler;
    if (((actor.cooldowns && actor.cooldowns[spec.actionKey]) || 0) > 0) continue;
    if (Number(spec.manaCost || 0) > Number(actor.mana || 0)) continue;

    if (isSupportKind(spec)) {
      if ((actor._supportTimer || 0) > 0) continue;
      const support = profile.support;
      if (!support || support.enabled !== true) continue;
      if (manaFraction(actor) <= support.minManaFrac) continue;
      const castTarget = supportTarget(actor, profile, spec, ctx);
      if (!castTarget) continue;
      return { spec, handler, target: castTarget };
    }

    if (!hostileTarget) continue;
    const range = Number(spec.range) || 1;
    if (dist > range + 0.5) continue;
    const minRange = Number(spec.minRange) || 0;
    if (dist < minRange - 0.5) continue;
    if (!LightingSystem.hasLineOfSight(ctx.gridMap, actor.x, actor.y, hostileTarget.x, hostileTarget.y)) continue;

    // Beam is a line: only commit when the target is roughly on-axis.
    if (handler.line) {
      const dx = Math.abs(hostileTarget.x - actor.x);
      const dy = Math.abs(hostileTarget.y - actor.y);
      const offAxis = Math.min(dx, dy);
      const onAxis = Math.max(dx, dy) || 1;
      if (offAxis > 0 && offAxis / onAxis > 0.5) continue;
    }
    return { spec, handler, target: hostileTarget };
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
 * The living party member a hostile is currently attacking, or null. A monster
 * that `EntityAI.updateMonsters` target-locked onto an ally counts, as does a
 * monster standing adjacent to one (the adjacency fallback keeps protection
 * working when a hand-built or test monster carries no target metadata).
 */
function protectVictim(monster, self, ctx) {
  const locked = monster.aggroTarget;
  if (
    locked
    && monster.isAggroed !== false
    && locked.hp > 0
    && !sameActor(locked, self)
    && isFriendly(self, locked)
  ) {
    return locked;
  }
  const allies = ctx.allies;
  for (let i = 0; i < allies.length; i++) {
    const a = allies[i];
    if (!a || a.hp <= 0 || sameActor(a, self)) continue;
    if (!isFriendly(self, a)) continue;
    if (Math.abs(a.x - monster.x) + Math.abs(a.y - monster.y) <= 1) return a;
  }
  return null;
}

/**
 * LIV-33 protector targeting. When a profile enables `protect`, returns the
 * hostile currently attacking another party member that is closest to this
 * member within `protect.radius`, or null. A support/backline profile disables
 * `protect` and keeps its `support`/`followDistance` posture untouched.
 */
function protectorTarget(member, profile, ctx) {
  const protect = profile.protect;
  if (!protect || protect.enabled !== true) return null;
  const radius = Number(protect.radius);
  if (!(radius > 0)) return null;
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  const monsters = ctx.monsters;
  for (let i = 0; i < monsters.length; i++) {
    const m = monsters[i];
    if (!m || m.hp <= 0 || m.visible === false) continue;
    if (!isHostile(member, m)) continue;
    if (!protectVictim(m, member, ctx)) continue;
    const d = Math.hypot(m.x - member.x, m.y - member.y);
    if (d > radius || d >= bestDist) continue;
    best = m;
    bestDist = d;
  }
  return best;
}

/**
 * Acquires/keeps an engagement target. A committed target (still alive and in
 * leash range) is held until `retargetSec` expires so allies do not thrash.
 * LIV-33: a protector profile first retaliates against a hostile attacking a
 * party member before defaulting to the nearest hostile.
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
  // Protector/retaliate: front-liners seek the attacker threatening a party
  // member before falling back to the nearest hostile (LIV-33).
  const protector = protectorTarget(actor, profile, ctx);
  if (protector) {
    actor.aiTargetId = protector.id;
    actor.aiRetargetTimer = Number(profile.retargetSec) || DEFAULT_AI_PROFILE.retargetSec;
    return protector;
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

/**
 * LIV-33 ground-item search. Scans a bounded window of `radius` tiles around the
 * member for the nearest reachable ground item, or null. Reads the live
 * `gridMap` (no per-tick list allocation) and requires the item tile to be
 * walkable with line of sight so a wall cannot bait the ally. Items on the
 * member's own tile are ignored because walk-over pickup only fires on a step.
 */
function findNearestGroundItem(member, ctx, radius) {
  const grid = ctx.gridMap;
  if (!grid || !(radius > 0)) return null;
  const r = Math.ceil(radius);
  const minX = Math.max(0, member.x - r);
  const maxX = Math.min(grid.width - 1, member.x + r);
  const minY = Math.max(0, member.y - r);
  const maxY = Math.min(grid.height - 1, member.y + r);
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const items = grid.getItems(x, y);
      if (!items || items.length === 0) continue;
      const d = Math.hypot(x - member.x, y - member.y);
      if (d > radius || d < 0.001 || d >= bestDist) continue;
      if (!grid.isWalkable(x, y)) continue;
      if (!LightingSystem.hasLineOfSight(grid, member.x, member.y, x, y)) continue;
      best = { x, y };
      bestDist = d;
    }
  }
  return best;
}

/**
 * One step toward the nearest ground item when out of combat, or null. The step
 * is a normal `move` event, so the app's existing walk-over pipeline
 * (`handleAllyWalkoverPickup` -> `handlePickUp`) banks the drop in the shared
 * party backpack. Paced by the same `movement.cadenceSec` gate as following.
 */
function tryItemSearch(member, profile, ctx) {
  const search = profile.itemSearch;
  if (!search || search.enabled !== true) return null;
  if (!canStep(member)) return null;
  const radius = Number(search.radius);
  const item = findNearestGroundItem(member, ctx, radius);
  if (!item) return null;
  const step = stepToward(member, item.x, item.y, ctx);
  if (!step) return null;
  const fromX = member.x;
  const fromY = member.y;
  commitStep(member, step, profile, ctx);
  return moveEvent(member, fromX, fromY);
}

/**
 * LIV-23 movement naturalness. Every auto ally carries transient timers, all
 * driven by the catalog `movement` block:
 *   - `_stepTimer` — per-step cadence (`cadenceSec` + random `jitterSec`) so
 *     allies do not march one tile per 10 Hz tick in lockstep.
 *   - `_followDelayTimer` — the catalog `staggerSec` phase offset an ally settled
 *     in formation waits before setting off, so allies do not all bolt at once.
 *   - `_wanderCooldown` — idle beats between occasional `wanderChance` steps.
 * `_followArmed` marks that the stagger offset is loaded for this formation
 * stance (re-armed only after the ally settles back inside `followDistance`).
 */
function movementNumber(profile, key) {
  const mv = profile && profile.movement;
  const value = mv ? Number(mv[key]) : NaN;
  return Number.isFinite(value) ? value : Number(DEFAULT_AI_MOVEMENT[key]) || 0;
}

function profileNumber(profile, key) {
  const value = Number(profile[key]);
  return Number.isFinite(value) ? value : Number(DEFAULT_AI_PROFILE[key]) || 0;
}

function unitRandom(ctx) {
  return typeof ctx.random === 'function' ? ctx.random() : Math.random();
}

function tickMovementTimers(member, deltaSec) {
  const dt = Number(deltaSec) || 0;
  if (dt <= 0) return;
  if (member._stepTimer > 0) member._stepTimer = Math.max(0, member._stepTimer - dt);
  if (member._wanderCooldown > 0) member._wanderCooldown = Math.max(0, member._wanderCooldown - dt);
  // LIV-25 shared support-cast cadence (anti-spam) counts down with movement.
  if (member._supportTimer > 0) member._supportTimer = Math.max(0, member._supportTimer - dt);
}

/** True when the per-step cadence has elapsed (or was never armed). */
function canStep(member) {
  return !(member._stepTimer > 0);
}

/** Applies a step and arms the jittered cadence before the next one. */
function commitStep(member, step, profile, ctx) {
  member.facing = EntityAI.getFacing(member.x, member.y, step.x, step.y);
  member.x = step.x;
  member.y = step.y;
  const cadence = Math.max(0, movementNumber(profile, 'cadenceSec'));
  const jitter = Math.max(0, movementNumber(profile, 'jitterSec'));
  member._stepTimer = cadence + unitRandom(ctx) * jitter;
}

/** Loads the per-ally stagger phase offset for this formation stance. */
function armFollowDelay(member, profile) {
  member._followDelayTimer = Math.max(0, movementNumber(profile, 'staggerSec'));
  member._followArmed = true;
}

/**
 * Occasional adjacent wander while settled in formation. `wanderChance` is
 * rolled when a member becomes eligible (cooldown elapsed); an accepted roll
 * takes one short step that stays within `wanderRadius` of the active member so
 * the ally never drifts off on its own. Rejection re-arms the cooldown so the
 * roll cadence stays bounded. Uses a cardinal scan (no per-tick allocation).
 */
function tryWander(member, active, profile, ctx) {
  if (member._wanderCooldown > 0) return null;
  if (!canStep(member)) return null;
  const deltaSec = Number(ctx.deltaSec) || 0;
  if (deltaSec <= 0) return null;
  const chance = Math.max(0, movementNumber(profile, 'wanderChance'));
  const cooldown = Math.max(0, movementNumber(profile, 'wanderCooldownSec'));
  if (chance <= 0) {
    member._wanderCooldown = cooldown;
    return null;
  }
  // Roll once per cooldown window so wander frequency is not tick-rate coupled.
  if (unitRandom(ctx) >= chance) {
    member._wanderCooldown = cooldown > 0 ? cooldown : DEFAULT_AI_MOVEMENT.wanderCooldownSec;
    return null;
  }

  const radius = Math.max(0, movementNumber(profile, 'wanderRadius'));
  const start = Math.floor(unitRandom(ctx) * WANDER_DIRECTIONS.length) % WANDER_DIRECTIONS.length;
  for (let k = 0; k < WANDER_DIRECTIONS.length; k++) {
    const dir = WANDER_DIRECTIONS[(start + k) % WANDER_DIRECTIONS.length];
    const nx = member.x + dir[0];
    const ny = member.y + dir[1];
    if (!ctx.gridMap.isWalkable(nx, ny)) continue;
    if (isTileOccupied(ctx, nx, ny, member)) continue;
    if (Math.hypot(nx - active.x, ny - active.y) > radius) continue;
    const fromX = member.x;
    const fromY = member.y;
    commitStep(member, { x: nx, y: ny }, profile, ctx);
    member._wanderCooldown = cooldown > 0 ? cooldown : DEFAULT_AI_MOVEMENT.wanderCooldownSec;
    return moveEvent(member, fromX, fromY);
  }
  // No legal wander tile: retry after the cooldown instead of every tick.
  member._wanderCooldown = cooldown > 0 ? cooldown : DEFAULT_AI_MOVEMENT.wanderCooldownSec;
  return null;
}

function moveEvent(member, fromX, fromY) {
  return { member, type: 'move', from: { x: fromX, y: fromY }, to: { x: member.x, y: member.y } };
}

function idleEvent(member) {
  return { member, type: 'idle' };
}

/** Tick the per-member auto-potion cooldown (LIV-24). */
function tickPotionTimer(member, deltaSec) {
  const dt = Number(deltaSec) || 0;
  if (dt <= 0) return;
  if (member._potionCooldown > 0) member._potionCooldown = Math.max(0, member._potionCooldown - dt);
}

/** Locate a catalog item by id in the shared party inventory, or null. */
function findSharedItem(player, itemId) {
  if (!player || !itemId) return null;
  const lists = [player.action_bar, player.backpack];
  for (let l = 0; l < lists.length; l++) {
    const list = lists[l];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item && item.item_id === itemId) return { item, list, index: i };
    }
  }
  return null;
}

/** First depleted resource ('hp' | 'mp') this member should drink for, or null. */
function potionNeed(member, potion) {
  const hpPct = Number(potion.hpPct);
  if (potion.itemId && hpPct > 0 && member.max_hp > 0 && member.hp / member.max_hp <= hpPct) return 'hp';
  const manaPct = Number(potion.manaPct);
  if (potion.manaItemId && manaPct > 0 && member.max_mana > 0 && member.mana / member.max_mana <= manaPct) return 'mp';
  return null;
}

/**
 * Auto-drinks a catalog potion from the shared party inventory when a resource
 * is at or below its profile threshold and the member is off cooldown. The
 * potion's catalog `effect.scope: 'party'` (items.json) makes the restore hit
 * every eligible ally, so one drink can top up the whole party. Returns a
 * 'potion' event, or null when nothing is needed / available / off cooldown.
 */
function usePotion(member, profile, ctx) {
  const potion = profile.potion;
  if (!potion || potion.enabled !== true) return null;
  if (member._potionCooldown > 0) return null;
  const resource = potionNeed(member, potion);
  if (!resource) return null;
  const itemId = resource === 'mp' ? potion.manaItemId : potion.itemId;
  const found = findSharedItem(ctx.active, itemId);
  if (!found) return null;

  const result = InventorySystem.consumeItem(ctx.active, found.item, () => {
    if (found.item.quantity > 1) found.item.quantity -= 1;
    else found.list[found.index] = null;
  });
  if (!result || !result.success) return null;

  member._potionCooldown = Math.max(0, Number(potion.cooldownSec) || 0);
  return { member, type: 'potion', resource, itemId, item: found.item, result };
}

/** True when a party entry is downed (the active entry reads the live mirror). */
function isPartyEntryDowned(player, member) {
  if (!member) return false;
  if (sameActor(player, member)) return isMemberDowned(player);
  return isMemberDowned(member);
}

/**
 * LIV-44 designated-reviver plan: the single living, capable member (nearest to
 * a downed ally, tie-break lowest party index) that will run the rescue. Only
 * revives whose start gate is open (no hostile within `safetyRadius`, damage
 * idle `idleSec`) are considered. Returns `{ reviverId, targetId }` or null.
 */
function planRevives(player, ctx) {
  const party = player && Array.isArray(player.party) ? player.party : null;
  if (!party || party.length < 2) return null;
  let bestReviverId = null;
  let bestTargetId = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let t = 0; t < party.length; t++) {
    const target = party[t];
    if (!target || !target.memberId) continue;
    if (!isPartyEntryDowned(player, target)) continue;
    if (!canStartRevive(target, ctx, ReviveSystem.resolveReviveConfig(target.vocation))) continue;
    for (let r = 0; r < party.length; r++) {
      const reviver = party[r];
      if (!reviver || reviver === target || !reviver.memberId) continue;
      if (isPartyEntryDowned(player, reviver)) continue;
      const cfg = ReviveSystem.resolveReviveConfig(reviver.vocation);
      if (!cfg.enabled) continue;
      if (!hasReviveSource(reviver, cfg, ctx)) continue;
      const d = Math.hypot(reviver.x - target.x, reviver.y - target.y);
      if (d < bestDist - 1e-6) {
        bestDist = d;
        bestReviverId = reviver.memberId;
        bestTargetId = target.memberId;
      }
    }
  }
  if (!bestReviverId) return null;
  return { reviverId: bestReviverId, targetId: bestTargetId };
}

/**
 * LIV-44 revive step for the designated reviver: walk orthogonally adjacent to
 * the downed ally, then channel. Returns an event, or null when this member is
 * not the designated reviver / nothing is actionable.
 */
function tryRevive(member, profile, ctx) {
  if (!ctx.designatedReviverId || ctx.designatedReviverId !== member.memberId) return null;
  if (!ctx.reviveTargetId) return null;
  const cfg = (profile && profile.revive) || ReviveSystem.resolveReviveConfig(member.vocation);
  if (!cfg.enabled) return null;
  const target = findPartyMemberById(ctx.active, ctx.reviveTargetId);
  if (!target || !isPartyEntryDowned(ctx.active, target)) return null;

  // Already committed to this target: hold position so the engine can tick the
  // channel (moving would break it).
  if (member._reviveTargetId === target.memberId) {
    return { member, type: 'revive', target, phase: 'channel', progressSec: toFinite(member._reviveProgressSec, 0) };
  }
  if (!canStartRevive(target, ctx, cfg)) return null;
  if (!hasReviveSource(member, cfg, ctx)) return null;

  if (orthogonalAdjacent(member, target)) {
    beginRevive(member, target, cfg);
    return { member, type: 'revive', target, phase: 'begin' };
  }
  if (canStep(member)) {
    const step = stepToward(member, target.x, target.y, ctx);
    if (step) {
      const fromX = member.x;
      const fromY = member.y;
      commitStep(member, step, profile, ctx);
      return moveEvent(member, fromX, fromY);
    }
  }
  return idleEvent(member);
}

function toFinite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Decide + apply one auto member's action for this tick. */
function updateMember(member, ctx) {
  const profile = profileForVocation(member.vocation);
  tickMovementTimers(member, ctx.deltaSec);
  tickPotionTimer(member, ctx.deltaSec);

  // 0. Top up a depleted resource from the shared party potion pool. Runs before
  //    retreat/attacks so a hurt or dry ally drinks instead of fleeing.
  const potion = usePotion(member, profile, ctx);
  if (potion) return potion;

  const target = acquireTarget(member, profile, ctx);
  const distToTarget = target ? Math.hypot(target.x - member.x, target.y - member.y) : Number.POSITIVE_INFINITY;

  // 1. Disengage when badly hurt while threatened.
  if (target && Number(profile.retreatHpPct) > 0 && missingHpFraction(member) >= Number(profile.retreatHpPct)) {
    const step = canStep(member) ? stepAwayFrom(member, target, ctx) : null;
    if (step) {
      const fromX = member.x;
      const fromY = member.y;
      commitStep(member, step, profile, ctx);
      return moveEvent(member, fromX, fromY);
    }
    return idleEvent(member);
  }

  // 2. Cast the first ready ability. Support kinds (heal/shield) act on a
  //    friendly target governed by the v2 `support` block; attacks use the
  //    engaged hostile. Cooldowns/mana/support cadence gate inside pickAbility.
  const ability = pickAbility(member, profile, target, distToTarget, ctx);
  if (ability) {
    const result = ability.handler.execute(member, ability.target, ctx, ability.spec);
    if (result && result.success) {
      if (isSupportKind(ability.spec)) {
        const support = profile.support;
        member._supportTimer = Math.max(0, Number(support && support.cooldownSec) || 0);
      }
      return {
        member,
        type: 'ability',
        abilityId: ability.spec.id,
        actionKey: ability.spec.actionKey,
        target: ability.target || null,
        result,
      };
    }
  }

  // 2c. Knockout rescue (LIV-44): the designated reviver walks to a downed ally
  //     and channels. Only runs while exploring (planner + start gate), after
  //     support, before loot/follow, so survival and support always win.
  if (ctx.partyState === 'exploring') {
    const rescue = tryRevive(member, profile, ctx);
    if (rescue) return rescue;
  }

  // 2b. Out of combat: seek nearby ground items into the shared backpack
  //     (LIV-33). Retreat/support/attacks already returned above, so looting
  //     never competes with survival; the app's walk-over pipeline banks the
  //     drop in the party stash when the move event lands on the item tile.
  if (!target) {
    const looting = tryItemSearch(member, profile, ctx);
    if (looting) return looting;
  }

  // 3. Close to preferred combat distance while engaged.
  if (target) {
    const castRange = Math.max(1, Number(profile.castRange) || 1);
    if (distToTarget > castRange + 0.5 && canStep(member)) {
      const step = stepToward(member, target.x, target.y, ctx);
      if (step) {
        const fromX = member.x;
        const fromY = member.y;
        commitStep(member, step, profile, ctx);
        return moveEvent(member, fromX, fromY);
      }
    }
    return idleEvent(member);
  }

  // 4. Follow the active member at formation distance.
  const active = ctx.active;
  if (active && !sameActor(active, member)) {
    const followDistance = Math.max(1, profileNumber(profile, 'followDistance'));
    const d = Math.hypot(active.x - member.x, active.y - member.y);
    if (d > followDistance + 0.001) {
      // Stagger: an ally settled in formation waits its `staggerSec` phase
      // offset before setting off, so allies do not all march on the same tick.
      if (member._followArmed) {
        if (member._followDelayTimer > 0) {
          member._followDelayTimer = Math.max(0, member._followDelayTimer - (Number(ctx.deltaSec) || 0));
          return idleEvent(member);
        }
        member._followArmed = false;
      }
      if (canStep(member)) {
        const step = stepToward(member, active.x, active.y, ctx);
        if (step) {
          const fromX = member.x;
          const fromY = member.y;
          commitStep(member, step, profile, ctx);
          return moveEvent(member, fromX, fromY);
        }
      }
      return idleEvent(member);
    }
    // Settled in formation: load the stagger offset and occasionally wander.
    if (!member._followArmed || member._followDelayTimer <= 0) armFollowDelay(member, profile);
    const wander = tryWander(member, active, profile, ctx);
    if (wander) return wander;
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
      if (!member || isMemberDowned(member)) continue;
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
    if (player && !isMemberDowned(player)) out.push(player);
    const party = player && Array.isArray(player.party) ? player.party : null;
    if (party) {
      for (let i = 0; i < party.length; i++) {
        const member = party[i];
        if (!member || isMemberDowned(member)) continue;
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
      if (!member || isMemberDowned(member)) continue;
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
   * @param {{ gridMap: object, monsters?: object[], deltaSec?: number,
   *   random?: () => number }} ctx `random` is injectable for deterministic tests.
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
      random: typeof ctx.random === 'function' ? ctx.random : Math.random,
      allies: PartyAI.livingAllies(player),
      active: player,
      // LIV-44: rescue is legal only while exploring; the gate also re-checks
      // no-hostile-in-safetyRadius + damage-idle. A caller that omits the idle
      // clock (engine tests) gets an open idle gate.
      partyState: ctx.partyState || 'exploring',
      combatIdleSec: Number.isFinite(Number(ctx.combatIdleSec))
        ? Number(ctx.combatIdleSec)
        : Number.POSITIVE_INFINITY,
    };
    const revivePlan = fullCtx.partyState === 'exploring' ? planRevives(player, fullCtx) : null;
    fullCtx.designatedReviverId = revivePlan ? revivePlan.reviverId : null;
    fullCtx.reviveTargetId = revivePlan ? revivePlan.targetId : null;

    const events = [];
    for (let i = 0; i < members.length; i++) {
      events.push(updateMember(members[i], fullCtx));
    }
    return events;
  }
}
