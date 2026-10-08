import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneControllerMethods } from '../app/scene-controller.js';
import { makeNpcRuntime, findTouchingNpc, spawnNpcsForScene } from '../engine/npc-system.js';
import { composeSceneById } from '../services/scene-composer.js';
import { createPartyPlayer } from '../engine/party.js';

// LIV-63: walking into / touching an NPC opens its default dialogue once per
// contact (Zelda-style touch-to-talk), without breaking the click/interact path.

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

function npc(id, x, y, extra = {}) {
  return makeNpcRuntime({ id, name: id, x, y, defaultDialogueId: `dlg_${id}`, ...extra });
}

test('LIV-63 collision talk', async (t) => {
  await t.test('findTouchingNpc: contact is the player tile or an orthogonal neighbour', () => {
    const npcs = [npc('near', 5, 5), npc('far', 10, 10)];
    assert.equal(findTouchingNpc(npcs, { x: 5, y: 6 }).npcId, 'near', 'below');
    assert.equal(findTouchingNpc(npcs, { x: 4, y: 5 }).npcId, 'near', 'left');
    assert.equal(findTouchingNpc(npcs, { x: 5, y: 5 }).npcId, 'near', 'overlap');
    assert.equal(findTouchingNpc(npcs, { x: 6, y: 6 }), null, 'diagonal is not contact');
    assert.equal(findTouchingNpc(npcs, { x: 20, y: 20 }), null, 'out of reach');
  });

  await t.test('findTouchingNpc ignores non-blocking NPCs', () => {
    const passthrough = [npc('ghost', 5, 5, { blocks: false })];
    assert.equal(findTouchingNpc(passthrough, { x: 5, y: 6 }), null);
  });

  await t.test('opens once per contact, re-arms only after separating', () => {
    const player = createPartyPlayer('magician');
    const npcs = [npc('captain_halden', 5, 5)];
    const app = fakeApp({ player, npcs });

    player.x = 5; player.y = 8;
    app.armContactTalk();
    assert.equal(app.maybeContactTalk(), false, 'no contact yet');
    assert.equal(app.calls.opened.length, 0);

    player.y = 6; // step into contact
    assert.equal(app.maybeContactTalk(), true, 'contact opens the dialogue');
    assert.equal(app.calls.opened.length, 1);
    assert.deepEqual(app.calls.events.at(-1), { type: 'talk', npcId: 'captain_halden' });
    assert.equal(app.calls.opened.at(-1).id, 'dlg_captain_halden');

    // Dialogue closed but still overlapping: must not reopen.
    app.isPaused = false;
    assert.equal(app.maybeContactTalk(), false, 'never reopens while in contact');
    assert.equal(app.calls.opened.length, 1);

    player.y = 8; // separate
    assert.equal(app.maybeContactTalk(), false, 'separating re-arms');
    player.y = 6; // re-touch
    assert.equal(app.maybeContactTalk(), true, 're-arm allows a fresh contact');
    assert.equal(app.calls.opened.length, 2);
  });

  await t.test('never auto-opens while a dialogue is already open', () => {
    const player = createPartyPlayer('magician');
    const npcs = [npc('wick', 5, 5)];
    const app = fakeApp({ player, npcs });
    player.x = 5; player.y = 6;
    app.isPaused = true;
    assert.equal(app.maybeContactTalk(), false, 'paused guard holds');
    assert.equal(app.calls.opened.length, 0);
    assert.equal(app.calls.events.length, 0);
    app.isPaused = false;
    assert.equal(app.maybeContactTalk(), true, 'resumes once the panel closes');
  });

  await t.test('spawning in contact does not auto-open until the player re-touches', () => {
    const player = createPartyPlayer('archer');
    const npcs = [npc('mara', 5, 5)];
    const app = fakeApp({ player, npcs });
    player.x = 5; player.y = 6;
    app.armContactTalk(); // simulates scene load adjacent to an NPC
    assert.equal(app.maybeContactTalk(), false, 'spawn contact is armed, not fired');
    player.y = 8;
    app.maybeContactTalk();
    player.y = 6;
    assert.equal(app.maybeContactTalk(), true, 're-touch after separating fires');
  });

  await t.test('a wandering NPC that steps into the player triggers', () => {
    const player = createPartyPlayer('paladin');
    const wanderer = npc('old_sailor_doran', 11, 9, { aiType: 'wander', wanderRadius: 2 });
    const app = fakeApp({ player, npcs: [wanderer] });
    player.x = 11; player.y = 11;
    app.armContactTalk();
    assert.equal(app.maybeContactTalk(), false, 'not touching yet');
    wanderer.x = 11; wanderer.y = 10; // the wanderer steps into contact
    assert.equal(app.maybeContactTalk(), true);
    assert.equal(app.calls.opened.at(-1).id, 'dlg_old_sailor_doran');
  });

  await t.test('every Havenreach NPC opens on contact', () => {
    const scene = composeSceneById('town_havenreach');
    const npcs = spawnNpcsForScene(scene);
    assert.ok(npcs.length >= 7, 'town exposes >= 7 NPCs');
    for (const target of npcs) {
      const player = createPartyPlayer('fighter');
      const app = fakeApp({ player, npcs });
      player.x = target.x;
      player.y = target.y + 1;
      app.armContactTalk();
      // Arm from the same spot, then simulate the approach from one tile away.
      player.y = target.y + 2;
      app.armContactTalk();
      player.y = target.y + 1;
      assert.equal(app.maybeContactTalk(), true, `${target.npcId} opens on contact`);
      assert.deepEqual(app.calls.events.at(-1), { type: 'talk', npcId: target.npcId });
    }
  });

  await t.test('contact path matches the click/interact path for the same NPC', () => {
    const scene = composeSceneById('town_havenreach');
    const npcs = spawnNpcsForScene(scene);
    const target = npcs.find((n) => n.npcId === 'captain_halden');

    const clickPlayer = createPartyPlayer('magician');
    const clickApp = fakeApp({ player: clickPlayer, npcs });
    clickPlayer.x = target.x - 1;
    clickPlayer.y = target.y;
    clickPlayer.facing = 'right';
    clickApp.interact();

    const touchPlayer = createPartyPlayer('magician');
    const touchApp = fakeApp({ player: touchPlayer, npcs });
    touchPlayer.x = target.x - 1;
    touchPlayer.y = target.y;
    touchApp.maybeContactTalk();

    assert.deepEqual(touchApp.calls.events, clickApp.calls.events, 'same talk event');
    assert.deepEqual(
      touchApp.calls.opened.map((o) => o.id),
      clickApp.calls.opened.map((o) => o.id),
      'same dialogue opened',
    );
  });
});
