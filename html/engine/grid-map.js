/**
 * Lokarta: Come Into The Light - Dungeon Grid Map Subsystem
 */

import { CONFIG, TILE_TYPES, IMPASSABLE_TILE_TYPES } from './config.js';

const CODE_TO_TILE_TYPE = {
  1: TILE_TYPES.WALL,
  2: TILE_TYPES.STAIRS,
  3: TILE_TYPES.DOOR,
  4: TILE_TYPES.GATED_DOOR,
  5: TILE_TYPES.SPRING,
  6: TILE_TYPES.TOWN_GATE,
  // LIV-59 scene tiles (append-only; island/town tilemaps).
  7: TILE_TYPES.WATER,
  8: TILE_TYPES.GRASS,
  9: TILE_TYPES.SAND,
  10: TILE_TYPES.PATH,
  11: TILE_TYPES.TREE,
  12: TILE_TYPES.BRIDGE,
  13: TILE_TYPES.BUILDING_WALL,
  14: TILE_TYPES.DOORWAY,
  15: TILE_TYPES.TOWER_ENTRANCE,
};

export class GridMap {
  /**
   * @param {number} [width=40]
   * @param {number} [height=40]
   */
  constructor(width = CONFIG.MAP_WIDTH, height = CONFIG.MAP_HEIGHT) {
    this.width = width;
    this.height = height;
    this.tiles = [];
    this.initEmptyGrid();
  }

  initEmptyGrid() {
    this.tiles = [];
    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) {
        row.push({
          x,
          y,
          type: TILE_TYPES.WALL,
          items: [],
          isLit: false,
          lightIntensity: 0,
          gateTier: null,
          gateOpen: false,
          blocked: false,
        });
      }
      this.tiles.push(row);
    }
  }

  /**
   * Loads the grid tile types from a 2D matrix of numbers.
   * @param {number[][]} matrix
   */
  loadFromMatrix(matrix) {
    if (!matrix || !matrix.length) return;
    this.height = matrix.length;
    this.width = matrix[0]?.length || CONFIG.MAP_WIDTH;
    this.tiles = [];

    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) {
        const typeCode = matrix[y][x];
        const tileType = CODE_TO_TILE_TYPE[typeCode] || TILE_TYPES.FLOOR;

        row.push({
          x,
          y,
          type: tileType,
          items: [],
          isLit: false,
          lightIntensity: 0,
          gateTier: null,
          gateOpen: false,
          blocked: false,
        });
      }
      this.tiles.push(row);
    }
  }

  isInBounds(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  isWalkable(x, y) {
    if (!this.isInBounds(x, y)) return false;
    const tile = this.tiles[y][x];
    // Walls plus the scene solids (water border, trees, building bodies)
    // always block; see IMPASSABLE_TILE_TYPES (LIV-55 D6).
    if (IMPASSABLE_TILE_TYPES.has(tile.type)) return false;
    // E3: a locked gated door blocks movement until its key unlocks the tile.
    if (tile.type === TILE_TYPES.GATED_DOOR && !tile.gateOpen) return false;
    // Healing springs are fountains and cannot be stepped on.
    if (tile.type === TILE_TYPES.SPRING) return false;
    // Placed decorative furniture is impassable; dropped items
    // and chests stay walkable (they are not marked blocked).
    if (tile.blocked === true) return false;
    return true;
  }

  /** True when the tile is an impassable water tile (overworld border). */
  isWater(x, y) {
    if (!this.isInBounds(x, y)) return false;
    return this.tiles[y][x].type === TILE_TYPES.WATER;
  }

  /** True when the tile is a building doorway (scene interaction trigger). */
  isDoorway(x, y) {
    if (!this.isInBounds(x, y)) return false;
    return this.tiles[y][x].type === TILE_TYPES.DOORWAY;
  }

  /** True when the tile is a tower entrance (scene portal trigger). */
  isTowerEntrance(x, y) {
    if (!this.isInBounds(x, y)) return false;
    return this.tiles[y][x].type === TILE_TYPES.TOWER_ENTRANCE;
  }

  /**
   * Step allowance for the active member. Identical to `isWalkable`, except
   * when `throughWalls` is true (the off-by-default Walk Thru Walls debug
   * option in `ui.json`) any in-bounds tile may be entered — wall, shut gate,
   * spring, or blocked prop. Out-of-bounds is always blocked so the debug
   * toggle can never carry the player off the map.
   *
   * @param {number} x
   * @param {number} y
   * @param {boolean} [throughWalls=false]
   * @returns {boolean}
   */
  canStep(x, y, throughWalls = false) {
    if (this.isWalkable(x, y)) return true;
    return throughWalls === true && this.isInBounds(x, y);
  }

  /** Marks a tile impassable without changing its type. */
  blockTile(x, y, blocked = true) {
    const tile = this.getTile(x, y);
    if (tile) tile.blocked = blocked === true;
    return Boolean(tile);
  }

  isWall(x, y) {
    if (!this.isInBounds(x, y)) return true;
    return this.tiles[y][x].type === TILE_TYPES.WALL;
  }

  isStairs(x, y) {
    if (!this.isInBounds(x, y)) return false;
    return this.tiles[y][x].type === TILE_TYPES.STAIRS;
  }

  isDoor(x, y) {
    if (!this.isInBounds(x, y)) return false;
    return this.tiles[y][x].type === TILE_TYPES.DOOR;
  }

  isGatedDoor(x, y) {
    if (!this.isInBounds(x, y)) return false;
    return this.tiles[y][x].type === TILE_TYPES.GATED_DOOR;
  }

  isSpring(x, y) {
    if (!this.isInBounds(x, y)) return false;
    return this.tiles[y][x].type === TILE_TYPES.SPRING;
  }

  isTownGate(x, y) {
    if (!this.isInBounds(x, y)) return false;
    return this.tiles[y][x].type === TILE_TYPES.TOWN_GATE;
  }

  getTile(x, y) {
    if (!this.isInBounds(x, y)) return null;
    return this.tiles[y][x];
  }

  addItem(x, y, item) {
    const tile = this.getTile(x, y);
    if (tile && item) {
      tile.items.push(item);
    }
  }

  popTopItem(x, y) {
    const tile = this.getTile(x, y);
    if (tile && tile.items.length > 0) {
      return tile.items.pop() || null;
    }
    return null;
  }

  removeItem(x, y, itemIndex) {
    const tile = this.getTile(x, y);
    if (tile && itemIndex >= 0 && itemIndex < tile.items.length) {
      const removed = tile.items.splice(itemIndex, 1);
      return removed[0] || null;
    }
    return null;
  }

  getItems(x, y) {
    const tile = this.getTile(x, y);
    return tile ? tile.items : [];
  }
}
