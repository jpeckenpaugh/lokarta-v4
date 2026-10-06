/**
 * LIV-31 / FIX-15b: honor the authored `rankCaps` when projecting an item to
 * ranks 6–20.
 *
 * The party-scaled cap now reaches 20 (FIX-13 / [LIV-28]). Core power (damage,
 * HP/MP, heal, poison) keeps scaling to Rank 20, but utility/control fields
 * plateau at the Game Designer's `items.json.rankCaps` ceiling so a
 * `+1 range/rank` wand cannot reach 24 tiles, a `+1s stun/rank` cape cannot
 * stun-lock for 24s, and a `-1s CD/rank` ability cannot hit the 1s floor.
 *
 * Contract: effective total contribution = `min(incKey × (rank − 1),
 * rankCaps.incKey)`; a missing key is uncapped. The clamp lands in both the
 * projection (`item-stats.js`) and the instance mutation
 * (`item-progression.js applyItemRankUp`), so gameplay — not just the HUD —
 * reads the capped value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlayer,
  createPartyMember,
  applyItemRankUp,
  getEffectiveDamage,
  getEffectiveRange,
  getEffectiveManaCost,
  getEffectiveCooldown,
  CombatSystem,
} from '../engine/index.js';
import { ITEMS_CATALOG } from '../data/index.js';

/** A player carrying a live four-member party (max authored rank 20). */
function fullParty() {
  const player = createPlayer('magician');
  const party = ['magician', 'archer', 'fighter', 'paladin'].map(vocation => createPartyMember(vocation));
  player.party = party;
  player.activeMemberId = party[0].memberId;
  return player;
}

/** Ranks an owned item to the live cap (20 for a four-member party). */
function rankToMax(player, item, rng = { randomInt: () => 5 }) {
  let guard = 0;
  while (item.itemLevel < 20 && guard++ < 50) {
    applyItemRankUp(player, item, { rng });
  }
  return item;
}

function instance(itemId) {
  return { ...ITEMS_CATALOG[itemId], item_id: itemId, itemLevel: 1 };
}

describe('LIV-31 rankCaps — projection at Rank 20', () => {
  it('clamps Spark Wand range to 8 (rangeInc ceiling 3) and plateaus from rank 4', () => {
    const at20 = { ...ITEMS_CATALOG.apprentice_wand, item_id: 'apprentice_wand', itemLevel: 20 };
    assert.equal(getEffectiveRange(at20), 8);
    // Cap reached at rank 4 (1 × 3), so rank 5 equals rank 20.
    const at4 = { ...ITEMS_CATALOG.apprentice_wand, item_id: 'apprentice_wand', itemLevel: 4 };
    const at5 = { ...ITEMS_CATALOG.apprentice_wand, item_id: 'apprentice_wand', itemLevel: 5 };
    assert.equal(getEffectiveRange(at4), 8);
    assert.equal(getEffectiveRange(at5), 8, 'utility plateaus instead of reaching 9 at rank 5');
  });

  it('clamps Astral Scepter range to 7 and effective MP to 6 (manaCostInc ceiling 20)', () => {
    const at20 = { ...ITEMS_CATALOG.astral_scepter, item_id: 'astral_scepter', itemLevel: 20 };
    assert.equal(getEffectiveRange(at20), 7);
    const mp = getEffectiveManaCost(at20);
    assert.ok(mp <= 15, `rank-20 scepter MP stays bounded (got ${mp})`);
    assert.equal(mp, 6, 'base 5 + capped 20 MP − 19 promoted labels');
    assert.equal(CombatSystem.getEffectiveManaCost(at20), 6, 'combat reads the capped projection');
  });

  it('projects an already-ranked instance without double-counting the rank bonus', () => {
    const player = fullParty();
    const scepter = rankToMax(player, instance('astral_scepter'));
    assert.equal(scepter.range, 7, 'instance field holds the capped range');
    assert.equal(getEffectiveRange(scepter), 7, 'projection is idempotent on the accumulated instance');
    assert.equal(scepter.manaCost, 25, 'instance field holds base 5 + capped 20 MP');
    assert.ok(getEffectiveManaCost(scepter) <= 15, 'gameplay MP stays bounded on the ranked instance');
    assert.equal(getEffectiveManaCost(scepter), 6);

    const wand = rankToMax(player, instance('apprentice_wand'));
    assert.equal(wand.range, 8);
    assert.equal(getEffectiveRange(wand), 8);
  });

  it('leaves an uncapped Tempered Broadsword scaling to 16 + avg(4..6) × 19', () => {
    const at20 = { ...ITEMS_CATALOG.tempered_broadsword, item_id: 'tempered_broadsword', itemLevel: 20 };
    assert.equal(getEffectiveDamage(at20), 16 + 5 * 19);

    const player = fullParty();
    const grown = rankToMax(player, instance('tempered_broadsword'));
    assert.equal(grown.itemLevel, 20);
    assert.equal(grown.damage, 16 + 5 * 19, 'instance damage keeps accumulating (no rankCaps key)');
  });
});

describe('LIV-31 rankCaps — clamped instance mutation', () => {
  it('caps a Rank-20 Vanguard Shield stun at 2.5s with a bash cooldown of 5s', () => {
    const player = fullParty();
    const shield = rankToMax(player, instance('vanguard_shield'));
    assert.equal(shield.itemLevel, 20);
    assert.equal(shield.stunSec, 2.5, 'base 1s + stunInc ceiling 1.5s');
    const cooldown = getEffectiveCooldown(shield);
    assert.ok(cooldown >= 5, `bash cooldown never collapses to the 1s floor (got ${cooldown})`);
    assert.equal(cooldown, 5, 'base 10s − cooldownReductionSec ceiling 5s');
    assert.equal(CombatSystem.getEffectiveCooldown(shield), 5, 'combat reads the capped cooldown');
  });

  it("caps a Rank-20 Apprentice's Cape stun at 6s with a Shock Shield cooldown of 5s", () => {
    const player = fullParty();
    const cape = rankToMax(player, instance('apprentice_cape'));
    assert.equal(cape.itemLevel, 20);
    assert.equal(cape.stunSec, 6, 'base 5s + stunInc ceiling 1s');
    const cooldown = getEffectiveCooldown(cape);
    assert.ok(cooldown >= 5, `Shock Shield cooldown never collapses (got ${cooldown})`);
    assert.equal(cooldown, 5);
  });

  it('still clamps every other authored utility field while core stats stay linear', () => {
    const player = fullParty();

    const quiver = rankToMax(player, instance('grey_stalker_quiver'));
    assert.equal(quiver.ammoRegenSec, 2.5, 'ammoRegenSecReduction ceiling 2.5 (floored at 2.5s)');
    assert.equal(quiver.arrowCapacity, 25 + 5 * 19, 'arrowCapacityInc is uncapped core power');
    assert.equal(quiver.poisonDps, 2 + 19, 'poisonDpsInc is uncapped core power');

    const cloak = rankToMax(player, instance('hunter_leathers'));
    assert.equal(cloak.dodgePct, 10 + 20, 'dodgePctInc ceiling 20');

    const talisman = rankToMax(player, instance('ranger_talisman'));
    assert.equal(talisman.critChance, 10 + 19, 'critChanceInc ceiling 25 is not reached by rank 20');
    assert.equal(talisman.critChance, 29, 'doc §9.4 rank-20 Ranger: +19% crit');
    assert.equal(talisman.critMult, 1.25 + 0.5, 'critMultInc ceiling 0.5');
    assert.equal(talisman.markDurationSec, 6 + 6, 'markDurationInc ceiling 6');
    assert.equal(talisman.rangedDamageBonus, 4 + 2 * 19, 'rangedDamageBonusInc (base 4) is uncapped');

    const plate = rankToMax(player, instance('plate_armor'));
    assert.equal(plate.mitigationPct, 10 + 15, 'mitigationPctInc ceiling 15');

    const crown = rankToMax(player, instance('holy_crown'));
    assert.equal(crown.healPowerPct, 15 + 30, 'healPowerPctInc ceiling 30');

    const sanctuary = rankToMax(player, instance('sanctuary_plate'));
    assert.equal(sanctuary.shieldAbsorb, 15 + 40, 'shieldAbsorbInc ceiling 40');
    assert.equal(sanctuary.shieldDuration, 20 + 12, 'shieldDurationInc ceiling 12');
  });
});
