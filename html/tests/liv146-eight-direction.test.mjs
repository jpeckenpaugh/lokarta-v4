/**
 * Lokarta: LIV-146 — 8-directional sprite set + angle-based frame rendering.
 *
 * Actors were authored in three render directions (`down`/`up`/`side`, left
 * mirrored from `side`). LIV-146 generalises the actor contract to the full
 * eight 45-degree directions and lets a continuous facing angle select the
 * nearest bucket. These tests pin the pure seams (no canvas):
 *
 *   1. `dir8FromAngle` quantises any continuous heading to the nearest of the
 *      eight 45-degree buckets and wraps.
 *   2. `dir8FromVector` / `dirFromFacing` accept vectors and legacy strings.
 *   3. `resolveFrameDir` maps every runtime direction onto a direction the def
 *      actually authors (8-dir bakes exactly; 3-dir flat defs via the fallback,
 *      with the mirror flag driving the left-hand half).
 *   4. `resolveSpriteFrame` returns the correct frame dir + flip for each of the
 *      eight requests against the baked archer and a legacy flat vocation.
 *   5. Every 3D-baked actor def (Player + NPCs + opponents) authors the five
 *      unique directions (down/down_side/side/up_side/up) with real frames.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIR8,
  DIR8_ANGLE,
  dir8FromAngle,
  dir8FromVector,
  dirFromFacing,
  flipFromFacing,
  normalizeDir8,
  resolveFrameDir,
} from '../app/animation-state.js';

import { resolveSpriteFrame } from '../app/sprite-renderer.js';
import { SPRITE_CATALOG } from '../assets/sprites/index.js';

const AUTHORS = ['down', 'down_side', 'side', 'up_side', 'up'];
const RAD = (deg) => (deg * Math.PI) / 180;

describe('LIV-146 8-direction sprite set + angle-based frame rendering', () => {
  it('1. dir8FromAngle quantises continuous headings to the nearest 45-degree bucket', () => {
    // Exact bucket centers.
    for (const dir of DIR8) assert.equal(dir8FromAngle(RAD(DIR8_ANGLE[dir])), dir, `${dir} center`);
    // Values inside a bucket round to its center; the +22.5 boundary is the tie.
    assert.equal(dir8FromAngle(RAD(20)), 'down');
    assert.equal(dir8FromAngle(RAD(44)), 'down_right');
    assert.equal(dir8FromAngle(RAD(89)), 'right');
    assert.equal(dir8FromAngle(RAD(134)), 'up_right');
    assert.equal(dir8FromAngle(RAD(179)), 'up');
    assert.equal(dir8FromAngle(RAD(224)), 'up_left');
    assert.equal(dir8FromAngle(RAD(269)), 'left');
    assert.equal(dir8FromAngle(RAD(314)), 'down_left');
    // Wrap-around and negatives.
    assert.equal(dir8FromAngle(RAD(350)), 'down');
    assert.equal(dir8FromAngle(RAD(-20)), 'down');
    assert.equal(dir8FromAngle(RAD(-90)), 'left');
    assert.equal(dir8FromAngle(RAD(720 + 45)), 'down_right');
    // Invalid input is a safe default, never a throw.
    assert.equal(dir8FromAngle(NaN), 'down');
    assert.equal(dir8FromAngle(undefined), 'down');
  });

  it('2. dir8FromVector + dirFromFacing accept vectors, angles, and legacy strings', () => {
    // Screen-space vectors: x right, y down.
    assert.equal(dir8FromVector(0, 1), 'down');
    assert.equal(dir8FromVector(1, 1), 'down_right');
    assert.equal(dir8FromVector(1, 0), 'right');
    assert.equal(dir8FromVector(1, -1), 'up_right');
    assert.equal(dir8FromVector(0, -1), 'up');
    assert.equal(dir8FromVector(-1, -1), 'up_left');
    assert.equal(dir8FromVector(-1, 0), 'left');
    assert.equal(dir8FromVector(-1, 1), 'down_left');
    assert.equal(dir8FromVector(0, 0), 'down', 'no heading defaults down');

    // dirFromFacing: number (radians), {x,y}, {angle}, legacy strings.
    assert.equal(dirFromFacing(RAD(90)), 'right');
    assert.equal(dirFromFacing({ x: 0, y: -1 }), 'up');
    assert.equal(dirFromFacing({ angle: RAD(270) }), 'left');
    assert.equal(dirFromFacing('down'), 'down');
    assert.equal(dirFromFacing('up'), 'up');
    assert.equal(dirFromFacing('right'), 'right');
    assert.equal(dirFromFacing('left'), 'left');
    assert.equal(dirFromFacing('side'), 'right', 'authored side aliases right');
    assert.equal(dirFromFacing('down_side'), 'down_right', 'authored diagonal aliases runtime dir');
    assert.equal(dirFromFacing('nonsense'), 'down', 'unknown facing defaults down');
    assert.equal(dirFromFacing(undefined), 'down');

    // Mirror flag is exactly the left-hand half of the eight directions.
    for (const dir of DIR8) {
      const expected = dir === 'left' || dir === 'up_left' || dir === 'down_left';
      assert.equal(flipFromFacing(dir), expected, `${dir} mirror flag`);
    }
  });

  it('3. resolveFrameDir maps every runtime direction to an authored direction', () => {
    // Full 8-dir def: exact authored dir + mirror for the left-hand half.
    const full = { down: [], down_side: [], side: [], up_side: [], up: [] };
    const expectFull = {
      down: { dir: 'down', flip: false },
      down_right: { dir: 'down_side', flip: false },
      right: { dir: 'side', flip: false },
      up_right: { dir: 'up_side', flip: false },
      up: { dir: 'up', flip: false },
      up_left: { dir: 'up_side', flip: true },
      left: { dir: 'side', flip: true },
      down_left: { dir: 'down_side', flip: true },
    };
    for (const [dir, want] of Object.entries(expectFull)) {
      assert.deepEqual(resolveFrameDir(full, dir), want, `full ${dir}`);
    }

    // Legacy 3-dir def: diagonals + cardinals fall back to a direction it owns,
    // and the left-hand half still mirrors the profile.
    const legacy = { down: [], up: [], side: [] };
    assert.deepEqual(resolveFrameDir(legacy, 'down'), { dir: 'down', flip: false });
    assert.deepEqual(resolveFrameDir(legacy, 'up'), { dir: 'up', flip: false });
    assert.deepEqual(resolveFrameDir(legacy, 'right'), { dir: 'side', flip: false });
    assert.deepEqual(resolveFrameDir(legacy, 'left'), { dir: 'side', flip: true });
    assert.equal(resolveFrameDir(legacy, 'down_right').flip, false);
    assert.equal(resolveFrameDir(legacy, 'up_right').flip, false);
    assert.equal(resolveFrameDir(legacy, 'down_left').flip, true);
    assert.equal(resolveFrameDir(legacy, 'up_left').flip, true);
    for (const dir of DIR8) {
      const { dir: frameDir } = resolveFrameDir(legacy, dir);
      assert.ok(Array.isArray(legacy[frameDir]), `${dir} resolves to an authored dir`);
    }
  });

  it('4. resolveSpriteFrame selects the right frame dir + flip for the eight facings', () => {
    const archer = SPRITE_CATALOG.archer;
    const cases = {
      down: ['down', false],
      down_right: ['down_side', false],
      right: ['side', false],
      up_right: ['up_side', false],
      up: ['up', false],
      up_left: ['up_side', true],
      left: ['side', true],
      down_left: ['down_side', true],
    };
    for (const [dir, [frameDir, flip]] of Object.entries(cases)) {
      const r = resolveSpriteFrame(archer, { state: 'walk', dir, frame: 0 });
      assert.equal(r.dir, frameDir, `${dir} frame dir`);
      assert.equal(r.flip, flip, `${dir} flip`);
      assert.ok(archer.frames[r.frameId], `${dir} frame ${r.frameId} exists`);
      assert.ok(String(r.frameId).startsWith('walk_'), `${dir} picks a walk frame`);
    }

    // The continuous angle path: 45° maps to down_right and animates the
    // down_side walk steps.
    const angled = resolveSpriteFrame(archer, { state: 'walk', dir: dirFromFacing(RAD(45)), frame: 1 });
    assert.equal(angled.dir, 'down_side');
    assert.equal(angled.frameId, archer.animations.walk.down_side[1]);

    // Backward compatible: a legacy 3-dir flat vocation keeps `side`, mirrored
    // for left, and down/up unchanged.
    const paladin = SPRITE_CATALOG.paladin;
    assert.deepEqual(
      ['down', 'up', 'left', 'right'].map((d) => resolveSpriteFrame(paladin, { state: 'walk', dir: d, frame: 0 }).dir),
      ['down', 'up', 'side', 'side']
    );
    assert.equal(resolveSpriteFrame(paladin, { state: 'walk', dir: 'left', frame: 0 }).flip, true);
    assert.equal(resolveSpriteFrame(paladin, { state: 'walk', dir: 'right', frame: 0 }).flip, false);
  });

  it('5. every 3D-baked actor authors the five unique directions (8 with mirror)', () => {
    const baked = Object.entries(SPRITE_CATALOG).filter(([, def]) => def.baked3d === true);
    assert.ok(baked.length >= 10, `expected the baked Player/NPC/opponent set, got ${baked.length}`);
    for (const [id, def] of baked) {
      for (const [state, dirs] of Object.entries(def.animations)) {
        // Death is direction-independent (one collapse set), so only the moving
        // and combat states must author every unique direction.
        if (state !== 'death') {
          for (const dir of AUTHORS) {
            assert.ok(Array.isArray(dirs[dir]) && dirs[dir].length > 0, `${id}.${state} missing ${dir}`);
            for (const fid of dirs[dir]) assert.ok(def.frames[fid], `${id} missing frame ${fid}`);
          }
        }
        // Every one of the eight runtime directions resolves to a real frame.
        for (const dir of DIR8) {
          const r = resolveSpriteFrame(def, { state, dir, frame: 0 });
          assert.ok(def.frames[r.frameId], `${id}.${state} dir ${dir} -> ${r.frameId}`);
        }
      }
      // The 45-degree views are genuinely distinct from the cardinals (real
      // three-quarter art, not a copy).
      assert.notDeepEqual(def.frames.idle_down_side, def.frames.idle_down, `${id} idle diagonal`);
      assert.notDeepEqual(def.frames.idle_down_side, def.frames.idle_side, `${id} idle diagonal vs profile`);
      if (def.frames.idle_up_side) {
        assert.notDeepEqual(def.frames.idle_up_side, def.frames.idle_up, `${id} up diagonal`);
      }
    }
  });

  it('6. normalizeDir8 folds authored aliases and rejects unknown names', () => {
    assert.equal(normalizeDir8('side'), 'right');
    assert.equal(normalizeDir8('down_side'), 'down_right');
    assert.equal(normalizeDir8('up_side'), 'up_right');
    assert.equal(normalizeDir8('left'), 'left');
    assert.equal(normalizeDir8('bogus'), 'down');
    assert.equal(normalizeDir8(null), 'down');
  });
});
