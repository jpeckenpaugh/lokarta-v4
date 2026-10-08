/**
 * LIV-45 — Knockout visuals + revive catalog tuning (Phases 4-5).
 *
 * Locks the E3 "Vigils" per-vocation revive data (Paladin reliable, Magician
 * fast/mana-hungry, Archer quick/low, Fighter drag/reduction levers), the
 * knockout presentation tokens in ui.json, and the pure renderer seams that
 * draw the downed grey-out, the E1 call-for-help beacon and the revive channel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReviveConfig } from '../engine/revive-system.js';
import { UI_CATALOG, PARTY_AI_CATALOG } from '../data/index.js';
import { CanvasRenderer } from '../app/canvas-renderer.js';

function makeCtxSpy() {
  const calls = { fills: 0, strokes: 0, total: 0 };
  const ctx = {
    save() { calls.total++; },
    restore() { calls.total++; },
    beginPath() { calls.total++; },
    closePath() { calls.total++; },
    arc() { calls.total++; },
    ellipse() { calls.total++; },
    moveTo() { calls.total++; },
    lineTo() { calls.total++; },
    fill() { calls.fills++; calls.total++; },
    stroke() { calls.strokes++; calls.total++; },
    fillRect() { calls.fills++; calls.total++; },
    set globalAlpha(v) {},
    set fillStyle(v) {},
    set strokeStyle(v) {},
    set lineWidth(v) {},
  };
  return { ctx, calls };
}

function living(memberId, vocation, x, y, extra = {}) {
  return { memberId, vocation, x, y, hp: 100, max_hp: 100, combatState: 'active', lifeState: 'alive', ...extra };
}

function downed(memberId, vocation, x, y, extra = {}) {
  return { memberId, vocation, x, y, hp: 0, max_hp: 100, combatState: 'downed', lifeState: 'downed', ...extra };
}

test('LIV-45 E3 Vigils: per-vocation revive flavors are pure data overrides', () => {
  const paladin = resolveReviveConfig('paladin');
  assert.equal(paladin.hpPct, 0.35, 'Paladin Holy Prayer is the most reliable rescue');
  const magician = resolveReviveConfig('magician');
  assert.equal(magician.channelSec, 1.4, 'Magician Arcane Suture is the fastest channel');
  assert.equal(magician.manaCost, 40, 'Magician pays the steepest mana');
  const archer = resolveReviveConfig('archer');
  assert.equal(archer.channelSec, 1.6, 'Archer Field Salve is quick');
  assert.equal(archer.hpPct, 0.2, 'Archer Field Salve restores less');

  // Fighter's drag/damage-reduction levers are authored on the profile even
  // before the engine handler lands; the resolver ignores unknown keys today.
  const fighter = PARTY_AI_CATALOG.profiles.fighter.revive;
  assert.equal(fighter.dragTiles, 1);
  assert.equal(fighter.damageReductionPct, 0.25);
});

test('LIV-45 ui.json declares the knockout presentation tokens', () => {
  const visuals = UI_CATALOG.knockout.visuals;
  assert.ok(visuals, 'ui.json.knockout.visuals exists');
  assert.ok(visuals.downed.tintAmount >= 0.3 && visuals.downed.tintAmount <= 0.5, '~40% desaturate');
  assert.equal(typeof visuals.downed.alpha, 'number');
  assert.ok(visuals.beacon.ringMaxTiles > visuals.beacon.ringMinTiles);
  assert.ok(visuals.channel.color);
  // Behavior switch lives in party_ai so the world read and AI share one source.
  assert.equal(PARTY_AI_CATALOG.revive.callForHelp.enabled, true);
});

test('LIV-45 renderer: nearest living ally ignores downed bodies and the active mirror', () => {
  const renderer = new CanvasRenderer(null);
  const player = living('a', 'fighter', 0, 0);
  const party = [
    player,
    downed('b', 'magician', 5, 0),
    living('c', 'archer', 3, 0),
    living('d', 'paladin', 9, 0),
  ];
  const ally = renderer.nearestLivingAlly(player, party, 5, 0);
  assert.ok(ally);
  assert.equal(ally.memberId, 'c', 'the nearest living member to the body wins');
});

test('LIV-45 renderer: a downed body draws the call-for-help beacon', () => {
  const renderer = new CanvasRenderer(null);
  const player = living('a', 'fighter', 0, 0);
  const party = [player, downed('b', 'magician', 4, 4)];
  const spy = makeCtxSpy();
  renderer.renderKnockoutVfx(spy.ctx, player, party, 0);
  assert.ok(spy.calls.strokes > 0, 'the pulsing ring strokes');
  assert.ok(spy.calls.fills > 0, 'the locator pip fills');
});

test('LIV-45 renderer: all-living party draws no knockout VFX', () => {
  const renderer = new CanvasRenderer(null);
  const player = living('a', 'fighter', 0, 0);
  const party = [player, living('b', 'magician', 4, 4)];
  const spy = makeCtxSpy();
  renderer.renderKnockoutVfx(spy.ctx, player, party, 0);
  assert.equal(spy.calls.total, 0, 'nothing is drawn without a downed body or channel');
});

test('LIV-45 renderer: a channeling reviver draws the tether + progress arc', () => {
  const renderer = new CanvasRenderer(null);
  const player = living('a', 'fighter', 0, 0);
  const reviver = living('b', 'paladin', 3, 3, { _reviveTargetId: 'c', _reviveProgressSec: 1, _reviveBlocked: false });
  const target = downed('c', 'magician', 4, 3);
  const party = [player, reviver, target];
  const spy = makeCtxSpy();
  renderer.renderKnockoutVfx(spy.ctx, player, party, 0);
  assert.ok(spy.calls.strokes >= 2, 'tether beam + progress arc both stroke');
});
