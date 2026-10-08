/**
 * Lokarta: Come Into The Light - Lighting & Dynamic FOV Subsystem
 */

import { CONFIG } from './config.js';
import { ABILITIES_CATALOG, ITEMS_CATALOG } from '../data/index.js';

export class LightingSystem {
  /**
   * Computes the player's active field of view radius dynamically from JSON catalog specs.
   * @param {object} player
   * @returns {number}
   */
  static computePlayerRadius(player) {
    let spellBonus = 0;
    if (player.lightSpellTimer > 0) {
      const stages = ABILITIES_CATALOG.magician_light?.radiusStages || [];
      const activeStage = stages.find(s => player.lightSpellTimer >= s.minRemainingSec);
      spellBonus = activeStage ? activeStage.radiusBonus : 0;
    }

    const offHand = player.paperdoll?.off_hand || player.paperdoll?.left_hand;
    const mainHand = player.paperdoll?.main_hand || player.paperdoll?.right_hand;
    const actionItems = player.action_bar || [];
    const equippedOrCarried = [offHand, mainHand, ...actionItems].filter(Boolean);

    const itemBonus = equippedOrCarried.reduce((maxBonus, item) => {
      const catalogItem = ITEMS_CATALOG[item.item_id];
      const bonus = catalogItem?.lightRadiusBonus || 0;
      return Math.max(maxBonus, bonus);
    }, 0);

    return CONFIG.BASE_LIGHT_RADIUS + Math.max(spellBonus, itemBonus);
  }

  /**
   * Marks every tile lit for an ambient (outdoor) scene — the overworld is
   * daylight, so the player-radius FOV is skipped (LIV-59 P1). Additive: cave
   * floors keep using `updateLighting`. Scalar writes only, no allocation.
   * @param {import('./grid-map.js').GridMap} gridMap
   */
  static applyAmbient(gridMap) {
    for (let y = 0; y < gridMap.height; y++) {
      for (let x = 0; x < gridMap.width; x++) {
        const tile = gridMap.tiles[y][x];
        tile.isLit = true;
        tile.lightIntensity = 1;
      }
    }
  }

  /**
   * Recalculates lighting map and entity visibility across the dungeon.
   * @param {import('./grid-map.js').GridMap} gridMap
   * @param {object} player
   * @param {Array<object>} ambientLights
   * @param {Array<object>} monsters
   */
  static updateLighting(gridMap, player, ambientLights = [], monsters = []) {
    // 1. Reset all tiles
    for (let y = 0; y < gridMap.height; y++) {
      for (let x = 0; x < gridMap.width; x++) {
        const tile = gridMap.tiles[y][x];
        tile.isLit = false;
        tile.lightIntensity = 0;
      }
    }

    // 2. Ambient room emitters disabled for player-only lighting test

    // 3. Cast light from player
    const playerRadius = LightingSystem.computePlayerRadius(player);
    LightingSystem.castLightCircle(gridMap, player.x, player.y, playerRadius);

    // 4. Update monster visibility & light-triggered aggro
    for (const monster of monsters) {
      const tile = gridMap.getTile(monster.x, monster.y);
      if (tile && tile.isLit) {
        monster.visible = true;
        if (!monster.isAggroed) {
          if (LightingSystem.hasLineOfSight(gridMap, monster.x, monster.y, player.x, player.y)) {
            monster.isAggroed = true;
          }
        }
      } else {
        monster.visible = false;
      }
    }
  }

  /**
   * Illuminates tiles in a circle from origin (originX, originY) based on distance, without wall occlusion.
   * @param {import('./grid-map.js').GridMap} gridMap
   * @param {number} originX
   * @param {number} originY
   * @param {number} radius
   */
  static castLightCircle(gridMap, originX, originY, radius) {
    const minX = Math.max(0, originX - radius);
    const maxX = Math.min(gridMap.width - 1, originX + radius);
    const minY = Math.max(0, originY - radius);
    const maxY = Math.min(gridMap.height - 1, originY + radius);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dist = Math.hypot(x - originX, y - originY);
        if (dist <= radius + 0.5) {
          const tile = gridMap.getTile(x, y);
          if (tile) {
            tile.isLit = true;
            const intensity = Math.max(0, 1 - dist / (radius + 1));
            tile.lightIntensity = Math.max(tile.lightIntensity, intensity);
          }
        }
      }
    }
  }

  /**
   * Checks if an unblocked line of sight exists between two coordinates.
   * @param {import('./grid-map.js').GridMap} gridMap
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   * @returns {boolean}
   */
  static hasLineOfSight(gridMap, x0, y0, x1, y1) {
    const points = LightingSystem.getBresenhamLine(x0, y0, x1, y1);
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (i > 0 && i < points.length - 1) {
        if (gridMap.isWall(pt.x, pt.y)) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Returns list of integer coordinates connecting (x0, y0) to (x1, y1).
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   * @returns {Array<{ x: number, y: number }>}
   */
  static getBresenhamLine(x0, y0, x1, y1) {
    const points = [];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let currX = x0;
    let currY = y0;

    while (true) {
      points.push({ x: currX, y: currY });
      if (currX === x1 && currY === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        currX += sx;
      }
      if (e2 < dx) {
        err += dx;
        currY += sy;
      }
    }

    return points;
  }
}
