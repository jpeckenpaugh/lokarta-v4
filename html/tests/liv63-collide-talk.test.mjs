import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneControllerMethods } from '../app/scene-controller.js';
import { gameLoopMethods } from '../app/game-loop.js';
import { makeNpcRuntime, findBumpedNpc, spawnNpcsForScene } from '../engine/npc-system.js';
import { composeSceneById } from '../services/scene-composer.js';
import { createPartyPlayer } from '../engine/party.js';
import { GridMap } from '../engine/grid-map.js';

// LIV-63 shipped touch-to-talk (any adjacent square opened dialogue). LIV-66
// refines it to bump-to-talk: the player must attempt to walk ONTO a blocking
// NPC's tile and be blocked by collision. Merely standing next to, or walking
// past, an NPC never opens dialogue. Click/interact is unchanged.

/** Minimal no-DOM app: real sceneController methods + stubs for the seams. */
function fakeApp({ player, npcs, scene = { sceneId: 'town_havenreach' } }) {
  const calls = { events: [], opened: [], logs: [] };
  const app = Object.assign({}, sceneControllerMethods, {
    calls,
    player,
    npcs,
    scene,
    isInGameplay: true,
    isPaused: false,
    isGameOver: false,
    isFloorCleared: false,
    fireQuestEvent: (ev) => { calls.events.push(ev); return []; },
    openDialogue: (id, ctx) => { calls.opened.push({ id, ctx }); app.isPaused = true; return true; },
    logCombat: (m) => calls.logs.push(m),
    updateHUD: () => {},
    persistSave: () => {},
  });
  return app;
}

/**
 * Minimal no-DOM app that also owns the game-loop methods, an all-floor grid,
 * and movement input — enough to drive the real `processMovementInput` blocked-
 * step path that arms bump-talk.
 */
function moveApp({ player, npcs, width = 12, height = 12 }) {
  const calls = { events: [], opened: [], logs: [] };
  const grid = new GridMap(width, height);
  grid.loadFromMatrix(Array.from({ length: height }, () => Array(width).fill(0)));
  const app = Object.assign({}, sceneControllerMethods, gameLoopMethods, {
    calls,
    player,
    npcs,
    scene: null,
    gridMap: grid,
    monsters: [],
    chests: [],
    props: [],
    keysDown: new Set(),
    isInGameplay: true,
    isPaused: false,
    isGameOver: false,
    isFloorCleared: false,
    fireQuestEvent: (ev) => { calls.events.push(ev); return []; },
    openDialogue: (id, ctx) => { calls.opened.push({ id, ctx }); app.isPaused = true; return true; },
    logCombat: (m) => calls.logs.push(m),
    updateHUD: () => {},
    persistSave: () => {},
  });
  return app;
}

function npc(id, x, y, extra = {}) {
  return makeNpcRuntime({ id, name: id, x, y, defaultDialogueId: `dlg_${id}`, ...extra });
}

test('LIV-63/LIV-66 bump talk', async (t) => {
  await t.test('findBumpedNpc: a bump is a blocked step onto the NPC tile', () => {
    const npcs = [npc('near', 5, 5), npc('far', 10, 10)];
    assert.equal(findBumpedNpc(npcs, 5, 6, 5, 5).npcId, 'near', 'step up');
    assert.equal(findBumpedNpc(npcs, 4, 5, 5, 5).npcId, 'near', 'step right');
    assert.equal(findBumpedNpc(npcs, 6, 5, 5, 5).npcId, 'near', 'step left');
    assert.equal(findBumpedNpc(npcs, 5, 4, 5, 5).npcId, 'near', 'step down');
    assert.equal(findBumpedNpc(npcs, 6, 6, 6, 5), null, 'no NPC on the destination');
    assert.equal(findBumpedNpc(npcs, 20, 20, 21, 20), null, 'out of reach');
  });

  await t.test('findBumpedNpc rejects non-single-step moves', () => {
    const npcs = [npc('near', 5, 5)];
    assert.equal(findBumpedNpc(npcs, 5, 5, 5, 5), null, 'no step');
    assert.equal(findBumpedNpc(npcs, 4, 4, 5, 5), null, 'diagonal is not a bump');
    assert.equal(findBumpedNpc(npcs, 5, 8, 5, 5), null, 'two tiles is not a bump');
  });

  await t.test('findBumpedNpc ignores non-blocking NPCs', () => {
    const passthrough = [npc('ghost', 5, 5, { blocks: false })];
    assert.equal(findBumpedNpc(passthrough, 5, 6, 5, 5), null);
  });

  await t.test('bumpTalk opens once per bump and never reopens while pressed', () => {
    const player = createPartyPlayer('magician');
    const npcs = [npc('captain_halden', 5, 5)];
    const app = fakeApp({ player, npcs });
    const target = npcs[0];

    player.x = 5; player.y = 6;
    app.armContactTalk();
    assert.equal(app.bumpTalk(target), true, 'the bump opens the dialogue');
    assert.equal(app.calls.opened.length, 1);
    assert.deepEqual(app.calls.events.at(-1), { type: 'talk', npcId: 'captain_halden' });
    assert.equal(app.calls.opened.at(-1).id, 'dlg_captain_halden');

    // Still pressed against the same NPC: must not stack a second dialogue.
    app.isPaused = false;
    assert.equal(app.bumpTalk(target), false, 'never reopens while pressed');
    assert.equal(app.calls.opened.length, 1);
  });

  await t.test('bumpTalk is re-armed by a scene load', () => {
    const player = createPartyPlayer('magician');
    const npcs = [npc('captain_halden', 5, 5)];
    const app = fakeApp({ player, npcs });
    const target = npcs[0];
    player.x = 5; player.y = 6;

    assert.equal(app.bumpTalk(target), true);
    app.isPaused = false;
    assert.equal(app.bumpTalk(target), false, 'latched');
    app.armContactTalk();
    assert.equal(app.bumpTalk(target), true, 'fresh scene re-arms the bump');
    assert.equal(app.calls.opened.length, 2);
  });

  await t.test('bumpTalk never opens while a dialogue is already open', () => {
    const player = createPartyPlayer('magician');
    const npcs = [npc('wick', 5, 5)];
    const app = fakeApp({ player, npcs });
    player.x = 5; player.y = 6;
    app.isPaused = true;
    assert.equal(app.bumpTalk(npcs[0]), false, 'paused guard holds');
    assert.equal(app.calls.opened.length, 0);
    assert.equal(app.calls.events.length, 0);
    app.isPaused = false;
    assert.equal(app.bumpTalk(npcs[0]), true, 'resumes once the panel closes');
  });

  await t.test('spawning adjacent to an NPC does not open until the player bumps', () => {
    const player = createPartyPlayer('archer');
    const npcs = [npc('mara', 5, 5)];
    const app = fakeApp({ player, npcs });
    player.x = 5; player.y = 6;
    app.armContactTalk(); // simulates scene load adjacent to an NPC
    // Adjacency alone never calls bumpTalk; the player must attempt the step.
    assert.equal(app.calls.opened.length, 0, 'spawn adjacency is silent');
    assert.equal(app.bumpTalk(npcs[0]), true, 'the deliberate bump fires');
  });

  await t.test('every Havenreach NPC opens when its tile is bumped', () => {
    const scene = composeSceneById('town_havenreach');
    const npcs = spawnNpcsForScene(scene);
    assert.ok(npcs.length >= 6, 'town exposes >= 6 NPCs');
    for (const target of npcs) {
      const player = createPartyPlayer('fighter');
      const app = fakeApp({ player, npcs });
      player.x = target.x;
      player.y = target.y + 1;
      const bumped = findBumpedNpc(npcs, player.x, player.y, target.x, target.y);
      assert.equal(bumped.npcId, target.npcId, `${target.npcId} is the bumped NPC`);
      assert.equal(app.bumpTalk(bumped), true, `${target.npcId} opens on bump`);
      assert.deepEqual(app.calls.events.at(-1), { type: 'talk', npcId: target.npcId });
    }
  });

  await t.test('bump path matches the click/interact path for the same NPC', () => {
    const scene = composeSceneById('town_havenreach');
    const npcs = spawnNpcsForScene(scene);
    const target = npcs.find((n) => n.npcId === 'captain_halden');

    const clickPlayer = createPartyPlayer('magician');
    const clickApp = fakeApp({ player: clickPlayer, npcs });
    clickPlayer.x = target.x - 1;
    clickPlayer.y = target.y;
    clickPlayer.facing = 'right';
    clickApp.interact();

    const bumpPlayer = createPartyPlayer('magician');
    const bumpApp = fakeApp({ player: bumpPlayer, npcs });
    bumpPlayer.x = target.x - 1;
    bumpPlayer.y = target.y;
    const bumped = findBumpedNpc(npcs, bumpPlayer.x, bumpPlayer.y, target.x, target.y);
    bumpApp.bumpTalk(bumped);

    assert.deepEqual(bumpApp.calls.events, clickApp.calls.events, 'same talk event');
    assert.deepEqual(
      bumpApp.calls.opened.map((o) => o.id),
      clickApp.calls.opened.map((o) => o.id),
      'same dialogue opened',
    );
  });

  await t.test('processMovementInput: adjacent standing and walking past stay silent', () => {
    const player = createPartyPlayer('magician');
    const npcs = [npc('captain_halden', 5, 5)];
    const app = moveApp({ player, npcs });
    app.armContactTalk();

    // Standing directly below the NPC with no movement input: silent.
    player.x = 5; player.y = 6;
    app.processMovementInput();
    assert.equal(app.calls.opened.length, 0, 'standing adjacent does not open');

    // Walking past (left) is a normal step: silent.
    app.keysDown = new Set(['ArrowLeft']);
    app.processMovementInput();
    assert.deepEqual([player.x, player.y], [4, 6], 'walked past');
    assert.equal(app.calls.opened.length, 0, 'walking past does not open');
  });

  await t.test('processMovementInput: a walk into the NPC bumps and opens once', () => {
    const player = createPartyPlayer('magician');
    const npcs = [npc('captain_halden', 5, 5)];
    const app = moveApp({ player, npcs });
    app.armContactTalk();
    player.x = 5; player.y = 6;

    // Attempt to walk up onto the NPC tile: blocked, and the bump talks.
    app.keysDown = new Set(['ArrowUp']);
    app.processMovementInput();
    assert.deepEqual([player.x, player.y], [5, 6], 'collision blocked the step');
    assert.equal(app.calls.opened.length, 1, 'walking into the NPC opens');
    assert.deepEqual(app.calls.events.at(-1), { type: 'talk', npcId: 'captain_halden' });

    // Keep pressing (dialogue closed, still adjacent): must not reopen.
    app.isPaused = false;
    app.processMovementInput();
    assert.equal(app.calls.opened.length, 1, 'no reopen while pressed');

    // Step away, then walk back in: a fresh bump reopens.
    app.keysDown = new Set(['ArrowDown']);
    app.processMovementInput();
    assert.deepEqual([player.x, player.y], [5, 7], 'stepped away');
    assert.equal(app._bumpTalkNpcId, null, 'the step re-arms the bump');
    app.keysDown = new Set(['ArrowUp']);
    app.processMovementInput(); // back to (5,6): free step
    app.processMovementInput(); // onto (5,5): bump
    assert.equal(app.calls.opened.length, 2, 'fresh bump after separating reopens');
  });
});
