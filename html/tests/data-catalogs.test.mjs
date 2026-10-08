import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CARDS_CATALOG,
  MONSTERS_CATALOG,
  ITEMS_CATALOG,
  VOCATIONS_CATALOG,
  SOUNDS_CATALOG,
  ABILITIES_CATALOG,
  BIOMES_CATALOG,
  ENCOUNTERS_CATALOG,
  DUNGEONS_CATALOG,
  TOWER_LEVELS_CATALOG,
  DOORS_CATALOG,
  CHESTS_CATALOG,
  TILE_THEMES_CATALOG,
  KEYBINDINGS_CATALOG,
  UI_CATALOG,
  ECONOMY_CATALOG,
} from '../data/index.js';

test('JSON Data Catalogs', async (t) => {
  await t.test('loads and validates cards.json catalog', () => {
    assert.ok(Array.isArray(CARDS_CATALOG), 'CARDS_CATALOG must be an array');
    // The "Radiant Light Spell" (card_light_spell) draft card was removed.
    // Retired 8 inert spell_* cards, card_hunter_quiver, and card_iron_buckler.
    // Added 4 ability-bearing Fighter/Paladin armor+relic cards.
    assert.equal(CARDS_CATALOG.length, 23, 'CARDS_CATALOG must contain 23 draft cards');
    assert.ok(
      !CARDS_CATALOG.some(c => c.id === 'card_light_spell' || c.item?.item_id === 'spell_light' || /radiant light/i.test(c.name)),
      'the Radian Light Spell card must be absent'
    );

    for (const card of CARDS_CATALOG) {
      assert.ok(card.id, 'Card must have id');
      assert.ok(card.name, 'Card must have name');
      assert.ok(card.rarity, 'Card must have rarity');
      assert.ok(card.icon, 'Card must have icon');
      assert.ok(card.item && card.item.item_id, 'Card must specify an item payload');
    }
  });

  await t.test('loads and validates monsters.json catalog', () => {
    const expectedMonsters = ['giant_rat', 'crypt_skeleton', 'shadow_cultist', 'elite_cultist', 'abyssal_overlord'];
    // The launch five are the floor-generation pool; the catalog may carry
    // additional opponents (LIV-2 framework demos) authored for the expansion.
    assert.ok(Object.keys(MONSTERS_CATALOG).length >= 5);
    for (const key of expectedMonsters) assert.ok(MONSTERS_CATALOG[key], `Missing launch monster ${key}`);

    const aiTypes = ['chase', 'standoff', 'ranged', 'charger', 'bomber', 'summoner'];
    const attackKinds = ['melee', 'projectile', 'aoe', 'dash', 'summon'];

    for (const [key, monster] of Object.entries(MONSTERS_CATALOG)) {
      assert.ok(monster.baseHp > 0, `Monster ${key} must have baseHp > 0`);
      assert.ok(monster.baseAttack > 0, `Monster ${key} must have baseAttack > 0`);
      assert.ok(typeof monster.moveCadence === 'number', `Monster ${key} must specify moveCadence`);
      assert.ok(typeof monster.attackCadence === 'number', `Monster ${key} must specify attackCadence`);
      assert.ok(aiTypes.includes(monster.aiType), `Invalid aiType "${monster.aiType}" for ${key}`);
      assert.ok(Array.isArray(monster.lootTable), `Monster ${key} must specify lootTable array`);
      if (monster.attacks) {
        assert.ok(Array.isArray(monster.attacks), `Monster ${key} attacks must be an array`);
        for (const atk of monster.attacks) {
          assert.ok(atk.key, `Monster ${key} attack must declare a key`);
          assert.ok(attackKinds.includes(atk.kind), `Monster ${key} attack ${atk.key} has unknown kind ${atk.kind}`);
        }
      }
    }
  });

  await t.test('ships catalog-driven opponents covering each attack style (LIV-2)', () => {
    // Each opponent runs purely from its catalog spec: these assertions lock in
    // the aiType + attack-kind coverage the engine dispatch tables resolve.
    const coverage = {
      cinder_acolyte: { aiType: 'ranged', kind: 'projectile', status: 'burn' },
      grave_charger: { aiType: 'charger', kind: 'dash', status: 'stun' },
      plague_bomber: { aiType: 'bomber', kind: 'aoe', status: 'poison' },
      bone_summoner: { aiType: 'summoner', kind: 'summon', status: null },
    };
    for (const [key, spec] of Object.entries(coverage)) {
      const monster = MONSTERS_CATALOG[key];
      assert.ok(monster, `missing framework opponent ${key}`);
      assert.equal(monster.aiType, spec.aiType, `${key} aiType`);
      const attack = monster.attacks.find(a => a.kind === spec.kind);
      assert.ok(attack, `${key} must declare a ${spec.kind} attack`);
      if (spec.status) {
        assert.equal(attack.onHit?.status, spec.status, `${key} onHit status`);
        assert.ok(attack.onHit.durationSec > 0, `${key} onHit duration`);
      }
      assert.ok(monster.spriteId, `${key} must declare a shared spriteId (no bespoke art required to ship)`);
    }
  });

  await t.test('loads and validates items.json catalog', () => {
    assert.ok(Object.keys(ITEMS_CATALOG).length >= 23, 'ITEMS_CATALOG must contain at least 23 items');

    const essentialItems = ['health_potion', 'mana_potion', 'arrows', 'apprentice_wand', 'tempered_broadsword'];
    for (const key of essentialItems) {
      const item = ITEMS_CATALOG[key];
      assert.ok(item, `Missing item definition for ${key}`);
      assert.ok(item.name, `Item ${key} must have a name`);
      assert.ok(item.icon, `Item ${key} must have an icon`);
      assert.ok(typeof item.maxStack === 'number', `Item ${key} must specify maxStack`);
    }

    // Removals: Wooden Torch and the Radiant Light Spell item.
    assert.equal(ITEMS_CATALOG.torch, undefined, 'Wooden Torch must be removed');
    assert.equal(ITEMS_CATALOG.spell_light, undefined, 'Radiant Light Spell item must be removed');

    // Removals: the 8 inert spell_* items, buckler, and the two
    // duplicate casters. Core abilities now map to exactly one item each.
    for (const retired of [
      'spell_slash', 'spell_cleave', 'spell_fortify', 'spell_holy_strike',
      'spell_healing_prayer', 'spell_holy_radiance', 'spell_bow_shot', 'spell_power_shot',
      'buckler', 'spell_wand_spark', 'spell_energy_beam', 'hunter_quiver',
    ]) {
      assert.equal(ITEMS_CATALOG[retired], undefined, `${retired} must be removed`);
    }

    assert.equal(ITEMS_CATALOG['arrows'].maxStack, 99);
    assert.equal(ITEMS_CATALOG['health_potion'].maxStack, 99);
    assert.equal(ITEMS_CATALOG['mana_potion'].maxStack, 99);
    assert.equal(ITEMS_CATALOG['apprentice_wand'].maxStack, 1);
  });

  await t.test('drives consumable effects and weapon visuals from items.json', () => {
    for (const [id, resource] of [['health_potion', 'hp'], ['mana_potion', 'mp']]) {
      const effect = ITEMS_CATALOG[id].effect;
      assert.ok(effect, `consumable ${id} must declare effect metadata`);
      assert.equal(effect.kind, 'restore', `${id} effect kind`);
      assert.equal(effect.resource, resource, `${id} effect resource`);
      assert.ok(effect.amount > 0, `${id} effect amount`);
    }

    for (const [id, item] of Object.entries(ITEMS_CATALOG)) {
      if (item.type !== 'weapon') continue;
      assert.ok(
        typeof item.renderKey === 'string' && item.renderKey.length > 0,
        `weapon ${id} must declare renderKey (no item_id substring heuristics)`
      );
    }
  });

  await t.test('loads the vocation-locked items with required fields', () => {
    const requiredFields = ['name', 'type', 'slot', 'stat_bonus', 'icon', 'svgCode', 'vocationAffinity', 'maxStack'];
    const newItems = {
      grey_stalker_quiver: { slot: 'off_hand', type: 'offhand', affinity: 'archer' },
      hunter_leathers: { slot: 'armor', type: 'armor', affinity: 'archer' },
      ranger_talisman: { slot: 'relic', type: 'relic', affinity: 'archer' },
      iron_helm: { slot: 'relic', type: 'relic', affinity: 'fighter' },
      holy_crown: { slot: 'relic', type: 'relic', affinity: 'paladin' },
      // Phase 2: ability-bearing armor/relic for Fighter and Paladin.
      vanguard_battleplate: { slot: 'armor', type: 'armor', affinity: 'fighter' },
      relic_berserkers_sigil: { slot: 'relic', type: 'relic', affinity: 'fighter' },
      sanctuary_plate: { slot: 'armor', type: 'armor', affinity: 'paladin' },
      relic_dawnlight: { slot: 'relic', type: 'relic', affinity: 'paladin' },
    };

    for (const [itemId, spec] of Object.entries(newItems)) {
      const item = ITEMS_CATALOG[itemId];
      assert.ok(item, `Missing new item definition for ${itemId}`);
      for (const field of requiredFields) {
        assert.ok(item[field] !== undefined, `Item ${itemId} must specify ${field}`);
      }
      assert.equal(item.slot, spec.slot, `Item ${itemId} must occupy slot ${spec.slot}`);
      assert.equal(item.type, spec.type, `Item ${itemId} must be type ${spec.type}`);
      assert.equal(item.maxStack, 1, `Item ${itemId} must have maxStack 1`);
      const matchesAffinity = item.vocationAffinity === spec.affinity
        || (Array.isArray(item.vocationAffinity) && item.vocationAffinity.includes(spec.affinity));
      assert.ok(matchesAffinity, `Item ${itemId} must carry vocationAffinity including ${spec.affinity}`);
    }

    // New items each have a grantable draft card
    const cardByItem = new Map(CARDS_CATALOG.map(c => [c.item?.item_id, c]));
    for (const itemId of Object.keys(newItems)) {
      const card = cardByItem.get(itemId);
      assert.ok(card, `Missing draft card for new item ${itemId}`);
    }
  });

  await t.test('ensures every equippable item carries vocationAffinity (or neutral)', () => {
    for (const [itemId, item] of Object.entries(ITEMS_CATALOG)) {
      if (!item.slot) continue; // non-equippable (consumables, ammo, spell-only items)
      assert.ok(
        item.vocationAffinity,
        `Equippable item ${itemId} must carry vocationAffinity (use "neutral" for all-class gear)`
      );
      assert.ok(
        item.vocationAffinity === 'neutral'
          || typeof item.vocationAffinity === 'string'
          || (Array.isArray(item.vocationAffinity) && item.vocationAffinity.length > 0),
        `Item ${itemId} has an invalid vocationAffinity value`
      );
    }
  });

  await t.test('loads and validates vocations.json catalog', () => {
    const vocations = ['magician', 'archer', 'fighter', 'paladin'];
    assert.equal(Object.keys(VOCATIONS_CATALOG).length, 4);

    for (const key of vocations) {
      const voc = VOCATIONS_CATALOG[key];
      assert.ok(voc, `Missing vocation definition for ${key}`);
      assert.ok(voc.hp > 0, `Vocation ${key} must have hp > 0`);
      assert.ok(voc.mana > 0, `Vocation ${key} must have mana > 0`);
      assert.ok(voc.hpPerLevel > 0, `Vocation ${key} must have hpPerLevel > 0`);
      assert.ok(voc.damageStep > 0, `Vocation ${key} must have damageStep > 0`);
      assert.ok(Array.isArray(voc.nativeEquipment) && voc.nativeEquipment.length > 0, `Vocation ${key} must list nativeEquipment`);
    }
  });

  await t.test('loads and validates sounds.json catalog', () => {
    assert.equal(Object.keys(SOUNDS_CATALOG).length, 25);
    assert.ok(SOUNDS_CATALOG.footstep);
    assert.ok(SOUNDS_CATALOG.wandSpark);
    assert.ok(SOUNDS_CATALOG.victory);
    assert.ok(SOUNDS_CATALOG.uiMove);
    assert.ok(SOUNDS_CATALOG.uiBack);
    // Items 4/5: metal key jangle + coin clink SFX.
    assert.ok(SOUNDS_CATALOG.keyJangle);
    assert.ok(SOUNDS_CATALOG.coins);
    // LIV-49: KO/handoff sting + control-swap cue.
    assert.ok(SOUNDS_CATALOG.koHandoff);
    assert.ok(SOUNDS_CATALOG.controlSwap);
  });

  await t.test('loads and validates abilities.json catalog', () => {
    assert.equal(Object.keys(ABILITIES_CATALOG).length, 10);
    assert.ok(ABILITIES_CATALOG.magician_spark);
    assert.equal(ABILITIES_CATALOG.magician_spark.vocation, 'magician');
    assert.ok(ABILITIES_CATALOG.magician_spark.visual, 'magician_spark must specify visual config');
    assert.equal(ABILITIES_CATALOG.magician_spark.visual.trailType, 'electric');
    assert.ok(ABILITIES_CATALOG.magician_spark.visual.burstParticleCount > 0);
    assert.ok(ABILITIES_CATALOG.paladin_heal);
    assert.equal(ABILITIES_CATALOG.paladin_heal.vocation, 'paladin');
    // LIV-25: the ally-castable force shield is a first-class support ability.
    assert.ok(ABILITIES_CATALOG.holy_shield);
    assert.equal(ABILITIES_CATALOG.holy_shield.vocation, 'paladin');
    assert.equal(ABILITIES_CATALOG.holy_shield.type, 'shield');
    assert.equal(ABILITIES_CATALOG.holy_shield.actionKey, 'force_shield');
    assert.equal(ABILITIES_CATALOG.holy_shield.targetsAllies, true);
    assert.ok(ABILITIES_CATALOG.holy_shield.shieldAbsorb > 0);
    assert.ok(ABILITIES_CATALOG.holy_shield.shieldDurationSec > 0);
  });

  await t.test('loads and validates biomes.json catalog (launch tiers + tower tierIds)', () => {
    // The launch five tiers are level-scanned (legacy floor fallback) and keep
    // their exact min/max levels. Tower-specific tiers added by LIV-5 resolve
    // through each tower level's `tierId`, so they intentionally carry no
    // min/max range and never participate in the level scan.
    assert.ok(Object.keys(BIOMES_CATALOG).length >= 5, 'launch tiers plus tower tiers must load');
    for (const [id, min, max] of [
      ['crypt', 1, 1],
      ['catacombs', 2, 2],
      ['shadow_vaults', 3, 3],
      ['abyssal_sanctum', 4, 4],
      ['crown_spire', 5, 5],
    ]) {
      assert.ok(BIOMES_CATALOG[id], `missing launch biome ${id}`);
      assert.equal(BIOMES_CATALOG[id].minLevel, min, `${id} minLevel`);
      assert.equal(BIOMES_CATALOG[id].maxLevel, max, `${id} maxLevel`);
    }
    // Every level 1..5 is covered by exactly one level-scanned tier.
    for (let level = 1; level <= 5; level++) {
      const matches = Object.values(BIOMES_CATALOG).filter(
        (b) => level >= b.minLevel && level <= b.maxLevel
      );
      assert.equal(matches.length, 1, `level ${level} must map to exactly one tower tier`);
    }
  });

  await t.test('loads and validates encounters.json catalog (monster groups + boss)', () => {
    assert.ok(ENCOUNTERS_CATALOG.groups, 'encounters must expose monster group data');
    assert.equal(ENCOUNTERS_CATALOG.boss.hp, 600);
    assert.equal(ENCOUNTERS_CATALOG.boss.type, 'abyssal_overlord');
    assert.equal(ENCOUNTERS_CATALOG.boss.level, 5);
    assert.ok(!ENCOUNTERS_CATALOG.tier_1_5, 'cave-era tier keys must be gone');
    assert.ok(!ENCOUNTERS_CATALOG.tier_20_boss, 'cave-era boss tier key must be gone');
  });

  await t.test('loads and validates tower_levels.json catalog', () => {
    assert.equal(TOWER_LEVELS_CATALOG.levelCount, 5);
    assert.equal(TOWER_LEVELS_CATALOG.levels.length, 5);
    // LIV-3: the catalog now holds a set of full tower definitions.
    assert.ok(Array.isArray(TOWER_LEVELS_CATALOG.towers), 'towers must be an array');
    assert.ok(TOWER_LEVELS_CATALOG.towers.length >= 2, 'at least two towers must load');
    for (const tower of TOWER_LEVELS_CATALOG.towers) {
      assert.ok(tower.id, 'tower id');
      assert.equal(tower.levels.length, tower.levelCount, `${tower.id} levels match levelCount`);
      assert.ok(tower.monsterGroups && tower.monsterGroups.pool, `${tower.id} monster pools`);
      assert.ok(tower.boss && tower.boss.type, `${tower.id} boss`);
      assert.ok(tower.theme && tower.theme.levelTheme, `${tower.id} theme`);
    }
    assert.equal(
      TOWER_LEVELS_CATALOG.defaultTowerId,
      TOWER_LEVELS_CATALOG.towers[0].id,
      'defaultTowerId must resolve to the first authored tower'
    );
    assert.equal(TOWER_LEVELS_CATALOG.entry.room, 2);
    assert.deepEqual(TOWER_LEVELS_CATALOG.entry.doorTile, [19, 1]);
    assert.deepEqual(TOWER_LEVELS_CATALOG.entry.spawnTile, [19, 2]);
    assert.deepEqual(TOWER_LEVELS_CATALOG.stairShaft, { 1: 9, 2: 6, 3: 3, 4: 8, 5: 5 });

    for (const level of TOWER_LEVELS_CATALOG.levels) {
      assert.ok(level.openEdges.length === 8, `level ${level.level} must open 8 edges`);
      assert.ok(level.sealedEdges.length === 4, `level ${level.level} must seal 4 edges`);
      assert.deepEqual(Object.keys(level.gates).sort(), ['copper', 'gold', 'silver']);
      assert.deepEqual(Object.keys(level.keyRooms).sort(), ['copper', 'gold', 'silver']);
      assert.equal(Object.keys(level.roomTiers).length, 9);
    }
  });

  await t.test('tower_levels.json progression is soft-lock-free on every level', () => {
    const edges = DUNGEONS_CATALOG.standard_40x40.edges;
    const neighbors = (level, room) => {
      const gateByEdge = new Map(Object.entries(level.gates).map(([tier, edge]) => [edge, tier]));
      const out = [];
      for (const edgeId of level.openEdges) {
        const edge = edges[edgeId];
        if (!edge) continue;
        const [a, b] = edge.rooms;
        if (a === room) out.push({ room: b, gate: gateByEdge.get(edgeId) || null });
        if (b === room) out.push({ room: a, gate: gateByEdge.get(edgeId) || null });
      }
      return out;
    };
    const bfs = (level, keys) => {
      const seen = new Set([level.entryRoom]);
      const queue = [level.entryRoom];
      while (queue.length) {
        const room = queue.shift();
        for (const { room: next, gate } of neighbors(level, room)) {
          const locked = gate && !keys[gate];
          if (locked || seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      return seen;
    };

    // Every level is a connected tree of 9 rooms: 8 carved (open) edges, and
    // all three gate edges are among those carved edges (locked until keyed).
    for (const level of TOWER_LEVELS_CATALOG.levels) {
      assert.equal(new Set(level.openEdges).size, 8, `L${level.level}: exactly 8 open edges`);
      for (const [tier, edge] of Object.entries(level.gates)) {
        assert.ok(level.openEdges.includes(edge), `L${level.level}: ${tier} gate ${edge} must be carved`);
      }
      // Reachability with all keys held must span all 9 rooms (connected tree).
      const allKeys = { copper: true, silver: true, gold: true };
      const allReach = bfs(level, allKeys);
      assert.equal(allReach.size, 9, `L${level.level}: carved graph must connect all 9 rooms`);
    }

    for (const level of TOWER_LEVELS_CATALOG.levels) {
      const keys = { copper: false, silver: false, gold: false };
      const R0 = bfs(level, keys);
      assert.ok(R0.has(level.keyRooms.copper), `L${level.level}: copper holder reachable`);
      assert.ok(!R0.has(level.keyRooms.silver), `L${level.level}: silver gated`);
      assert.ok(!R0.has(level.keyRooms.gold), `L${level.level}: gold gated`);
      assert.ok(!R0.has(level.stairRoom), `L${level.level}: stair gated`);
      keys.copper = true;
      const R1 = bfs(level, keys);
      assert.ok(R1.has(level.keyRooms.silver), `L${level.level}: silver reachable after copper`);
      assert.ok(!R1.has(level.keyRooms.gold), `L${level.level}: gold still gated`);
      assert.ok(!R1.has(level.stairRoom), `L${level.level}: stair still gated`);
      keys.silver = true;
      const R2 = bfs(level, keys);
      assert.ok(R2.has(level.keyRooms.gold), `L${level.level}: gold reachable after silver`);
      assert.ok(!R2.has(level.stairRoom), `L${level.level}: stair still gated`);
      keys.gold = true;
      const R3 = bfs(level, keys);
      assert.ok(R3.has(level.stairRoom), `L${level.level}: stair reachable after gold`);
    }
  });

  await t.test('loads and validates chests.json loot catalog (tiered tables)', () => {
    assert.ok(CHESTS_CATALOG.chests, 'chests.json must expose a chests map');
    assert.deepEqual(Object.keys(CHESTS_CATALOG.chests).sort(), ['copper', 'gold', 'silver']);
    // Better color = more rolls (D2 §7.3).
    assert.ok(CHESTS_CATALOG.chests.gold.rolls >= CHESTS_CATALOG.chests.silver.rolls);
    assert.ok(CHESTS_CATALOG.chests.silver.rolls >= CHESTS_CATALOG.chests.copper.rolls);
    for (const [tier, table] of Object.entries(CHESTS_CATALOG.chests)) {
      assert.ok(Number.isInteger(table.rolls) && table.rolls > 0, `${tier} must specify rolls`);
      for (const entry of table.entries) {
        assert.ok(entry.weight > 0, `${tier} entry needs a positive weight`);
        assert.equal(entry.quantity.length, 2, `${tier} entry needs [min,max]`);
        if (!entry.vocationGear) {
          assert.ok(entry.itemId, `${tier} entry needs itemId`);
        }
      }
    }
    // Every explicit loot item references a real items.json entry.
    for (const table of Object.values(CHESTS_CATALOG.chests)) {
      for (const entry of table.entries) {
        if (entry.itemId) {
          assert.ok(ITEMS_CATALOG[entry.itemId], `unknown chest loot item ${entry.itemId}`);
        }
      }
    }
    // A spent chest has a distinct drained palette.
    assert.ok(CHESTS_CATALOG.spentVisual, 'chests.json must define the spent visual');
    assert.ok(CHESTS_CATALOG.spentVisual.overlay);
    assert.ok(CHESTS_CATALOG.spentVisual.tint?.light && CHESTS_CATALOG.spentVisual.tint?.dark);
  });

  await t.test('loads and validates doors.json catalog (tier → key + shape cue)', () => {    for (const tier of ['copper', 'silver', 'gold']) {
      const door = DOORS_CATALOG[tier];
      assert.ok(door, `missing door definition for ${tier}`);
      assert.equal(door.keyItemId, `key_${tier}`);
      assert.ok(['circle', 'square', 'crown'].includes(door.shape));
      assert.ok(door.accent);
    }
  });

  await t.test('items.json exposes three gated keys and lootTier metadata', () => {
    for (const tier of ['copper', 'silver', 'gold']) {
      const key = ITEMS_CATALOG[`key_${tier}`];
      assert.ok(key, `missing key_${tier}`);
      assert.equal(key.type, 'key');
      assert.equal(key.keyTier, tier);
      assert.equal(key.maxStack, 1);
      assert.equal(key.droppable, false);
      assert.equal(key.pickupType, 'key', 'Keys use the ground key dispatch');
    }
    // Every lootTier in §7.4 maps to a real item tagged with that tier.
    const tiered = Object.values(ITEMS_CATALOG).filter((i) => typeof i.lootTier === 'number');
    assert.ok(tiered.length >= 15, 'expected vocation gear to carry lootTier metadata');
    for (const item of tiered) {
      assert.ok([1, 2, 3].includes(item.lootTier), `item ${item.item_id} has invalid lootTier`);
    }
  });

  await t.test('loads and validates dungeons.json catalog (v4 edges layout)', () => {
    const spec = DUNGEONS_CATALOG.standard_40x40;
    assert.ok(spec);
    assert.equal(spec.templateVersion, 4);
    assert.equal(spec.width, 40);
    assert.equal(spec.height, 40);
    assert.equal(spec.rooms.length, 9);
    assert.equal(Object.keys(spec.edges).length, 12);
    for (const edge of Object.values(spec.edges)) {
      // Doorways are a single tile wide.
      assert.equal(edge.tiles.length, 1, 'each edge must expose exactly one doorway tile');
      assert.equal(edge.rooms.length, 2, 'each edge must connect exactly two rooms');
    }
  });

  await t.test('loads and validates tile_themes.json catalog', () => {
    assert.ok(TILE_THEMES_CATALOG.wall);
    assert.ok(TILE_THEMES_CATALOG.floor);
    assert.ok(TILE_THEMES_CATALOG.stairs);
    assert.ok(TILE_THEMES_CATALOG.door);

    // Walls carry a subtle per-tile shade palette (base fill included).
    const hex = /^#[0-9a-f]{6}$/i;
    const checkWall = (wall, label) => {
      assert.ok(Array.isArray(wall.shades), `${label}: wall.shades must be an array`);
      assert.ok(wall.shades.length >= 3, `${label}: wall.shades needs >= 3 entries`);
      assert.equal(new Set(wall.shades).size, wall.shades.length, `${label}: shades must be distinct`);
      assert.ok(wall.shades.includes(wall.fill), `${label}: shades must include the base fill`);
      for (const shade of wall.shades) assert.match(shade, hex, `${label}: invalid shade ${shade}`);
    };
    checkWall(TILE_THEMES_CATALOG.wall, 'root');
    for (const [n, theme] of Object.entries(TILE_THEMES_CATALOG.levels)) {
      checkWall(theme.wall, `level ${n}`);
    }
  });

  await t.test('loads and validates keybindings.json catalog', () => {
    assert.ok(KEYBINDINGS_CATALOG.movement);
    assert.ok(Array.isArray(KEYBINDINGS_CATALOG.movement.up));
    // D1 §2.7: `keySlots` replaces the retired `actionBar`/`equipmentBar`.
    assert.deepEqual(KEYBINDINGS_CATALOG.keySlots.equipment, {
      q: 'main_hand',
      w: 'off_hand',
      e: 'armor',
      r: 'relic',
    });
    assert.equal(KEYBINDINGS_CATALOG.keySlots.active.length, 4);
    assert.deepEqual(KEYBINDINGS_CATALOG.keySlots.active, ['Digit1', 'Digit2', 'Digit3', 'Digit4']);
    assert.equal(KEYBINDINGS_CATALOG.actionBar, undefined, 'retired actionBar must be gone');
    assert.equal(KEYBINDINGS_CATALOG.equipmentBar, undefined, 'retired equipmentBar must be gone');
    assert.ok(KEYBINDINGS_CATALOG.gestureTimings.tapMaxMs > 0);
  });

  await t.test('loads and validates the economy.json catalog (town/gold/springs)', () => {
    assert.ok(ECONOMY_CATALOG.gold, 'economy.gold required');
    assert.ok(Number.isFinite(ECONOMY_CATALOG.passiveRecovery.intervalSec));
    assert.equal(ECONOMY_CATALOG.passiveRecovery.hpPerTick, 1);
    assert.equal(ECONOMY_CATALOG.passiveRecovery.mpPerTick, 1);
    // Springs are per-second adjacent regen fountains.
    assert.equal(ECONOMY_CATALOG.springs.hpPerSec, 5);
    assert.equal(ECONOMY_CATALOG.springs.mpPerSec, 5);
    assert.equal(ECONOMY_CATALOG.shop.sellRatePct, 50, 'pawn pays 50% of purchase price');
    assert.ok(Array.isArray(ECONOMY_CATALOG.stock) && ECONOMY_CATALOG.stock.length > 0, 'shop stock required');
    for (const entry of ECONOMY_CATALOG.stock) {
      assert.ok(ITEMS_CATALOG[entry.itemId], `unknown shop item ${entry.itemId}`);
      assert.ok(entry.price >= 0, `${entry.itemId} needs a non-negative price`);
    }
    for (const [type, range] of Object.entries(ECONOMY_CATALOG.monsterGold)) {
      assert.ok(MONSTERS_CATALOG[type], `monsterGold references unknown monster ${type}`);
      assert.ok(range.min >= 0 && range.max >= range.min, `${type} gold range invalid`);
    }
  });

  await t.test('loads and validates ui.json presentation catalog', () => {
    assert.ok(UI_CATALOG.splash);
    assert.ok(UI_CATALOG.transitions);
    assert.ok(UI_CATALOG.titleAmbient);
    assert.equal(UI_CATALOG.saveSlots.count, 5);
    assert.equal(UI_CATALOG.options.defaults.sfxVolume, 70);
    assert.equal(UI_CATALOG.options.ranges.pixelScale['3x'], 96);
    // Debug options default off; magnitude is authored, not hardcoded in JS.
    assert.equal(UI_CATALOG.options.defaults.walkThruWalls, false);
    assert.equal(UI_CATALOG.options.defaults.testerStrength, false);
    assert.equal(UI_CATALOG.options.debug.testerStrengthDamageReductionPct, 90);
    // D1 §2.7 + §3.2: catalog field names.
    assert.equal(UI_CATALOG.inventory.backpack.defaultSlots, 36);
    assert.equal(UI_CATALOG.inventory.backpack.columns, 6);
    assert.equal(UI_CATALOG.inventory.backpack.rows, 6);
    assert.equal(UI_CATALOG.inventory.activeSlots, 4);
    assert.equal(UI_CATALOG.inventory.equipmentSlots, 4);
    assert.equal(UI_CATALOG.hud.loadout.activeKeys.length, 4);
    assert.equal(UI_CATALOG.hud.loadout.equipmentKeys.length, 4);
    assert.ok(UI_CATALOG.entityBars.widthPx > 0);
    assert.ok(UI_CATALOG.entityBars.heightPx > 0);
    assert.ok(UI_CATALOG.entityBars.offsetAboveSpritePx > 0);
    assert.ok(UI_CATALOG.entityBars.hpFill);
    assert.equal(UI_CATALOG.entityBars.enemyShowWhen, 'damaged');
    assert.ok(UI_CATALOG.town.title);
    // LIV-49: downed grayscale + on-back rotation, and the swap-feedback tokens.
    assert.equal(UI_CATALOG.knockout.visuals.downed.grayscale, true);
    assert.ok(UI_CATALOG.knockout.visuals.downed.desaturate >= 0.9);
    assert.equal(UI_CATALOG.knockout.visuals.downed.rotationDeg, 90);
    assert.ok(UI_CATALOG.knockout.swap.beatMs > 0);
    assert.ok(UI_CATALOG.knockout.swap.destinationFlash.durationMs >= 900);
    assert.ok(UI_CATALOG.knockout.swap.sfx.koHandoff);
    assert.ok(UI_CATALOG.knockout.swap.sfx.controlSwap);
  });

  await t.test('every item declares a D1 slotRole', () => {
    for (const [id, item] of Object.entries(ITEMS_CATALOG)) {
      assert.ok(
        ['active', 'equipment', 'bank'].includes(item.slotRole),
        `${id} must declare slotRole (active|equipment|bank)`
      );
    }
  });

  await t.test('consolidates exactly one solid item per class per equipment slot', () => {
    const slots = ['main_hand', 'off_hand', 'armor', 'relic'];
    for (const voc of ['fighter', 'paladin', 'magician', 'archer']) {
      const solid = VOCATIONS_CATALOG[voc].solidEquipment;
      assert.ok(solid, `${voc} must declare solidEquipment`);
      for (const slot of slots) {
        const itemId = solid[slot];
        assert.ok(itemId, `${voc}.${slot} must declare exactly one solid item`);
        const item = ITEMS_CATALOG[itemId];
        assert.ok(item, `${voc}.${slot} item ${itemId} must exist`);
        assert.equal(item.solidGear, true, `${itemId} must be flagged solidGear`);
        assert.ok(item.upgradeSpec, `${itemId} must be upgradeable (no flat stat stick)`);
      }
    }
    // Paladin's warhammer must be usable: its MP cost is reduced to 5.
    assert.equal(ITEMS_CATALOG.consecrated_warhammer.manaCost, 5, 'warhammer ability MP cost must be 5');
    // Every solid item must also grant a real active ability (4/4 coverage).
    for (const voc of ['fighter', 'paladin', 'magician', 'archer']) {
      const solid = VOCATIONS_CATALOG[voc].solidEquipment;
      for (const slot of slots) {
        assert.ok(ITEMS_CATALOG[solid[slot]].actionKey, `${voc}.${slot} (${solid[slot]}) must grant an actionKey ability`);
      }
    }
  });
});


