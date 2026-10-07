/**
 * Lokarta: Come Into The Light - Fate Grant Draft Subsystem
 */

import { CARDS_CATALOG, ITEMS_CATALOG } from '../data/index.js';
import { InventorySystem } from './inventory-system.js';
import { EconomySystem } from './economy-system.js';
import { applyItemRankUp } from './item-progression.js';

export class FateGrantSystem {
  static CARD_DATABASE = CARDS_CATALOG;

  static generateDraftOffer(vocationOrPlayer, level = 1, opts = {}) {
    const player = typeof vocationOrPlayer === 'object' ? vocationOrPlayer : null;
    const vocation = player ? (player.vocation || 'magician') : vocationOrPlayer;

    // Rank cap is catalog-driven (`economy.json` → `shop.maxRankByParty`) and
    // scales with the live party size (LIV-28). `rankCapOwner` lets a caller
    // whose actor has no `.party` (an auto ally) borrow the shared party's cap.
    const rankCap = EconomySystem.maxRankForParty(opts.rankCapOwner || player);

    const pool = [...FateGrantSystem.CARD_DATABASE];
    // Filter to include ONLY cards matching the player's class OR neutral cards
    const eligibleCards = pool.filter(c => {
      if (!c.vocationAffinity || c.vocationAffinity === 'neutral') return true;
      if (Array.isArray(c.vocationAffinity)) return c.vocationAffinity.includes(vocation);
      return c.vocationAffinity === vocation;
    });

    const orderedPool = [...eligibleCards];
    FateGrantSystem.shuffle(orderedPool);

    // Helper to find player's existing item matching item_id or actionKey
    const findExistingItem = (itemId, cardItem) => {
      if (!player) return null;
      const catalogEntry = ITEMS_CATALOG[itemId];
      if (!catalogEntry?.upgradeSpec) return null;
      const cardActionKey = cardItem?.actionKey || catalogEntry?.actionKey;
      const allSlots = [...(player.action_bar || []), ...(player.paperdoll ? Object.values(player.paperdoll) : []), ...(player.backpack || [])];
      return allSlots.find(item => item && (item.item_id === itemId || (cardActionKey && (item.actionKey === cardActionKey || ITEMS_CATALOG[item.item_id]?.actionKey === cardActionKey))));
    };

    const chosenCards = [];
    for (const c of orderedPool) {
      if (chosenCards.length >= 5) break;
      const card = JSON.parse(JSON.stringify(c));
      const itemId = card.item?.item_id;
      const catalogEntry = ITEMS_CATALOG[itemId] || {};
      const existing = findExistingItem(itemId, card.item);

      if (existing) {
        const currentLevel = existing.itemLevel || 1;
        if (currentLevel >= rankCap) continue;

        card.isUpgrade = true;
        card.targetItemId = existing.item_id;
        card.targetItemLevel = currentLevel;

        const spec = catalogEntry.upgradeSpec;
        const prevRank = currentLevel;
        const nextRank = currentLevel + 1;

        if (spec) {
          const dmgInc = spec.randomDamageInc ? (Math.floor(Math.random() * (spec.randomDamageInc[1] - spec.randomDamageInc[0] + 1)) + spec.randomDamageInc[0]) : (spec.stepDamageInc || 0);
          if (dmgInc) card.upgradeDmgInc = dmgInc;

          const cooldownSec = Math.max(12, 22 - 2 * nextRank);
          card.name = `LEVEL UP: ${existing.name || card.name} (Rank ${nextRank})`;
          card.description = (spec.descriptionPattern || '')
            .replace('{prevRank}', prevRank)
            .replace('{nextRank}', nextRank)
            .replace('{dmgInc}', dmgInc)
            .replace('{cooldownSec}', cooldownSec);
          card.statBonusText = (spec.statBonusTextPattern || '')
            .replace('{dmgInc}', dmgInc)
            .replace('{nextRank}', nextRank)
            .replace('{cooldownSec}', cooldownSec);
        } else {
          card.name = `LEVEL UP: ${existing.name || card.name} (Rank ${nextRank})`;
          card.description = `Level Up ${existing.name || card.name} (Rank ${prevRank} ➔ ${nextRank}).`;
          card.statBonusText = `Rank ${nextRank}`;
        }
      } else {
        if (catalogEntry.damageMin && catalogEntry.damageMax && !card.item?.damage) {
          const rolledDmg = Math.floor(Math.random() * (catalogEntry.damageMax - catalogEntry.damageMin + 1)) + catalogEntry.damageMin;
          if (card.item) card.item.damage = rolledDmg;
          card.description = `${card.description} (${rolledDmg} Dmg)`;
        }
        if (card.item && !card.item.itemLevel) {
          card.item.itemLevel = 1;
        }
      }

      chosenCards.push(card);
    }

    // Rule guard: at game start (level 1) every vocation must be OFFERED at
    // least one main_hand card and one off_hand card so the player can always
    // attack and progress. This is an offer-only guarantee — nothing is
    // auto-equipped and selection is never forced. Level > 1 drafts are unchanged.
    if (level === 1) {
      FateGrantSystem.guaranteeLevelOneHandSlots(chosenCards, eligibleCards, vocation);
    }

    // Board rule: the player must select exactly 2 cards. If a
    // future catalog ever offered fewer than 2, fall back to requiring every
    // offered card so the draft cannot dead-end. The current 5-card offer
    // guarantee makes that fallback unreachable in practice.
    const requiredCount = Math.min(2, chosenCards.length);
    if (chosenCards.length < 2) {
      console.warn(`FateGrantSystem: only ${chosenCards.length} card(s) offered; requiring all.`);
    }

    return {
      cards: chosenCards,
      requiredSelections: { min: requiredCount, max: requiredCount },
    };
  }

  /**
   * Resolves the paperdoll slot for a card's item by falling back to the
   * items catalog entry. Cards embed no slot themselves.
   */
  static resolveCardSlot(card) {
    const itemId = card?.item?.item_id;
    if (!itemId) return null;
    return card.item?.slot || ITEMS_CATALOG[itemId]?.slot || null;
  }

  /**
   * Level-1 rule guard: ensures the offered draft contains at least one
   * main_hand and one off_hand card for the vocation. If a slot is missing,
   * a matching offer card is injected (preferring the vocation's own affinity
   * cards, then neutral). The injection only touches the OFFER — it never
   * equips anything and never forces a selection. If no catalog candidate
   * exists for a slot, nothing is invented (the gap is surfaced by the caller).
   */
  static guaranteeLevelOneHandSlots(offeredCards, eligibleCards, vocation) {
    const hasSlot = (slot) => offeredCards.some((c) => FateGrantSystem.resolveCardSlot(c) === slot);

    const injectForSlot = (slot) => {
      if (hasSlot(slot)) return;

      const candidates = eligibleCards.filter((c) => FateGrantSystem.resolveCardSlot(c) === slot);
      if (candidates.length === 0) return; // no catalog candidate — do not fabricate

      // Prefer the vocation's own affinity cards over neutral ones.
      const affinityScore = (card) => {
        const aff = card.vocationAffinity;
        if (!aff || aff === 'neutral') return 0;
        if (Array.isArray(aff)) return aff.includes(vocation) ? 2 : 1;
        return aff === vocation ? 2 : 1;
      };
      candidates.sort((a, b) => affinityScore(b) - affinityScore(a));

      const offerCard = JSON.parse(JSON.stringify(candidates[0]));
      if (offerCard.item && !offerCard.item.itemLevel) offerCard.item.itemLevel = 1;

      // Replace a non-hand-slot card so the draft stays a 5-card offer.
      const replaceIdx = offeredCards.findIndex((c) => {
        const s = FateGrantSystem.resolveCardSlot(c);
        return s !== 'main_hand' && s !== 'off_hand';
      });
      if (replaceIdx !== -1) {
        offeredCards[replaceIdx] = offerCard;
      } else {
        offeredCards.push(offerCard);
      }
    };

    injectForSlot('main_hand');
    injectForSlot('off_hand');
  }

  /**
   * Rarity display ordering used only as an auto-draft tie-breaker. Rarity is a
   * cosmetic label in `cards.json`; this rank never gates eligibility.
   */
  static AUTO_DRAFT_RARITY = Object.freeze({ common: 0, rare: 1, epic: 2, legendary: 3 });

  /**
   * Named auto-draft tie-breakers keyed by the catalog policy's `priority`
   * tokens (LIV-20 / FIX-5). Each returns a number where higher wins. A new
   * policy token needs a ranker here plus a `party_ai.json` entry.
   */
  static AUTO_DRAFT_RANKERS = {
    upgrade: (card) => (card && card.isUpgrade ? 1 : 0),
    main_hand: (card) => (FateGrantSystem.resolveCardSlot(card) === 'main_hand' ? 1 : 0),
    off_hand: (card) => (FateGrantSystem.resolveCardSlot(card) === 'off_hand' ? 1 : 0),
    affinity: (card, actor) => {
      const aff = card && card.vocationAffinity;
      if (!aff || aff === 'neutral') return 1;
      const vocation = actor && actor.vocation;
      if (Array.isArray(aff)) return aff.includes(vocation) ? 2 : 0;
      return aff === vocation ? 2 : 0;
    },
    rarity: (card) => FateGrantSystem.AUTO_DRAFT_RARITY[(card && card.rarity) || 'common'] || 0,
    // Earlier offer positions win; the negative index makes that a descending sort.
    offer_order: (card, actor, index) => -index,
  };

  /**
   * Deterministic, non-interactive draft selection used by auto allies. The
   * policy comes from `party_ai.json` → `autoFateGrant` (Game Designer, LIV-26);
   * `priority` is an ordered list of rule tokens applied as tie-breakers. An
   * unknown token is skipped and an empty policy falls back to offer order, so a
   * selection is always produced. Returns exactly the offer's required count
   * (clamped to what was offered).
   *
   * @param {{cards: object[], requiredSelections: {min:number, max:number}}} offer
   * @param {object} actor member-shaped object (its `vocation` drives affinity)
   * @param {{picks?: number, priority?: string[]}} [policy]
   * @returns {object[]}
   */
  static selectAutoDraft(offer, actor, policy = {}) {
    const cards = Array.isArray(offer && offer.cards) ? offer.cards : [];
    if (cards.length === 0) return [];

    const required = Math.max(1, Math.floor(Number(offer && offer.requiredSelections && offer.requiredSelections.min) || 1));
    const picks = Math.max(1, Math.floor(Number(policy.picks) || required));
    const count = Math.min(picks, required, cards.length);
    const priority = Array.isArray(policy.priority) && policy.priority.length ? policy.priority : ['offer_order'];

    const ranking = cards.map((card, index) => ({ card, index }));
    ranking.sort((a, b) => {
      for (const token of priority) {
        const ranker = FateGrantSystem.AUTO_DRAFT_RANKERS[token];
        if (!ranker) continue;
        const diff = ranker(b.card, actor, b.index) - ranker(a.card, actor, a.index);
        if (diff !== 0) return diff;
      }
      return a.index - b.index;
    });

    return ranking.slice(0, count).map((entry) => entry.card);
  }

  static applyDraftedCards(player, cards, gridMap, opts = {}) {
    const result = {
      addedToHotbar: [],
      addedToBackpack: [],
      droppedOnFloor: [],
    };

    for (const card of cards) {
      const targetItemId = card.targetItemId || card.item?.item_id;
      const catalogEntry = ITEMS_CATALOG[targetItemId] || {};

      const allSlots = [
        ...(player.action_bar ? player.action_bar.map((it, idx) => ({ it, container: 'action_bar', idx })) : []),
        ...(player.paperdoll ? Object.entries(player.paperdoll).map(([key, it]) => ({ it, container: 'paperdoll', key })) : []),
        ...(player.backpack ? player.backpack.map((it, idx) => ({ it, container: 'backpack', idx })) : []),
      ];

      const cardActionKey = card.item?.actionKey || catalogEntry?.actionKey;
      const existingSlot = allSlots.find(s => s.it && (s.it.item_id === targetItemId || (cardActionKey && (s.it.actionKey === cardActionKey || ITEMS_CATALOG[s.it.item_id]?.actionKey === cardActionKey))));

      if (existingSlot || card.isUpgrade) {
        const item = existingSlot ? existingSlot.it : null;
        if (item) {
          const upgrade = applyItemRankUp(player, item, {
            source: 'fate_grant',
            upgradeDmgInc: card.upgradeDmgInc,
            rankCapOwner: opts.rankCapOwner,
          });
          if (upgrade) {
            result.addedToHotbar.push(
              `${item.name} Upgraded to Rank ${upgrade.rank}${upgrade.notes.length ? ` (${upgrade.notes.join(', ')})` : ''}`
            );
            continue;
          }
        }
      }

      const itemToPlace = JSON.parse(JSON.stringify(card.item));
      if (!itemToPlace.itemLevel) itemToPlace.itemLevel = 1;

      // Roll fixed damage stats for items with random ranges when offered/drafted
      if (itemToPlace.item_id === 'apprentice_wand' && !itemToPlace.damage) {
        itemToPlace.damage = Math.floor(Math.random() * (16 - 12 + 1)) + 12;
      }

      // Merge functional catalog fields the card payload omits (LOK-12 Golden
      // gear relies on equipped instances carrying actionKey/cooldown/ammo/
      // absorb fields even when placed via card payloads that only carry the
      // cosmetic fields).
      const catalogItem = ITEMS_CATALOG[itemToPlace.item_id];
      const FUNCTIONAL_ITEM_KEYS = [
        'slot', 'damageMin', 'damageMax', 'range', 'cooldown', 'manaCost',
        'actionKey', 'arrowCapacity', 'arrowCount', 'ammoRegenSec',
        'pushbackRange', 'stunSec', 'shieldAbsorb', 'shieldDuration',
        'dodgePct', 'critChance', 'critMult', 'mitigationPct',
        'hpBonus', 'manaBonus', 'healPowerPct', 'grantedAmmo', 'upgradeSpec',
        // Archer primary-item abilities.
        'poisonDps', 'poisonDurationSec', 'poisonArrows', 'poisonBuffSec',
        'siphonHp', 'siphonRadius', 'rangedDamageBonus',
        'markDurationSec', 'markRange', 'markDamageMult',
        // Paladin relic Benediction restoration fields.
        'healMin', 'healMax', 'mpRestore',
      ];
      if (catalogItem) {
        for (const key of FUNCTIONAL_ITEM_KEYS) {
          if (itemToPlace[key] === undefined && catalogItem[key] !== undefined) {
            itemToPlace[key] = catalogItem[key];
          }
        }
      }

      // Stackable acquisitions (potion stashes, ammo) top up an
      // existing stack in the loadout or backpack before a new cell is opened.
      // `InventorySystem.addItem` owns that stack-first placement order; a full
      // inventory (`success: false`) falls through to the floor-drop fallback.
      if (InventorySystem.getMaxStack(itemToPlace.item_id) > 1) {
        const stackRes = InventorySystem.addItem(player, itemToPlace);
        if (stackRes.success) {
          const label = `${itemToPlace.name}${itemToPlace.quantity > 1 ? ` (x${itemToPlace.quantity})` : ''}`;
          const landsInHotbar = (player.action_bar || []).some(s => s && s.item_id === itemToPlace.item_id);
          (landsInHotbar ? result.addedToHotbar : result.addedToBackpack).push(label);
          continue;
        }
      }

      // Auto-assign staff to main_hand, wand to off_hand, armor to armor, or relic to relic slot if paperdoll slot is empty
      const targetSlot = itemToPlace.slot || catalogItem?.slot;
      if (!player.paperdoll) {
        player.paperdoll = { main_hand: null, off_hand: null, armor: null, relic: null };
      }

      if (targetSlot && (targetSlot === 'main_hand' || targetSlot === 'off_hand' || targetSlot === 'armor' || targetSlot === 'relic') && !player.paperdoll[targetSlot]) {
        player.paperdoll[targetSlot] = itemToPlace;
        // General equippable recompute: hpBonus/manaBonus now work on any slot
        // (replaces the amulet-only special case).
        InventorySystem.recomputeGearBonuses(player);
        result.addedToHotbar.push(`${itemToPlace.name} (Equipped to ${targetSlot.replace('_', ' ')})`);
        continue;
      }

      // 1. Try placing into lowest empty Action Slot (0..9)
      let placedInHotbar = false;
      if (player.action_bar) {
        for (let i = 0; i < player.action_bar.length; i++) {
          if (player.action_bar[i] === null) {
            player.action_bar[i] = itemToPlace;
            result.addedToHotbar.push(`${itemToPlace.name} (Slot ${i + 1})`);
            placedInHotbar = true;
            break;
          }
        }
      }

      // If drafting an item that grants starter ammo (e.g. bow), grant starter ammo if none exist
      const grantedAmmo = itemToPlace.grantedAmmo || ITEMS_CATALOG[itemToPlace.item_id]?.grantedAmmo;
      if (grantedAmmo) {
        const ammoId = grantedAmmo.item_id;
        const hasAmmo = player.action_bar?.some(s => s?.item_id === ammoId) || player.backpack?.some(s => s?.item_id === ammoId);
        if (!hasAmmo && player.backpack) {
          const ammoCatalogItem = ITEMS_CATALOG[ammoId] || {};
          const arrowItem = {
            item_id: ammoId,
            name: ammoCatalogItem.name || 'Arrows',
            type: ammoCatalogItem.type || 'ammo',
            quantity: grantedAmmo.quantity || 20,
            stat_bonus: ammoCatalogItem.stat_bonus || 0,
            icon: ammoCatalogItem.icon || '🏹',
          };
          const emptyBp = player.backpack.findIndex(s => s === null);
          if (emptyBp !== -1) {
            player.backpack[emptyBp] = arrowItem;
            result.addedToBackpack.push(`Starter Arrows (x${arrowItem.quantity})`);
          }
        }
      }

      if (placedInHotbar) continue;

      // 2. Try placing into lowest empty Backpack Slot (0..5)
      let placedInBackpack = false;
      if (player.backpack) {
        for (let i = 0; i < player.backpack.length; i++) {
          if (player.backpack[i] === null) {
            player.backpack[i] = itemToPlace;
            result.addedToBackpack.push(`${itemToPlace.name} (Backpack ${i + 1})`);
            placedInBackpack = true;
            break;
          }
        }
      }

      if (placedInBackpack) continue;

      // 3. Drop onto floor
      if (gridMap) {
        gridMap.addItem(player.x, player.y, itemToPlace);
        result.droppedOnFloor.push(itemToPlace.name);
      }
    }

    return result;
  }

  static shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}
