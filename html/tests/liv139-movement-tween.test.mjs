import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../engine/config.js';
import { MOVEMENT_CATALOG } from '../data/index.js';
import { createPartyPlayer } from '../engine/party.js';
import { GridMap } from '../engine/grid-map.js';
import { gameLoopMethods } from '../app/game-loop.js';
import {
  tweenIntermediatePositions,
  tweenStepProgress,
  advanceActorTween,
  tweenTileX,
  tweenTileY,
} from '../app/actor-tween.js';

// LIV-139: movement feel pass. The player step cadence is halved (10 -> 5
// tiles/sec) and every tile hop — player, NPC and opponent — is drawn as a
// ~3 intermediate-frame tween instead of a snap. The logical tile position
// stays authoritative; only rendering interpolates.

/** Minimal no-DOM app that owns the game-loop movement methods. */
function moveApp(player, { width = 24, height = 24 } = {}) {
  const grid = new GridMap(width, height);
  grid.loadFromMatrix(Array.from({ length: height }, () => Array(width).fill(0)));
  return Object.assign({}, gameLoopMethods, {
    player,
    gridMap: grid,
    monsters: [],
    npcs: [],
    chests: [],
    scene: null,
    keysDown: new Set(),
    fireQuestEvent: () => [],
    logCombat: () => {},
    updateHUD: () => {},
    persistSave: () => {},
  });
}

test('LIV-139 movement tween', async (t) => {
  await t.test('catalog halves the player speed and declares 3 tween frames', () => {
    assert.equal(MOVEMENT_CATALOG.player.tilesPerSec, 5, 'catalog speed');
    assert.equal(CONFIG.PLAYER_MOVE_SPEED_TILES_PER_SEC, 5, 'config reads catalog');

    // The legacy cadence was one tile per 10 Hz tick = 10 tiles/sec.
    const legacyTilesPerSec = 1 / (CONFIG.TICK_INTERVAL_MS / 1000);
    assert.equal(legacyTilesPerSec, 10);
    assert.equal(CONFIG.PLAYER_MOVE_SPEED_TILES_PER_SEC, legacyTilesPerSec / 2, 'halved');

    assert.equal(CONFIG.MOVE_TWEEN_INTERMEDIATE_FRAMES, 3);
    assert.ok(CONFIG.MOVE_TWEEN_DURATION_MS > 0);
  });

  await t.test('tweenIntermediatePositions draws exactly N intermediate steps', () => {
    const horiz = tweenIntermediatePositions(0, 0, 1, 0, 3);
    assert.equal(horiz.length, 3, 'three intermediate frames');
    assert.deepEqual(horiz.map((s) => s.x), [0.25, 0.5, 0.75]);
    assert.ok(horiz.every((s) => s.y === 0));

    const vert = tweenIntermediatePositions(2, 2, 2, 3, 3);
    assert.deepEqual(vert.map((s) => s.y), [2.25, 2.5, 2.75]);

    // Steps are strictly between the endpoints (never snap endpoints).
    assert.ok(horiz.every((s) => s.x > 0 && s.x < 1));
    assert.equal(tweenIntermediatePositions(0, 0, 1, 0, 4).length, 4);
  });

  await t.test('tweenStepProgress quantizes onto the intermediate ladder', () => {
    const ladder = [0, 0.1, 0.25, 0.3, 0.5, 0.6, 0.75, 0.8, 1].map((p) => tweenStepProgress(p, 3));
    assert.deepEqual(ladder, [0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1]);
  });

  await t.test('advanceActorTween interpolates a one-tile hop and snaps a jump', () => {
    const actor = { x: 0, y: 0 };
    advanceActorTween(actor, 0);
    assert.equal(tweenTileX(actor), 0, 'init at the logical tile');

    actor.x = 1;
    advanceActorTween(actor, CONFIG.MOVE_TWEEN_DURATION_MS / 2);
    assert.equal(tweenTileX(actor), 0.5, 'halfway through the hop');

    advanceActorTween(actor, CONFIG.MOVE_TWEEN_DURATION_MS / 2);
    assert.equal(tweenTileX(actor), 1, 'lands on the destination');
    assert.equal(actor.x, 1, 'logical position untouched by the tween');

    // A multi-tile warp (floor transition / knockback) must not slide.
    actor.x = 9;
    advanceActorTween(actor, 10);
    assert.equal(tweenTileX(actor), 9, 'jump snaps to the logical tile');
  });

  await t.test('player cadence gate: 5 steps/sec at the 10 Hz tick', () => {
    const player = createPartyPlayer('magician');
    player.x = 5;
    player.y = 5;
    const app = moveApp(player);
    app.keysDown = new Set(['ArrowRight']);

    const dt = CONFIG.TICK_INTERVAL_MS / 1000;
    const ticks = 20; // 2 seconds
    for (let i = 0; i < ticks; i++) app.processMovementInput(dt);
    assert.equal(player.x - 5, 10, '5 tiles/sec over 2s');

    // Legacy discrete invocation (no delta) keeps one-step-per-call semantics.
    const legacy = createPartyPlayer('magician');
    legacy.x = 5;
    legacy.y = 5;
    const legacyApp = moveApp(legacy);
    legacyApp.keysDown = new Set(['ArrowRight']);
    legacyApp.processMovementInput();
    assert.equal(legacy.x, 6, 'direct call still steps once');
  });

  await t.test('updateAnimations tweens the player, allies, NPCs and opponents', () => {
    const player = { x: 0, y: 0, facing: 'down', activeMemberId: 'hero', party: [{ x: 1, y: 1, memberId: 'ally1' }] };
    const monster = { x: 0, y: 0, hp: 1 };
    const npc = { x: 5, y: 5 };
    const app = Object.assign({}, gameLoopMethods, {
      player,
      monsters: [monster],
      npcs: [npc],
      projectiles: [],
      particles: [],
      floatingTexts: [],
      deathEffects: [],
      swapFeedback: null,
    });

    app.updateAnimations(0); // seed tween state at current tiles

    monster.x = 1; // opponent steps
    npc.x = 6;     // NPC steps
    player.party[0].x = 2; // ally steps
    player.x = 0;  // hero holds

    app.updateAnimations(CONFIG.MOVE_TWEEN_DURATION_MS / 2);

    assert.equal(tweenTileX(monster), 0.5, 'opponent interpolates');
    assert.equal(tweenTileX(npc), 5.5, 'NPC interpolates');
    assert.equal(tweenTileX(player.party[0]), 1.5, 'ally interpolates');
    assert.equal(tweenTileX(player), 0, 'stationary hero stays put');
    assert.equal(monster.x, 1, 'opponent logical tile is authoritative');
    assert.equal(npc.x, 6, 'NPC logical tile is authoritative');
  });
});
