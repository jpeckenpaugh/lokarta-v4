/**
 * Lokarta: Come Into The Light - Stair Traversal Subsystem
 *
 * Runtime half of the two-way stair shaft authored in `tower_levels.json`
 * (D2 §3, §9.3). The generator emits each stair with a `dir`
 * (`up` / `down` / `summit`) and a `targetLevel`; this module resolves the stair
 * the player is standing on against that authored data instead of blindly
 * advancing a floor counter.
 *
 * It also owns §9.3 stair arming: the tile the player arrives on is disarmed
 * until they step off it, so a transition can never immediately re-trigger.
 *
 * Pure and dependency-free — no DOM, worker, or storage I/O — so the native Node
 * test runner can exercise it directly.
 */

/**
 * Finds the stair occupying a grid tile, if any.
 * @param {object[]} stairs - active floor's `stairs` list
 * @param {number} x
 * @param {number} y
 * @returns {object|null}
 */
export function findStairAt(stairs, x, y) {
  if (!Array.isArray(stairs)) return null;
  for (let i = 0; i < stairs.length; i++) {
    const stair = stairs[i];
    if (stair && stair.x === x && stair.y === y) return stair;
  }
  return null;
}

/**
 * Resolves a stair's authored direction/target into a traversal outcome.
 *
 * - `summit` resolves to `{ kind: 'summit', targetLevel: null }` (victory).
 * - `up` / `down` resolve to `{ kind: 'transition', targetLevel }`, honoring the
 *   stair's `targetLevel` and falling back to shaft arithmetic when it is absent.
 * - A missing/unknown direction, or a target outside the tower, is a `noop`.
 *
 * @param {object} stair
 * @param {number} [currentLevel=1] - used only for the missing-target fallback
 * @returns {{ kind: 'transition'|'summit'|'noop', dir: string|null, targetLevel: number|null }|null}
 */
export function resolveStairTarget(stair, currentLevel = 1) {
  if (!stair) return null;

  const dir = stair.dir || null;
  if (dir === 'summit') {
    return { kind: 'summit', dir, targetLevel: null };
  }

  if (dir !== 'up' && dir !== 'down') {
    return { kind: 'noop', dir, targetLevel: null };
  }

  const level = Number.isFinite(Number(currentLevel)) ? Math.floor(Number(currentLevel)) : 1;
  const authored = Number(stair.targetLevel);
  const targetLevel = Number.isFinite(authored)
    ? Math.floor(authored)
    : (dir === 'up' ? level - 1 : level + 1);

  if (targetLevel < 1) {
    return { kind: 'noop', dir, targetLevel: null };
  }
  return { kind: 'transition', dir, targetLevel };
}

/**
 * Stateful resolver for the active floor's stairs. Tracks the single disarmed
 * "arrival" tile so stepping back onto it never immediately re-triggers a
 * transition (D2 §9.3).
 */
export class StairSystem {
  /**
   * @param {object[]} [stairs=[]] - active floor's `stairs` list
   * @param {number} [currentLevel=1] - current tower level
   * @param {{ x: number, y: number }} [arrival=null] - tile the player landed on
   */
  constructor(stairs = [], currentLevel = 1, arrival = null) {
    this.stairs = Array.isArray(stairs) ? stairs : [];
    this.currentLevel = Number.isFinite(Number(currentLevel)) ? Math.floor(Number(currentLevel)) : 1;
    this.disarmed = null;
    if (arrival) this.disarm(arrival.x, arrival.y);
  }

  /** Replaces the active floor's stair list (e.g. after a floor transition). */
  setStairs(stairs, currentLevel = this.currentLevel) {
    this.stairs = Array.isArray(stairs) ? stairs : [];
    if (Number.isFinite(Number(currentLevel))) this.currentLevel = Math.floor(Number(currentLevel));
    this.disarmed = null;
  }

  /** Disarms the stair at (x, y) when one exists (the arrival tile). */
  disarm(x, y) {
    if (findStairAt(this.stairs, x, y)) {
      this.disarmed = { x, y };
    }
  }

  /**
   * Re-arms any stair once the player has stepped off the arrival tile.
   * Called once per movement tick, before `resolve`.
   */
  syncArmed(x, y) {
    if (this.disarmed && (this.disarmed.x !== x || this.disarmed.y !== y)) {
      this.disarmed = null;
    }
  }

  /** True when the stair at (x, y) is the currently disarmed arrival tile. */
  isDisarmed(x, y) {
    return Boolean(this.disarmed && this.disarmed.x === x && this.disarmed.y === y);
  }

  /**
   * Resolves the armed stair under the player.
   * @param {number} x
   * @param {number} y
   * @returns {{ kind: string, dir: string|null, targetLevel: number|null, stair: object }|null}
   */
  resolve(x, y) {
    const stair = findStairAt(this.stairs, x, y);
    if (!stair) return null;
    if (this.isDisarmed(x, y)) return null;

    const target = resolveStairTarget(stair, this.currentLevel);
    if (!target) return null;
    return { ...target, stair };
  }
}
