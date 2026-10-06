/**
 * Lokarta: Come Into The Light - Projectile / Attack Collision Helpers
 *
 * Pure, allocation-light helpers that make fast-moving attacks unable to phase
 * through a monster. A tile-sampled projectile that only tests its endpoint can
 * "swap places" with a monster moving the other way in the same frame: the
 * monster steps onto the tile the projectile just left while the projectile
 * lands on the tile the monster just left. These helpers close that seam by
 * sweeping the whole tile span between an attack's previous and next position.
 *
 * No DOM, worker, or storage I/O.
 */

/**
 * Walks the grid tiles crossed by a segment (Bresenham), inclusive of both
 * endpoints, from (x0,y0) to (x1,y1). Returns at most one entry per tile in
 * travel order. Integer-only on the hot path.
 *
 * @returns {{x:number,y:number}[]}
 */
export function tilesOnSegment(x0, y0, x1, y1) {
  let x = Math.trunc(x0);
  let y = Math.trunc(y0);
  const ex = Math.trunc(x1);
  const ey = Math.trunc(y1);
  const dx = Math.abs(ex - x);
  const dy = Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx - dy;

  const out = [{ x, y }];
  // Guard against a pathological loop; the grid diagonal is tiny.
  let guard = dx + dy + 2;
  while ((x !== ex || y !== ey) && guard-- > 0) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
    out.push({ x, y });
  }
  return out;
}

/**
 * The first live monster standing on any tile of the segment, in travel order.
 * A wall tile stops the sweep first, so a projectile cannot reach a monster
 * behind a wall.
 *
 * @param {object[]} monsters
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {(x:number,y:number)=>boolean} isWall
 * @returns {{ monster: object, tile: {x:number,y:number}|null, stoppedByWall: boolean }|null}
 */
export function firstMonsterOnSegment(monsters, x0, y0, x1, y1, isWall) {
  const tiles = tilesOnSegment(x0, y0, x1, y1);
  for (const tile of tiles) {
    if (isWall && isWall(tile.x, tile.y)) {
      return { monster: null, tile, stoppedByWall: true };
    }
    const monster = monsters.find(m => m.hp > 0 && m.x === tile.x && m.y === tile.y);
    if (monster) return { monster, tile, stoppedByWall: false };
  }
  return null;
}

/**
 * True when a monster standing on `tile` lies anywhere behind (or on) an
 * attack front that has advanced through waves `0..frontIndex` along the
 * given facing. Used by the beam so an enemy that walks back into a tile the
 * wave already swept is still caught instead of passing through.
 *
 * @param {{x:number,y:number}} tile
 * @param {number} originX
 * @param {number} originY
 * @param {number} fX
 * @param {number} fY
 * @param {number} frontIndex
 * @returns {boolean}
 */
export function isInSweptBeam(tile, originX, originY, fX, fY, frontIndex) {
  if (frontIndex < 0) return false;
  const relX = tile.x - originX;
  const relY = tile.y - originY;
  // Distance along the facing axis, and perpendicular offset.
  const along = relX * fX + relY * fY;
  const across = relX * (-fY) + relY * fX;
  // The wave expands to width 2*s+1 as it advances; a swept tile is one whose
  // forward distance is at most the front and whose lateral offset fits the
  // front's half-width.
  return along >= 1 && along <= frontIndex + 1 && Math.abs(across) <= frontIndex;
}

/**
 * Given a monster's previous and next tile and an attack travelling the
 * opposite way through the same corridor, true when the two would swap places
 * (the monster steps onto the tile the attack is leaving as the attack steps
 * onto the monster's tile). Detected attacks refuse the move rather than
 * phasing.
 *
 * @param {{x:number,y:number}} from - monster previous tile
 * @param {{x:number,y:number}} to - monster next tile
 * @param {{x:number,y:number}} attackTile - current attack tile
 * @param {{x:number,y:number}} attackNext - attack's next tile
 * @returns {boolean}
 */
export function wouldSwapPlaces(from, to, attackTile, attackNext) {
  return (
    from.x === attackNext.x && from.y === attackNext.y &&
    to.x === attackTile.x && to.y === attackTile.y
  );
}

/**
 * Resolves which monsters a swept beam front has caught this step, including
 * monsters that moved backward into already-swept tiles. Returns the newly
 * caught monsters (not already in `carriedIds`).
 *
 * @param {object[]} monsters
 * @param {Array<{x:number,y:number}>} waveTiles - current front tiles
 * @param {{originX:number,originY:number,fX:number,fY:number,frontIndex:number}} geometry
 * @param {Set<string>|Array<string>} carriedIds
 * @returns {object[]}
 */
export function monstersCaughtByBeam(monsters, waveTiles, geometry, carriedIds) {
  const carried = carriedIds instanceof Set ? carriedIds : new Set(carriedIds || []);
  const caught = [];
  const seen = new Set();

  const consider = monster => {
    if (monster.hp <= 0 || carried.has(monster.id) || seen.has(monster.id)) return;
    seen.add(monster.id);
    caught.push(monster);
  };

  for (const tile of waveTiles) {
    if (tile.isWall) continue;
    for (const monster of monsters) {
      if (monster.x === tile.x && monster.y === tile.y) consider(monster);
    }
  }

  // Backstop: an enemy that stepped behind the front (into a swept tile) is
  // still in the wave and must be caught, never phased through.
  for (const monster of monsters) {
    if (monster.hp <= 0 || carried.has(monster.id) || seen.has(monster.id)) continue;
    if (isInSweptBeam(monster, geometry.originX, geometry.originY, geometry.fX, geometry.fY, geometry.frontIndex)) {
      consider(monster);
    }
  }

  return caught;
}
