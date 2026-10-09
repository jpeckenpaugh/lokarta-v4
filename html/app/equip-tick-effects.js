/**
 * Lokarta: Come Into The Light - Equipped-Item Passive Tick Effects
 *
 * The 10 Hz simulation tick asks this module to run an equipped relic's / armor's
 * passive effect. Each handler is keyed by the item's catalog `tickEffectKey`
 * (`items.json`); an item with no key (or an unknown key) is a silent no-op.
 * Extracted from `game-loop.js` (LIV-94) so the tick loop stays focused on
 * orchestration while item-specific passive behavior lives in one cohesive file.
 *
 * Every interval/amount is read from the item's catalog fields, so a new passive
 * is a catalog entry plus — only when functionally new — one handler here.
 */

import { EconomySystem } from '../engine/index.js';
import { soundFX } from '../audio/index.js';
import { UI_CATALOG } from '../data/index.js';

/** Lifetime (seconds) of the Luminous Prayer orb VFX after each heal pulse. */
const LUMINOUS_PRAYER_VFX_SEC = Number(UI_CATALOG?.playerVfx?.luminousPrayer?.durationSec) || 1.6;

export const EQUIP_TICK_EFFECTS = {
  luminous_prayer_passive: (loop, item, deltaSec) => {
    if (!loop.prayerAccumulator) loop.prayerAccumulator = 0;
    loop.prayerAccumulator += deltaSec;
    const intervalSec = Number(item.prayerPulseSec) || 10;
    if (loop.prayerAccumulator < intervalSec) return;
    loop.prayerAccumulator -= intervalSec;

    const rank = item.itemLevel || 1;
    const poolPerRank = Number(item.prayerPoolPerRank) || 2;
    let poolRemaining = rank * poolPerRank;

    let hpRestored = 0;
    let manaRestored = 0;
    const hpNeeded = Math.max(0, loop.player.max_hp - loop.player.hp);
    const manaNeeded = Math.max(0, loop.player.max_mana - loop.player.mana);

    if (hpNeeded > 0 && poolRemaining > 0) {
      hpRestored = Math.min(hpNeeded, poolRemaining);
      poolRemaining -= hpRestored;
      loop.player.hp += hpRestored;
    }
    if (manaNeeded > 0 && poolRemaining > 0) {
      manaRestored = Math.min(manaNeeded, poolRemaining);
      poolRemaining -= manaRestored;
      loop.player.mana += manaRestored;
    }
    if (hpRestored <= 0 && manaRestored <= 0) return;

    soundFX.play('holyChime');
    loop.player.luminousPrayerVfxSec = LUMINOUS_PRAYER_VFX_SEC;
    const text = hpRestored > 0 && manaRestored > 0
      ? `+${hpRestored} HP / +${manaRestored} MP`
      : (hpRestored > 0 ? `+${hpRestored} HP` : `+${manaRestored} MP`);
    loop.addFloatingText(text, loop.player.x, loop.player.y, '#f59e0b');
    loop.logCombat(`Luminous Amulet Prayer restored ${text}.`, 'spell');
    loop.updateHUD();
  },
  power_pulse_passive: (loop, item, deltaSec) => {
    if (!loop.powerPulseAccumulator) loop.powerPulseAccumulator = 0;
    loop.powerPulseAccumulator += deltaSec;

    const rankCap = EconomySystem.maxRankForParty(loop.player);
    const rank = Math.min(rankCap, Math.max(1, item.itemLevel || 1));
    const base = Number(item.pulseIntervalBaseSec) || 22;
    const per = Number(item.pulseIntervalPerRankSec) || 2;
    const min = Number(item.pulseIntervalMinSec) || 12;
    const intervalSec = Math.max(min, base - per * rank);
    if (loop.powerPulseAccumulator < intervalSec) return;
    loop.powerPulseAccumulator -= intervalSec;

    const mpRestored = Math.max(1, rank * (Number(item.mpPulsePerRank) || 1));
    if (loop.player.mana >= loop.player.max_mana) return;
    const actualRestored = Math.min(mpRestored, loop.player.max_mana - loop.player.mana);
    loop.player.mana += actualRestored;
    soundFX.play('manaRegen');
    loop.addFloatingText(`+${actualRestored} MP Pulse`, loop.player.x, loop.player.y, '#38bdf8');
    loop.logCombat(`Apprentice's Cape Power Pulse restored +${actualRestored} MP!`, 'spell');
    loop.updateHUD();
  },
};

/** Runs an equipped item's catalog-declared passive tick effect, if any. */
export function runEquipTickEffect(loop, item, deltaSec) {
  const handler = item && EQUIP_TICK_EFFECTS[item.tickEffectKey];
  if (handler) handler(loop, item, deltaSec);
}
