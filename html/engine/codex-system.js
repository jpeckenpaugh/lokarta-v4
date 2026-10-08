/**
 * Lokarta: Come Into The Light - Bestiary / Codex System (I10)
 *
 * Pure, browser-free model for the in-game codex. It resolves discovered foes
 * against the authored catalogs and records first defeats on the save envelope.
 *
 * Data flow (no duplicated stats):
 *   - `codex.json` references a foe by `id` and authors only the player-facing
 *     reading aids (`role`, `tier`, `silhouette`, `telegraph`).
 *   - `monsters.json` remains the single source of a foe's name, sprite,
 *     `svgCode`, and mechanical stats. The codex never copies them.
 *   - The player envelope carries `discoveredFoeIds` (an array of foe `type`
 *     ids), so discovery rides the existing character save. A foe is recorded
 *     only when it is defeated, which is what keeps the codex spoiler-free.
 *
 * Nothing here touches the DOM, storage, or timers — it is the exact surface
 * the native `node --test` suite exercises. See `modal-manager.js` for the
 * renderer.
 */

import { CODEX_CATALOG, MONSTERS_CATALOG } from '../data/index.js';

const ROLES = (CODEX_CATALOG && CODEX_CATALOG.roles) || {};
const TIERS = (CODEX_CATALOG && CODEX_CATALOG.tiers) || {};
const ENTRIES = (CODEX_CATALOG && CODEX_CATALOG.entries) || {};
const FALLBACK_ROLE_KEY = 'unknown';

/** True when `monsterId` is an authored monster catalog id. */
export function isCodexFoeId(monsterId) {
  return typeof monsterId === 'string' && Boolean(MONSTERS_CATALOG && MONSTERS_CATALOG[monsterId]);
}

/** Resolves a codex role descriptor (`{ key, name, summary }`), with a fallback. */
export function resolveCodexRole(roleKey) {
  const key = roleKey && ROLES[roleKey] ? roleKey : FALLBACK_ROLE_KEY;
  const role = ROLES[key] || { name: 'Uncatalogued', summary: '' };
  return { key, ...role };
}

/** Resolves a codex tier descriptor (`{ key, name, summary? }`), with a fallback. */
export function resolveCodexTier(tierKey) {
  const key = tierKey && TIERS[tierKey] ? tierKey : 'normal';
  const tier = TIERS[key] || { name: 'Common' };
  return { key, ...tier };
}

/**
 * Builds the full resolved codex entry for a foe, or null when the id is not an
 * authored monster. Name/icon come from `monsters.json`; reading aids come from
 * `codex.json` with a safe fallback for an unauthored foe.
 * @param {string} monsterId
 * @returns {object|null}
 */
export function getCodexEntry(monsterId) {
  const monster = MONSTERS_CATALOG && MONSTERS_CATALOG[monsterId];
  if (!monster) return null;
  const authored = ENTRIES[monsterId] || {};
  const role = resolveCodexRole(authored.role);
  const tier = resolveCodexTier(authored.tier);
  return {
    id: monsterId,
    name: monster.name || monsterId,
    icon: monster.svgCode || null,
    spriteId: monster.spriteId || null,
    role: role.key,
    roleName: role.name,
    roleSummary: role.summary || '',
    tier: tier.key,
    tierName: tier.name,
    tierSummary: tier.summary || '',
    silhouette: authored.silhouette || '',
    telegraph: authored.telegraph || '',
  };
}

/** Every authored monster as a resolved codex entry, in monster catalog order. */
export function listCodexEntries() {
  if (!MONSTERS_CATALOG) return [];
  const out = [];
  for (const id of Object.keys(MONSTERS_CATALOG)) {
    const entry = getCodexEntry(id);
    if (entry) out.push(entry);
  }
  return out;
}

/** Total number of recordable foes (the codex denominator). */
export function codexEntryCount() {
  return MONSTERS_CATALOG ? Object.keys(MONSTERS_CATALOG).length : 0;
}

/**
 * Normalizes a raw persisted `discoveredFoeIds` value into a clean, deduped
 * array of known monster ids, ordered by the monster catalog so storage order
 * never leaks into presentation. Never throws.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeDiscoveredFoeIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const id of raw) {
    if (isCodexFoeId(id)) seen.add(id);
  }
  const ordered = [];
  if (MONSTERS_CATALOG) {
    for (const id of Object.keys(MONSTERS_CATALOG)) {
      if (seen.has(id)) ordered.push(id);
    }
  }
  // Preserve the caller's array reference when it is already clean so callers
  // (and `migratePlayerParty`) can detect a true no-op by identity.
  if (ordered.length === raw.length) {
    let same = true;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i] !== raw[i]) { same = false; break; }
    }
    if (same) return raw;
  }
  return ordered;
}

/** True when the player has already recorded `monsterId`. */
export function isFoeDiscovered(player, monsterId) {
  if (!isCodexFoeId(monsterId) || !player) return false;
  const list = player.discoveredFoeIds;
  return Array.isArray(list) && list.includes(monsterId);
}

/**
 * Records a first defeat of `monsterId` on the player envelope. Idempotent and
 * non-mutating: returns the same `player` reference when nothing changed, or a
 * shallow copy with the ordered, deduped `discoveredFoeIds` when it did.
 * @param {object|null} player
 * @param {string} monsterId
 * @returns {{ player: object|null, isNew: boolean }}
 */
export function recordFoeDiscovery(player, monsterId) {
  if (!player || !isCodexFoeId(monsterId)) {
    return { player, isNew: false };
  }
  const current = normalizeDiscoveredFoeIds(player.discoveredFoeIds);
  if (current.includes(monsterId)) {
    // Heal a missing/mis-ordered list in one shot without reporting a new entry.
    if (Array.isArray(player.discoveredFoeIds) && player.discoveredFoeIds.length === current.length) {
      return { player, isNew: false };
    }
    return { player: { ...player, discoveredFoeIds: current }, isNew: false };
  }
  const seen = new Set(current);
  seen.add(monsterId);
  const next = normalizeDiscoveredFoeIds([...seen]);
  return { player: { ...player, discoveredFoeIds: next }, isNew: true };
}

/**
 * Resolved codex entries for foes the player has defeated, in catalog order.
 * This is what the UI renders: undiscovered foes are never included.
 * @param {object|null} player
 * @returns {object[]}
 */
export function listDiscoveredCodexEntries(player) {
  const discovered = new Set(normalizeDiscoveredFoeIds(player && player.discoveredFoeIds));
  return listCodexEntries().filter((entry) => discovered.has(entry.id));
}

/** `{ discovered, total }` progress for the codex header. */
export function codexProgress(player) {
  const discovered = normalizeDiscoveredFoeIds(player && player.discoveredFoeIds).length;
  return { discovered, total: codexEntryCount() };
}
