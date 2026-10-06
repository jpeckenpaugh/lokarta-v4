import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteRenderer } from '../app/sprite-renderer.js';
import { CanvasRenderer } from '../app/canvas-renderer.js';
import { HUDManager } from '../app/hud-manager.js';
import { ModalManager } from '../app/modal-manager.js';
import { InputController } from '../app/input-controller.js';
import { LokartaApp } from '../app/app-controller.js';
import * as AppExports from '../app/index.js';
import * as RootAppExports from '../app.js';

test('App Submodules & Root Re-exports', async (t) => {
  await t.test('verifies SpriteRenderer exports and helper methods', () => {
    assert.equal(typeof SpriteRenderer.drawTile, 'function');
    assert.equal(typeof SpriteRenderer.drawPlayer, 'function');
    assert.equal(typeof SpriteRenderer.drawMonster, 'function');
    assert.equal(typeof SpriteRenderer.drawItem, 'function');
  });

  await t.test('dispatches weapon visuals by catalog renderKey (no item_id substring sniff)', () => {
    const calls = [];
    const ctx = {
      calls,
      canvas: { width: 64, height: 64 },
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      beginPath: () => calls.push('beginPath'),
      moveTo: () => {},
      lineTo: () => {},
      arc: () => calls.push('arc'),
      stroke: () => calls.push('stroke'),
      fill: () => calls.push('fill'),
      fillRect: () => calls.push('fillRect'),
    };

    SpriteRenderer.drawItem(ctx, { type: 'weapon', item_id: 'wooden_bow', renderKey: 'archer', quantity: 1 }, 0, 0, 32);
    assert.ok(calls.includes('arc'), 'archer renderKey selects the bow arc renderer');

    calls.length = 0;
    SpriteRenderer.drawItem(ctx, { type: 'weapon', item_id: 'consecrated_warhammer', renderKey: 'paladin', quantity: 1 }, 0, 0, 32);
    assert.ok(calls.includes('fillRect') && !calls.includes('arc'), 'paladin renderKey selects the hammer block renderer');

    calls.length = 0;
    SpriteRenderer.drawItem(ctx, { type: 'weapon', item_id: 'mystery_weapon', quantity: 1 }, 0, 0, 32);
    assert.ok(calls.includes('stroke'), 'unknown weapon falls back to the neutral default renderer');
  });

  await t.test('verifies CanvasRenderer constructor and coordinate conversion', () => {
    const cr = new CanvasRenderer(null);
    assert.equal(cr.cameraX, 0);
    assert.equal(cr.cameraY, 0);
    const grid = cr.screenToGrid(32, 64);
    assert.equal(typeof grid.x, 'number');
    assert.equal(typeof grid.y, 'number');
  });

  await t.test('verifies HUDManager helper functions', () => {
    assert.equal(HUDManager.renderItemIcon({ item_id: 'health_potion', name: 'Health Potion' }), '<img class="openmoji-icon" src="./assets/openmoji/1F9EA.svg" alt="Health Potion" draggable="false" />');
    assert.equal(HUDManager.escapeHtml('<test>'), '&lt;test&gt;');
  });

  await t.test('verifies ModalManager static methods', () => {
    assert.equal(typeof ModalManager.showTitleScreen, 'function');
    assert.equal(typeof ModalManager.showCharacterSelectModal, 'function');
    assert.equal(typeof ModalManager.showFateGrantModal, 'function');
    assert.equal(typeof ModalManager.showOptionsModal, 'function');
    assert.equal(typeof ModalManager.showSlotSelectModal, 'function');
    assert.equal(typeof ModalManager.showConfirmModal, 'function');
    assert.equal(typeof ModalManager.showPauseModal, 'function');
  });

  await t.test('verifies InputController class', () => {
    assert.equal(typeof InputController.prototype.bindInputs, 'function');
  });

  await t.test('verifies Beam Wave swept-up carrying and collision resolution', () => {
    globalThis.soundFX = { play: () => {}, playAt: () => {} };
    globalThis.CONFIG = { GRID_SIZE: 64 };
    const mockApp = Object.create(LokartaApp.prototype);
    mockApp.particles = [];
    mockApp.floatingTexts = [];
    mockApp.logCombat = () => {};
    mockApp.addFloatingText = () => {};
    mockApp.triggerImpactBurst = () => {};
    mockApp.handleCombatResult = () => {};
    mockApp.gridMap = {
      width: 10,
      height: 10,
      isWall: (x, y) => x === 5 && y === 2, // Wall at (5,2)
      isInBounds: (x, y) => x >= 0 && x < 10 && y >= 0 && y < 10,
      isWalkable: (x, y) => x >= 0 && x < 10 && y >= 0 && y < 10 && !(x === 5 && y === 2),
    };
    mockApp.monsters = [
      { id: 'm1', name: 'Goblin A', x: 2, y: 2, hp: 100 },
      { id: 'm2', name: 'Goblin B', x: 3, y: 2, hp: 150 },
    ];
    mockApp.projectiles = [
      {
        type: 'energy_beam',
        fX: 1,
        fY: 0,
        currentWaveIndex: -1,
        elapsedMs: 0,
        stepIntervalMs: 100,
        stepDamage: [30, 30, 30],
        stepVolumes: [1, 1, 1],
        hitMonsterIds: [],
        waves: [
          { tiles: [{ x: 2, y: 2, isWall: false }] },
          { tiles: [{ x: 3, y: 2, isWall: false }] },
          { tiles: [{ x: 4, y: 2, isWall: false }] },
          { tiles: [{ x: 5, y: 2, isWall: true }] },
        ],
      },
    ];

    // Step 0 (50ms): targetWaveIndex = 0 -> Goblin A caught at x=2
    mockApp.updateAnimations(50);
    assert.equal(mockApp.monsters[0].x, 2);
    assert.equal(mockApp.monsters[0].hp, 70); // 100 - 30

    // Step 1 (50ms -> total 100ms -> targetWaveIndex = 1): Goblin A moves to x=3, Goblin B caught at x=3 -> STACK COLLISION (+10 extra dmg)
    mockApp.updateAnimations(50);
    assert.equal(mockApp.monsters[0].x, 3);
    assert.equal(mockApp.monsters[1].x, 3);
    assert.equal(mockApp.monsters[0].hp, 30); // 70 - 30 - 10 = 30
    assert.equal(mockApp.monsters[1].hp, 110); // 150 - 30 - 10 = 110

    // Step 2 (100ms -> total 200ms -> targetWaveIndex = 2): both move to x=4 -> Goblin A takes 30 dmg & is slain (0 HP); Goblin B takes 30 dmg (80 HP, no stack collide since A is dead)
    mockApp.updateAnimations(100);
    assert.equal(mockApp.monsters[0].x, 4);
    assert.equal(mockApp.monsters[1].x, 4);
    assert.equal(mockApp.monsters[0].hp, 0); // Slain! (30 - 30 = 0)
    assert.equal(mockApp.monsters[1].hp, 80); // 110 - 30 = 80

    // Step 3 (100ms -> total 300ms -> targetWaveIndex = 3): x=5 is wall -> Goblin B hits wall at x=5 -> WALL COLLISION (+10 extra dmg), stays at x=4
    mockApp.updateAnimations(100);
    assert.equal(mockApp.monsters[1].x, 4);
    assert.equal(mockApp.monsters[1].hp, 70); // 80 - 10 (wall) = 70

    // Wave expires & resolves end positions (elapsed 300 + 210 = 510ms >= 500ms)
    mockApp.updateAnimations(210);
    assert.equal(mockApp.monsters[1].x, 4); // Placed safely on walkable tile
    assert.equal(mockApp.monsters[1].stunTimer, 0.5); // Stun extended for 0.5s after wave ends
  });
});

