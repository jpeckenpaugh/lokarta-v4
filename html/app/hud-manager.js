/**
 * Lokarta: Come Into The Light - HUD & Interface Manager
 *
 * D1 §2 presentation: one Loadout panel (`#loadout-container`) with a 4+4 keyed
 * grid (active `1-4` above equipment `q w e r`) and one 6x6 Backpack grid.
 * Skeleton is built once, then diffed; a single delegated pointer listener on
 * `#sidebar-hud` drives both drag and click-to-swap.
 */

import { InventorySystem, LightingSystem, DoorSystem, CombatSystem, EconomySystem, questLogEntries } from '../engine/index.js';
import { soundFX } from '../audio/index.js';
import { ITEMS_CATALOG, DOORS_CATALOG, UI_CATALOG, VOCATIONS_CATALOG, PARTY_AI_CATALOG } from '../data/index.js';
import { EQUIPMENT_KEY_MAP, ACTIVE_SLOT_KEYS, INVENTORY_CONFIG } from '../engine/config.js';

const EMOJI_TO_SVG_MAP = {
  '🧪': '1F9EA',
  '⚗️': '2697',
  '🔷': '1F539',
  '🔥': '1F525',
  '🏹': '1F3F9',
  '🪄': '1FA84',
  '🦯': '1F9AF',
  '🔮': '1F52E',
  '🗡️': '1F5E1',
  '⚔️': '2694',
  '⚒️': '2692',
  '🔨': '1F528',
  '🛡️': '1F6E1',
  '🦺': '1F9BA',
  '🧥': '1F9E5',
  '📿': '1F4FF',
  '👑': '1F451',
  '🧢': '1F9E2',
  '🪖': '1FA96',
  '✨': '2728',
  '💡': '1F4A1',
  '⚡': '26A1',
  '🎯': '1F3AF',
  '🌪️': '1F32A',
  '💖': '1F496',
  '☀️': '2600',
  '📦': '1F4E6',
  '🕯️': '1F56F',
  '🧙‍♂️': '1F9D9',
  '📖': '1F4D6',
  '⭐': '2B50',
};

const CLASS_TINT_CLASSES = ['voc-fighter', 'voc-paladin', 'voc-magician', 'voc-archer', 'voc-neutral'];
const NEUTRAL_CLASS = { classLabel: 'N', classGlyphSvgCode: '1F4E6' };

export class HUDManager {
  /**
   * Binds one delegated pointer listener on the sidebar root for every slot
   * interaction (D1 §2.1). Safe to call repeatedly.
   */
  static bindHUDEvents(elements, app) {
    if (!elements) return;
    const root = elements.sidebarEl || elements.loadoutEl || elements.backpackEl;
    if (!root || root._boundSlotPointer) return;
    root._boundSlotPointer = true;
    root.addEventListener('pointerdown', e => HUDManager._onPointerDown(app, e));
    root.addEventListener('pointermove', e => HUDManager._onPointerMove(app, e));
    root.addEventListener('pointerup', e => HUDManager._onPointerUp(app, e));
    root.addEventListener('dblclick', e => HUDManager._onDoubleClick(app, e));
    root.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const slot = e.target.closest('.loadout-slot, .backpack-slot');
      if (!slot) return;
      e.preventDefault();
      const ctx = HUDManager._slotContext(slot);
      if (!ctx) return;
      HUDManager._handleSlotActivate(app, ctx, e.target);
    });
  }

  // ---- Slot descriptors & item lookup -------------------------------------

  static _slotContext(el) {
    if (!el) return null;
    if (el.classList.contains('loadout-slot')) return { source: 'loadout', ref: el.getAttribute('data-ref'), el };
    if (el.classList.contains('backpack-slot')) return { source: 'backpack', ref: el.getAttribute('data-ref'), el };
    return null;
  }

  static _itemAt(app, ref) {
    const info = InventorySystem.resolveKeyedSlot(app.player, ref);
    return info ? InventorySystem._readRef(app.player, info) : null;
  }

  // ---- Pointer drag + click-to-swap (D1 §2.4) -----------------------------

  static _ghost() {
    let ghost = document.getElementById('slot-drag-ghost');
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.id = 'slot-drag-ghost';
      ghost.className = 'slot-drag-ghost';
      (document.getElementById('app') || document.body).appendChild(ghost);
    }
    return ghost;
  }

  static _moveGhost(clientX, clientY) {
    const ghost = HUDManager._ghost();
    ghost.style.left = `${clientX}px`;
    ghost.style.top = `${clientY}px`;
  }

  static _clearDropHints() {
    document.querySelectorAll('.drop-valid, .drop-invalid').forEach(el => {
      el.classList.remove('drop-valid', 'drop-invalid');
    });
  }

  static _clearSelection(app) {
    app._selectedSlot = null;
    document.querySelectorAll('.slot-selected').forEach(el => el.classList.remove('slot-selected'));
  }

  static _highlightSelection(app, ref) {
    document.querySelectorAll('.slot-selected').forEach(el => el.classList.remove('slot-selected'));
    document.querySelector(`.loadout-slot[data-ref="${ref}"], .backpack-slot[data-ref="${ref}"]`)?.classList.add('slot-selected');
  }

  static _onPointerDown(app, e) {
    if (app.isPaused || !app.isInGameplay) return;
    const slot = e.target.closest('.loadout-slot, .backpack-slot');
    if (!slot) return;
    const ctx = HUDManager._slotContext(slot);
    if (!ctx) return;
    const item = HUDManager._itemAt(app, ctx.ref);
    app._drag = {
      ref: ctx.ref,
      el: slot,
      item,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      pointerId: e.pointerId,
    };
    if (item) {
      slot.classList.add('slot-dragging');
      const ghost = HUDManager._ghost();
      ghost.innerHTML = HUDManager.renderItemIcon(item);
      ghost.style.display = 'block';
      HUDManager._moveGhost(e.clientX, e.clientY);
    }
  }

  static _onPointerMove(app, e) {
    const drag = app._drag;
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5) {
      drag.moved = true;
    }
    if (!drag.moved || !drag.item) return;
    HUDManager._moveGhost(e.clientX, e.clientY);
    HUDManager._clearDropHints();
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.loadout-slot, .backpack-slot');
    if (under && under !== drag.el) {
      const ctx = HUDManager._slotContext(under);
      if (ctx) {
        const check = InventorySystem.validateMove(app.player, drag.ref, ctx.ref);
        under.classList.add(check.valid ? 'drop-valid' : 'drop-invalid');
      }
    }
  }

  static _onPointerUp(app, e) {
    const drag = app._drag;
    app._drag = null;
    HUDManager._clearDropHints();
    if (drag?.el) drag.el.classList.remove('slot-dragging');
    const ghost = document.getElementById('slot-drag-ghost');
    if (ghost) ghost.style.display = 'none';

    if (drag && drag.moved && drag.item) {
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.loadout-slot, .backpack-slot');
      const ctx = under ? HUDManager._slotContext(under) : null;
      if (ctx && ctx.ref !== drag.ref) HUDManager._commitMove(app, drag.ref, ctx.ref, ctx.el);
      HUDManager._clearSelection(app);
      return;
    }

    const slot = e.target.closest('.loadout-slot, .backpack-slot') || drag?.el;
    if (!slot) return;
    const ctx = HUDManager._slotContext(slot);
    if (!ctx) return;
    HUDManager._handleSlotActivate(app, ctx, slot);
  }

  /** Click / Enter activation: select a source, or resolve a pending move. */
  static _handleSlotActivate(app, ctx, slotEl) {
    const selected = app._selectedSlot;
    if (selected && selected.ref !== ctx.ref) {
      HUDManager._commitMove(app, selected.ref, ctx.ref, slotEl);
      HUDManager._clearSelection(app);
      return;
    }
    if (selected && selected.ref === ctx.ref) {
      HUDManager._clearSelection(app);
      return;
    }
    if (HUDManager._itemAt(app, ctx.ref)) {
      app._selectedSlot = { ref: ctx.ref };
      HUDManager._highlightSelection(app, ctx.ref);
    }
  }

  static _commitMove(app, from, to, targetEl) {
    const res = InventorySystem.swapKeyedItem(app.player, from, to);
    if (res.success) {
      soundFX.play('equip');
      app.logCombat(res.message, 'loot');
      app.updateHUD();
      app.persistSave();
      return;
    }
    soundFX.play('uiDenied');
    app.logCombat(res.message, 'warning');
    if (targetEl) {
      targetEl.classList.remove('slot-shake');
      // Force reflow so the shake animation replays on consecutive rejects.
      void targetEl.offsetWidth;
      targetEl.classList.add('slot-shake');
      setTimeout(() => targetEl.classList.remove('slot-shake'), 220);
    }
  }

  static _onDoubleClick(app, e) {
    if (app.isPaused || !app.isInGameplay) return;
    const slot = e.target.closest('.backpack-slot');
    if (!slot) return;
    const index = parseInt(slot.getAttribute('data-index') || '-1', 10);
    if (index < 0) return;
    const res = InventorySystem.useBackpackItem(app.player, index);
    if (res.success) {
      soundFX.play('equip');
      app.logCombat(res.message, 'loot');
      app.updateHUD();
      app.persistSave();
    } else {
      app.logCombat(res.message, 'warning');
    }
  }

  // ---- Render -------------------------------------------------------------

  static updateHUD(elements, app) {
    HUDManager.bindHUDEvents(elements, app);
    const { statusBarsEl, loadoutEl, backpackEl, questLogEl } = elements;
    HUDManager.renderStatusBars(statusBarsEl, app.player, app.currentFloorName);
    HUDManager.renderQuestLog(questLogEl, app);
    HUDManager.renderLoadout(loadoutEl, app);
    HUDManager.renderBackpack(backpackEl, app);
    HUDManager.updateKnockoutPrompt(app);
  }

  /**
   * Quest Log panel (LIV-60 P3). Rendered from `player.questState` through the
   * quest-system's catalog-aware accessor; copy resolves from `ui.json.quests`.
   * Diffed against the last signature so a 10 Hz tick that changes nothing does
   * not rebuild the DOM.
   */
  static renderQuestLog(questLogEl, app) {
    if (!questLogEl) return;
    const copy = UI_CATALOG?.quests || {};
    const entries = questLogEntries(app?.player?.questState);
    const sig = JSON.stringify(entries);
    if (questLogEl._questSig === sig) return;
    questLogEl._questSig = sig;

    const header = `<div class="panel-header">${copy.logTitle || 'Quest Log'}</div>`;
    if (entries.length === 0) {
      questLogEl.innerHTML = `${header}<div class="quest-empty">${copy.noActiveQuests || 'No active quests.'}</div>`;
      return;
    }
    const rows = entries.map((entry) => {
      const objectives = entry.objectives.map((obj) => {
        const label = copy[obj.logKey] || obj.id;
        const progress = (copy.objectiveProgress || '{current}/{count}')
          .replace('{current}', String(obj.count))
          .replace('{count}', String(obj.target));
        return `<li class="quest-objective ${obj.done ? 'done' : ''}"><span class="quest-obj-label">${label}</span><span class="quest-obj-progress">${progress}</span></li>`;
      }).join('');
      const ready = entry.status === 'complete';
      return `<div class="quest-entry ${ready ? 'ready' : ''}">
        <div class="quest-name">${entry.name}${ready ? ' ★' : ''}</div>
        <ul class="quest-objectives">${objectives}</ul>
      </div>`;
    }).join('');
    questLogEl.innerHTML = `${header}${rows}`;
  }

  static renderStatusBars(statusBarsEl, player, currentFloorName) {
    if (!statusBarsEl) return;
    const hpPercent = Math.max(0, Math.min(100, (player.hp / player.max_hp) * 100));
    const mpPercent = Math.max(0, Math.min(100, (player.mana / player.max_mana) * 100));
    const xpPercent = player.level >= 20 ? 100 : Math.max(0, Math.min(100, (player.xp / (player.xpToNextLevel || 100)) * 100));
    const vocationDisplay = (player.vocation || 'magician').charAt(0).toUpperCase() + (player.vocation || 'magician').slice(1);
    const dmgBonusPct = Math.round(((player.skillBoosts?.damageMultiplier || 1.0) - 1.0) * 100);

    statusBarsEl.innerHTML = `
      <div class="panel-header">HERO STATUS & TOWER ASCENT</div>
      <div class="status-panel-inner">
        <div class="status-header">
          <div class="vocation-tag"><span class="level-badge">Lv. ${player.level || 1}</span> <strong class="val">${vocationDisplay}</strong></div>
          <div class="floor-tag"><span class="label">Floor:</span> <strong class="val">${player.current_floor || 1} · ${currentFloorName}</strong></div>
        </div>

        <div class="gold-tag"><span class="gold-icon">🪙</span> <span class="gold-label">GOLD</span> <strong class="gold-val">${Number(player.gold) || 0}</strong></div>

        ${HUDManager.renderKeyIndicators(player)}

        ${HUDManager.renderPartyPanel(player)}

        <div class="meter-container hp-meter">
          <div class="meter-info">
            <span class="meter-label">HEALTH (HP)</span>
            <span class="meter-values">${player.hp} / ${player.max_hp}</span>
          </div>
          <div class="meter-bar-track">
            <div class="meter-bar-fill hp-fill" style="width: ${hpPercent}%;"></div>
          </div>
        </div>

        <div class="meter-container mp-meter">
          <div class="meter-info">
            <span class="meter-label">MANA (MP)</span>
            <span class="meter-values">${player.mana} / ${player.max_mana}</span>
          </div>
          <div class="meter-bar-track">
            <div class="meter-bar-fill mp-fill" style="width: ${mpPercent}%;"></div>
          </div>
        </div>

        <div class="meter-container xp-meter">
          <div class="meter-info">
            <span class="meter-label">EXP (XP)</span>
            <span class="meter-values">${player.level >= 20 ? 'MAX LEVEL' : `${player.xp || 0} / ${player.xpToNextLevel || 100}`}</span>
          </div>
          <div class="meter-bar-track">
            <div class="meter-bar-fill xp-fill" style="width: ${xpPercent}%;"></div>
          </div>
        </div>

        ${
          dmgBonusPct > 0 || player.skillBoosts?.bonusRange || player.skillBoosts?.bonusRegen
            ? `<div class="skill-boosts-summary">
                <span>⚡ +${dmgBonusPct}% Damage</span>
                ${player.skillBoosts?.bonusRange ? `<span>🏹 +${player.skillBoosts.bonusRange} Range</span>` : ''}
                ${player.skillBoosts?.bonusRegen ? `<span>❤️ +${player.skillBoosts.bonusRegen} Regen</span>` : ''}
              </div>`
            : ''
        }

        ${
          player.lightSpellTimer > 0
            ? `<div class="active-buff-badge">
                <span class="buff-icon">✨</span>
                <span class="buff-text">Light Aura: <strong>${Math.ceil(player.lightSpellTimer)}s</strong> (${LightingSystem.computePlayerRadius(player)} tiles)</span>
              </div>`
            : ''
        }
      </div>
    `;
  }

  static renderKeyIndicators(player) {
    const floor = player?.current_floor || 1;
    const tiers = DoorSystem.tiers();
    if (tiers.length === 0) return '';

    const icons = tiers.map(tier => {
      const earned = DoorSystem.hasKey(player, tier, floor);
      const keyItemId = DoorSystem.keyItemForTier(tier);
      const catalogItem = keyItemId ? ITEMS_CATALOG[keyItemId] : null;
      const accent = DOORS_CATALOG?.[tier]?.accent || '#94a3b8';
      const label = catalogItem?.name || `${tier} key`;
      const icon = HUDManager.renderItemIcon({
        item_id: keyItemId,
        name: label,
        svgCode: earned && catalogItem?.svgCodeActive ? catalogItem.svgCodeActive : catalogItem?.svgCode,
      });
      const state = earned ? 'active' : 'locked';
      const tip = earned ? `${label} earned on Floor ${floor}` : `${label} — not yet earned on Floor ${floor}`;
      return `<span class="level-key ${state}" data-tier="${tier}" style="--key-accent: ${accent};" title="${tip}">${icon}</span>`;
    }).join('');

    return `
      <div class="level-keys-row" aria-label="Keys earned on this floor">
        <span class="level-keys-label">KEYS</span>
        <span class="level-keys-icons">${icons}</span>
      </div>
    `;
  }

  /**
   * Compact party panel (LIV-10/WS2): one chip per member with initials,
   * HP/MP bars and an active marker. Data-driven from `player.party` and the
   * vocation catalog; safe no-op for legacy single-character players.
   */
  static renderPartyPanel(player) {
    const party = Array.isArray(player?.party) ? player.party : null;
    if (!party || party.length === 0) return '';
    const activeId = player.activeMemberId;
    const knockout = UI_CATALOG?.knockout || {};
    const downedToken = knockout.visuals?.downed || {};
    const help = PARTY_AI_CATALOG?.revive?.callForHelp || {};
    const glyph = downedToken.glyph || '✚';
    const pipColor = help.color || '#fde68a';
    const pipEnabled = help.enabled !== false;
    // LIV-52 "down #N" escalation pip (ui.json.knockout.autoRevive.pip).
    const autoPip = knockout.autoRevive?.pip || {};
    const downPipColors = Array.isArray(autoPip.colors) && autoPip.colors.length
      ? autoPip.colors
      : ['#fde68a', '#fb923c', '#ef4444'];
    const downPipMaxLabel = autoPip.labelMax || '3+';
    const members = party
      .map((member) => {
        const voc = member.vocation || 'magician';
        const theme = VOCATIONS_CATALOG?.[voc]?.renderTheme || {};
        const label = theme.classLabel || voc.charAt(0).toUpperCase();
        const color = theme.primary || '#5c2d91';
        const accent = theme.accent || '#ffd700';
        const isActive = member.memberId === activeId;
        // The active member's live state lives on the top-level player, not its
        // (capture-time) party mirror; read it here so the panel bar is current
        // without a per-tick JSON clone of the whole actor.
        const hp = isActive ? player.hp : member.hp;
        const maxHp = isActive ? player.max_hp : member.max_hp;
        const mp = isActive ? player.mana : member.mana;
        const maxMp = isActive ? player.max_mana : member.max_mana;
        const downed = member.combatState === 'downed' || member.lifeState === 'downed' || !(Number(hp) > 0);
        const hpPct = downed ? 0 : Math.max(0, Math.min(100, (Number(hp) / Math.max(1, Number(maxHp))) * 100));
        const mpPct = downed ? 0 : Math.max(0, Math.min(100, (Number(mp) / Math.max(1, Number(maxMp))) * 100));
        const name = voc.charAt(0).toUpperCase() + voc.slice(1);
        // Downed chip: greyed, a downed glyph badge, a DOWN tag, and the E1
        // locator pip (call-for-help) when an ally can still answer.
        const pip = downed && pipEnabled
          ? `<span class="party-locator-pip" style="--pip-color:${pipColor}" aria-hidden="true"></span>`
          : '';
        const badge = downed ? glyph : label;
        // "down #N" pip: gold/amber/red by escalated KO count within the tower
        // (clamped to the last colour for 3rd+), so a longer 2nd/3rd+ timer reads.
        const downCount = Math.max(1, Math.floor(Number(isActive ? player.downCount : member.downCount) || 1));
        const downPipSize = Number.isFinite(Number(autoPip.diameterPx)) ? Number(autoPip.diameterPx) : 12;
        const downPipFont = Number.isFinite(Number(autoPip.fontSizeRem)) ? Number(autoPip.fontSizeRem) : 0.52;
        const downPipRimW = Number.isFinite(Number(autoPip.rimWidthPx)) ? Number(autoPip.rimWidthPx) : 1.5;
        const downPipStyle = `--down-pip-color:${downPipColors[Math.min(downCount - 1, downPipColors.length - 1)]};`
          + `--down-pip-size:${downPipSize}px;--down-pip-font:${downPipFont}rem;`
          + `--down-pip-text:${autoPip.textColor || '#020617'};--down-pip-rim:${autoPip.rimColor || '#020617'};`
          + `--down-pip-rim-w:${downPipRimW}px`;
        const downPip = downed
          ? `<em class="party-down-pip" style="${downPipStyle}" title="Down ${downCount}">${downCount >= downPipColors.length ? downPipMaxLabel : downCount}</em>`
          : '';
        return `
          <div class="party-chip${isActive ? ' is-active' : ''}${downed ? ' is-downed' : ''}" data-member="${member.memberId || voc}" title="${name} · Lv ${member.level || 1}" style="--party-color: ${color}; --party-accent: ${accent}; --pip-color: ${pipColor};">
            <span class="party-chip-badge">${badge}</span>
            <span class="party-chip-body">
              <span class="party-chip-name">${name}${isActive && !downed ? ' <em>★</em>' : ''}${downed ? ` <em class="party-downed-tag">DOWN</em>${downPip}` : ''}</span>
              <span class="party-chip-bars">
                <span class="party-hp"><i style="width:${hpPct}%"></i></span>
                <span class="party-mp"><i style="width:${mpPct}%"></i></span>
              </span>
            </span>
            ${pip}
          </div>`;
      })
      .join('');
    return `
      <div class="party-panel" aria-label="Party members">
        <div class="party-panel-header">PARTY (${party.length})</div>
        <div class="party-chips">${members}</div>
      </div>
    `;
  }

  /**
   * On-screen knockout/revive prompt (LIV-45). Shows `reviveStartCue` while a
   * living ally channels a rescue and `downedCue` while a body waits; hidden
   * otherwise. Creates the element once inside `.viewport-panel` and only
   * toggles text/hidden after — no per-frame DOM churn (docs/engineering/agents.md).
   * @param {object} app
   */
  static updateKnockoutPrompt(app) {
    if (typeof document === 'undefined' || !app) return;
    const knockout = UI_CATALOG?.knockout;
    const party = Array.isArray(app.player?.party) ? app.player.party : null;
    if (!knockout || !party || party.length <= 1) {
      HUDManager._setKnockoutPrompt(null);
      return;
    }
    const isDowned = (m) => Boolean(m) && (m.combatState === 'downed' || m.lifeState === 'downed' || !(Number(m.hp) > 0));
    const nameOf = (m) => {
      const v = VOCATIONS_CATALOG?.[m && m.vocation];
      return (v && v.name) || (m && m.vocation ? m.vocation.charAt(0).toUpperCase() + m.vocation.slice(1) : 'An ally');
    };
    const fill = (tpl, member) => String(tpl || '').replace('{member}', nameOf(member));

    const reviver = party.find((m) => m && !isDowned(m) && m._reviveTargetId);
    if (reviver) {
      const target = party.find((m) => m && m.memberId === reviver._reviveTargetId) || reviver;
      HUDManager._setKnockoutPrompt(fill(knockout.reviveStartCue, target), 'reviving');
      return;
    }
    const downed = party.find((m) => isDowned(m));
    if (downed) {
      // Informational only: the auto designee handles the rescue, so do not
      // imply a non-existent manual binding (`revivePrompt` is reserved for the
      // player-initiated revive follow-up).
      HUDManager._setKnockoutPrompt(fill(knockout.downedCue, downed), 'downed');
      return;
    }
    HUDManager._setKnockoutPrompt(null);
  }

  /** Lazily mounts the prompt element once, then only toggles it. */
  static _setKnockoutPrompt(text, state) {
    if (typeof document === 'undefined') return;
    let el = HUDManager._knockoutPromptEl;
    if (!el) {
      el = document.getElementById('knockout-prompt');
      const host = document.querySelector('.viewport-panel');
      if (!el && !host) return;
      if (!el) {
        el = document.createElement('div');
        el.id = 'knockout-prompt';
        el.className = 'knockout-prompt';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.hidden = true;
        host.appendChild(el);
      }
      HUDManager._knockoutPromptEl = el;
    }
    if (!text) {
      if (!el.hidden) { el.hidden = true; el.textContent = ''; }
      return;
    }
    if (el.hidden) el.hidden = false;
    if (el.textContent !== text) el.textContent = text;
    if (el.dataset.state !== state) el.dataset.state = state || '';
  }

  /**
   * The Loadout panel (D1 §2): row 1 active `1-4`, row 2 equipment `q w e r`.
   * Skeleton built once; slots diffed via classList/textContent only.
   */
  static renderLoadout(loadoutEl, app) {
    if (!loadoutEl) return;
    const loadout = UI_CATALOG?.hud?.loadout || {};
    const activeKeys = Array.isArray(loadout.activeKeys) && loadout.activeKeys.length ? loadout.activeKeys : ACTIVE_SLOT_KEYS;
    const equipmentKeys = Array.isArray(loadout.equipmentKeys) && loadout.equipmentKeys.length ? loadout.equipmentKeys : Object.keys(EQUIPMENT_KEY_MAP);
    const columns = Number(loadout.columns) || 4;

    let grid = loadoutEl.querySelector('.loadout-grid');
    if (!grid) {
      const activeHtml = activeKeys.map((key, i) => `
        <button class="loadout-slot active-slot slot-empty" type="button" data-ref="active:${i}" data-slot="active_${i}" data-kind="active" data-index="${i}" data-key="${key}" aria-label="Active slot ${key}">
          <span class="key-badge">${key}</span>
          <span class="slot-class-badge" aria-hidden="true"></span>
          <span class="slot-content"></span>
          <span class="slot-name"></span>
          <span class="item-qty"></span>
          <span class="cooldown-overlay" style="display:none;"></span>
        </button>`).join('');
      const equipHtml = equipmentKeys.map(key => {
        const slotName = EQUIPMENT_KEY_MAP[key] || key;
        const label = HUDManager.slotLabel(slotName);
        return `
        <button class="loadout-slot equip-slot slot-empty" type="button" data-ref="${slotName}" data-slot="${slotName}" data-kind="equipment" data-key="${key}" aria-label="${label}, key ${key.toUpperCase()}">
          <span class="key-badge">${String(key).toUpperCase()}</span>
          <span class="slot-class-badge" aria-hidden="true"></span>
          <span class="slot-content"></span>
          <span class="slot-name"></span>
          <span class="item-qty"></span>
          <span class="cooldown-overlay" style="display:none;"></span>
        </button>`;
      }).join('');
      loadoutEl.innerHTML = `
        <div class="panel-header">LOADOUT <span class="slot-count">${activeKeys.length + equipmentKeys.length} KEYED</span></div>
        <div class="loadout-grid" style="grid-template-columns: repeat(${columns}, minmax(0, 1fr));">
          ${activeHtml}${equipHtml}
        </div>`;
      grid = loadoutEl.querySelector('.loadout-grid');
    }

    const paperdoll = app.player.paperdoll || {};
    const actionBar = app.player.action_bar || [];
    grid.querySelectorAll('.loadout-slot').forEach(el => {
      const kind = el.getAttribute('data-kind');
      if (kind === 'active') {
        const i = parseInt(el.getAttribute('data-index') || '-1', 10);
        HUDManager._paintSlot(el, actionBar[i] || null, app);
      } else {
        const slotName = el.getAttribute('data-slot');
        HUDManager._paintSlot(el, paperdoll[slotName] || null, app);
      }
    });
  }

  static renderBackpack(backpackEl, app) {
    if (!backpackEl) return;
    const layout = UI_CATALOG?.inventory?.backpack || {};
    const columns = Number(layout.columns) || INVENTORY_CONFIG.BACKPACK_COLUMNS;
    const total = Number(layout.defaultSlots) || INVENTORY_CONFIG.BACKPACK_SLOTS;
    const backpack = app.player.backpack || new Array(total).fill(null);
    const occupiedCount = backpack.filter(Boolean).length;

    let grid = backpackEl.querySelector('.backpack-slots-grid');
    if (!grid) {
      let html = `
        <div class="panel-header">
          <span>BACKPACK</span>
          <span class="slot-count" id="backpack-slot-count">${occupiedCount}/${total}</span>
        </div>
        <div class="backpack-slots-grid backpack-6x6" style="grid-template-columns: repeat(${columns}, 1fr);">`;
      for (let i = 0; i < total; i++) {
        html += `
          <button class="backpack-slot slot-empty" type="button" data-ref="backpack:${i}" data-index="${i}" aria-label="Backpack slot ${i + 1}">
            <span class="slot-class-badge" aria-hidden="true"></span>
            <span class="slot-content"></span>
            <span class="item-qty"></span>
          </button>`;
      }
      html += `</div>`;
      backpackEl.innerHTML = html;
      grid = backpackEl.querySelector('.backpack-slots-grid');
    }

    const countEl = backpackEl.querySelector('#backpack-slot-count');
    if (countEl) {
      const label = `${occupiedCount}/${total}`;
      if (countEl.textContent !== label) countEl.textContent = label;
    }

    grid.querySelectorAll('.backpack-slot').forEach(el => {
      const i = parseInt(el.getAttribute('data-index') || '-1', 10);
      HUDManager._paintSlot(el, backpack[i] || null);
    });
  }

  /** Diffs one slot element to an item (or null) without rebuilding DOM. */
  static _paintSlot(el, item, app = null) {
    const isOccupied = Boolean(item);
    el.classList.toggle('slot-empty', !isOccupied);
    el.classList.toggle('slot-occupied', isOccupied);

    // Key badge stays constant; class tint + glyph reflect the item.
    el.classList.remove(...CLASS_TINT_CLASSES);
    const classInfo = HUDManager._classInfo(item);
    if (isOccupied) el.classList.add(`voc-${classInfo.key}`);

    const classBadge = el.querySelector('.slot-class-badge');
    if (classBadge) {
      const next = isOccupied ? classInfo.label : '';
      if (classBadge.textContent !== next) classBadge.textContent = next;
      classBadge.classList.toggle('visible', isOccupied);
    }

    const contentEl = el.querySelector('.slot-content');
    if (contentEl && contentEl.dataset.iconItem !== (item?.item_id || '')) {
      contentEl.innerHTML = isOccupied ? HUDManager.renderItemIcon(item) : '';
      contentEl.dataset.iconItem = item?.item_id || '';
    }

    const nameEl = el.querySelector('.slot-name');
    if (nameEl) {
      const next = isOccupied ? item.name : 'Empty';
      if (nameEl.textContent !== next) nameEl.textContent = next;
    }

    const qtyEl = el.querySelector('.item-qty');
    if (qtyEl) {
      const qty = isOccupied && item.quantity > 1 ? `x${item.quantity}` : '';
      if (qtyEl.textContent !== qty) qtyEl.textContent = qty;
    }

    el.title = HUDManager._tooltip(item, app);
    HUDManager._paintCooldown(el, item, app);
  }

  /**
   * D1 §2.5: paint a loadout slot's "recharge" overlay. The grey scrim
   * wipes top -> bottom over the effective cooldown `D`; progress is
   * `1 - remaining / D`. No-op for slots without an overlay or an item whose
   * catalog entry has no `actionKey`/`cooldown`.
   */
  static _paintCooldown(el, item, app = null) {
    const overlay = el.querySelector('.cooldown-overlay');
    if (!overlay) return;

    const baseLabel = el.dataset.baseLabel || el.getAttribute('aria-label') || '';
    if (!el.dataset.baseLabel) el.dataset.baseLabel = baseLabel;

    const catalogItem = item ? ITEMS_CATALOG[item.item_id] : null;
    const actionKey = item?.actionKey || catalogItem?.actionKey || null;
    const effectiveCooldown = item ? CombatSystem.getEffectiveCooldown(item) : null;
    const remaining = (actionKey && app?.player?.cooldowns)
      ? (app.player.cooldowns[actionKey] ?? 0)
      : 0;

    if (!item || !actionKey || typeof effectiveCooldown !== 'number' || remaining <= 0) {
      if (el.classList.contains('on-cooldown')) el.classList.remove('on-cooldown');
      if (overlay.style.display !== 'none') overlay.style.display = 'none';
      el.style.removeProperty('--cd-inset');
      if (baseLabel && el.getAttribute('aria-label') !== baseLabel) {
        el.setAttribute('aria-label', baseLabel);
      }
      return;
    }

    const progress = Math.max(0, Math.min(1, 1 - remaining / effectiveCooldown));
    el.style.setProperty('--cd-inset', `${(progress * 100).toFixed(1)}%`);
    if (overlay.style.display !== 'block') overlay.style.display = 'block';
    el.classList.add('on-cooldown');

    const rechargingLabel = `${baseLabel}, recharging`;
    if (el.getAttribute('aria-label') !== rechargingLabel) {
      el.setAttribute('aria-label', rechargingLabel);
    }
  }

  static _classInfo(item) {
    if (!item) return { key: 'neutral', label: '', glyph: NEUTRAL_CLASS.classGlyphSvgCode };
    const affinity = item.vocationAffinity || ITEMS_CATALOG[item.item_id]?.vocationAffinity;
    let key = 'neutral';
    if (affinity && affinity !== 'neutral') {
      key = Array.isArray(affinity) ? (affinity[0] || 'neutral') : affinity;
    }
    const theme = VOCATIONS_CATALOG?.[key]?.renderTheme || NEUTRAL_CLASS;
    return {
      key,
      label: theme.classLabel || key.charAt(0).toUpperCase(),
      glyph: theme.classGlyphSvgCode || NEUTRAL_CLASS.classGlyphSvgCode,
    };
  }

  static slotLabel(slotName) {
    const map = { main_hand: 'Main hand', off_hand: 'Off hand', armor: 'Armor', relic: 'Relic' };
    return map[slotName] || String(slotName || '').replace('_', ' ');
  }

  static _tooltip(item, app = null) {
    if (!item) return 'Empty';
    const catalog = ITEMS_CATALOG[item.item_id] || {};
    const lines = [item.name];
    const classInfo = HUDManager._classInfo(item);
    if (classInfo.key !== 'neutral') lines.push(`Class: ${classInfo.key}`);
    lines.push(`Slot: ${HUDManager.slotLabel(item.slot || catalog.slot || catalog.type || '')}`);
    if (item.itemLevel > 1) {
      const cap = EconomySystem.maxRankForParty(app?.player);
      lines.push(`Rank ${item.itemLevel}/${cap}`);
    }
    if (item.damageMin || item.damageMax) lines.push(`Damage: ${item.damageMin || 0}–${item.damageMax || 0}`);
    if (item.stat_bonus) lines.push(`Power: +${item.stat_bonus}`);
    if (item.manaCost) lines.push(`Mana: ${item.manaCost}`);
    if (item.hpBonus) lines.push(`+${item.hpBonus} Max HP`);
    if (item.manaBonus) lines.push(`+${item.manaBonus} Max MP`);
    if (item.rangedDamageBonus) lines.push(`+${item.rangedDamageBonus} Ranged Damage`);
    if (item.critChance) lines.push(`+${item.critChance}% Crit`);
    if (item.poisonDps) lines.push(`Poison: ${item.poisonDps} dmg/s for ${item.poisonDurationSec || 3}s`);
    if (item.siphonHp) lines.push(`Life Siphon: ${item.siphonHp} HP / ${item.siphonRadius || 2} tiles`);
    if (item.markDurationSec) lines.push(`Hunter's Mark: ${item.markDurationSec}s`);
    const actionKey = item.actionKey || catalog.actionKey;
    if (actionKey) lines.push(`Ability: ${actionKey.replace(/_/g, ' ')}`);
    if (item.cooldown) lines.push(`Cooldown: ${item.cooldown}s`);
    return lines.join('\n');
  }

  static emojiToOpenMojiCode(emoji) {
    if (!emoji) return '1F4E6';
    return EMOJI_TO_SVG_MAP[emoji] || '1F4E6';
  }

  static renderItemIcon(item) {
    if (!item) return '•';
    const catalogItem = ITEMS_CATALOG[item.item_id];
    const code = item.svgCode || catalogItem?.svgCode || (item.icon ? HUDManager.emojiToOpenMojiCode(item.icon) : '1F4E6');
    return `<img class="openmoji-icon" src="./assets/openmoji/${code}.svg" alt="${item.name || 'item'}" draggable="false" />`;
  }

  static logCombat(combatLogScrollEl, message, category = 'system') {
    if (!combatLogScrollEl) return;
    const now = new Date();
    const timestamp = now.toTimeString().split(' ')[0];

    const line = document.createElement('div');
    line.className = `log-line log-${category}`;
    line.innerHTML = `<span class="log-time">[${timestamp}]</span> <span class="log-msg">${HUDManager.escapeHtml(message)}</span>`;

    combatLogScrollEl.appendChild(line);

    const MAX_LOG_LINES = 100;
    while (combatLogScrollEl.childElementCount > MAX_LOG_LINES) {
      combatLogScrollEl.removeChild(combatLogScrollEl.firstElementChild);
    }

    combatLogScrollEl.scrollTop = combatLogScrollEl.scrollHeight;
  }

  static clearCombatLog(combatLogScrollEl) {
    if (combatLogScrollEl) {
      combatLogScrollEl.innerHTML = '';
    }
  }

  static escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
