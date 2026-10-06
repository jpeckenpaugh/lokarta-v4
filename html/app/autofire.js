/**
 * Lokarta: Come Into The Light - Hold-to-Autofire Policy
 *
 * Pure, DOM-free policy shared by the mobile AbilityBar subsystem and the unit
 * tests. It answers two questions:
 *
 *   1. `classifyHold(elapsedMs)` — did a press cross the autofire hold threshold?
 *   2. `canAutoFire(app, ref)` — may an autofire repeat dispatch *now* without
 *      wasting MP/ammo or producing no effect?
 *
 * The guard is a dispatch table keyed on the item's catalog `actionKey` (no
 * string heuristics), with a safe fallback that suppresses unknown abilities.
 * Timing constants live in `keybindings.json.autofire` -> `CONFIG`; nothing
 * here hardcodes a duration.
 */

import { CONFIG } from '../engine/config.js';
import { CombatSystem } from '../engine/combat-system.js';
import { LightingSystem } from '../engine/lighting-system.js';
import { ITEMS_CATALOG, ABILITIES_CATALOG } from '../data/index.js';

/** Safe fallbacks if a catalog ever drops the `autofire` block. */
export const AUTOFIRE_DEFAULTS = Object.freeze({ holdMs: 2000, repeatMs: 200, feedbackMs: 1200 });

/** `actionKey -> abilities.json entry`, so a guard can read `consumesArrow`/range. */
const ABILITY_BY_ACTION_KEY = Object.fromEntries(
  Object.values(ABILITIES_CATALOG || {})
    .filter(def => def && def.actionKey)
    .map(def => [def.actionKey, def])
);

/**
 * Cooldowns are stored on `player.cooldowns[actionKey]`, except the Light Spell
 * whose combat handler writes `player.cooldowns.light` while its item
 * `actionKey` is `light_spell` (combat-system.js:357). Resolve both to one key
 * so the guard and the HUD cooldown wipe can never disagree.
 */
const COOLDOWN_KEY_OVERRIDES = Object.freeze({ light_spell: 'light' });

/** `{ holdMs, repeatMs, feedbackMs }` resolved from CONFIG with fallbacks. */
export function autofireTimings() {
  return {
    holdMs: Number(CONFIG?.AUTOFIRE_HOLD_MS) || AUTOFIRE_DEFAULTS.holdMs,
    repeatMs: Number(CONFIG?.AUTOFIRE_REPEAT_MS) || AUTOFIRE_DEFAULTS.repeatMs,
    feedbackMs: Number(CONFIG?.AUTOFIRE_FEEDBACK_MS) || AUTOFIRE_DEFAULTS.feedbackMs,
  };
}

/**
 * Classifies a completed/ongoing press by duration.
 * `>= holdMs` begins autofire; anything shorter is a single activation.
 */
export function classifyHold(elapsedMs, holdMs = autofireTimings().holdMs) {
  return Number(elapsedMs) >= Number(holdMs) ? 'autofire' : 'single';
}

/** Resolves a button ref (`{kind:'equipment',slot}` | `{kind:'active',index}`). */
export function resolveAbilityRef(app, ref) {
  const player = app?.player || null;
  if (!player || !ref) {
    return { kind: ref?.kind || null, slot: ref?.slot, index: ref?.index, item: null, catalogItem: null, ability: null, actionKey: null };
  }
  if (ref.kind === 'equipment') {
    const item = player.paperdoll?.[ref.slot] || null;
    const catalogItem = item ? ITEMS_CATALOG[item.item_id] || null : null;
    const actionKey = item?.actionKey || catalogItem?.actionKey || null;
    return { kind: 'equipment', slot: ref.slot, item, catalogItem, ability: ABILITY_BY_ACTION_KEY[actionKey] || null, actionKey };
  }
  if (ref.kind === 'active') {
    const item = player.action_bar?.[ref.index] || null;
    const catalogItem = item ? ITEMS_CATALOG[item.item_id] || null : null;
    const actionKey = item?.actionKey || catalogItem?.actionKey || null;
    return { kind: 'active', index: ref.index, item, catalogItem, ability: ABILITY_BY_ACTION_KEY[actionKey] || null, actionKey };
  }
  return { kind: null, item: null, catalogItem: null, ability: null, actionKey: null };
}

/**
 * Active slots 1-4 are deliberately non-repeatable (consume/equip would drain
 * stacks and MP — Spec §4). Only equipment abilities with a catalog
 * `actionKey` may enter the autofire repeat loop.
 */
export function isRepeatable(ref, ctx) {
  return ref?.kind === 'equipment' && Boolean(ctx?.actionKey);
}

function dispatchAllowed(app) {
  if (!app) return false;
  if (app.isInGameplay === false) return false;
  if (app.isPaused) return false;
  if (app.isGameOver) return false;
  if (app.isFloorCleared) return false;
  if (app.transition && typeof app.transition.isLocked === 'function' && app.transition.isLocked()) return false;
  return true;
}

function hasLineOfSight(gridMap, player, monster) {
  if (!gridMap || typeof LightingSystem?.hasLineOfSight !== 'function') return true;
  return LightingSystem.hasLineOfSight(gridMap, player.x, player.y, monster.x, monster.y);
}

function isAliveMonster(m) {
  return Boolean(m) && m.hp > 0 && m.visible !== false;
}

/** Nearest visible, living monster within `range` (+0.5 tolerance) in LOS. */
function nearestVisible(player, monsters, gridMap, range) {
  if (!player || !Array.isArray(monsters)) return null;
  const effective = range + (player.skillBoosts?.bonusRange || 0) + 0.5;
  let best = null;
  let bestDist = Infinity;
  for (const m of monsters) {
    if (!isAliveMonster(m)) continue;
    const d = Math.hypot(m.x - player.x, m.y - player.y);
    if (d > effective || d >= bestDist) continue;
    if (!hasLineOfSight(gridMap, player, m)) continue;
    bestDist = d;
    best = m;
  }
  return best;
}

/** Any living monster within `radius` (visibility ignored, matching AoE casts). */
function anyWithin(player, monsters, radius) {
  if (!player || !Array.isArray(monsters)) return false;
  return monsters.some(m => m && m.hp > 0 && Math.hypot(m.x - player.x, m.y - player.y) <= radius);
}

/** Any living monster adjacent (Manhattan distance 1) — Shield Bash reach. */
function anyAdjacent(player, monsters) {
  if (!player || !Array.isArray(monsters)) return false;
  return monsters.some(m => m && m.hp > 0 && Math.abs(m.x - player.x) + Math.abs(m.y - player.y) === 1);
}

/**
 * True when at least one visible living monster sits in the widening Energy
 * Beam cone along `player.facing`, within `range` steps (mirrors the wave tile
 * generation in `CombatSystem.executeEnergyBeam`).
 */
function beamHasTarget(player, monsters, gridMap, range) {
  const fVecs = {
    up: { fX: 0, fY: -1, pX: 1, pY: 0 },
    down: { fX: 0, fY: 1, pX: -1, pY: 0 },
    left: { fX: -1, fY: 0, pX: 0, pY: -1 },
    right: { fX: 1, fY: 0, pX: 0, pY: 1 },
  };
  const { fX, fY, pX, pY } = fVecs[player.facing] || fVecs.right;
  for (const m of monsters) {
    if (!isAliveMonster(m)) continue;
    const dx = m.x - player.x;
    const dy = m.y - player.y;
    const along = dx * fX + dy * fY;
    const lateral = dx * pX + dy * pY;
    if (along < 1 || along > range) continue;
    if (Math.abs(lateral) > along - 1) continue;
    if (!hasLineOfSight(gridMap, player, m)) continue;
    return true;
  }
  return false;
}

function effectiveRange(player, item, fallback) {
  const base = (item && typeof item.range === 'number') ? CombatSystem.itemRange(item) : fallback;
  return Number(base) || fallback;
}

function manaCostFor(item, ability) {
  const viaItem = CombatSystem.getEffectiveManaCost(item);
  if (typeof viaItem === 'number') return viaItem;
  if (ability && typeof ability.manaCost === 'number') return ability.manaCost;
  return 0;
}

function consumesArrowFor(item, catalogItem, ability) {
  return Boolean(ability?.consumesArrow || item?.consumesArrow || catalogItem?.consumesArrow);
}

function hasArrow(player) {
  const quiver = player?.paperdoll?.off_hand;
  if (quiver && typeof quiver.arrowCount === 'number' && quiver.arrowCount > 0) return true;
  return Boolean(CombatSystem.findArrowItem(player));
}

function cooldownKeyFor(actionKey) {
  return COOLDOWN_KEY_OVERRIDES[actionKey] || actionKey;
}

function cooldownRemaining(player, actionKey) {
  const key = cooldownKeyFor(actionKey);
  const value = player?.cooldowns?.[key];
  return Number(value) > 0 ? Number(value) : 0;
}

const OK = Object.freeze({ ok: true, reason: 'ok' });
const no = reason => ({ ok: false, reason });

/**
 * Per-`actionKey` benefit predicate: repeat only when the cast would produce a
 * positive change. Offensive casts need a target in their real damage area;
 * self-buffs/heals are suppressed while already active or at full pools.
 * Unknown `actionKey`s fall back to suppression (never repeat blind).
 */
const BENEFIT_CHECKS = {
  wand_spark: c => (nearestVisible(c.player, c.monsters, c.gridMap, CONFIG.MAGICIAN_SPARK_RANGE) ? OK : no('no-target')),
  energy_beam: c => (beamHasTarget(c.player, c.monsters, c.gridMap, effectiveRange(c.player, c.item, CONFIG.MAGICIAN_BEAM_RANGE)) ? OK : no('no-target')),
  bow_shot: c => (nearestVisible(c.player, c.monsters, c.gridMap, effectiveRange(c.player, c.player.paperdoll?.main_hand, CONFIG.ARCHER_BOW_RANGE)) ? OK : no('no-target')),
  power_shot: c => (nearestVisible(c.player, c.monsters, c.gridMap, effectiveRange(c.player, c.player.paperdoll?.main_hand, CONFIG.ARCHER_POWER_SHOT_RANGE)) ? OK : no('no-target')),
  slash: c => (nearestVisible(c.player, c.monsters, c.gridMap, 2.5) ? OK : no('no-target')),
  cleave: c => (anyWithin(c.player, c.monsters, 2.5) ? OK : no('no-target')),
  holy_strike: c => (nearestVisible(c.player, c.monsters, c.gridMap, 2.5) ? OK : no('no-target')),
  shield_bash: c => (anyAdjacent(c.player, c.monsters) ? OK : no('no-target')),
  shock_shield: c => (c.player.shockShieldCharges > 0 ? no('active') : (anyWithin(c.player, c.monsters, 2.5) ? OK : no('no-target'))),
  life_siphon: c => (anyWithin(c.player, c.monsters, c.item?.siphonRadius || 2) ? OK : no('no-target')),
  hunters_mark: c => (nearestVisible(c.player, c.monsters, c.gridMap, c.item?.markRange || 8) ? OK : no('no-target')),
  holy_shield: c => (c.player.shieldAbsorb > 0 ? no('active') : OK),
  sanctuary: c => (c.player.shieldAbsorb > 0 ? no('active') : OK),
  fortify: c => (c.player.fortifyActive ? no('active') : OK),
  light_spell: c => (c.player.lightSpellTimer > 0 ? no('active') : OK),
  luminous_prayer: c => ((c.player.hp < c.player.max_hp || c.player.mana < c.player.max_mana) ? OK : no('active')),
  benediction: c => ((c.player.hp < c.player.max_hp || c.player.mana < c.player.max_mana) ? OK : no('active')),
  healing_prayer: c => (c.player.hp < c.player.max_hp ? OK : no('active')),
  poison_tip: c => (c.player.poisonTipArrows > 0 ? no('active') : OK),
};

function guardResolved(app, ref, ctx) {
  const player = app?.player || null;

  if (!ctx.item) return no('empty');
  if (!ctx.actionKey) return no('no-ability');
  if (!dispatchAllowed(app)) return no('inactive');
  if (!(player && player.hp > 0)) return no('dead');
  if (ref?.kind === 'active') return no('nonrepeatable');

  if (cooldownRemaining(player, ctx.actionKey) > 0) return no('cooldown');

  if (player.mana < manaCostFor(ctx.item, ctx.ability)) return no('mana');
  if (consumesArrowFor(ctx.item, ctx.catalogItem, ctx.ability) && !hasArrow(player)) return no('ammo');

  const check = BENEFIT_CHECKS[ctx.actionKey];
  if (!check) return no('no-target');

  const monsters = app?.monsters || [];
  const gridMap = app?.gridMap || null;
  return check({ app, player, item: ctx.item, catalogItem: ctx.catalogItem, ability: ctx.ability, monsters, gridMap });
}

/**
 * Evaluates every gate for one ability ref.
 * @returns {{ ok: boolean, reason: string }}
 *   reason ∈ ok|empty|inactive|dead|nonrepeatable|no-ability|cooldown|mana|ammo|no-target|active
 */
export function evaluateGuard(app, ref) {
  return guardResolved(app, ref, resolveAbilityRef(app, ref));
}

/**
 * The autofire repeat gate: repeatable equipment ability AND all guards pass.
 * A `false` result means the tick is skipped (no cast, no resource spent); the
 * caller keeps holding and re-checks next tick so a cooldown gap auto-resumes.
 */
export function canAutoFire(app, ref) {
  const ctx = resolveAbilityRef(app, ref);
  if (!isRepeatable(ref, ctx)) return false;
  return guardResolved(app, ref, ctx).ok;
}
