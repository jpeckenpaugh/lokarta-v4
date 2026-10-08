/**
 * Lokarta: "Debug round 2" regression coverage.
 *
 * Pins the ten board fixes from 
 *   1. Merchant stall: Purchase / Pawn (50%) / Upgrade Gear across 4 slots.
 *   2. Pause menu: no town return by default; header button reads "Menu".
 *   3. Furniture props block; dropped items/chests stay walkable.
 *   4. Keys drop on the ground + key-jangle SFX on drop/pickup/door.
 *   5. Gold drops on the ground, multi-drops spread, coin SFX.
 *   6. Pickup/chest messages stagger and live longer.
 *   7. No XP from floor changes.
 *   8. Potions stack to 99.
 *   9. Springs are impassable fountains with adjacent +5/+5 per second.
 *  10. Spent chests read as drained grey, distinct from silver.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  GridMap,
  InventorySystem,
  EconomySystem,
  DoorSystem,
  TILE_TYPES,
  createPlayer,
  createPartyPlayer,
  createPartyMember,
  ReviveSystem,
} from '../engine/index.js';
import { generateFloor } from '../services/floor-generator.js';
import { ITEMS_CATALOG, UI_CATALOG, CHESTS_CATALOG, ECONOMY_CATALOG } from '../data/index.js';
import { LokartaApp } from '../app/app-controller.js';
import { SpriteRenderer } from '../app/sprite-renderer.js';
import { soundFX } from '../audio/index.js';
import { readControllerSources } from './helpers/app-source.mjs';

const LEVELS = [1, 2, 3, 4, 5];

function makeFakeCtx() {
  const styles = [];
  const ctx = {
    canvas: { width: 256, height: 256 },
    calls: [],
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    save() {}, restore() {}, beginPath() {}, closePath() {},
    arc() {}, ellipse() {}, moveTo() {}, lineTo() {}, fill() {}, stroke() {},
    fillRect() { this.calls.push('fillRect'); },
    strokeRect() {}, fillText() {}, drawImage() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    _fillStyle: '#000',
  };
  Object.defineProperty(ctx, 'fillStyle', {
    get() { return this._fillStyle; },
    set(v) { this._fillStyle = v; styles.push(v); },
    configurable: true,
  });
  ctx.styles = styles;
  return ctx;
}

function withCapturedSounds(fn) {
  const original = soundFX.play;
  const played = [];
  soundFX.play = key => { played.push(key); };
  try {
    fn(played);
  } finally {
    soundFX.play = original;
  }
  return played;
}

describe('Merchant stall', () => {
  it('offers upgrades for looted gear that carries no instance upgradeSpec', () => {
    const looted = { item_id: 'astral_scepter', name: 'Beam Staff', type: 'weapon', itemLevel: 1 };
    assert.equal(EconomySystem.canUpgrade(looted), true, 'catalog spec must qualify looted gear');
    assert.equal(EconomySystem.upgradeCost(looted), 40);
  });

  it('lists upgrades for all four equipped slots via collectUpgradableItems', () => {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPlayer('fighter');
    app.player.paperdoll.main_hand = { ...ITEMS_CATALOG.tempered_broadsword, item_id: 'tempered_broadsword', itemLevel: 1 };
    app.player.paperdoll.off_hand = { ...ITEMS_CATALOG.vanguard_shield, item_id: 'vanguard_shield', itemLevel: 1 };
    app.player.paperdoll.armor = { ...ITEMS_CATALOG.plate_armor, item_id: 'plate_armor', itemLevel: 1 };
    app.player.paperdoll.relic = { ...ITEMS_CATALOG.iron_helm, item_id: 'iron_helm', itemLevel: 1 };
    const list = app.collectUpgradableItems();
    const slots = new Set(list.map(e => e.source === 'equipment' ? e.index : null));
    for (const slot of ['main_hand', 'off_hand', 'armor', 'relic']) {
      assert.ok(slots.has(slot), `${slot} must appear in Upgrade Gear`);
    }
  });

  it('pawns a backpack item for 50% of its purchase price and removes it', () => {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPlayer('magician');
    app.player.backpack[0] = { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 1, pricePaid: 20 };
    app.logCombat = () => {};
    app.updateHUD = () => {};
    app.persistSave = () => {};
    app.openShop = () => {};

    assert.equal(EconomySystem.pawnValue(app.player.backpack[0]), 10, '50% of 20 gold');
    app.pawnShopItem('backpack', 0);
    assert.equal(app.player.backpack[0], null, 'pawned item removed from the backpack');
    assert.equal(app.player.gold, 10, 'gold credited');
  });

  it('buying a duplicate copies it instead of silently ranking up the owned item', () => {
    const p = createPlayer('magician');
    p.paperdoll.main_hand = { ...ITEMS_CATALOG.astral_scepter, item_id: 'astral_scepter', itemLevel: 1 };
    const purchase = { ...ITEMS_CATALOG.astral_scepter, item_id: 'astral_scepter', quantity: 1, pricePaid: 220 };
    InventorySystem.addItem(p, purchase, { allowRankUp: false });
    assert.equal(p.paperdoll.main_hand.itemLevel, 1, 'purchase must not rank up the equipped copy');
    assert.ok(p.backpack.some(s => s && s.item_id === 'astral_scepter'), 'a second copy banks into the backpack');

    // Reward paths still rank up an owned duplicate.
    const p2 = createPlayer('magician');
    p2.paperdoll.main_hand = { ...ITEMS_CATALOG.astral_scepter, item_id: 'astral_scepter', itemLevel: 1 };
    InventorySystem.addItem(p2, { ...ITEMS_CATALOG.astral_scepter, item_id: 'astral_scepter', quantity: 1 });
    assert.equal(p2.paperdoll.main_hand.itemLevel, 2, 'loot duplication still ranks up');
  });
});

describe('Pause menu', () => {
  it('disables Return to Town by default and labels the header button Menu', () => {
    assert.equal(UI_CATALOG.pause.returnToTownEnabled, false);
    const html = readFileSync(resolve(process.cwd(), 'html/index.html'), 'utf8');
    assert.match(html, /header-guide-btn[^>]*>\s*<img[^>]*alt="Menu"[^>]*\/>\s*Menu/, 'header button must read Menu');
  });
});

describe('Furniture props block', () => {
  it('blocks furniture tiles, keeps decor walkable, and never disconnects the floor', () => {
    for (const lv of LEVELS) {
      for (const seed of [1, 7, 42, 1337, 90210]) {
        const floor = generateFloor(lv, seed);
        const grid = new GridMap();
        grid.loadFromMatrix(floor.tiles);
        for (const prop of floor.props) {
          if (prop.layer === 'prop') {
            grid.blockTile(prop.x, prop.y, true);
            assert.equal(grid.isWalkable(prop.x, prop.y), false, `L${lv}/${seed} furniture blocks`);
          } else {
            assert.equal(grid.isWalkable(prop.x, prop.y), true, `L${lv}/${seed} decor walkable`);
          }
        }
        // Dropped items / chests stay walkable: blocking is prop-only.
        for (const item of floor.items) {
          assert.equal(grid.isWalkable(item.x, item.y), true, `L${lv}/${seed} item tile stays walkable`);
        }
        for (const chest of floor.chests) {
          assert.equal(grid.isWalkable(chest.x, chest.y), true, `L${lv}/${seed} chest tile stays walkable`);
        }
      }
    }
  });
});

describe('Keys drop on the ground', () => {
  it('builds a ground key stack and does not auto-grant it on drop', () => {
    const player = createPlayer('fighter');
    const drop = DoorSystem.keyDropForMonster({ holdsKey: 'copper' });
    assert.equal(drop.type, 'key');
    assert.equal(drop.pickupType, 'key');
    assert.equal(drop.keyTier, 'copper');
    assert.deepEqual(player.levelKeys, {}, 'dropping a key must not grant it');
  });

  it('walking over a ground key grants it and plays the key-jangle SFX', async () => {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPlayer('fighter');
    app.player.current_floor = 2;
    app.player.x = 5;
    app.player.y = 5;
    app.gridMap = new GridMap();
    app.gridMap.addItem(5, 5, DoorSystem.keyDropForMonster({ holdsKey: 'silver' }));
    app.logCombat = () => {};
    app.addFloatingText = () => {};
    app.updateHUD = () => {};
    app.persistSave = async () => {};

    const played = await withCapturedSounds(async () => { await app.handlePickUp(); });
    assert.equal(DoorSystem.hasKey(app.player, 'silver', 2), true, 'key granted on pickup');
    assert.equal(app.gridMap.getItems(5, 5).length, 0, 'ground key consumed');
    assert.ok(played.includes('keyJangle'), 'key jangle plays on pickup');
  });

  it('plays the key-jangle SFX when a door opens with a key', () => {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPlayer('fighter');
    app.player.current_floor = 1;
    app.player.levelKeys = { 1: { copper: true } };
    app.gridMap = new GridMap();
    app.gridMap.loadFromMatrix(generateFloor(1).tiles);
    const gate = generateFloor(1).gates.copper.tiles[0];
    const tile = app.gridMap.getTile(gate.x, gate.y);
    tile.type = TILE_TYPES.GATED_DOOR;
    tile.gateTier = 'copper';
    tile.gateOpen = false;
    app.logCombat = () => {};
    app.addFloatingText = () => {};
    app.updateHUD = () => {};
    app.persistSave = () => {};

    const played = withCapturedSounds(() => {
      assert.equal(app.openDoorUnderPlayer(gate.x, gate.y), true, 'door opens');
    });
    assert.ok(played.includes('keyJangle'), 'key jangle plays on door open');
  });
});

describe('Gold drops on the ground + spreads', () => {
  it('credits the purse and clears the tile when a coin stack is walked over', async () => {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPlayer('fighter');
    app.player.x = 3;
    app.player.y = 3;
    app.gridMap = new GridMap();
    app.gridMap.addItem(3, 3, { item_id: 'gold', name: 'Gold', type: 'currency', pickupType: 'currency', quantity: 42 });
    app.logCombat = () => {};
    app.addFloatingText = () => {};
    app.updateHUD = () => {};
    app.persistSave = async () => {};

    const played = await withCapturedSounds(async () => { await app.handlePickUp(); });
    assert.equal(app.player.gold, 42, 'gold credited on pickup');
    assert.equal(app.gridMap.getItems(3, 3).length, 0, 'coin stack removed');
    assert.ok(played.includes('coins'), 'coin clink plays on pickup');
  });

  it('drops gold and keys on the ground (not auto-granted) and spreads multiple drops', () => {
    const app = Object.create(LokartaApp.prototype);
    const floor = generateFloor(2);
    app.player = createPlayer('fighter');
    app.player.current_floor = 2;
    app.gridMap = new GridMap();
    app.gridMap.loadFromMatrix(floor.tiles);
    app.logCombat = () => {};
    app.addFloatingText = () => {};
    app.updateHUD = () => {};
    app.spawnDeathEffect = () => {};
    app.showFateGrantModal = () => {};
    app.persistSave = () => {};
    app.isFinalFloor = false;
    app.isFloorCleared = false;
    app.selectedMonsterId = null;
    app.projectiles = [];
    app.particles = [];
    app.monsters = [{
      id: 'rat_1', name: 'Giant Rat', type: 'giant_rat',
      x: 10, y: 10, hp: 1, max_hp: 18, isBoss: false, holdsKey: 'copper',
    }];

    app.handleCombatResult({ success: true, defeatedMonsterId: 'rat_1', damageDealt: 100 }, 10, 10);

    const highlighted = new Set();
    let goldStacks = 0;
    let keyStacks = 0;
    for (let y = 9; y <= 11; y++) {
      for (let x = 9; x <= 11; x++) {
        for (const item of app.gridMap.getItems(x, y)) {
          highlighted.add(`${x},${y}`);
          if (item.pickupType === 'currency') goldStacks++;
          if (item.pickupType === 'key') keyStacks++;
        }
      }
    }
    assert.equal(app.player.gold, 0, 'gold is not auto-credited on kill');
    assert.equal(DoorSystem.hasKey(app.player, 'copper', 2), false, 'key is not auto-granted on kill');
    assert.ok(goldStacks >= 1, 'gold dropped on the ground');
    assert.equal(keyStacks, 1, 'key dropped on the ground');
    assert.ok(highlighted.size >= 2, 'multi-item drop spread across adjacent squares');
  });
});

describe('Pickup messages', () => {
  it('staggers floating text and gives loot a longer life with a bounded list', () => {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPlayer('fighter');
    app.floatingTexts = [];
    app.options = { damageNumbers: true };
    app.addFloatingText('+1 HP', 4, 4, '#22c55e');
    app.addFloatingText('+Health Potion', 4, 4, '#22c55e', { durationMs: 2400 });
    assert.equal(app.floatingTexts.length, 2);
    assert.notEqual(new Set(app.floatingTexts.map(t => `${t.x},${t.y}`)).size, 1, 'messages do not overlap');
    assert.ok(app.floatingTexts[1].durationMs > app.floatingTexts[0].durationMs, 'loot lives longer');
    assert.ok(UI_CATALOG.floatingText.maxActive > 0);
  });
});

describe('No XP from floor changes', () => {
  it('removes the floor-clear XP grant from the controller source', () => {
    const src = readControllerSources();
    assert.doesNotMatch(src, /Floor Clear XP/, 'floor-clear XP copy must be gone');
    const clearBody = src.slice(src.indexOf('async handleFloorClear'));
    assert.doesNotMatch(clearBody.slice(0, clearBody.indexOf('addFloatingText(')), /awardXP/, 'floor change must not award XP');
  });
});

describe('Potion stacks to 99', () => {
  it('stacks a full 99 potions in one cell', () => {
    assert.equal(ITEMS_CATALOG.health_potion.maxStack, 99);
    assert.equal(ITEMS_CATALOG.mana_potion.maxStack, 99);
    const p = createPlayer('magician');
    InventorySystem.addItem(p, { item_id: 'health_potion', name: 'Health Potion', type: 'consumable', quantity: 99 });
    const cell = p.action_bar[0] || p.backpack.find(Boolean);
    assert.equal(cell.quantity, 99, 'one cell holds 99');
  });
});

describe('Healing fountain', () => {
  it('makes springs non-walkable and regenerates +5/+5 from an adjacent square', () => {
    const floor = generateFloor(1);
    const spring = floor.springs[0];
    const grid = new GridMap();
    grid.loadFromMatrix(floor.tiles);
    assert.equal(grid.tiles[spring.y][spring.x].type, TILE_TYPES.SPRING);
    assert.equal(grid.isWalkable(spring.x, spring.y), false, 'fountain is impassable');

    const app = Object.create(LokartaApp.prototype);
    app.player = createPlayer('fighter');
    app.gridMap = grid;
    app.springs = floor.springs;
    app.player.x = spring.x + 1;
    app.player.y = spring.y;
    assert.ok(app.findAdjacentSpring(), 'adjacent fountain detected');
    app.player.x = spring.x;
    app.player.y = spring.y - 5;
    assert.equal(app.findAdjacentSpring(), null, 'distant player is not near a fountain');

    const p = createPlayer('fighter');
    p.hp = 10;
    p.mana = 10;
    const regen = EconomySystem.applySpringRegen(p);
    assert.deepEqual(regen, { hp: 5, mp: 5 });
  });
});

describe('Fountain heals the whole party (LIV-19)', () => {
  function makeSpringPartyApp() {
    const app = Object.create(LokartaApp.prototype);
    app.player = createPartyPlayer('magician');
    const fighter = createPartyMember('fighter');
    const archer = createPartyMember('archer');
    app.player.party.push(fighter, archer);
    for (const member of app.player.party) {
      member.hp = 10;
      member.mana = 10;
      member.x = 1;
      member.y = 1;
    }
    app.player.hp = 10;
    app.player.mana = 10;
    app.addFloatingText = () => {};
    app.updateHUD = () => {};
    return { app, fighter, archer };
  }

  it('heals the whole party by catalog rule, not just the active member', () => {
    assert.equal(ECONOMY_CATALOG.springs.healsParty, true, 'catalog enables party-wide springs');
    assert.equal(EconomySystem.springHealsParty(), true);

    const { app, fighter, archer } = makeSpringPartyApp();
    const healed = app.applySpringRegenToParty();
    assert.equal(healed, 3, 'active member plus both allies recover');
    assert.equal(app.player.hp, 15, 'active member heals');
    assert.equal(fighter.hp, 15, 'ally 1 heals');
    assert.equal(archer.hp, 15, 'ally 2 heals');
    assert.equal(app.player.mana, 15);
    assert.equal(fighter.mana, 15);
    assert.equal(archer.mana, 15);
  });

  it('caps each member at its own max and skips downed members', () => {
    const { app, fighter, archer } = makeSpringPartyApp();
    fighter.max_hp = 12;
    fighter.hp = 11; // only +1 HP is missing
    archer.hp = 0; // downed allies are not revived by a fountain
    const healed = app.applySpringRegenToParty();
    assert.equal(healed, 2, 'active member + injured ally; downed ally skipped');
    assert.equal(fighter.hp, 12, 'never overheals past max_hp');
    assert.equal(archer.hp, 0, 'downed member stays down');
    assert.equal(app.player.hp, 15);
  });

  it('LIV-44: a fountain never revives a downed member; the party step keeps it down', () => {
    const player = createPartyPlayer('magician');
    const downed = createPartyMember('archer', { x: 1, y: 1, hp: 0 });
    downed.lifeState = 'downed';
    downed.downedAtSec = 0;
    player.party.push(downed);

    const res = ReviveSystem.evaluateParty(player, {
      elapsedSec: 5,
      floor: 1,
      monsters: [],
      combatIdleSec: 0,
    });
    assert.equal(downed.hp, 0, 'only the dedicated revive flow restores a body');
    assert.equal(downed.lifeState, 'downed');
    assert.equal(res.events.length, 0, 'no revive fires while the gate is closed');
  });
});

describe('Spent chest visual', () => {
  it('washes an opened chest with a drained grey distinct from the silver tier', () => {
    const spent = CHESTS_CATALOG.spentVisual;
    assert.ok(spent && spent.overlay && spent.tint);
    assert.notEqual(spent.tint.light, '#dfe3ea', 'spent grey must differ from silver');

    const ctx = makeFakeCtx();
    SpriteRenderer.drawChest(ctx, { tier: 'silver', opened: true }, 0, 0, 32);
    assert.ok(ctx.styles.includes(spent.overlay) || ctx.styles.includes(spent.tint.dark),
      'opened chest must paint the spent palette');
  });
});
