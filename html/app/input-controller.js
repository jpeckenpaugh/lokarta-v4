/**
 * Lokarta: Come Into The Light - Input Controller Subsystem
 */

import { GestureEngine, NPC_INTERACT_RADIUS } from '../engine/index.js';
import { EQUIPMENT_KEY_MAP, PARTY_CYCLE_BINDINGS } from '../engine/config.js';
import { KEYBINDINGS_CATALOG } from '../data/index.js';
import { soundFX } from '../audio/index.js';

/**
 * Keyboard-event codes that trigger an interaction (`keybindings.json.interact`).
 * Catalog-driven so a rebind (or a new key like Square on a gamepad shim) is a
 * data edit. Space/F by default.
 */
const INTERACT_KEY_CODE_SET = new Set(
  Array.isArray(KEYBINDINGS_CATALOG?.interact) ? KEYBINDINGS_CATALOG.interact : ['Space', 'KeyF']
);

/** `{ KeyQ: 'main_hand', KeyE: 'armor', ... }` from `keybindings.json`. */
const EQUIPMENT_KEY_CODE_MAP = Object.fromEntries(
  Object.entries(EQUIPMENT_KEY_MAP || {}).map(([key, slot]) => [`Key${String(key).toUpperCase()}`, slot])
);

/**
 * `{ KeyA: -1, KeyS: 1 }` from `keybindings.json.party` (LIV-27): the event
 * code of each cycle key maps to the direction it steps through the party.
 * Catalog-driven, so a rebind is a `keybindings.json` edit.
 */
const PARTY_CYCLE_KEY_CODE_MAP = (() => {
  const map = {};
  const prev = PARTY_CYCLE_BINDINGS && PARTY_CYCLE_BINDINGS.prev;
  const next = PARTY_CYCLE_BINDINGS && PARTY_CYCLE_BINDINGS.next;
  if (Array.isArray(prev)) for (const code of prev) map[code] = -1;
  if (Array.isArray(next)) for (const code of next) map[code] = 1;
  return map;
})();

export class InputController {
  constructor(app) {
    this.app = app;
  }

  bindInputs() {
    window.addEventListener('keydown', e => {
      // Input is locked during transitions.
      if (this.app.transition && this.app.transition.isLocked && this.app.transition.isLocked()) {
        return;
      }

      if (e.code === 'Escape') {
        // Escape opens the pause menu only from an unpaused gameplay surface.
        // When already paused, the open pause modal owns Escape (Resume); when
        // not in gameplay it is a no-op (e.g. the title screen).
        if (this.app.isInGameplay && !this.app.isGameOver && !this.app.isPaused) {
          e.preventDefault();
          this.app.openPauseMenu();
        }
        return;
      }

      // Only gameplay surfaces own movement / combat keys.
      if (!this.app.isInGameplay) return;

      // Modal-owned surfaces (pause, town, temple, fate grant) pause the
      // simulation; never let a gameplay hotkey leak through while paused.
      if (this.app.isPaused) return;

      // Party control (LIV-27): catalog `keybindings.json.party` cycles which
      // member the player drives; every other member stays on auto-AI. Handled
      // before `keysDown` so a cycle key can never leak into held movement.
      const cycleDirection = PARTY_CYCLE_KEY_CODE_MAP[e.code];
      if (cycleDirection !== undefined) {
        e.preventDefault();
        soundFX.init();
        this.app.cycleControlledMember(cycleDirection);
        return;
      }

      // Interact (LIV-60 P2): talk to an adjacent NPC / examine a world object.
      // Handled before `keysDown` so the interact key never leaks into movement.
      if (INTERACT_KEY_CODE_SET.has(e.code)) {
        e.preventDefault();
        soundFX.init();
        this.app.interact();
        return;
      }

      this.app.keysDown.add(e.code);

      // Equipment abilities: q/w/e/r map to main_hand/off_hand/armor/relic
      // (keybindings.json.keySlots.equipment). Only the equipped item's
      // catalog `actionKey` produces an effect.
      const equipmentSlot = EQUIPMENT_KEY_CODE_MAP[e.code];
      if (equipmentSlot) {
        e.preventDefault();
        soundFX.init();
        this.app.executeHandCombat(equipmentSlot);
        return;
      }

      const slotIdx = GestureEngine.keyToSlotIndex(e.key);
      if (slotIdx !== null) {
        e.preventDefault();
        this.app.gestureEngine.handleInputDown(slotIdx);
      }
    });

    window.addEventListener('keyup', e => {
      if (!this.app.isInGameplay) return;
      this.app.keysDown.delete(e.code);

      const slotIdx = GestureEngine.keyToSlotIndex(e.key);
      if (slotIdx !== null) {
        e.preventDefault();
        this.app.gestureEngine.handleInputUp(slotIdx);
      }
    });

    // Canvas click: targeting or looting
    if (this.app.canvas) {
      this.app.canvas.addEventListener('click', e => {
        if (!this.app.isInGameplay) return;
        soundFX.init();
        const rect = this.app.canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;

        const gridPos = this.app.renderer.screenToGrid(clickX, clickY);

        // Tap-to-interact (LIV-60 P2): an adjacent NPC or world object takes the
        // tap before monster/chest targeting. Out of reach, it falls through.
        const player = this.app.player;
        const reach = NPC_INTERACT_RADIUS;
        const tappedNpc = (this.app.npcs || []).find(
          (n) => n.x === gridPos.x && n.y === gridPos.y
        );
        if (tappedNpc && Math.abs(tappedNpc.x - player.x) + Math.abs(tappedNpc.y - player.y) <= reach) {
          this.app.openNpcDialogue(tappedNpc);
          return;
        }
        const tappedObject = (this.app.scene?.interactables || []).find(
          (i) => i.kind === 'object' && i.x === gridPos.x && i.y === gridPos.y
        );
        if (tappedObject && Math.abs(tappedObject.x - player.x) + Math.abs(tappedObject.y - player.y) <= reach) {
          this.app.interactWithSceneObject(tappedObject);
          return;
        }

        const clickedMonster = this.app.monsters.find(
          m => m.x === gridPos.x && m.y === gridPos.y && m.visible && m.hp > 0
        );
        if (clickedMonster) {
          this.app.selectedMonsterId = clickedMonster.id;
          this.app.logCombat(`Targeted ${clickedMonster.name} (${clickedMonster.hp}/${clickedMonster.max_hp} HP).`, 'system');
        } else {
          const clickedChest = (this.app.chests || []).find(
            c => c.x === gridPos.x && c.y === gridPos.y
          );
          if (clickedChest && clickedChest.opened !== true && this.app.gridMap.tiles[gridPos.y]?.[gridPos.x]?.isLit) {
            this.app.handleOpenChest(gridPos.x, gridPos.y);
            return;
          }
          const clickedItems = this.app.gridMap.getItems(gridPos.x, gridPos.y);
          if (clickedItems.length > 0) {
            const topItem = clickedItems[clickedItems.length - 1];
            this.app.logCombat(`Ground inspection: ${topItem.name} (${topItem.type}) on tile (${gridPos.x}, ${gridPos.y}).`, 'system');
          } else {
            this.app.selectedMonsterId = null;
          }
        }
      });
    }

    // Touch D-Pad buttons
    const touchBtns = document.querySelectorAll('.touch-btn');
    touchBtns.forEach(btn => {
      const key = btn.getAttribute('data-key');
      btn.addEventListener('touchstart', e => {
        e.preventDefault();
        soundFX.init();
        this.app.keysDown.add(key);
      });
      btn.addEventListener('touchend', e => {
        e.preventDefault();
        this.app.keysDown.delete(key);
      });
    });
  }
}
