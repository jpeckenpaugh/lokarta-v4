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
  selfReviveSec: 45,
  selfReviveHpPct: 0.15,
  bleedOutSec: 0,
  boss: Object.freeze({ safetyRadius: 5, channelSec: 3.0 }),
  potion: Object.freeze({ enabled: true, itemId: 'health_potion', hpPct: 0.2 }),
});

/** Scalar revive config keys copied field-wise from catalog blocks. */
const REVIVE_NUMBER_KEYS = [
  'channelSec', 'cooldownSec', 'manaCost', 'hpPct', 'manaPct', 'graceSec',
  'idleSec', 'safetyRadius', 'channelDecayMult', 'selfReviveSec',
  'selfReviveHpPct', 'bleedOutSec',
];
const REVIVE_BOOL_KEYS = ['enabled', 'interruptOnDamage', 'interruptOnMove', 'reviveOnFloorTransition'];

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function applyReviveBlock(out, block) {
  if (!block || typeof block !== 'object') return;
  for (const key of REVIVE_NUMBER_KEYS) {
    if (block[key] !== undefined) out[key] = toNumber(block[key], out[key]);
  }
  for (const key of REVIVE_BOOL_KEYS) {
    if (typeof block[key] === 'boolean') out[key] = block[key];
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
  const out = { ...DEFAULT_REVIVE_CONFIG, boss: { ...DEFAULT_REVIVE_CONFIG.boss }, potion: { ...DEFAULT_REVIVE_CONFIG.potion } };
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
 *      its first down and never self-stabilizes);
 *   4. ticks interruptible revive channels + the self-stabilize safety net.
 *
 * @param {object} player top-level (active-authoritative) player
 * @param {object} [ctx] { deltaSec, elapsedSec, monsters, combatIdleSec, active, floor }
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
  //    self-stabilizes). Only a surviving member keeps the run alive.
  result.wiped = evaluateWipe(player);
  if (result.wiped) return result;

  // 4. Channels + self-stabilize. Channels belong to the reviver; self-revive
  //    belongs to the downed member and is a last-resort safety net.
  for (let i = 0; i < party.length; i++) {
    const member = party[i];
    if (!member) continue;
    if (isAlive(member)) {
      const ev = tickReviveChannel(member, player, ctx, resolveReviveConfig(member.vocation));
      if (ev) result.events.push(ev);
      continue;
    }
    const cfg = resolveReviveConfig(member.vocation);
    if (cfg.selfReviveSec > 0
      && (markCtx.elapsedSec - toNumber(member.downedAtSec, markCtx.elapsedSec)) >= cfg.selfReviveSec) {
      applyRevive(member, { ...cfg, hpPct: cfg.selfReviveHpPct, manaPct: 0 });
      if (i === activeIdx) syncActiveMirror(player, member);
      result.events.push({ type: 'selfRevive', member });
    }
  }
  return result;
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
  orthogonalAdjacent,
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
