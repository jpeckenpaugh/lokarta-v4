/**
 * Lokarta: Come Into The Light - Scene Monster Spawner
 *
 * Pure, browser-free planning of the visible roaming monsters that live in an
 * overworld scene (decision D3, Zelda-style). Zones/elites are catalog data
 * (`islands.json` `spawnZones` / `questSpawns`); this module only turns that
 * data into deterministic spawn descriptors. Placement is reproducible from the
 * scene id (Mulberry32), and the plan is recomputed to top a zone back up to
 * `maxAlive` — roamers respawn forever so XP can never be exhausted.
 */

import { MONSTERS_CATALOG, getQuestDefinition } from '../data/index.js';
import { MONSTER_FACTION } from '../engine/faction.js';
import { createPRNG } from './floor-generator.js';
import { isCodeWalkable } from './scene-composer.js';
import { QUEST_STATUS, getQuestStatus, getObjectiveCount } from '../engine/quest-system.js';

/** djb2 string hash -> unsigned 32-bit seed (deterministic scene placement). */
export function seedFromString(str) {
  let hash = 5381;
  const text = String(str || '');
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash >>> 0;
}

/**
 * Builds a runtime monster object from the catalog, shaped like the tower
 * floor generator's `buildMonster` so every combat/AI/render path works
 * unchanged. `visible` is forced true because ambient outdoor scenes skip the
 * fog pass that would otherwise reveal monsters.
 */
export function makeSceneMonster(type, x, y, id, extra = {}) {
  const base = MONSTERS_CATALOG[type] || MONSTERS_CATALOG.giant_rat;
  return {
    id,
    type,
    name: base.name,
    faction: base.faction || MONSTER_FACTION,
    x,
    y,
    hp: base.baseHp,
    max_hp: base.baseHp,
    attack: base.baseAttack,
    defense: base.baseDefense,
    damageScale: 1,
    facing: 'down',
    isAggroed: false,
    attackCooldown: 0,
    moveCooldown: 0,
    attackCadence: base.attackCadence,
    moveCadence: base.moveCadence,
    isElite: base.isElite === true,
    isBoss: base.isBoss === true,
    spriteId: base.spriteId || null,
    visible: true,
    ...extra,
  };
}

/** True when the quest's kill objective for `monsterType` is already complete. */
function questKillSatisfied(questState, questDef, monsterType) {
  const obj = (questDef?.objectives || []).find(
    (o) => o.type === 'kill' && o.targetMonsterType === monsterType
  );
  if (!obj) return false;
  return getObjectiveCount(questState, questDef.id, obj.id) >= (Number(obj.count) || 1);
}

/** Integer-hash of a scene tile, or null when out of bounds/non-walkable. */
function walkableHash(scene, x, y) {
  const row = scene.tiles[y];
  if (!row || !isCodeWalkable(row[x])) return null;
  return y * scene.width + x;
}

/**
 * Nearest free walkable tile to `(cx, cy)`, ring by ring (Manhattan shell
 * order). Authored elite coordinates are anchors: if a decor tile sits on the
 * exact spot, the elite lands beside it instead of failing to spawn.
 */
function nearestWalkableHash(scene, cx, cy, occupied, maxRing = 6) {
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let manhattan = ring; manhattan <= 2 * ring; manhattan++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          if (Math.abs(dx) + Math.abs(dy) !== manhattan) continue;
          const hash = walkableHash(scene, cx + dx, cy + dy);
          if (hash === null) continue;
          if (occupied && occupied.has(hash)) continue;
          return hash;
        }
      }
    }
  }
  return null;
}

/**
 * Plans the spawns needed to bring a scene up to its authored population.
 * Call with `existing: []` for a fresh load, or the live monster list to fill a
 * zone back to `maxAlive` on a respawn tick. `occupied` (integer-hash set)
 * accumulates every claimed tile so nothing overlaps the party, existing
 * monsters, or an earlier spawn.
 *
 * @param {object} scene - composed scene descriptor
 * @param {object} questState
 * @param {{ existing?: object[], occupied?: Set<number>, idPrefix?: string, idSeq?: number }} [opts]
 * @returns {{ id: string, type: string, x: number, y: number, spawnZoneId?: string, questSpawnId?: string, questId?: string }[]}
 */
export function planSceneMonsters(scene, questState, opts = {}) {
  const out = [];
  if (!scene || !Array.isArray(scene.tiles)) return out;
  const width = scene.width;
  const occupied = opts.occupied || new Set();
  const existing = Array.isArray(opts.existing) ? opts.existing : [];
  const idPrefix = opts.idPrefix || 'sm';
  let seq = Number(opts.idSeq) || 0;

  const aliveByZone = {};
  const aliveByQuestSpawn = {};
  for (const m of existing) {
    if (!m || m.hp <= 0) continue;
    if (m.spawnZoneId) aliveByZone[m.spawnZoneId] = (aliveByZone[m.spawnZoneId] || 0) + 1;
    if (m.questSpawnId) aliveByQuestSpawn[m.questSpawnId] = (aliveByQuestSpawn[m.questSpawnId] || 0) + 1;
    occupied.add(m.y * width + m.x);
  }

  const prng = createPRNG(seedFromString(scene.sceneId));

  // Named quest elites first, so their tile is reserved before the roaming
  // zones fill. Present only while the quest is active and the corresponding
  // kill objective is still outstanding (anti-soft-lock). The authored
  // coordinate is an anchor; the elite lands on the nearest free walkable tile.
  for (const qs of scene.questSpawns || []) {
    if (aliveByQuestSpawn[qs.id]) continue;
    const def = getQuestDefinition(qs.questId);
    if (!def) continue;
    if (getQuestStatus(questState, qs.questId) !== QUEST_STATUS.ACTIVE) continue;
    if (questKillSatisfied(questState, def, qs.monsterType)) continue;
    const hash = nearestWalkableHash(scene, qs.x, qs.y, occupied);
    if (hash === null) continue;
    occupied.add(hash);
    const x = hash % width;
    const y = (hash - x) / width;
    out.push({
      id: `${idPrefix}_${++seq}`,
      type: qs.monsterType,
      x,
      y,
      questSpawnId: qs.id,
      questId: qs.questId,
    });
  }

  for (const zone of scene.spawnZones || []) {
    const maxAlive = Math.max(0, Number(zone.maxAlive) || 0);
    let need = maxAlive - (aliveByZone[zone.id] || 0);
    if (need <= 0) continue;
    const pool = Array.isArray(zone.pool) ? zone.pool.filter((t) => MONSTERS_CATALOG[t]) : [];
    if (pool.length === 0) continue;

    // Collect free walkable tiles in the zone, then deterministically shuffle.
    const candidates = [];
    for (let y = Math.max(0, zone.y0); y <= zone.y1 && y < scene.height; y++) {
      for (let x = Math.max(0, zone.x0); x <= zone.x1 && x < width; x++) {
        const hash = walkableHash(scene, x, y);
        if (hash === null || occupied.has(hash)) continue;
        candidates.push(hash);
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(prng() * (i + 1));
      const tmp = candidates[i];
      candidates[i] = candidates[j];
      candidates[j] = tmp;
    }
    for (let i = 0; i < candidates.length && need > 0; i++, need--) {
      const hash = candidates[i];
      occupied.add(hash);
      const x = hash % width;
      const y = (hash - x) / width;
      const type = pool[Math.floor(prng() * pool.length)] || pool[0];
      out.push({ id: `${idPrefix}_${++seq}`, type, x, y, spawnZoneId: zone.id });
    }
  }

  return out;
}
