/**
 * Lokarta: Come Into The Light - Party Knockout & Revive System (LIV-41/LIV-44)
 *
 * Pure, browser-free owner of the party "downed" lifecycle. This is the ONE
 * module that flips a member between `alive` and `downed` (the `markDowned`
 * seam), evaluates a simultaneous full-party wipe, and ticks the interruptible
 * revive channel. Damage sites only clamp `hp`; they never set state.
 *
 * Contract:
 *   - A member at `hp <= 0` is `downed`: it stays in `player.party`, keeps its
 *     tile, cannot act, and is not targeted by monsters.
 *   - Control never lands on a downed member; `evaluateParty` hands control to a
 *     living ally when the active member falls.
 *   - A wipe is `player.party.every(m => m.hp <= 0)` at the same instant and
 *     nothing less; a solo party therefore wipes on its first down.
 *   - A downed member is recovered either by an adjacent ally channel (the fast
 *     active rescue) or by a per-member auto-revive timer (the guaranteed
 *     fallback): 10s/20s/30s by `downCount`, running during combat, cancelled by
 *     a completed ally revive, and reset only on exiting + re-entering a tower.
 *   - Everything is catalog-driven (`party_ai.json.revive`, `abilities.json`
 *     `canRevive`, `items.json` `effect.canRevive`). No per-class branches.
 *
 * Hot-path discipline: `markDowned` is O(1) per actor, `evaluateWipe` is
 * O(party) (<= ~4), and no closures/arrays are allocated per tick inside the
 * scalar helpers. No DOM, worker, storage, or timers.
 */

import { PARTY_AI_CATALOG, ABILITIES_CATALOG } from '../data/index.js';
import { activeMemberIndex, cycleActiveMember } from './party.js';
import { sameActor } from './faction.js';

/**
 * Documented, data-overridable baseline for the revive flow. Live values belong
 * in `party_ai.json` -> `revive`; this only covers a missing / partial catalog.
 */
export const DEFAULT_REVIVE_CONFIG = Object.freeze({
  enabled: true,
  channelSec: 2.0,
  cooldownSec: 6.0,
  manaCost: 25,
  hpPct: 0.3,
  manaPct: 0.25,
  graceSec: 1.0,
  idleSec: 3.0,
  safetyRadius: 8,
  interruptOnDamage: true,
  interruptOnMove: true,
  channelDecayMult: 2.0,
  reviveOnFloorTransition: true,
  bleedOutSec: 0,
  // LIV-52 time-based auto-revive: the guaranteed per-member fallback that
  // replaces the retired 45s self-stabilize net. `secs` is the escalation
  // schedule indexed by a member's `downCount` within the tower (1st -> secs[0]),
  // `capSec` clamps the last entry, `cancelledByAllyRevive` lets a completed
  // channel cancel the pending timer, and `resetOnTowerReentry` resets the count
  // only on exiting + re-entering a tower (never on revive or floor change).
  autoRevive: Object.freeze({
    enabled: true,
    secs: Object.freeze([10, 20, 30]),
    capSec: 30,
    resetOnTowerReentry: true,
    runsDuringCombat: true,
    cancelledByAllyRevive: true,
    hpPct: 0.25,
    manaPct: 0.25,
  }),
  // LIV-47 E3 "Vigils": generic revive-channel levers. `0` is a no-op for every
  // vocation that does not override them (Fighter sets dragTiles:1 /
  // damageReductionPct:0.25 in party_ai.json; no per-class branch reads them).
  dragTiles: 0,
  damageReductionPct: 0,
  boss: Object.freeze({ safetyRadius: 5, channelSec: 3.0 }),
  potion: Object.freeze({ enabled: true, itemId: 'health_potion', hpPct: 0.2 }),
});

/** Scalar revive config keys copied field-wise from catalog blocks. */
const REVIVE_NUMBER_KEYS = [
  'channelSec', 'cooldownSec', 'manaCost', 'hpPct', 'manaPct', 'graceSec',
  'idleSec', 'safetyRadius', 'channelDecayMult', 'bleedOutSec', 'dragTiles',
  'damageReductionPct',
];
const REVIVE_BOOL_KEYS = ['enabled', 'interruptOnDamage', 'interruptOnMove', 'reviveOnFloorTransition'];

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Merges a catalog `autoRevive` block over the baseline (field-wise). */
function applyAutoReviveBlock(current, block) {
  const cur = current || DEFAULT_REVIVE_CONFIG.autoRevive;
  const a = block && typeof block === 'object' ? block : {};
  const secs = Array.isArray(a.secs)
    ? a.secs.map((v) => toNumber(v, 0)).filter((v) => v > 0)
    : null;
  return {
    enabled: typeof a.enabled === 'boolean' ? a.enabled : cur.enabled,
    secs: secs && secs.length ? secs : cur.secs,
    capSec: toNumber(a.capSec, cur.capSec),
    resetOnTowerReentry: typeof a.resetOnTowerReentry === 'boolean' ? a.resetOnTowerReentry : cur.resetOnTowerReentry,
    runsDuringCombat: typeof a.runsDuringCombat === 'boolean' ? a.runsDuringCombat : cur.runsDuringCombat,
    cancelledByAllyRevive: typeof a.cancelledByAllyRevive === 'boolean' ? a.cancelledByAllyRevive : cur.cancelledByAllyRevive,
    hpPct: toNumber(a.hpPct, cur.hpPct),
    manaPct: toNumber(a.manaPct, cur.manaPct),
  };
}

/**
 * Escalating auto-revive window (seconds) for a member's `downCount` within the
 * tower: `secs[downCount - 1]`, clamped to the last entry, then capped at
 * `capSec`. `downCount <= 0` uses the first entry (a fresh down is the 1st).
 * Pure; no catalog lookup so it is safe to call from a per-tick path.
 * @param {object} autoRevive resolved `revive.autoRevive` block
 * @param {number} downCount per-member down counter within the tower
 * @returns {number} seconds until auto-revive
 */
export function autoReviveSecForCount(autoRevive, downCount) {
  const cfg = autoRevive || DEFAULT_REVIVE_CONFIG.autoRevive;
  const fallback = DEFAULT_REVIVE_CONFIG.autoRevive.secs;
  const secs = Array.isArray(cfg.secs) && cfg.secs.length ? cfg.secs : fallback;
  const idx = Math.min(Math.max(1, Math.floor(toNumber(downCount, 1))) - 1, secs.length - 1);
  const base = toNumber(secs[idx], secs[secs.length - 1]);
  const cap = toNumber(cfg.capSec, DEFAULT_REVIVE_CONFIG.autoRevive.capSec);
  return cap > 0 ? Math.min(base, cap) : base;
}

/**
 * Seconds a downed member has left before auto-revive (>= 0), derived from the
 * window stamped at `markDowned` time. This is the value the renderer drains, so
 * it is a lean scalar read with no config resolution. Returns 0 when the member
 * has no pending window.
 * @param {object} member
 * @param {number} elapsedSec current run clock
 * @returns {number}
 */
export function autoReviveRemainingSec(member, elapsedSec) {
  if (!member || typeof member !== 'object') return 0;
  const total = toNumber(member.autoReviveTotalSec, 0);
  if (!(total > 0)) return 0;
  const remaining = total - (toNumber(elapsedSec, 0) - toNumber(member.downedAtSec, 0));
  return remaining > 0 ? remaining : 0;
}

function applyReviveBlock(out, block) {
  if (!block || typeof block !== 'object') return;
  for (const key of REVIVE_NUMBER_KEYS) {
    if (block[key] !== undefined) out[key] = toNumber(block[key], out[key]);
  }
  for (const key of REVIVE_BOOL_KEYS) {
    if (typeof block[key] === 'boolean') out[key] = block[key];
  }
  if (block.autoRevive && typeof block.autoRevive === 'object') {
    out.autoRevive = applyAutoReviveBlock(out.autoRevive, block.autoRevive);
  }
  if (block.boss && typeof block.boss === 'object') {
    out.boss = {
      safetyRadius: toNumber(block.boss.safetyRadius, out.boss.safetyRadius),
      channelSec: toNumber(block.boss.channelSec, out.boss.channelSec),
    };
  }
  if (block.potion && typeof block.potion === 'object') {
    out.potion = {
      enabled: typeof block.potion.enabled === 'boolean' ? block.potion.enabled : out.potion.enabled,
      itemId: typeof block.potion.itemId === 'string' && block.potion.itemId ? block.potion.itemId : out.potion.itemId,
      hpPct: toNumber(block.potion.hpPct, out.potion.hpPct),
    };
  }
  if (block.callForHelp && typeof block.callForHelp === 'object') {
    out.callForHelp = { ...block.callForHelp };
  }
}

/**
 * Resolves the revive config for a vocation: baseline <- `party_ai.json.revive`
 * <- that vocation's optional `profiles[vocation].revive` override.
 * @param {string} [vocation]
 * @returns {object}
 */
export function resolveReviveConfig(vocation = null) {
  const out = {
    ...DEFAULT_REVIVE_CONFIG,
    boss: { ...DEFAULT_REVIVE_CONFIG.boss },
    potion: { ...DEFAULT_REVIVE_CONFIG.potion },
    autoRevive: { ...DEFAULT_REVIVE_CONFIG.autoRevive, secs: [...DEFAULT_REVIVE_CONFIG.autoRevive.secs] },
  };
  const catalogDefault = PARTY_AI_CATALOG && PARTY_AI_CATALOG.revive;
  applyReviveBlock(out, catalogDefault);
  const key = vocation ? String(vocation).toLowerCase() : null;
  const profile = key && PARTY_AI_CATALOG && PARTY_AI_CATALOG.profiles
    ? PARTY_AI_CATALOG.profiles[key]
    : null;
  if (profile) applyReviveBlock(out, profile.revive);
  return out;
}

/**
 * True when `member` is present and downed (explicit state or 0 HP). Both the
 * approved-plan `combatState` field and the tech-plan `lifeState` alias are
 * honored; the engine writes them together so they never diverge.
 */
export function isDowned(member) {
  if (!member || typeof member !== 'object') return false;
  if (member.combatState === 'downed' || member.lifeState === 'downed') return true;
  return !(Number(member.hp) > 0);
}

/** True when `member` is present and alive. */
export function isAlive(member) {
  return Boolean(member) && !isDowned(member);
}

/**
 * The single downed-transition seam (O(1)). Idempotent: a member already
 * `downed`, or one with `hp > 0`, is left untouched. Never removes the member,
 * never nulls its tile, and cancels any in-flight channel/target/timers.
 * @param {object} actor
 * @param {{ elapsedSec?: number, floor?: number }} [ctx]
 * @returns {boolean} true when the actor transitioned this call
 */
export function markDowned(actor, ctx = {}) {
  if (!actor || typeof actor !== 'object') return false;
  if (actor.combatState === 'downed' || actor.lifeState === 'downed') return false;
  if (Number(actor.hp) > 0) return false;
  const auto = resolveReviveConfig(actor.vocation).autoRevive;
  actor.combatState = 'downed';
  actor.lifeState = 'downed';
  actor.hp = 0;
  actor.downedAtSec = toNumber(ctx.elapsedSec, 0);
  actor.downedFloor = toNumber(ctx.floor, toNumber(actor.current_floor, 1));
  actor.reviveGraceSec = 0;
  actor.aiTargetId = null;
  actor.aiRetargetTimer = 0;
  actor.stunTimer = 0;
  actor._reviveTargetId = null;
  actor._reviveProgressSec = 0;
  actor._reviveBlocked = false;
  actor._reviveDraggedTiles = 0;
  // LIV-52: every down increments the per-member escalation counter (it is never
  // reset on revive, only on exiting + re-entering a tower) and stamps the
  // auto-revive window the timer drains.
  actor.downCount = Math.max(0, Math.floor(toNumber(actor.downCount, 0))) + 1;
  const total = autoReviveSecForCount(auto, actor.downCount);
  actor.autoReviveTotalSec = auto.enabled ? total : 0;
  actor.autoReviveRemainingSec = auto.enabled ? total : 0;
  return true;
}

/**
 * Restores a downed member to `hpPct` / `manaPct` of max with the grace window
 * and clears all downed/channel bookkeeping. Idempotent on an alive member.
 * @param {object} member
 * @param {object} config resolved revive config
 * @returns {object|null} the member
 */
export function applyRevive(member, config = DEFAULT_REVIVE_CONFIG) {
  if (!member || typeof member !== 'object') return null;
  const maxHp = toNumber(member.max_hp, 0);
  const maxMana = toNumber(member.max_mana, 0);
  const hpPct = toNumber(config.hpPct, DEFAULT_REVIVE_CONFIG.hpPct);
  const manaPct = toNumber(config.manaPct, DEFAULT_REVIVE_CONFIG.manaPct);
  member.hp = Math.max(1, Math.ceil(maxHp * hpPct));
  member.mana = Math.max(0, Math.ceil(maxMana * manaPct));
  member.combatState = 'active';
  member.lifeState = 'alive';
  member.downedAtSec = 0;
  // LIV-52: a completed revive (ally channel or auto-revive) cancels any pending
  // auto-revive window. `downCount` is deliberately NOT reset here — the
  // escalation persists across revives until the tower is re-entered.
  member.autoReviveTotalSec = 0;
  member.autoReviveRemainingSec = 0;
  member.reviveGraceSec = toNumber(config.graceSec, DEFAULT_REVIVE_CONFIG.graceSec);
  member.aiTargetId = null;
  member.aiRetargetTimer = 0;
  return member;
}

/**
 * Wipe predicate: true iff every member of the party is down at the same
 * instant. The live active member's `hp` is read from the top-level player when
 * its party mirror is stale. A party with no members falls back to the
 * top-level player's own `hp` (legacy/solo).
 * @param {object} player
 * @returns {boolean}
 */
export function evaluateWipe(player) {
  if (!player || typeof player !== 'object') return false;
  const party = Array.isArray(player.party) ? player.party : null;
  if (!party || party.length === 0) return !(Number(player.hp) > 0);
  const activeIdx = activeMemberIndex(player);
  for (let i = 0; i < party.length; i++) {
    const member = party[i];
    if (!member) return false;
    const hp = i === activeIdx ? Number(player.hp) : Number(member.hp);
    if (hp > 0) return false;
  }
  return true;
}

/** True when the party has at least one living member. */
export function hasLivingMember(player) {
  if (!player || !Array.isArray(player.party)) return Number(player && player.hp) > 0;
  const activeIdx = activeMemberIndex(player);
  for (let i = 0; i < player.party.length; i++) {
    const member = player.party[i];
    if (!member) continue;
    const hp = i === activeIdx ? Number(player.hp) : Number(member.hp);
    if (hp > 0) return true;
  }
  return false;
}

/** Orthogonal (manhattan === 1) adjacency between two actors. */
export function orthogonalAdjacent(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

/**
 * LIV-47 "Drag to Safety" damage lever (pure). A living reviver actively
 * channeling a revive (`_reviveTargetId` set) benefits from its resolved
 * `damageReductionPct`; every other actor — and every vocation without the
 * override — resolves to 0, so the combat seam is a no-op by default. No
 * vocation branch: identity is data via `resolveReviveConfig`.
 * @param {object} reviver candidate damage target
 * @param {object} [config] resolved revive config; resolved from the actor when omitted
 * @returns {number} 0..1 incoming-damage reduction fraction
 */
export function reviverChannelDamageReduction(reviver, config = null) {
  if (!reviver || !reviver._reviveTargetId) return 0;
  if (isDowned(reviver)) return 0;
  const cfg = config || resolveReviveConfig(reviver.vocation);
  const pct = toNumber(cfg.damageReductionPct, 0);
  return pct > 0 ? Math.min(1, pct) : 0;
}

/**
 * True when no living actor already stands on (x, y). Checks living monsters
 * and every party member except `self`, and requires the tile to be in bounds
 * and walkable when a `gridMap` is supplied (without one the drag is skipped,
 * since walkability cannot be proven).
 * @param {object} ctx `{ gridMap, monsters }`
 * @param {object} player top-level player (party owner)
 * @param {number} x
 * @param {number} y
 * @param {object} self the actor being displaced (never blocks itself)
 * @returns {boolean}
 */
function dragDestinationFree(ctx, player, x, y, self) {
  const grid = ctx && ctx.gridMap;
  if (!grid || typeof grid.isWalkable !== 'function') return false;
  if (typeof grid.isInBounds === 'function' && !grid.isInBounds(x, y)) return false;
  if (!grid.isWalkable(x, y)) return false;
  const monsters = ctx && ctx.monsters;
  if (Array.isArray(monsters)) {
    for (let i = 0; i < monsters.length; i++) {
      const m = monsters[i];
      if (m && m.hp > 0 && m.x === x && m.y === y) return false;
    }
  }
  const party = player && Array.isArray(player.party) ? player.party : null;
  if (party) {
    for (let i = 0; i < party.length; i++) {
      const m = party[i];
      if (!m || m === self) continue;
      if (m.x === x && m.y === y) return false;
    }
  }
  return true;
}

/**
 * LIV-47 "Drag to Safety": displace the downed `target` one orthogonal tile
 * toward `reviver`, bounded to `cfg.dragTiles` tiles over the whole channel and
 * guarded against walls/occupied tiles. A single step per live tick; a broken
 * channel does not drag. Returns true when the target actually moved.
 */
function dragTargetTowardReviver(reviver, target, player, ctx, cfg) {
  const maxDrag = Math.floor(toNumber(cfg.dragTiles, 0));
  if (!(maxDrag > 0)) return false;
  const dragged = toNumber(reviver._reviveDraggedTiles, 0);
  if (dragged >= maxDrag) return false;

  const dx = reviver.x - target.x;
  const dy = reviver.y - target.y;
  if (dx === 0 && dy === 0) return false;

  // Prefer the dominant axis; fall back to the other when the first is blocked.
  const steps = Math.abs(dx) >= Math.abs(dy)
    ? [[Math.sign(dx), 0], [0, Math.sign(dy)]]
    : [[0, Math.sign(dy)], [Math.sign(dx), 0]];
  for (let i = 0; i < steps.length; i++) {
    const sx = steps[i][0];
    const sy = steps[i][1];
    if (sx === 0 && sy === 0) continue;
    const nx = target.x + sx;
    const ny = target.y + sy;
    if (!dragDestinationFree(ctx, player, nx, ny, target)) continue;
    target.x = nx;
    target.y = ny;
    reviver._reviveDraggedTiles = dragged + 1;
    return true;
  }
  return false;
}

/** True when any living monster stands within `radius` of (x, y). */
export function hasLivingHostileWithin(monsters, x, y, radius) {
  if (!Array.isArray(monsters)) return false;
  const r = Number(radius);
  if (!(r > 0)) return false;
  for (let i = 0; i < monsters.length; i++) {
    const m = monsters[i];
    if (!m || !(m.hp > 0)) continue;
    if (Math.hypot(m.x - x, m.y - y) <= r) return true;
  }
  return false;
}

/**
 * Revive-start gate: no living hostile within `safetyRadius` of the downed
 * member AND no damage dealt/taken for `idleSec`. Pure predicate; the caller
 * supplies `ctx.monsters` and `ctx.combatIdleSec`.
 * @param {object} target downed member
 * @param {object} ctx
 * @param {object} [config]
 * @returns {boolean}
 */
export function canStartRevive(target, ctx = {}, config = null) {
  const cfg = config || resolveReviveConfig(target && target.vocation);
  if (!cfg.enabled) return false;
  if (!target || !isDowned(target)) return false;
  if (toNumber(ctx.combatIdleSec, 0) < cfg.idleSec) return false;
  const radius = toNumber(cfg.safetyRadius, DEFAULT_REVIVE_CONFIG.safetyRadius);
  if (hasLivingHostileWithin(ctx.monsters, target.x, target.y, radius)) return false;
  return true;
}

/** First ready `canRevive` heal ability for the member, or null. */
export function findReviveAbility(member, config) {
  if (!member) return null;
  const vocation = member.vocation ? String(member.vocation).toLowerCase() : null;
  for (const id of Object.keys(ABILITIES_CATALOG)) {
    const spec = ABILITIES_CATALOG[id];
    if (!spec || spec.canRevive !== true) continue;
    if (spec.type && spec.type !== 'heal') continue;
    if (vocation && spec.vocation && spec.vocation !== vocation) continue;
    const cost = toNumber(spec.manaCost, toNumber(config && config.manaCost, 0));
    if (toNumber(member.mana, 0) < cost) continue;
    const cooldownKey = spec.actionKey || id;
    if (toNumber(member.cooldowns && member.cooldowns[cooldownKey], 0) > 0) continue;
    return spec;
  }
  return null;
}

/** First shared-backpack consumable flagged `canRevive`, or null. */
export function findRevivePotion(player, config) {
  const potion = config && config.potion;
  if (potion && potion.enabled === false) return null;
  const itemId = (potion && potion.itemId) || 'health_potion';
  const lists = [player && player.action_bar, player && player.backpack];
  for (let l = 0; l < lists.length; l++) {
    const list = lists[l];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item) continue;
      const flagged = item.effect && item.effect.canRevive === true;
      if (!flagged && item.item_id !== itemId) continue;
      return { item, list, index: i, itemId: item.item_id || itemId };
    }
  }
  return null;
}

/** A ready revive source for the member ({ kind }), or null. */
export function selectReviveSource(member, config, ctx = {}) {
  const ability = findReviveAbility(member, config);
  if (ability) return { kind: 'ability', spec: ability };
  const potion = findRevivePotion(ctx.active, config);
  if (potion) return { kind: 'potion', potion };
  return null;
}

/** True when the member can currently revive (has a ready source). */
export function hasReviveSource(member, config, ctx = {}) {
  return selectReviveSource(member, config, ctx) !== null;
}

/**
 * Spends the chosen revive source: ability -> mana + `cooldownSec`; potion ->
 * consumed from the shared backpack. Mutates; returns true on success.
 */
export function consumeReviveSource(member, source, config) {
  if (!member || !source) return false;
  if (source.kind === 'ability' && source.spec) {
    const cost = toNumber(source.spec.manaCost, toNumber(config && config.manaCost, 0));
    member.mana = Math.max(0, toNumber(member.mana, 0) - cost);
    const cooldownKey = source.spec.actionKey || source.spec.id;
    if (!member.cooldowns) member.cooldowns = {};
    member.cooldowns[cooldownKey] = toNumber(config && config.cooldownSec, DEFAULT_REVIVE_CONFIG.cooldownSec);
    return true;
  }
  if (source.kind === 'potion' && source.potion) {
    const { item, list, index } = source.potion;
    if (toNumber(item.quantity, 1) > 1) item.quantity -= 1;
    else list[index] = null;
    return true;
  }
  return false;
}

/** Clears a reviver's channel bookkeeping. */
export function clearReviveChannel(reviver) {
  if (!reviver) return;
  reviver._reviveTargetId = null;
  reviver._reviveProgressSec = 0;
  reviver._reviveBlocked = false;
  reviver._reviveDraggedTiles = 0;
}

/**
 * Starts (or resumes) a revive channel. Progress is preserved when the same
 * target is re-targeted; a fresh target resets it.
 */
export function beginRevive(reviver, target, config = DEFAULT_REVIVE_CONFIG) {
  if (!reviver || !target) return false;
  const targetId = target.memberId || target.id || null;
  if (reviver._reviveTargetId !== targetId) {
    reviver._reviveProgressSec = 0;
    reviver._reviveDraggedTiles = 0;
  }
  reviver._reviveTargetId = targetId;
  reviver._reviveBlocked = false;
  reviver._reviveStartHp = toNumber(reviver.hp, 0);
  reviver._reviveX = reviver.x;
  reviver._reviveY = reviver.y;
  return true;
}

/** Member on the party with `targetId`, or null. */
export function findPartyMemberById(player, targetId) {
  if (!player || !Array.isArray(player.party) || !targetId) return null;
  for (let i = 0; i < player.party.length; i++) {
    const m = player.party[i];
    if (m && m.memberId === targetId) return m;
  }
  return null;
}

/**
 * Advances one reviver's channel by `deltaSec`. Returns an event when the
 * channel completes (`revived`) or breaks (`reviveInterrupted`), else null.
 *
 * Interrupts (progress retained, decays at `channelDecayMult` while broken):
 * reviver damage, reviver move, hostiles re-entering `safetyRadius`, or the
 * reviver losing orthogonal adjacency.
 *
 * LIV-47 "Drag to Safety": when the resolved `dragTiles > 0` (Fighter), a live
 * channel also pulls the downed `target` toward the reviver, one orthogonal step
 * per tick up to `dragTiles` total, only onto a walkable/unoccupied tile.
 */
export function tickReviveChannel(reviver, player, ctx = {}, config = null) {
  if (!reviver || !reviver._reviveTargetId) return null;
  const cfg = config || resolveReviveConfig(reviver.vocation);
  const deltaSec = toNumber(ctx.deltaSec, 0);
  const target = findPartyMemberById(player, reviver._reviveTargetId);
  if (!target || !isDowned(target) || isDowned(reviver)) {
    clearReviveChannel(reviver);
    return null;
  }

  const wasBlocked = reviver._reviveBlocked === true;

  // LIV-47 "Drag to Safety": a live (unbroken) channel pulls the downed body up
  // to `dragTiles` orthogonal steps toward the reviver. Only the reviver's own
  // movement interrupts the channel (`interruptOnMove`), never the dragged body.
  if (!wasBlocked && toNumber(cfg.dragTiles, 0) > 0) {
    dragTargetTowardReviver(reviver, target, player, ctx, cfg);
  }

  const adjacency = orthogonalAdjacent(reviver, target);
  const moved = cfg.interruptOnMove
    && (reviver.x !== reviver._reviveX || reviver.y !== reviver._reviveY);
  const damaged = cfg.interruptOnDamage
    && toNumber(reviver.hp, 0) < toNumber(reviver._reviveStartHp, 0);
  const hostileNear = hasLivingHostileWithin(ctx.monsters, target.x, target.y, cfg.safetyRadius);

  if (!adjacency || moved || damaged || hostileNear) {
    reviver._reviveBlocked = true;
  }

  if (reviver._reviveBlocked) {
    const decay = toNumber(cfg.channelDecayMult, DEFAULT_REVIVE_CONFIG.channelDecayMult) * deltaSec;
    reviver._reviveProgressSec = Math.max(0, toNumber(reviver._reviveProgressSec, 0) - decay);
    reviver._reviveStartHp = toNumber(reviver.hp, 0);
    reviver._reviveX = reviver.x;
    reviver._reviveY = reviver.y;
    // Emit the break only on the transition into the blocked state (not every
    // decaying tick), so the app does not spam the cue.
    return wasBlocked ? null : { type: 'reviveInterrupted', member: reviver, target };
  }

  reviver._reviveStartHp = toNumber(reviver.hp, 0);
  reviver._reviveX = reviver.x;
  reviver._reviveY = reviver.y;
  reviver._reviveProgressSec = toNumber(reviver._reviveProgressSec, 0) + deltaSec;

  if (reviver._reviveProgressSec >= toNumber(cfg.channelSec, DEFAULT_REVIVE_CONFIG.channelSec)) {
    const source = selectReviveSource(reviver, cfg, ctx);
    consumeReviveSource(reviver, source, cfg);
    applyRevive(target, cfg);
    clearReviveChannel(reviver);
    return { type: 'revived', member: target, reviver };
  }
  return null;
}

/**
 * Funnels every 0-HP party member through `markDowned` (active mirror
 * included, synced onto its party entry by reference so no full capture is
 * needed). Idempotent and O(party); safe to call before the ally AI so the
 * revive planner can see the downed state.
 * @param {object} player
 * @param {{ elapsedSec?: number, floor?: number }} [ctx]
 * @returns {boolean} true when any member transitioned this call
 */
export function markPartyDowned(player, ctx = {}) {
  if (!player || !Array.isArray(player.party)) return false;
  const party = player.party;
  const activeIdx = activeMemberIndex(player);
  const markCtx = {
    elapsedSec: toNumber(ctx.elapsedSec, 0),
    floor: toNumber(ctx.floor, toNumber(player.current_floor, 1)),
  };
  let changed = false;
  for (let i = 0; i < party.length; i++) {
    const member = party[i];
    if (!member) continue;
    if (i === activeIdx) {
      if (markDowned(player, markCtx)) {
        member.combatState = 'downed';
        member.lifeState = 'downed';
        member.hp = 0;
        member.downedAtSec = player.downedAtSec;
        member.downedFloor = player.downedFloor;
        member.reviveGraceSec = 0;
        member.downCount = player.downCount;
        member.autoReviveTotalSec = player.autoReviveTotalSec;
        member.autoReviveRemainingSec = player.autoReviveRemainingSec;
        changed = true;
      }
    } else if (markDowned(member, markCtx)) {
      changed = true;
    }
  }
  return changed;
}

/**
 * The single per-tick party step. Runs after all ally/monster updates and:
 *   1. funnels every 0-HP member through `markDowned` (active mirror included);
 *   2. hands control to a living ally when the active member falls;
 *   3. evaluates the simultaneous full-party wipe FIRST (a solo party ejects on
 *      its first down and never auto-revives);
 *   4. ticks interruptible revive channels + the per-member auto-revive timer.
 *
 * @param {object} player top-level (active-authoritative) player
 * @param {object} [ctx] { deltaSec, elapsedSec, monsters, combatIdleSec, active, floor, gridMap }
 * @returns {{ wiped: boolean, handoff: object|null, events: object[] }}
 */
export function evaluateParty(player, ctx = {}) {
  const result = { wiped: false, handoff: null, events: [] };
  if (!player || !Array.isArray(player.party)) return result;
  const party = player.party;
  const activeIdx = activeMemberIndex(player);
  const markCtx = { elapsedSec: toNumber(ctx.elapsedSec, 0), floor: toNumber(ctx.floor, toNumber(player.current_floor, 1)) };

  // 1. Down seam (idempotent; may already have run before the ally AI).
  markPartyDowned(player, ctx);

  // 2. Active-down control handoff (never lands on a downed member).
  if (activeIdx >= 0) {
    const active = party[activeIdx];
    if (active && isDowned(active) && hasLivingMember(player)) {
      const next = cycleActiveMember(player, 1);
      if (next) result.handoff = next;
    }
  }

  // 3. Wipe is evaluated before any revive: a simultaneous all-down is an
  //    immediate eject (a solo party wipes on its first down, never
  //    auto-revives). Only a surviving member keeps the run alive, so the timer
  //    can never nullify a wipe.
  result.wiped = evaluateWipe(player);
  if (result.wiped) return result;

  // 4. Channels + auto-revive. Channels belong to the living reviver; the
  //    per-member auto-revive timer belongs to each downed body and is the
  //    guaranteed fallback (it runs during combat, unlike the channel gate).
  for (let i = 0; i < party.length; i++) {
    const member = party[i];
    if (!member) continue;
    if (isAlive(member)) {
      const ev = tickReviveChannel(member, player, ctx, resolveReviveConfig(member.vocation));
      if (ev) result.events.push(ev);
      continue;
    }
    const cfg = resolveReviveConfig(member.vocation);
    const auto = cfg.autoRevive;
    if (!auto.enabled) continue;
    const total = toNumber(member.autoReviveTotalSec, 0) > 0
      ? toNumber(member.autoReviveTotalSec, 0)
      : autoReviveSecForCount(auto, member.downCount);
    if (!(member.autoReviveTotalSec > 0)) member.autoReviveTotalSec = total;
    const remaining = total - (markCtx.elapsedSec - toNumber(member.downedAtSec, markCtx.elapsedSec));
    member.autoReviveRemainingSec = remaining > 0 ? remaining : 0;
    if (remaining <= 0) {
      applyRevive(member, { ...cfg, hpPct: auto.hpPct, manaPct: auto.manaPct });
      if (i === activeIdx) syncActiveMirror(player, member);
      result.events.push({ type: 'autoRevive', member });
    }
  }
  return result;
}

/**
 * LIV-52 tower-reentry reset: clears each member's `downCount` (and the derived
 * auto-revive window), so the first down in a freshly entered tower is 10s
 * again. Called ONLY on exiting + re-entering a tower — never on revive, floor
 * change, or save/load. Returns true when anything changed.
 * @param {object} player
 * @returns {boolean}
 */
export function resetAutoReviveCounts(player) {
  if (!player || typeof player !== 'object') return false;
  let changed = false;
  const reset = (m) => {
    if (!m || typeof m !== 'object') return;
    if (Math.floor(toNumber(m.downCount, 0)) !== 0
      || toNumber(m.autoReviveTotalSec, 0) !== 0
      || toNumber(m.autoReviveRemainingSec, 0) !== 0) {
      m.downCount = 0;
      m.autoReviveTotalSec = 0;
      m.autoReviveRemainingSec = 0;
      changed = true;
    }
  };
  if (Array.isArray(player.party)) {
    for (let i = 0; i < player.party.length; i++) reset(player.party[i]);
  }
  reset(player);
  return changed;
}

/** Copies a revived party entry's resources onto the top-level active mirror. */
function syncActiveMirror(player, member) {
  if (!player || !member || !sameActor(player, member)) return;
  player.hp = member.hp;
  player.mana = member.mana;
  player.combatState = member.combatState;
  player.lifeState = member.lifeState;
  player.downedAtSec = member.downedAtSec;
  player.reviveGraceSec = member.reviveGraceSec;
  player.downCount = member.downCount;
  player.autoReviveTotalSec = member.autoReviveTotalSec;
  player.autoReviveRemainingSec = member.autoReviveRemainingSec;
}

/** Convenience barrel for consumers that prefer a namespace. */
export const ReviveSystem = {
  DEFAULT_REVIVE_CONFIG,
  resolveReviveConfig,
  isDowned,
  isAlive,
  markDowned,
  markPartyDowned,
  applyRevive,
  evaluateWipe,
  hasLivingMember,
  autoReviveSecForCount,
  autoReviveRemainingSec,
  resetAutoReviveCounts,
  orthogonalAdjacent,
  reviverChannelDamageReduction,
  hasLivingHostileWithin,
  canStartRevive,
  findReviveAbility,
  findRevivePotion,
  selectReviveSource,
  hasReviveSource,
  consumeReviveSource,
  beginRevive,
  tickReviveChannel,
  clearReviveChannel,
  findPartyMemberById,
  evaluateParty,
};
