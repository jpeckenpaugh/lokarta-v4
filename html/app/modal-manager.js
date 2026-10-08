/**
 * Lokarta: Come Into The Light - Modals & Screen Overlays Manager
 */

import { FateGrantSystem, listDiscoveredCodexEntries, codexProgress, listColorBlindModes, listDialogueTextScales } from '../engine/index.js';
import { towerUnlockInfo } from '../engine/campaign.js';
import { soundFX } from '../audio/index.js';
import { HUDManager } from './hud-manager.js';
import { portraitDataUrl } from './portrait-renderer.js';
import {
  resolveDialogueAdvanceKeys,
  isDialogueAdvanceKey,
  computeDialogueBubblePosition,
} from './dialogue-bubble.js';
import { UI_CATALOG, VOCATIONS_CATALOG, listTowerDefinitions, getTowerDefinition, getQuestDefinition } from '../data/index.js';
import {
  SAVE_SLOT_COUNT,
  formatPlaytime,
  classifySlot,
  firstNewGameSlotIndex,
  newGameActionLabel,
} from '../services/save-slots.js';

const VOCATION_ICONS = {
  magician: '1F9D9',
  archer: '1F3F9',
  fighter: '2694',
  paladin: '1F6E1',
};

const REDUCE_MOTION_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const UI_SCALE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'X-Large' },
];

const PIXEL_SCALE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: '1x', label: '1×' },
  { value: '2x', label: '2×' },
  { value: '3x', label: '3×' },
];

// I10 accessibility selectors, resolved from `ui.json.accessibility`.
const COLOR_BLIND_OPTIONS = listColorBlindModes().map(m => ({ value: m.value, label: m.label }));
const DIALOGUE_SCALE_OPTIONS = listDialogueTextScales().map(s => ({ value: s.value, label: s.label }));

export class ModalManager {
  /**
   * Delay before the auto-applied draft fades out once exactly 2 Fate Grant
   * cards are checked. Overridable in tests so auto-confirm
   * can run synchronously.
   */
  static FATE_AUTO_CONFIRM_DELAY_MS = 260;

  /** Fate Grant fade-out duration; kept in sync with `modals.css`. */
  static FATE_FADE_MS = 180;

  /**
   * Removes the single modal-scoped keydown handler registered on `window`,
   * if any. Every modal render and close funnels through here so that no
   * navigation path (mouse click, back button, programmatic close) can leave a
   * stale handler behind that would fire on a later key press.
   */
  static _clearKeyHandler(overlay) {
    if (!overlay || typeof overlay._keyHandler !== 'function') return;
    overlay._keyHandler();
    overlay._keyHandler = null;
  }

  /**
   * Registers the single modal-scoped keydown handler for this overlay,
   * replacing any handler left by a previous render. The handler is removed by
   * `_clearKeyHandler` on the next render/close, or by the handler itself.
   */
  static _setKeyHandler(overlay, handler) {
    this._clearKeyHandler(overlay);
    window.addEventListener('keydown', handler);
    overlay._keyHandler = () => {
      window.removeEventListener('keydown', handler);
      overlay._keyHandler = null;
    };
  }

  static _reset(overlay) {
    this._clearKeyHandler(overlay);
    overlay.classList.remove('hidden');
    overlay.classList.remove('dialogue-active');
    overlay.innerHTML = '';
  }

  static _close(overlay) {
    this._clearKeyHandler(overlay);
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
    overlay.classList.remove('title-active');
    overlay.classList.remove('dialogue-active');
  }

  /**
   * Title screen with ambient subject and four menu actions.
   * @param {HTMLElement} modalOverlayEl
   * @param {{ slots?: object[], hasSaves?: boolean, lastPlayedSlotIndex?: number|null }} state
   * @param {object} callbacks
   */
  static showTitleScreen(modalOverlayEl, state = {}, callbacks = {}) {
    const slots = state.slots || [];
    const hasSaves = state.hasSaves !== undefined
      ? state.hasSaves
      : slots.some(s => s && s.status === 'occupied');

    this._reset(modalOverlayEl);
    modalOverlayEl.classList.add('title-active');

    modalOverlayEl.innerHTML = `
      <div class="title-screen-modal">
        <div class="torch-flicker-container">
          <span class="title-torch left-torch"><img class="openmoji-icon torch-icon" src="./assets/openmoji/1F525.svg" alt="Torch" /></span>
          <span class="title-torch right-torch"><img class="openmoji-icon torch-icon" src="./assets/openmoji/1F525.svg" alt="Torch" /></span>
        </div>
        <div class="title-emblem"><img class="openmoji-icon emblem-icon" src="./assets/livive-studios-mark.svg" alt="Lokarta" /></div>
        <h1 class="title-main">LOKARTA</h1>
        <div class="title-subtitle">COME INTO THE LIGHT</div>
        <div class="title-tagline">A Gothic Roguelike Tower Ascent</div>
        <div class="title-menu-actions" role="menu">
          <button class="title-btn new-game-btn" id="title-btn-new-game" data-row="0" role="menuitem"><img class="openmoji-icon btn-emoji" src="./assets/openmoji/1F56F.svg" alt="Candle" /> NEW GAME</button>
          <button class="title-btn continue-btn" id="title-btn-continue" data-row="1" role="menuitem"${hasSaves ? '' : ' aria-disabled="true" disabled'}><img class="openmoji-icon btn-emoji" src="./assets/openmoji/2694.svg" alt="Swords" /> CONTINUE</button>
          <button class="title-btn" id="title-btn-options" data-row="2" role="menuitem"><img class="openmoji-icon btn-emoji" src="./assets/openmoji/2699.svg" alt="Gear" /> OPTIONS</button>
          <button class="title-btn" id="title-btn-guide" data-row="3" role="menuitem"><img class="openmoji-icon btn-emoji" src="./assets/openmoji/1F4D6.svg" alt="Guide" /> GUIDE &amp; CONTROLS</button>
          <button class="title-btn" id="title-btn-codex" data-row="4" role="menuitem"><img class="openmoji-icon btn-emoji" src="./assets/openmoji/1F43A.svg" alt="Codex" /> ${UI_CATALOG?.codex?.titleButtonLabel || 'BESTIARY'}</button>
        </div>
        <div class="title-footer">v2.4 • ${SAVE_SLOT_COUNT} Save Slots • Fate Grant Draft</div>
      </div>
    `;

    const rows = Array.from(modalOverlayEl.querySelectorAll('.title-btn'));
    let selected = rows.findIndex(r => !r.disabled);
    const applySelection = () => {
      rows.forEach((row, i) => row.classList.toggle('selected', i === selected));
    };
    const move = delta => {
      if (!rows.length) return;
      for (let i = 0; i < rows.length; i += 1) {
        selected = (selected + delta + rows.length) % rows.length;
        if (!rows[selected].disabled) break;
      }
      applySelection();
      soundFX.play('uiMove', 0.5);
    };
    const activate = row => {
      if (!row || row.disabled) return;
      soundFX.play('click');
      if (row.id === 'title-btn-new-game') callbacks.onNewGame?.();
      else if (row.id === 'title-btn-continue') callbacks.onContinue?.();
      else if (row.id === 'title-btn-options') callbacks.onOptions?.();
      else if (row.id === 'title-btn-guide') callbacks.onGuide?.();
      else if (row.id === 'title-btn-codex') callbacks.onCodex?.();
    };

    rows.forEach(row => {
      row.addEventListener('mouseenter', () => {
        selected = Number(row.dataset.row);
        applySelection();
      });
      row.addEventListener('click', () => activate(row));
    });
    applySelection();

    const keyHandler = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'KeyS' || e.key === 'KeyW') {
        e.preventDefault();
        move(e.key === 'ArrowDown' || e.key === 'KeyS' ? 1 : -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate(rows[selected]);
      }
    };
    this._setKeyHandler(modalOverlayEl, keyHandler);
  }

  /**
   * Options modal. Changes apply immediately via callbacks.onChange.
   */
  static showOptionsModal(modalOverlayEl, options, callbacks = {}, context = {}) {
    const opts = options || {};
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');

    // Debug action (not a toggle): only offered while a live game can still
    // recruit another vocation. Hidden entirely otherwise (LIV-29/FIX-14).
    const canRecruitCharacter = context.canRecruitCharacter === true;

    const toggle = (key, label) => `
      <div class="option-row" data-option="${key}">
        <span class="option-label">${label}</span>
        <button class="option-toggle" data-toggle="${key}" aria-pressed="${opts[key] ? 'true' : 'false'}">${opts[key] ? 'ON' : 'OFF'}</button>
      </div>`;

    const segmented = (key, label, choices) => `
      <div class="option-row" data-option="${key}">
        <span class="option-label">${label}</span>
        <div class="option-segmented">
          ${choices.map(c => `<button class="option-seg${opts[key] === c.value ? ' active' : ''}" data-seg="${key}" data-value="${c.value}">${c.label}</button>`).join('')}
        </div>
      </div>`;

    modalOverlayEl.innerHTML = `
      <div class="options-modal">
        <div class="modal-header">
          <h2>OPTIONS</h2>
          <div class="subtitle">Changes apply immediately and are saved automatically.</div>
        </div>
        <div class="options-list">
          ${toggle('soundEffects', 'Sound Effects')}
          <div class="option-row" data-option="sfxVolume">
            <span class="option-label">Sound Volume</span>
            <input class="option-slider" id="option-sfx-volume" type="range" min="0" max="100" step="5" value="${Number(opts.sfxVolume) || 0}" />
            <span class="option-value" id="option-sfx-volume-value">${Number(opts.sfxVolume) || 0}</span>
          </div>
          ${segmented('reduceMotion', 'Reduce Motion', REDUCE_MOTION_OPTIONS)}
          ${segmented('uiScale', 'UI Scale', UI_SCALE_OPTIONS)}
          ${segmented('pixelScale', 'Pixel Zoom', PIXEL_SCALE_OPTIONS)}
          ${toggle('fullscreen', 'Fullscreen')}
          ${toggle('damageNumbers', 'Damage Numbers')}
          ${toggle('showFps', 'Frame Rate Counter')}
          <div class="options-section-label">Accessibility</div>
          ${segmented('colorBlindMode', 'Telegraph Colours', COLOR_BLIND_OPTIONS)}
          ${segmented('dialogueTextScale', 'Dialogue Text', DIALOGUE_SCALE_OPTIONS)}
          <div class="options-section-label">Debug</div>
          ${toggle('walkThruWalls', 'Walk Thru Walls')}
          ${toggle('testerStrength', "Tester's Strength")}
          ${canRecruitCharacter ? `
          <div class="option-row" data-option="recruitCharacter">
            <span class="option-label">Recruit Character</span>
            <button class="option-toggle" id="options-recruit-character">RECRUIT</button>
          </div>` : ''}
        </div>
        <div class="modal-back-action options-actions">
          <button class="action-btn" id="options-save-data">SAVE DATA</button>
          <button class="action-btn danger" id="options-reset">RESET TO DEFAULTS</button>
          <button class="action-btn" id="options-back">BACK</button>
        </div>
      </div>
    `;

    modalOverlayEl.querySelectorAll('[data-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.toggle;
        const next = !(btn.getAttribute('aria-pressed') === 'true');
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        btn.textContent = next ? 'ON' : 'OFF';
        soundFX.play('click');
        callbacks.onChange?.({ [key]: next });
      });
    });

    modalOverlayEl.querySelector('#options-recruit-character')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onRecruitCharacter?.();
    });

    modalOverlayEl.querySelectorAll('[data-seg]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.seg;
        modalOverlayEl.querySelectorAll(`[data-seg="${key}"]`).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        soundFX.play('click');
        callbacks.onChange?.({ [key]: btn.dataset.value });
      });
    });

    const slider = modalOverlayEl.querySelector('#option-sfx-volume');
    const sliderValue = modalOverlayEl.querySelector('#option-sfx-volume-value');
    slider?.addEventListener('input', () => {
      sliderValue.textContent = slider.value;
    });
    slider?.addEventListener('change', () => {
      callbacks.onChange?.({ sfxVolume: Number(slider.value) });
    });

    modalOverlayEl.querySelector('#options-save-data')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onSaveData?.();
    });
    modalOverlayEl.querySelector('#options-reset')?.addEventListener('click', () => {
      soundFX.play('uiBack');
      callbacks.onReset?.();
    });
    modalOverlayEl.querySelector('#options-back')?.addEventListener('click', () => {
      soundFX.play('uiBack');
      callbacks.onBack?.();
    });
  }

  /**
   * Save-slot selection. mode: 'create' | 'load' | 'manage'.
   */
  static showSlotSelectModal(modalOverlayEl, state = {}, callbacks = {}) {
    const slots = state.slots || [];
    const mode = state.mode || 'create';
    const lastPlayed = state.lastPlayedSlotIndex;
    const header = mode === 'manage' ? 'SAVE DATA' : 'SELECT A SAVE SLOT';
    const subtitle = mode === 'load'
      ? 'Choose an expedition to continue.'
      : mode === 'manage'
        ? 'Load, overwrite, or delete a save.'
        : 'Choose a slot for your new expedition.';

    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');

    // New Game must reach character creation in one step. The first
    // loadable empty slot is the default target and gets a single obvious
    // primary action, so a fresh profile never dead-ends on this screen.
    const defaultNewGameIndex = mode === 'create' ? firstNewGameSlotIndex(slots) : null;

    const cards = slots.map(slot => {
      const index = slot.slotIndex;
      const kind = classifySlot(slot);
      if (kind !== 'occupied') {
        // A record that is neither a valid empty slot nor a loadable save is
        // corrupt/unknown: render DATA UNAVAILABLE with DELETE only (spec §4.2).
        if (kind === 'unavailable') {
          // Composition matches an occupied row (spec §4.2): mono slot badge,
          // then the DATA UNAVAILABLE title + subcopy, DELETE only. The words
          // carry the corrupt state, not the red border (WCAG 1.4.1).
          return `
          <div class="slot-card corrupt" data-slot="${index}" data-status="unavailable">
            <div class="slot-badge">SLOT ${index}</div>
            <div class="slot-info">
              <div class="slot-title"><strong>DATA UNAVAILABLE</strong></div>
              <div class="slot-sub">This save record is unreadable. Delete it to reuse the slot.</div>
            </div>
            <div class="slot-actions">
              <button class="action-btn danger" data-action="delete" data-slot="${index}">DELETE</button>
            </div>
          </div>`;
        }
        const disabled = mode === 'load' || mode === 'manage';
        const isDefault = index === defaultNewGameIndex;
        const newLabel = isDefault ? newGameActionLabel(index) : 'EMPTY — NEW GAME';
        return `
          <div class="slot-card empty${isDefault ? ' selected' : ''}" data-slot="${index}"${isDefault ? ' data-default-new="true"' : ''}>
            <div class="slot-badge">SLOT ${index}</div>
            <div class="slot-empty-body">
              <button class="action-btn slot-new-btn${isDefault ? ' primary' : ''}" data-action="new" data-slot="${index}"${isDefault ? ' data-default-new="true" autofocus' : ''}${disabled ? ' disabled' : ''}>${mode === 'create' ? newLabel : 'EMPTY'}</button>
            </div>
          </div>`;
      }

      const icon = VOCATION_ICONS[slot.vocation] || '1F56F';
      const ribbon = lastPlayed === index ? '<span class="slot-ribbon">LAST PLAYED</span>' : '';
      const primaryAction = mode === 'load'
        ? `<button class="action-btn" data-action="load" data-slot="${index}">LOAD</button>`
        : `<button class="action-btn" data-action="overwrite" data-slot="${index}">OVERWRITE</button>`;
      return `
        <div class="slot-card occupied" data-slot="${index}">
          ${ribbon}
          <div class="slot-badge">SLOT ${index}</div>
          <img class="openmoji-icon slot-thumb" src="./assets/openmoji/${icon}.svg" alt="${slot.vocation || ''}" />
          <div class="slot-info">
            <div class="slot-title"><strong>${String(slot.vocation || 'unknown').toUpperCase()}</strong> — Level ${slot.level || 1}</div>
            <div class="slot-sub">Floor ${slot.currentFloor || 1}${slot.biome ? ` · ${slot.biome}` : ''}</div>
            <div class="slot-meta">Played ${formatPlaytime(slot.playtimeMs)} · Last played ${formatLastPlayed(slot.lastPlayedAt)}</div>
          </div>
          <div class="slot-actions">
            ${primaryAction}
            <button class="action-btn danger" data-action="delete" data-slot="${index}">DELETE</button>
          </div>
        </div>`;
    }).join('');

    modalOverlayEl.innerHTML = `
      <div class="slot-select-modal">
        <div class="modal-header">
          <h2>${header}</h2>
          <div class="subtitle">${subtitle}</div>
        </div>
        <div class="slot-list">${cards}</div>
        <div class="modal-back-action">
          <button class="action-btn" id="slots-back">BACK</button>
        </div>
      </div>
    `;

    const activate = btn => {
      if (!btn || btn.disabled) return;
      const index = Number(btn.dataset.slot);
      soundFX.play('click');
      if (btn.dataset.action === 'new') callbacks.onNew?.(index);
      else if (btn.dataset.action === 'load') callbacks.onLoad?.(index);
      else if (btn.dataset.action === 'overwrite') callbacks.onOverwrite?.(index);
      else if (btn.dataset.action === 'delete') callbacks.onDelete?.(index);
    };

    modalOverlayEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => activate(btn));
    });
    modalOverlayEl.querySelector('#slots-back')?.addEventListener('click', () => {
      soundFX.play('uiBack');
      callbacks.onBack?.();
    });

    // Landing focus on the default New Game action makes the whole flow one
    // step: New Game → Enter → character creation. Arrow keys move between the
    // New Game actions when there is more than one selectable empty slot.
    const defaultBtn = modalOverlayEl.querySelector('[data-default-new="true"]');
    const promoTargets = Array.from(modalOverlayEl.querySelectorAll('.slot-card.empty:not(.corrupt) [data-action="new"]'))
      .filter(btn => !btn.disabled);
    let focusIndex = Math.max(0, promoTargets.indexOf(defaultBtn));
    const focusTarget = () => {
      const btn = promoTargets[focusIndex];
      if (btn && typeof btn.focus === 'function') btn.focus();
    };
    focusTarget();

    const keyHandler = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (promoTargets.length < 2) return;
        e.preventDefault();
        focusIndex = (focusIndex + (e.key === 'ArrowDown' ? 1 : -1) + promoTargets.length) % promoTargets.length;
        focusTarget();
      } else if (e.key === 'Enter') {
        const active = modalOverlayEl.ownerDocument?.activeElement;
        if (active && active.dataset && active.dataset.defaultNew === 'true') {
          e.preventDefault();
          activate(active);
        }
      }
    };
    this._setKeyHandler(modalOverlayEl, keyHandler);
  }

  /**
   * Generic destructive/confirm dialog.
   * @param {{ title: string, body: string, confirmLabel: string, cancelLabel?: string, danger?: boolean, onConfirm: Function, onCancel: Function }} opts
   */
  static showConfirmModal(modalOverlayEl, opts = {}) {
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    modalOverlayEl.innerHTML = `
      <div class="result-modal confirm-modal">
        <h2>${opts.title || 'ARE YOU SURE?'}</h2>
        <p class="result-subtitle">${opts.body || ''}</p>
        <div class="confirm-actions">
          <button class="action-btn" id="confirm-cancel">${opts.cancelLabel || 'CANCEL'}</button>
          <button class="action-btn ${opts.danger ? 'danger' : ''}" id="confirm-ok">${opts.confirmLabel || 'CONFIRM'}</button>
        </div>
      </div>
    `;

    const cancel = () => {
      soundFX.play('uiBack');
      this._close(modalOverlayEl);
      opts.onCancel?.();
    };
    const confirm = () => {
      soundFX.play('click');
      this._close(modalOverlayEl);
      opts.onConfirm?.();
    };
    modalOverlayEl.querySelector('#confirm-cancel')?.addEventListener('click', cancel);
    modalOverlayEl.querySelector('#confirm-ok')?.addEventListener('click', confirm);

    // Error prevention (packaging-design.md §4.4, §3.2): a destructive confirm
    // lands focus on CANCEL so a reflexive `Enter` cancels instead of deleting
    // or overwriting data. Non-destructive dialogs (e.g. the load-error OK/BACK
    // dialog) keep focus on their primary OK button.
    const safeFocusTarget = opts.danger
      ? modalOverlayEl.querySelector('#confirm-cancel')
      : modalOverlayEl.querySelector('#confirm-ok');
    safeFocusTarget?.focus?.();

    const keyHandler = e => {
      if (e.key === 'Escape') {
        this._clearKeyHandler(modalOverlayEl);
        cancel();
      }
    };
    this._setKeyHandler(modalOverlayEl, keyHandler);
  }

  /**
   * NPC / world-prompt dialogue (LIV-60 P2, refined LIV-67). Renders a speaker
   * and plays the stage's lines as sequential **beats** — one line at a time —
   * advanced by typical keyboard keys (Enter/Space/E/arrows) or click/tap. When
   * anchored, the panel is a speech bubble placed above the speaking NPC (below
   * near the top edge) so it never covers the speaker or the field. A close
   * button is always offered, so a dialogue can never soft-lock the player.
   * Stage actions (accept/turn-in/shop/temple/rest/interact) appear on the final
   * beat and resolve through the caller's `onAction`.
   *
   * @param {object} opts
   * @param {string} [opts.speaker]
   * @param {string} [opts.portraitId] - resolved 48x48 bust asset id (LIV-81);
   *   falls back to `portraitEmoji` when absent
   * @param {string} [opts.portraitEmoji]
   * @param {string[]} [opts.lines] - one line per beat
   * @param {Array<{label:string,type:string}>} [opts.actions]
   * @param {object} [opts.labels] - `dialogues.json.ui` label/keys overrides
   * @param {{x:number, top:number, bottom:number}} [opts.anchor] - speaker
   *   viewport coords; when present the panel becomes an anchored bubble
   * @param {{width:number, height:number}} [opts.viewport]
   * @param {(action:object)=>void} [opts.onAction]
   * @param {()=>void} [opts.onClose]
   */
  static showDialogueModal(modalOverlayEl, opts = {}) {
    const lines = Array.isArray(opts.lines) ? opts.lines : [];
    const actions = Array.isArray(opts.actions) ? opts.actions : [];
    const labels = opts.labels || {};
    const beats = lines.length;
    const advanceKeys = resolveDialogueAdvanceKeys(labels);
    let beatIndex = 0;
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');

    const actionHtml = actions
      .map((action, i) => `<button class="action-btn dialogue-action" data-action-index="${i}">${action.label}</button>`)
      .join('');
    const hasPortrait = !!(opts.portraitId || opts.portraitEmoji);
    modalOverlayEl.innerHTML = `
      <div class="result-modal dialogue-modal" role="dialog" aria-modal="true">
        <div class="dialogue-arrow" aria-hidden="true"></div>
        <div class="dialogue-speaker">
          ${hasPortrait ? `<span class="dialogue-portrait" id="dialogue-portrait">${opts.portraitEmoji || ''}</span>` : ''}
          <h2>${opts.speaker || ''}</h2>
        </div>
        <div class="dialogue-lines" id="dialogue-lines" aria-live="polite"></div>
        <div class="dialogue-actions confirm-actions" id="dialogue-actions"${beats > 1 ? ' hidden' : ''}>
          ${actionHtml}
        </div>
        <div class="dialogue-foot">
          <span class="dialogue-beat-count" id="dialogue-beat-count"></span>
          <span class="dialogue-advance" id="dialogue-advance" aria-hidden="true">${labels.advanceHint || '▼'}</span>
          <button class="action-btn dialogue-close" id="dialogue-close">${labels.closeLabel || opts.closeLabel || 'Farewell'}</button>
        </div>
      </div>
    `;

    const panel = modalOverlayEl.querySelector('.dialogue-modal');
    const linesEl = modalOverlayEl.querySelector('#dialogue-lines');
    const actionsEl = modalOverlayEl.querySelector('#dialogue-actions');
    const advanceEl = modalOverlayEl.querySelector('#dialogue-advance');
    const beatCountEl = modalOverlayEl.querySelector('#dialogue-beat-count');
    const arrowEl = modalOverlayEl.querySelector('.dialogue-arrow');
    const anchor = opts.anchor;

    // LIV-81: upgrade the emoji fallback to the authored bust when the portrait
    // asset resolves. If it is absent (or no canvas host exists) the emoji stays.
    if (opts.portraitId) {
      const holder = modalOverlayEl.querySelector('#dialogue-portrait');
      const url = portraitDataUrl(opts.portraitId, 2);
      if (holder && url) holder.innerHTML = `<img class="dialogue-portrait-img" src="${url}" alt="" />`;
    }

    // Anchoring turns the panel into a viewport-fixed speech bubble and clears
    // the dimming backdrop so the scene around the speaker stays readable.
    if (anchor && panel && typeof panel.getBoundingClientRect === 'function') {
      panel.classList.add('dialogue-bubble');
      modalOverlayEl.classList.add('dialogue-active');
    }

    const positionBubble = () => {
      if (!anchor || !panel || typeof panel.getBoundingClientRect !== 'function') return;
      const rect = panel.getBoundingClientRect();
      const width = Math.round(rect.width) || 320;
      const height = Math.round(rect.height) || 140;
      const win = typeof window !== 'undefined' ? window : null;
      const viewport = opts.viewport || {
        width: (win && win.innerWidth) || width + 16,
        height: (win && win.innerHeight) || height + 16,
      };
      const pos = computeDialogueBubblePosition(anchor, viewport, { width, height });
      panel.style.left = `${pos.left}px`;
      panel.style.top = `${pos.top}px`;
      panel.style.width = `${pos.width}px`;
      panel.dataset.placement = pos.placement;
      if (arrowEl) arrowEl.style.left = `${pos.arrowX}px`;
    };

    const renderBeat = () => {
      if (linesEl) linesEl.innerHTML = `<p class="dialogue-line">${lines[beatIndex] ?? ''}</p>`;
      const atEnd = beats === 0 || beatIndex >= beats - 1;
      if (actionsEl) actionsEl.hidden = beats > 1 && !atEnd;
      if (advanceEl) advanceEl.hidden = beats <= 1 || atEnd;
      if (beatCountEl) beatCountEl.textContent = beats > 1 ? `${beatIndex + 1} / ${beats}` : '';
      positionBubble();
    };

    const close = () => {
      this._close(modalOverlayEl);
      opts.onClose?.();
    };
    const resolve = () => {
      if (actions.length) {
        soundFX.play('click');
        this._close(modalOverlayEl);
        opts.onAction?.(actions[0]);
      } else {
        soundFX.play('uiBack');
        close();
      }
    };
    // Steps one beat. Returns false on the final beat so callers can choose to
    // resolve (keyboard) or wait for an explicit button (pointer).
    const stepBeat = () => {
      if (beatIndex >= beats - 1) return false;
      beatIndex += 1;
      soundFX.play('uiMove', 0.4);
      renderBeat();
      return true;
    };
    // Keyboard advance: steps beats, then resolves the stage on the final beat.
    const advance = () => {
      if (!stepBeat()) resolve();
    };

    modalOverlayEl.querySelector('#dialogue-close')?.addEventListener('click', () => {
      soundFX.play('uiBack');
      close();
    });
    modalOverlayEl.querySelectorAll('[data-action-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = actions[Number(btn.getAttribute('data-action-index'))];
        soundFX.play('click');
        this._close(modalOverlayEl);
        opts.onAction?.(action);
      });
    });

    // Click / tap anywhere on the panel (except a button) advances a beat; the
    // final beat's actions / close button are the explicit pointer affordances.
    panel?.addEventListener('click', (e) => {
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) return;
      stepBeat();
    });

    renderBeat();

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        soundFX.play('uiBack');
        close();
        return;
      }
      if (!isDialogueAdvanceKey(e.key, advanceKeys, e.code)) return;
      e.preventDefault();
      advance();
    };
    this._setKeyHandler(modalOverlayEl, keyHandler);
  }

  static showCharacterSelectModal(modalOverlayEl, onSelectVocation) {
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    modalOverlayEl.innerHTML = `
      <div class="character-select-modal">
        <div class="modal-header">
          <h2>CHOOSE YOUR VOCATION</h2>
          <div class="subtitle">Ascend the Five Tiers of the Tower of Lokarta</div>
        </div>
        <p class="prompt">Select your champion. Each vocation wields unique combat mechanics & exclusive access to vocation-locked gear:</p>
        <div class="vocation-cards">
          <!-- Magician -->
          <div class="vocation-card" data-vocation="magician">
            <div class="card-icon"><img class="openmoji-icon card-emoji" src="./assets/openmoji/1F9D9.svg" alt="Magician" /></div>
            <h3>Magician</h3>
            <div class="stats-preview">
              <div class="stat-row"><span class="stat-label">Health (HP):</span><span class="stat-val hp">60</span></div>
              <div class="stat-row"><span class="stat-label">Mana (MP):</span><span class="stat-val mp">150</span></div>
            </div>
            <p class="desc">Master of elemental sorcery, radiant illumination, and linear piercing beam blasts.</p>
            <button class="select-btn" data-vocation="magician">Select Magician</button>
          </div>

          <!-- Archer -->
          <div class="vocation-card" data-vocation="archer">
            <div class="card-icon"><img class="openmoji-icon card-emoji" src="./assets/openmoji/1F3F9.svg" alt="Archer" /></div>
            <h3>Archer</h3>
            <div class="stats-preview">
              <div class="stat-row"><span class="stat-label">Health (HP):</span><span class="stat-val hp">90</span></div>
              <div class="stat-row"><span class="stat-label">Mana (MP):</span><span class="stat-val mp">80</span></div>
            </div>
            <p class="desc">Deadly ranged marksman firing precision arrows and high-tension Power Shots across darkness.</p>
            <button class="select-btn" data-vocation="archer">Select Archer</button>
          </div>

          <!-- Fighter -->
          <div class="vocation-card" data-vocation="fighter">
            <div class="card-icon"><img class="openmoji-icon card-emoji" src="./assets/openmoji/2694.svg" alt="Fighter" /></div>
            <h3>Fighter</h3>
            <div class="stats-preview">
              <div class="stat-row"><span class="stat-label">Health (HP):</span><span class="stat-val hp">140</span></div>
              <div class="stat-row"><span class="stat-label">Mana (MP):</span><span class="stat-val mp">30</span></div>
            </div>
            <p class="desc">Unyielding melee berserker delivering lethal sword slashes and whirlwind cleaves.</p>
            <button class="select-btn" data-vocation="fighter">Select Fighter</button>
          </div>

          <!-- Paladin -->
          <div class="vocation-card" data-vocation="paladin">
            <div class="card-icon"><img class="openmoji-icon card-emoji" src="./assets/openmoji/1F6E1.svg" alt="Paladin" /></div>
            <h3>Paladin</h3>
            <div class="stats-preview">
              <div class="stat-row"><span class="stat-label">Health (HP):</span><span class="stat-val hp">120</span></div>
              <div class="stat-row"><span class="stat-label">Mana (MP):</span><span class="stat-val mp">90</span></div>
            </div>
            <p class="desc">Holy champion wielding consecrated warhammers, healing prayers, and sacred radiance.</p>
            <button class="select-btn" data-vocation="paladin">Select Paladin</button>
          </div>
        </div>
      </div>
    `;

    const selectBtns = modalOverlayEl.querySelectorAll('.select-btn, .vocation-card');
    selectBtns.forEach(btn => {
      btn.addEventListener('click', async e => {
        const vocation = e.currentTarget.getAttribute('data-vocation');
        if (vocation) {
          soundFX.play('click');
          this._close(modalOverlayEl);
          if (onSelectVocation) await onSelectVocation(vocation);
        }
      });
    });
  }

  /**
   * Tower-selection card list (catalog-driven). Renders one card per authored
   * tower and reports the chosen `towerId`; callers own the actual switch.
   * @param {HTMLElement} modalOverlayEl
   * @param {object[]} towers - tower definitions (`id`/`name`/`description`/`levelCount`/`icon`)
   * @param {string|null} currentTowerId
   * @param {{ onSelect?: Function, onCancel?: Function }} callbacks
   */
  static showTowerSelectModal(modalOverlayEl, towers, currentTowerId, callbacks = {}) {
    if (!modalOverlayEl) return;
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    const list = Array.isArray(towers) ? towers : [];
    const progress = callbacks.progress || null;
    const campaign = UI_CATALOG?.campaign || {};
    const lockedLabel = campaign.towerLockedLabel || 'Locked';
    const lockedHint = campaign.towerLockedHint || 'Complete {required} to unlock.';
    const unlockedLabel = campaign.towerUnlockedLabel || 'Unlocked';
    const cards = list
      .map((tower) => {
        const active = tower.id === currentTowerId;
        const levels = Number(tower.levelCount) || 1;
        const { unlocked, requires } = towerUnlockInfo(progress, tower.id);
        // A quest-gated tower (LIV-55 D7) has no `unlockRequires` chain; name the
        // rite from its catalog `accessGate` instead of an empty hint.
        const gateQuest = tower.accessGate && tower.accessGate.questId
          ? getQuestDefinition(tower.accessGate.questId)
          : null;
        const requiredNames = requires.length > 0
          ? requires.map((id) => getTowerDefinition(id)?.name || id).join(', ')
          : (gateQuest?.name || '');
        const hint = lockedHint.replace('{required}', requiredNames);
        const icon = tower.icon
          ? `<img class="openmoji-icon card-emoji" src="./assets/openmoji/${tower.icon}.svg" alt="${tower.name}" />`
          : '';
        const statusRow = !unlocked
          ? `<div class="stat-row"><span class="stat-label">Status:</span><span class="stat-val tower-locked">${lockedLabel}</span></div>`
          : active
            ? '<div class="stat-row"><span class="stat-label">Status:</span><span class="stat-val">Current</span></div>'
            : `<div class="stat-row"><span class="stat-label">Status:</span><span class="stat-val">${unlockedLabel}</span></div>`;
        const button = active
          ? `<button class="select-btn" data-tower="${tower.id}">Resume</button>`
          : unlocked
            ? `<button class="select-btn" data-tower="${tower.id}">Enter</button>`
            : `<button class="select-btn" disabled aria-disabled="true">${lockedLabel}</button>`;
        return `
          <div class="vocation-card${active ? ' is-active' : ''}${unlocked ? '' : ' is-locked'}" data-tower="${tower.id}"${unlocked ? '' : ' aria-disabled="true"'}>
            <div class="card-icon">${icon}</div>
            <h3>${tower.name}</h3>
            <p class="desc">${unlocked ? (tower.description || '') : hint}</p>
            <div class="stats-preview">
              <div class="stat-row"><span class="stat-label">Floors:</span><span class="stat-val">${levels}</span></div>
              ${statusRow}
            </div>
            ${button}
          </div>`;
      })
      .join('');

    modalOverlayEl.innerHTML = `
      <div class="character-select-modal">
        <div class="modal-header">
          <h2>CHOOSE A TOWER</h2>
          <div class="subtitle">Each tower has its own floors, foes, and guardian.</div>
        </div>
        <p class="prompt">Select a tower to descend into. The towers awaken in campaign order — clear one to unlock the next.</p>
        <div class="vocation-cards">${cards}</div>
        <div class="modal-actions">
          <button class="action-btn" id="tower-cancel">Back to Town</button>
        </div>
      </div>
    `;

    modalOverlayEl.querySelectorAll('.select-btn[data-tower]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const towerId = e.currentTarget.getAttribute('data-tower');
        if (!towerId) return;
        soundFX.play('click');
        this._close(modalOverlayEl);
        if (callbacks.onSelect) await callbacks.onSelect(towerId);
      });
    });
    modalOverlayEl.querySelector('#tower-cancel')?.addEventListener('click', () => {
      soundFX.play('click');
      this._close(modalOverlayEl);
      callbacks.onCancel?.();
    });
    this._setKeyHandler(modalOverlayEl, (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      this._close(modalOverlayEl);
      callbacks.onCancel?.();
    });
  }

  /**
   * Non-terminal Tower Complete card. Leads into the recruit flow via
   * `onContinue`; the caller owns picking the next tower.
   * @param {HTMLElement} modalOverlayEl
   * @param {{ towerName?: string, nextTowerName?: string }} summary
   * @param {{ onContinue?: Function, onReturnToTown?: Function }} callbacks
   */
  static showTowerCompleteModal(modalOverlayEl, summary = {}, callbacks = {}) {
    if (!modalOverlayEl) return;
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    const campaign = UI_CATALOG?.campaign || {};
    const title = campaign.towerCompleteTitle || 'Tower Complete';
    const body = (campaign.towerCompleteBody || 'The {tower} has fallen. A new companion awaits.')
      .replace('{tower}', summary.towerName || 'tower');
    const continueLabel = campaign.towerContinueLabel || 'Continue';
    const townLabel = campaign.towerReturnToTownLabel || 'Return to Town';
    const nextLine = summary.nextTowerName
      ? `<p class="result-subtitle">The path to <strong>${summary.nextTowerName}</strong> now lies open.</p>`
      : '<p class="result-subtitle">The campaign continues.</p>';

    modalOverlayEl.innerHTML = `
      <div class="result-modal victory-modal tower-complete-modal">
        <h2>${title}</h2>
        ${nextLine}
        <p class="result-subtitle">${body}</p>
        <div class="confirm-actions">
          <button class="action-btn" id="tower-complete-continue">${continueLabel}</button>
          <button class="action-btn" id="tower-complete-town">${townLabel}</button>
        </div>
      </div>
    `;

    modalOverlayEl.querySelector('#tower-complete-continue')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onContinue?.();
    });
    modalOverlayEl.querySelector('#tower-complete-town')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onReturnToTown?.();
    });
  }

  /**
   * Recruit card: the player must choose one vocation not yet on the party.
   * @param {HTMLElement} modalOverlayEl
   * @param {string[]} vocations - recruitable vocation ids
   * @param {{ partyVocations?: string[] }} context
   * @param {{ onRecruit?: Function }} callbacks
   */
  static showRecruitModal(modalOverlayEl, vocations, context = {}, callbacks = {}) {
    if (!modalOverlayEl) return;
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    const campaign = UI_CATALOG?.campaign || {};
    const title = campaign.recruitTitle || 'Recruit a Companion';
    const prompt = campaign.recruitPrompt || 'Choose the vocation that joins your party.';
    const list = Array.isArray(vocations) ? vocations : [];
    const cards = list
      .map((vocation) => {
        const voc = VOCATIONS_CATALOG?.[vocation] || {};
        const name = voc.name || vocation.charAt(0).toUpperCase() + vocation.slice(1);
        const icon = VOCATION_ICONS[vocation] || '1F9D9';
        return `
          <div class="vocation-card" data-vocation="${vocation}">
            <div class="card-icon"><img class="openmoji-icon card-emoji" src="./assets/openmoji/${icon}.svg" alt="${name}" /></div>
            <h3>${name}</h3>
            <p class="desc">${voc.description || ''}</p>
            <div class="stats-preview">
              <div class="stat-row"><span class="stat-label">Health (HP):</span><span class="stat-val hp">${voc.hp ?? voc.max_hp ?? '-'}</span></div>
              <div class="stat-row"><span class="stat-label">Mana (MP):</span><span class="stat-val mp">${voc.mana ?? voc.max_mana ?? '-'}</span></div>
            </div>
            <button class="select-btn" data-vocation="${vocation}">${campaign.recruitConfirmLabel || 'Recruit'} ${name}</button>
          </div>`;
      })
      .join('');

    modalOverlayEl.innerHTML = `
      <div class="character-select-modal">
        <div class="modal-header">
          <h2>${title}</h2>
          <div class="subtitle">Party: ${(context.partyVocations || []).length} / 4</div>
        </div>
        <p class="prompt">${prompt}</p>
        <div class="vocation-cards">${cards}</div>
      </div>
    `;

    modalOverlayEl.querySelectorAll('.select-btn[data-vocation]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const vocation = e.currentTarget.getAttribute('data-vocation');
        if (!vocation) return;
        soundFX.play('click');
        this._close(modalOverlayEl);
        callbacks.onRecruit?.(vocation);
      });
    });
  }

  static showGuideModal(modalOverlayEl, callbacks = {}) {
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    modalOverlayEl.innerHTML = `
      <div class="guide-modal">
        <div class="modal-header">
          <h2>SURVIVAL GUIDE & CONTROLS</h2>
          <div class="subtitle">Tower Mechanics of Lokarta</div>
        </div>
        <div class="guide-content">
          <div class="guide-section">
            <h3>Movement & Floor Interaction</h3>
            <ul class="guide-list">
              <li>Arrow Keys: Move character in 4 directions.</li>
              <li><code>A</code> / <code>S</code>: Cycle control to the previous / next party member. Every other member fights on auto-AI.</li>
              <li><strong>Walkover Auto-Loot:</strong> Step on any item tile to immediately collect it into lowest empty Action Slot or Backpack.</li>
              <li><strong>Left-Click Floor Tile:</strong> Target enemies or inspect/loot items directly.</li>
            </ul>
          </div>
          <div class="guide-section">
            <h3>10 Modular Action Slots (Keys 1-9, 0)</h3>
            <ul class="guide-list">
              <li>Keys <code>1</code> to <code>9</code>, <code>0</code>: Execute items, spells, and weapons in the corresponding slot.</li>
              <li><strong>Multi-Modal Input:</strong> Tap (&lt;250ms), Hold/Charge (&ge;250ms), Double-Tap (&lt;300ms).</li>
              <li><strong>Weapons in Action Slots:</strong> Pressing a weapon hotkey (Q/W or 1-9,0) always swings — Swords, Cleaves, and Holy Strikes animate toward your facing and hit every enemy inside the reach.</li>
              <li><strong>Vocation-Locked Equipment:</strong> Weapons, armor, and relics can only be equipped by their appropriate vocation — the class advantage is exclusive access to your class's gear!</li>
            </ul>
          </div>
          <div class="guide-section">
            <h3>Fate Grant Roguelike Draft</h3>
            <p>At Level 1 and every Level-Up, draft 1–2 cards from 5 randomly offered spells, weapons, and relics to power up your hero.</p>
          </div>
        </div>
        <div class="modal-back-action">
          <button class="action-btn" id="btn-close-guide">Back to the Tower</button>
        </div>
      </div>
    `;

    document.getElementById('btn-close-guide')?.addEventListener('click', () => {
      soundFX.play('click');
      if (typeof callbacks.onClose === 'function') {
        callbacks.onClose();
      } else {
        this._close(modalOverlayEl);
      }
    });
  }

  /**
   * Bestiary/Codex (I10): renders only the foes the player has defeated, so an
   * unencountered opponent is never spoiled. Reads resolved entries from
   * `codex-system.js`; undiscovered foes simply do not appear.
   */
  static showCodexModal(modalOverlayEl, app, callbacks = {}) {
    const copy = (UI_CATALOG && UI_CATALOG.codex) || {};
    const entries = listDiscoveredCodexEntries(app && app.player);
    const progress = codexProgress(app && app.player);
    const progressText = (copy.progressLabel || '{discovered} of {total} foes recorded')
      .split('{discovered}').join(String(progress.discovered))
      .split('{total}').join(String(progress.total));

    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');

    const cards = entries.map((e) => `
      <article class="codex-card" data-foe="${e.id}">
        <div class="codex-silhouette">
          ${e.icon ? `<img class="openmoji-icon codex-icon" src="./assets/openmoji/${e.icon}.svg" alt="" />` : ''}
        </div>
        <div class="codex-body">
          <div class="codex-name">${e.name}</div>
          <div class="codex-tags">
            <span class="codex-tier">${e.tierName}</span>
            <span class="codex-role">${e.roleName}</span>
          </div>
          ${e.silhouette ? `<p class="codex-read"><span class="codex-label">${copy.silhouetteLabel || 'Read'}:</span> ${e.silhouette}</p>` : ''}
          ${e.telegraph ? `<p class="codex-counter"><span class="codex-label">${copy.telegraphLabel || 'Counter'}:</span> ${e.telegraph}</p>` : ''}
        </div>
      </article>`).join('');

    modalOverlayEl.innerHTML = `
      <div class="codex-modal">
        <div class="modal-header">
          <h2>${copy.title || 'Bestiary'}</h2>
          <div class="subtitle">${copy.subtitle || ''} — ${progressText}</div>
        </div>
        ${entries.length
          ? `<div class="codex-grid">${cards}</div>`
          : `<p class="codex-empty">${copy.empty || 'No foes recorded yet.'}</p>`}
        <div class="modal-back-action">
          <button class="action-btn" id="codex-back">${copy.backLabel || 'BACK'}</button>
        </div>
      </div>
    `;

    modalOverlayEl.querySelector('#codex-back')?.addEventListener('click', () => {
      soundFX.play('uiBack');
      callbacks.onClose?.();
    });
    const keyHandler = (e) => {
      if (e.key === 'Escape' || e.key === 'KeyC' || e.code === 'KeyC') {
        e.preventDefault();
        soundFX.play('uiBack');
        callbacks.onClose?.();
      }
    };
    this._setKeyHandler(modalOverlayEl, keyHandler);
  }

  /** In-game pause menu. */
  static showPauseModal(modalOverlayEl, callbacks = {}) {
    // Returning to town from the pause menu is disabled by
    // default; the tower's stair exits / Tower Gate remain the only way back.
    const returnToTownEnabled = UI_CATALOG?.pause?.returnToTownEnabled === true;
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    modalOverlayEl.innerHTML = `
      <div class="result-modal pause-modal">
        <h2>PAUSED</h2>
        <p class="result-subtitle">The tower waits.</p>
        <div class="pause-actions">
          <button class="title-btn" id="pause-resume">RESUME</button>
          ${returnToTownEnabled ? '<button class="title-btn" id="pause-town">RETURN TO TOWN</button>' : ''}
          <button class="title-btn" id="pause-options">OPTIONS</button>
          <button class="title-btn" id="pause-codex">${UI_CATALOG?.codex?.pauseButtonLabel || 'BESTIARY'}</button>
          <button class="title-btn" id="pause-guide">GUIDE &amp; CONTROLS</button>
          <button class="title-btn" id="pause-title">RETURN TO TITLE</button>
        </div>
      </div>
    `;

    modalOverlayEl.querySelector('#pause-resume')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onResume?.();
    });
    modalOverlayEl.querySelector('#pause-town')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onReturnToTown?.();
    });
    modalOverlayEl.querySelector('#pause-options')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onOptions?.();
    });
    modalOverlayEl.querySelector('#pause-guide')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onGuide?.();
    });
    modalOverlayEl.querySelector('#pause-codex')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onCodex?.();
    });
    modalOverlayEl.querySelector('#pause-title')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onReturnToTitle?.();
    });

    const keyHandler = e => {
      if (e.key === 'Escape') {
        this._clearKeyHandler(modalOverlayEl);
        callbacks.onResume?.();
      }
    };
    this._setKeyHandler(modalOverlayEl, keyHandler);
  }

  /** Hero vitals strip shared by the Town hub and subpanels (D1 §4.1). */
  static _townVitalsHtml(app) {
    const player = app?.player || {};
    const gold = Number(player.gold) || 0;
    const voc = player.vocation || 'magician';
    const vocLabel = voc.charAt(0).toUpperCase() + voc.slice(1);
    return `
      <div class="town-hero-summary">
        <span class="town-vocation">${vocLabel} · Lv ${player.level || 1}</span>
        <span class="town-hp">HP ${player.hp}/${player.max_hp}</span>
        <span class="town-mp">MP ${player.mana}/${player.max_mana}</span>
        <span class="town-gold"><img class="openmoji-icon" src="./assets/openmoji/2697.svg" alt="Gold" /> <strong>${gold}</strong> gold</span>
      </div>`;
  }

  /**
   * Persistent Town hub: rendered into the always-present
   * `#town-screen` sibling of `#modal-overlay`, never a dismissible modal.
   */
  static renderTownHub(townEl, app, callbacks = {}) {
    if (!townEl) return;
    const town = app?.townConfig || { title: 'Havenreach', subtitle: '', shopName: "Merchant's Stall", templeName: 'Temple of the Dawn', enterTowerLabel: 'Enter the Tower' };
    const player = app?.player || {};
    const floor = player.current_floor || 1;
    const towers = listTowerDefinitions();
    const currentTower = getTowerDefinition(player.towerId);
    const towerLabel = currentTower ? currentTower.name : (town.enterTowerLabel || 'Enter the Tower');

    townEl.hidden = false;
    townEl.onkeydown = null;
    townEl.innerHTML = `
      <div class="town-modal">
        <div class="modal-header">
          <h2 id="town-title"><img class="openmoji-icon title-icon" src="./assets/openmoji/1F56F.svg" alt="Candle" /> ${town.title}</h2>
          <div class="subtitle">${town.subtitle || ''}</div>
        </div>
        <div class="town-actions town-venues">
          <button class="action-btn town-venue" id="town-shop">
            <img class="openmoji-icon" src="./assets/openmoji/2699.svg" alt="Shop" />
            <strong>${town.shopName || 'Shop'}</strong>
            <span>Buy, pawn &amp; upgrade gear</span>
          </button>
          <button class="action-btn town-venue" id="town-temple">
            <img class="openmoji-icon" src="./assets/openmoji/1F496.svg" alt="Temple" />
            <strong>${town.templeName || 'Temple'}</strong>
            <span>Heal &amp; revive</span>
          </button>
          <button class="action-btn town-venue town-enter-btn" id="town-tower">
            <img class="openmoji-icon" src="./assets/openmoji/${currentTower?.icon || '1F5DD'}.svg" alt="Tower Gate" />
            <strong>${town.enterTowerLabel || 'Enter the Tower'}</strong>
            <span>${towerLabel} · Floor ${floor}</span>
          </button>
          ${towers.length > 1
            ? `<button class="action-btn town-venue" id="town-choose-tower">
                 <img class="openmoji-icon" src="./assets/openmoji/1F3AF.svg" alt="Towers" />
                 <strong>Choose Tower</strong>
                 <span>${towers.length} towers available</span>
               </button>`
            : ''}
        </div>
        ${ModalManager._townVitalsHtml(app)}
        <div class="modal-actions">
          <button class="action-btn" id="town-options">Options</button>
        </div>
      </div>
    `;

    townEl.querySelector('#town-shop')?.addEventListener('click', () => { soundFX.play('click'); callbacks.onShop?.(); });
    townEl.querySelector('#town-temple')?.addEventListener('click', () => { soundFX.play('click'); callbacks.onTemple?.(); });
    townEl.querySelector('#town-tower')?.addEventListener('click', () => { soundFX.play('click'); callbacks.onEnterTower?.(); });
    townEl.querySelector('#town-choose-tower')?.addEventListener('click', () => { soundFX.play('click'); callbacks.onChooseTower?.(); });
    townEl.querySelector('#town-options')?.addEventListener('click', () => { soundFX.play('click'); callbacks.onOptions?.(); });
    townEl.querySelector('.town-venue')?.focus();
  }

  /**
   * One Upgrade Gear button. The `data-upgrade-slot` payload is
   * `source:index`, where `index` is a numeric list position for pack/action-bar
   * items but a paperdoll slot *name* (`main_hand`, `off_hand`, `armor`,
   * `relic`) for equipment. It must therefore round-trip as a raw string and
   * never be coerced with `Number()`.
   *
   * An unaffordable entry stays clickable so the handler can log the exact
   * shortfall instead of silently no-opping; it is dimmed and marked
   * `aria-disabled` for the affordance.
   */
  static _upgradeEntryHtml(entry, gold) {
    const affordable = gold >= entry.cost;
    const icon = HUDManager.renderItemIcon(entry.item);
    const reason = affordable ? '' : `Need ${entry.cost} gold — you have ${gold}`;
    const attr = affordable
      ? ''
      : ` aria-disabled="true" title="${reason}"`;
    return `
      <button class="shop-entry upgrade-entry${affordable ? '' : ' is-unaffordable'}" data-upgrade-slot="${entry.source}:${entry.index}"${attr}>
        <span class="shop-icon">${icon}</span>
        <span class="shop-name">${entry.item.name} <em>Rank ${entry.rank}</em></span>
        <span class="shop-price">${entry.cost}g</span>
      </button>`;
  }

  /** Splits a rendered `source:index` shop ref, preserving a string slot index. */
  static _splitShopRef(encoded) {
    const ref = String(encoded ?? '');
    const sep = ref.indexOf(':');
    return sep < 0 ? [ref, ''] : [ref.slice(0, sep), ref.slice(sep + 1)];
  }

  /** Shop subpanel inside the persistent Town screen (D1 §4.3). */
  static renderTownShop(townEl, app, callbacks = {}) {
    if (!townEl) return;
    const stock = app?.shopStock || [];
    const gold = Number(app?.player?.gold) || 0;
    const upgradeList = app?.ownedUpgradableItems || [];
    const pawnList = app?.pawnItems || [];
    townEl.hidden = false;
    townEl.innerHTML = `
      <div class="town-modal">
        <div class="modal-header">
          <h2 id="town-title"><img class="openmoji-icon title-icon" src="./assets/openmoji/2699.svg" alt="Shop" /> ${app?.townConfig?.shopName || 'Shop'}</h2>
          <div class="subtitle">Gold: <strong>${gold}</strong></div>
        </div>
        <div class="shop-section-title">Purchase</div>
        <div class="shop-stock-grid" id="shop-stock">
          ${stock.map(entry => {
            const icon = HUDManager.renderItemIcon({ item_id: entry.itemId, name: entry.name });
            return `
              <button class="shop-entry" data-item-id="${entry.itemId}" ${gold < entry.price ? 'disabled' : ''}>
                <span class="shop-icon">${icon}</span>
                <span class="shop-name">${entry.name}${entry.quantity > 1 ? ` x${entry.quantity}` : ''}</span>
                <span class="shop-price">${entry.price}g</span>
              </button>`;
          }).join('')}
        </div>
        <div class="shop-section-title">Pawn</div>
        <div class="shop-upgrades" id="shop-pawn">
          ${pawnList.length === 0
            ? '<div class="shop-empty">No backpack items the merchant will buy.</div>'
            : pawnList.map(entry => {
                const icon = HUDManager.renderItemIcon(entry.item);
                return `
                  <button class="shop-entry pawn-entry" data-pawn-slot="${entry.source}:${entry.index}">
                    <span class="shop-icon">${icon}</span>
                    <span class="shop-name">${entry.item.name}${entry.item.quantity > 1 ? ` x${entry.item.quantity}` : ''}</span>
                    <span class="shop-price">+${entry.value}g</span>
                  </button>`;
              }).join('')}
        </div>
        <div class="shop-section-title">Upgrade Gear</div>
        <div class="shop-upgrades" id="shop-upgrades">
          ${upgradeList.length === 0
            ? '<div class="shop-empty">No upgradable gear in your pack.</div>'
            : upgradeList.map(entry => ModalManager._upgradeEntryHtml(entry, gold)).join('')}
        </div>
        <div class="modal-actions">
          <button class="action-btn" id="shop-back">Back to Town</button>
        </div>
      </div>
    `;
    townEl.querySelectorAll('.shop-entry[data-item-id]').forEach(btn => {
      btn.addEventListener('click', () => callbacks.onBuy?.(btn.getAttribute('data-item-id')));
    });
    townEl.querySelectorAll('.shop-entry[data-pawn-slot]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [source, index] = ModalManager._splitShopRef(btn.getAttribute('data-pawn-slot'));
        callbacks.onPawn?.(source, Number(index));
      });
    });
    townEl.querySelectorAll('.shop-entry[data-upgrade-slot]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [source, index] = ModalManager._splitShopRef(btn.getAttribute('data-upgrade-slot'));
        callbacks.onUpgrade?.(source, index);
      });
    });
    townEl.querySelector('#shop-back')?.addEventListener('click', () => { soundFX.play('uiBack'); callbacks.onBack?.(); });
    townEl.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); soundFX.play('uiBack'); callbacks.onBack?.(); }
    };
  }

  /**
   * True when the player is already at full HP and MP, so a temple blessing
   * would do nothing. Missing/zero maxima read as not-full.
   */
  static templeAtFull(player) {
    if (!player) return false;
    const hp = Number(player.hp) || 0;
    const maxHp = Number(player.max_hp) || 0;
    const mana = Number(player.mana) || 0;
    const maxMana = Number(player.max_mana) || 0;
    return hp >= maxHp && mana >= maxMana;
  }

  /** Temple subpanel inside the persistent Town screen (D1 §4.4). */
  static renderTownTemple(townEl, app, callbacks = {}) {
    if (!townEl) return;
    const player = app?.player || {};
    const cost = app?.templeCost ?? 0;
    const gold = Number(player.gold) || 0;
    const free = cost === 0;
    // At full HP and MP the blessing does nothing — show a
    // "not in need" message and grey out the button until HP/MP is missing.
    const atFull = ModalManager.templeAtFull(player);
    const costMessage = atFull
      ? 'You are not in need of our services at this time.'
      : (free ? 'The temple offers its blessing freely.' : `Offering: <strong>${cost}</strong> gold`);
    const healDisabled = atFull || (!free && gold < cost);
    townEl.hidden = false;
    townEl.innerHTML = `
      <div class="town-modal">
        <div class="modal-header">
          <h2 id="town-title"><img class="openmoji-icon title-icon" src="./assets/openmoji/1F496.svg" alt="Temple" /> ${app?.townConfig?.templeName || 'Temple'}</h2>
          <div class="subtitle">Restore health and mana to full.</div>
        </div>
        <div class="temple-body">
          <p>HP ${player.hp}/${player.max_hp} · MP ${player.mana}/${player.max_mana}</p>
          <p class="temple-cost">${costMessage}</p>
        </div>
        <div class="modal-actions">
          <button class="action-btn" id="temple-back">Back to Town</button>
          <button class="action-btn temple-heal-btn" id="temple-heal" ${healDisabled ? 'disabled' : ''}>${free ? 'Receive Blessing' : `Heal (${cost}g)`}</button>
        </div>
      </div>
    `;
    townEl.querySelector('#temple-heal')?.addEventListener('click', () => callbacks.onHeal?.());
    townEl.querySelector('#temple-back')?.addEventListener('click', () => { soundFX.play('uiBack'); callbacks.onBack?.(); });
    townEl.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); soundFX.play('uiBack'); callbacks.onBack?.(); }
    };
  }

  /** Hides the persistent Town screen and clears its subpanel DOM. */
  static hideTownScreen(townEl) {
    if (!townEl) return;
    townEl.hidden = true;
    townEl.onkeydown = null;
    townEl.innerHTML = '';
  }

  /** The Town shop: buy items and upgrade owned gear. */
  static showShopModal(modalOverlayEl, app, callbacks = {}) {
    const stock = app?.shopStock || [];
    const gold = Number(app?.player?.gold) || 0;
    const upgradeList = app?.ownedUpgradableItems || [];

    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    modalOverlayEl.innerHTML = `
      <div class="shop-modal">
        <div class="modal-header">
          <h2><img class="openmoji-icon title-icon" src="./assets/openmoji/2699.svg" alt="Shop" /> ${app?.townConfig?.shopName || 'Shop'}</h2>
          <div class="subtitle">Gold: <strong id="shop-gold-val">${gold}</strong></div>
        </div>
        <div class="shop-section-title">For sale</div>
        <div class="shop-stock-grid" id="shop-stock">
          ${stock.map(entry => {
            const icon = HUDManager.renderItemIcon({ item_id: entry.itemId, name: entry.name });
            return `
              <button class="shop-entry" data-item-id="${entry.itemId}" ${gold < entry.price ? 'disabled' : ''}>
                <span class="shop-icon">${icon}</span>
                <span class="shop-name">${entry.name}${entry.quantity > 1 ? ` x${entry.quantity}` : ''}</span>
                <span class="shop-price">${entry.price}g</span>
              </button>`;
          }).join('')}
        </div>
        <div class="shop-section-title">Upgrade owned gear</div>
        <div class="shop-upgrades" id="shop-upgrades">
          ${upgradeList.length === 0
            ? '<div class="shop-empty">No upgradable gear in your pack.</div>'
            : upgradeList.map(entry => ModalManager._upgradeEntryHtml(entry, gold)).join('')}
        </div>
        <div class="modal-actions">
          <button class="action-btn" id="shop-back">Back to Town</button>
        </div>
      </div>
    `;

    modalOverlayEl.querySelectorAll('.shop-entry[data-item-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const itemId = btn.getAttribute('data-item-id');
        callbacks.onBuy?.(itemId);
      });
    });
    modalOverlayEl.querySelectorAll('.shop-entry[data-upgrade-slot]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [source, index] = ModalManager._splitShopRef(btn.getAttribute('data-upgrade-slot'));
        callbacks.onUpgrade?.(source, index);
      });
    });
    modalOverlayEl.querySelector('#shop-back')?.addEventListener('click', () => {
      soundFX.play('uiBack');
      callbacks.onBack?.();
    });
  }

  /** The Town temple: heal to full for gold. */
  static showTempleModal(modalOverlayEl, app, callbacks = {}) {
    const player = app?.player || {};
    const cost = app?.templeCost ?? 0;
    const gold = Number(player.gold) || 0;
    const free = cost === 0;
    // Full HP/MP => "not in need" message + disabled button.
    const atFull = ModalManager.templeAtFull(player);
    const costMessage = atFull
      ? 'You are not in need of our services at this time.'
      : (free ? 'The temple offers its blessing freely.' : `Offering: <strong>${cost}</strong> gold`);
    const healDisabled = atFull || (!free && gold < cost);

    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    modalOverlayEl.innerHTML = `
      <div class="temple-modal">
        <div class="modal-header">
          <h2><img class="openmoji-icon title-icon" src="./assets/openmoji/1F496.svg" alt="Temple" /> ${app?.townConfig?.templeName || 'Temple'}</h2>
          <div class="subtitle">Restore health and mana to full.</div>
        </div>
        <div class="temple-body">
          <p>HP ${player.hp}/${player.max_hp} · MP ${player.mana}/${player.max_mana}</p>
          <p class="temple-cost">${costMessage}</p>
        </div>
        <div class="modal-actions">
          <button class="action-btn" id="temple-back">Back to Town</button>
          <button class="action-btn temple-heal-btn" id="temple-heal" ${healDisabled ? 'disabled' : ''}>${free ? 'Receive Blessing' : `Heal (${cost}g)`}</button>
        </div>
      </div>
    `;

    modalOverlayEl.querySelector('#temple-heal')?.addEventListener('click', () => {
      callbacks.onHeal?.();
    });
    modalOverlayEl.querySelector('#temple-back')?.addEventListener('click', () => {
      soundFX.play('uiBack');
      callbacks.onBack?.();
    });
  }

  static showFateGrantModal(modalOverlayEl, app, level = 1) {
    if (app) app.isPaused = true;

    // `app.player` is the party-bearing top-level player (its `.party` is the live
    // roster), so pass it as the rank-cap owner explicitly — the interactive path
    // must resolve the same party-scaled cap (5/10/15/20) as the Merchant's Stall
    // and the auto Fate Grant path (LIV-40).
    const offer = FateGrantSystem.generateDraftOffer(app.player, level, { rankCapOwner: app.player });
    const selectedCards = new Set();
    let focusIndex = 0;

    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    modalOverlayEl.innerHTML = `
      <div class="fate-grant-modal">
        <div class="modal-header">
          <h2><img class="openmoji-icon title-icon" src="./assets/openmoji/1F56F.svg" alt="Candle" /> FATE GRANT (Level ${level})</h2>
          <div class="subtitle">Choose 2 cards to fortify your Action Slots and Backpack — the draft is applied automatically</div>
        </div>
        <div class="fate-cards-grid" id="fate-cards-grid" role="group" aria-label="Fate Grant cards">
          ${offer.cards
            .map(
              (card, idx) => {
                const iconCode = HUDManager.emojiToOpenMojiCode(card.icon);
                return `
            <button type="button" class="fate-card rarity-${card.rarity}" role="checkbox" aria-checked="false" data-card-id="${card.id}" data-idx="${idx}" tabindex="-1">
              <span class="card-select-badge" aria-hidden="true">✓</span>
              <span class="card-icon"><img class="openmoji-icon card-emoji" src="./assets/openmoji/${iconCode}.svg" alt="${card.name}" /></span>
              <span class="card-title">${card.name}</span>
              <span class="card-stat-bonus">${card.statBonusText || ''}</span>
              <span class="card-desc">${card.description}</span>
            </button>
          `;
              }
            )
            .join('')}
        </div>
        <div class="sr-only" id="fate-selection-status" aria-live="polite">0 of 2 selected</div>
      </div>
    `;

    const modalEl = modalOverlayEl.querySelector('.fate-grant-modal');
    const cardEls = Array.from(modalOverlayEl.querySelectorAll('.fate-card'));
    const statusEl = modalOverlayEl.querySelector('#fate-selection-status');
    const reduceMotion = !!(app && app.reduceMotionResolved);
    const autoConfirmDelayMs = reduceMotion ? 0 : ModalManager.FATE_AUTO_CONFIRM_DELAY_MS;

    let isResolving = false;
    let autoConfirmTimer = null;

    // Transient animation class; removed on animationend and with a timeout
    // fallback so it never persists (incl. under reduced motion).
    const flash = (el, cls) => {
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
      el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
      setTimeout(() => el.classList.remove(cls), 400);
    };

    const focusCard = idx => {
      if (!cardEls.length) return;
      focusIndex = (idx + cardEls.length) % cardEls.length;
      cardEls.forEach((el, i) => {
        el.classList.toggle('card-focused', i === focusIndex);
        el.tabIndex = i === focusIndex ? 0 : -1;
      });
      cardEls[focusIndex].focus({ preventScroll: true });
    };

    const updateStatus = () => {
      const count = selectedCards.size;
      if (statusEl) {
        statusEl.textContent = count === 2 ? '2 of 2 selected — applying draft' : `${count} of 2 selected`;
      }
    };

    /**
     * Applies the two drafted cards, then fades the screen out and closes it.
     * Exactly-2 is enforced by both callers, so this is the single mutation
     * seam. `isResolving` latches so a stray click cannot double-apply.
     */
    const applyDraft = () => {
      if (isResolving || selectedCards.size !== 2) return;
      isResolving = true;
      if (autoConfirmTimer) {
        clearTimeout(autoConfirmTimer);
        autoConfirmTimer = null;
      }
      soundFX.play('equip');

      const chosen = Array.from(selectedCards);
      const applyResult = FateGrantSystem.applyDraftedCards(app.player, chosen, app.gridMap, { rankCapOwner: app.player });

      for (const hotbarItem of applyResult.addedToHotbar) {
        app.logCombat(`Fate granted: ${hotbarItem}`, 'loot');
      }
      for (const bpItem of applyResult.addedToBackpack) {
        app.logCombat(`Fate granted: ${bpItem}`, 'loot');
      }
      for (const floorItem of applyResult.droppedOnFloor) {
        app.logCombat(`Inventory full: ${floorItem} placed on floor.`, 'warning');
      }

      void closeDraft();
    };

    /**
     * Fades the screen out (unless reduced motion) and then hides it. The
     * draft is mandatory, so there is no cancel path — only auto-confirm.
     */
    const closeDraft = async () => {
      this._clearKeyHandler(modalOverlayEl);
      if (modalEl && !reduceMotion) {
        modalEl.classList.add('fate-leaving');
        await new Promise(resolve => setTimeout(resolve, ModalManager.FATE_FADE_MS));
      }
      this._close(modalOverlayEl);
      if (app) app.isPaused = false;
      app.updateHUD();
      await app.persistSave();
    };

    /** Arms auto-confirm once exactly 2 cards are checked. */
    const maybeAutoConfirm = () => {
      if (isResolving || selectedCards.size !== 2) return;
      if (autoConfirmTimer) return;
      if (autoConfirmDelayMs <= 0) {
        applyDraft();
        return;
      }
      // Brief pause so the second check mark is visible before the fade.
      autoConfirmTimer = setTimeout(() => {
        autoConfirmTimer = null;
        applyDraft();
      }, autoConfirmDelayMs);
    };

    const toggleCard = el => {
      if (!el || isResolving) return;
      const cardId = el.getAttribute('data-card-id');
      const cardObj = offer.cards.find(c => c.id === cardId);
      if (!cardObj) return;

      if (selectedCards.has(cardObj)) {
        selectedCards.delete(cardObj);
        el.classList.remove('selected');
        el.setAttribute('aria-checked', 'false');
        soundFX.play('click');
        // A de-selection cancels a pending auto-confirm.
        if (autoConfirmTimer) {
          clearTimeout(autoConfirmTimer);
          autoConfirmTimer = null;
        }
      } else if (selectedCards.size < 2) {
        selectedCards.add(cardObj);
        el.classList.add('selected');
        el.setAttribute('aria-checked', 'true');
        soundFX.play('click');
        flash(el, 'card-activating');
      } else {
        // A 3rd selection is rejected (no silent eviction): red flash + back.
        soundFX.play('uiBack');
        flash(el, 'card-reject');
        return;
      }
      updateStatus();
      maybeAutoConfirm();
    };

    cardEls.forEach((el, idx) => {
      // Click moves the keyboard cursor to the card, then toggles (pointer and
      // keyboard stay in sync). Hover stays a pure CSS affordance.
      el.addEventListener('click', () => {
        focusCard(idx);
        toggleCard(el);
      });
    });

    updateStatus();
    focusCard(0);

    const keyHandler = e => {
      if (isResolving) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        soundFX.play('uiMove', 0.5);
        focusCard(focusIndex + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (e.code === 'KeyQ' || e.key === 'q' || e.key === 'Q') {
        e.preventDefault();
        toggleCard(cardEls[focusIndex]);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleCard(cardEls[focusIndex]);
      }
      // Escape is intentionally a no-op: the draft is mandatory.
    };
    this._setKeyHandler(modalOverlayEl, keyHandler);
  }

  static showVictoryModal(modalOverlayEl, player, callbacks = {}) {
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    const p = player || {};
    const campaign = UI_CATALOG?.campaign || {};
    modalOverlayEl.innerHTML = `
      <div class="result-modal victory-modal">
        <h2>${campaign.ultimateVictoryTitle || 'ULTIMATE VICTORY'}</h2>
        <p class="result-subtitle">${campaign.ultimateVictoryBody || 'The tower is conquered. Lokarta is lit.'}</p>
        <div class="character-summary">
          <p><strong>Vocation:</strong> ${String(p.vocation || 'magician').toUpperCase()}</p>
          <p><strong>Party:</strong> ${Array.isArray(p.party) ? p.party.length : 1} members</p>
          <p><strong>Final Level:</strong> Level ${p.level || 1}</p>
          <p><strong>Damage Boost:</strong> +${Math.round(((p.skillBoosts?.damageMultiplier || 1) - 1) * 100)}%</p>
          <p><strong>Remaining HP:</strong> ${p.hp} / ${p.max_hp}</p>
          <p><strong>Remaining MP:</strong> ${p.mana} / ${p.max_mana}</p>
        </div>
        <div class="confirm-actions">
          <button class="action-btn" id="victory-new-game">NEW GAME</button>
          <button class="action-btn" id="victory-title">RETURN TO TITLE</button>
        </div>
      </div>
    `;

    modalOverlayEl.querySelector('#victory-new-game')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onNewGame?.();
    });
    modalOverlayEl.querySelector('#victory-title')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onReturnToTitle?.();
    });
  }

  static showGameOverModal(modalOverlayEl, player, callbacks = {}) {
    this._reset(modalOverlayEl);
    modalOverlayEl.classList.remove('title-active');
    const fromFloor = callbacks.fromFloor || player?.current_floor || 1;
    const toFloor = callbacks.toFloor || fromFloor;
    const descended = toFloor < fromFloor;
    const title = callbacks.title || 'YOU HAVE PERISHED';
    const body = callbacks.body
      ? String(callbacks.body).replace(/\{floor\}/g, String(fromFloor))
      : `Floor ${fromFloor} claims another soul. You awaken at the tower gate, restored to full health and magic.`;
    const primaryLabel = descended ? `DESCEND TO FLOOR ${toFloor}` : `CONTINUE ON FLOOR ${toFloor}`;

    modalOverlayEl.innerHTML = `
      <div class="result-modal defeat-modal">
        <h2>${title}</h2>
        <p class="result-subtitle">${body}</p>
        <div class="confirm-actions">
          <button class="action-btn" id="btn-retry">${primaryLabel}</button>
          <button class="action-btn" id="btn-continue">RETURN TO TITLE</button>
        </div>
        <p class="result-hint">A full-party knockout returns you to the Temple of the Dawn at the tower's entry floor.<br />Continue enters the town; Return to Title exits to the main menu.</p>
      </div>
    `;

    modalOverlayEl.querySelector('#btn-retry')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onRetry?.();
    });
    modalOverlayEl.querySelector('#btn-continue')?.addEventListener('click', () => {
      soundFX.play('click');
      callbacks.onContinue?.();
    });
  }
}

function formatLastPlayed(iso) {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
