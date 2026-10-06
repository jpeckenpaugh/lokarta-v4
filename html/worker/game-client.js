/**
 * Lokarta: Come Into The Light - Game Client
 * Asynchronous RPC client that instantiates the Web Worker and wraps postMessage requests into Promises.
 */

export class GameClient {
  /**
   * Initializes the GameClient and spawns the Dedicated Web Worker.
   * @param {string|URL|Worker} [workerOrUrl] - Worker URL or existing Worker instance
   * @param {object} [options={}] - Client configuration options
   * @param {number} [options.timeout=10000] - Default request timeout in milliseconds
   */
  constructor(workerOrUrl = new URL('./game-worker.js', import.meta.url), options = {}) {
    this.options = {
      timeout: 10000,
      ...options,
    };

    this.pending = new Map();
    this.reqIdCounter = 0;

    if (workerOrUrl && typeof workerOrUrl === 'object' && typeof workerOrUrl.postMessage === 'function') {
      this.worker = workerOrUrl;
    } else if (typeof Worker !== 'undefined') {
      this.worker = new Worker(workerOrUrl, { type: 'module' });
    } else {
      this.worker = null;
    }

    if (this.worker) {
      this.worker.onmessage = this._handleMessage.bind(this);
      this.worker.onerror = this._handleError.bind(this);
    }
  }

  /**
   * Internal message handler for responses from the Web Worker.
   * @param {MessageEvent} event
   * @private
   */
  _handleMessage(event) {
    const { id, ok, data, error } = event.data || {};
    if (id === undefined || !this.pending.has(id)) {
      return;
    }

    const { resolve, reject, timer } = this.pending.get(id);
    if (timer) {
      clearTimeout(timer);
    }
    this.pending.delete(id);

    if (ok) {
      resolve(data);
    } else {
      reject(new Error(error || 'Worker request failed.'));
    }
  }

  /**
   * Internal error handler when the Web Worker encounters an unhandled runtime error.
   * @param {ErrorEvent} errorEvent
   * @private
   */
  _handleError(errorEvent) {
    const errorMsg = errorEvent?.message || 'Web Worker runtime error.';
    const err = new Error(errorMsg);

    // Reject all active pending requests
    for (const [id, { reject, timer }] of this.pending.entries()) {
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    }
    this.pending.clear();
  }

  /**
   * Sends an asynchronous RPC request command to the Web Worker.
   * @param {string} command - Command name
   * @param {object} [payload={}] - Command payload object
   * @param {number} [timeoutMs=this.options.timeout] - Custom timeout in ms
   * @returns {Promise<any>}
   */
  request(command, payload = {}, timeoutMs = this.options.timeout) {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        return reject(new Error('Web Worker is not initialized or not supported in this environment.'));
      }

      this.reqIdCounter += 1;
      const id = `req_${this.reqIdCounter}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request '${command}' (ID: ${id}) timed out after ${timeoutMs}ms.`));
        }
      }, timeoutMs) : null;

      this.pending.set(id, { resolve, reject, timer, command });

      try {
        this.worker.postMessage({ id, command, payload });
      } catch (postError) {
        if (timer) {
          clearTimeout(timer);
        }
        this.pending.delete(id);
        reject(postError);
      }
    });
  }

  /**
   * Bootstraps game storage, retrieves or initializes profile settings,
   * and checks for an active saved character and floor.
   * @returns {Promise<{ player: object|null, profile: object, activeFloor: object|null }>}
   */
  async bootstrap() {
    return this.request('bootstrap');
  }

  /**
   * Initializes a new character from archetype (magician or archer) at Level 1,
   * generates Floor 1, commits to IndexedDB, and returns player & floor data.
   * @param {'magician'|'archer'} [vocation='magician']
   * @returns {Promise<{ player: object, floor: object }>}
   */
  async newGame(vocation = 'magician') {
    return this.request('newGame', { vocation });
  }

  /**
   * Persists player character state into IndexedDB.
   * @param {object} player
   * @returns {Promise<{ success: boolean, savedAt: string }>}
   */
  async saveCharacter(player) {
    return this.request('saveCharacter', { player });
  }

  /**
   * Retrieves cached floor from IndexedDB or generates it with generateFloor.
   * @param {number} floorNumber
   * @param {boolean} [forceRegenerate=false]
   * @returns {Promise<object>}
   */
  async getFloor(floorNumber, forceRegenerate = false) {
    return this.request('getFloor', { floorNumber, forceRegenerate });
  }

  /**
   * Persists chest opened-state for the player's current floor.
   * @param {object} player
   * @param {object[]} chests - minimal chest-state records
   * @returns {Promise<{ success: boolean }>}
   */
  async saveFloorState(player, chests) {
    return this.request('saveFloorState', { player, chests });
  }

  /**
   * Advances player to next floor, updating floor level, coordinates, and saving state.
   * @param {object} player
   * @param {number} [nextFloorNumber]
   * @returns {Promise<{ player: object, floor: object }>}
   */
  async advanceFloor(player, nextFloorNumber) {
    return this.request('advanceFloor', { player, nextFloorNumber });
  }

  /**
   * Lists the five save-slot metadata records.
   * @returns {Promise<{ slots: object[] }>}
   */
  async listSlots() {
    return this.request('listSlots');
  }

  /**
   * Creates a new character in the given slot.
   * @param {number} slotIndex
   * @param {string} vocation
   * @returns {Promise<{ player: object, floor: object, slot: object }>}
   */
  async createSlot(slotIndex, vocation, towerId) {
    return this.request('createSlot', { slotIndex, vocation, towerId });
  }

  /**
   * Loads an occupied slot.
   * @param {number} slotIndex
   * @returns {Promise<{ player: object, floor: object, slot: object }>}
   */
  async loadSlot(slotIndex) {
    return this.request('loadSlot', { slotIndex });
  }

  /**
   * Selects a tower for an occupied slot and restarts it at that tower's level 1.
   * @param {number} slotIndex
   * @param {string} towerId
   * @returns {Promise<{ player: object, floor: object, slot: object }>}
   */
  async selectTower(slotIndex, towerId) {
    return this.request('selectTower', { slotIndex, towerId });
  }

  /**
   * Records a tower completion for an occupied slot and unlocks the next tower
   * in campaign order.
   * @param {number} slotIndex
   * @param {string} towerId
   * @returns {Promise<{ player: object, allComplete: boolean, nextTowerId: string|null, recruitableVocations: string[] }>}
   */
  async completeTower(slotIndex, towerId) {
    return this.request('completeTower', { slotIndex, towerId });
  }

  /**
   * Recruits a vocation onto an occupied slot's party as the new active member.
   * @param {number} slotIndex
   * @param {string} vocation
   * @returns {Promise<{ player: object, member: object, recruitableVocations: string[] }>}
   */
  async recruitMember(slotIndex, vocation) {
    return this.request('recruitMember', { slotIndex, vocation });
  }

  /**
   * Deletes a save slot.
   * @param {number} slotIndex
   * @returns {Promise<{ success: boolean }>}
   */
  async deleteSlot(slotIndex) {
    return this.request('deleteSlot', { slotIndex });
  }

  /**
   * Restarts the current floor from the slot's arrival snapshot.
   * @param {number} slotIndex
   * @returns {Promise<{ player: object, floor: object }>}
   */
  async restartFloor(slotIndex) {
    return this.request('restartFloor', { slotIndex });
  }

  /**
   * Respawns a defeated player one level lower (min level 1) with full HP/mana
   * at that level's start position.
   * @param {number} slotIndex
   * @returns {Promise<{ player: object, floor: object }>}
   */
  async respawnAfterDeath(slotIndex) {
    return this.request('respawnAfterDeath', { slotIndex });
  }

  /**
   * Reads persisted options.
   * @returns {Promise<{ options: object }>}
   */
  async getOptions() {
    return this.request('getOptions');
  }

  /**
   * Merges and persists an options patch.
   * @param {object} patch
   * @returns {Promise<{ options: object }>}
   */
  async setOptions(patch) {
    return this.request('setOptions', { patch });
  }

  /**
   * Resets options to catalog defaults.
   * @returns {Promise<{ options: object }>}
   */
  async resetOptions() {
    return this.request('resetOptions');
  }

  /**
   * Updates sound setting in user profile.
   * @param {boolean} soundEnabled
   * @returns {Promise<{ soundEnabled: boolean }>}
   */
  async setSoundEnabled(soundEnabled) {
    return this.request('setSoundEnabled', { soundEnabled });
  }

  /**
   * Clears characters and dungeon floors from IndexedDB to allow a clean restart.
   * @returns {Promise<{ success: boolean }>}
   */
  async resetProgress() {
    return this.request('resetProgress');
  }

  /**
   * Terminates the Web Worker and cancels all pending requests.
   */
  terminate() {
    if (this.worker) {
      // Reject any pending requests
      const cancelError = new Error('GameClient was terminated.');
      for (const [id, { reject, timer }] of this.pending.entries()) {
        if (timer) {
          clearTimeout(timer);
        }
        reject(cancelError);
      }
      this.pending.clear();

      if (typeof this.worker.terminate === 'function') {
        this.worker.terminate();
      }
      this.worker = null;
    }
  }
}

export default GameClient;
