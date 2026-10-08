/**
 * LIV-84 (I10) — Bestiary codex, onboarding, and accessibility pass.
 *
 * Covers the pure, browser-free surfaces added by I10:
 *   - `codex.json` references foes by id (no duplicated stats) and every foe is
 *     catalogued;
 *   - the codex resolver + discovery model (`codex-system.js`) records a first
 *     defeat idempotently on the save envelope, and only ever lists discovered
 *     foes (spoiler-safe);
 *   - the accessibility resolvers (`accessibility.js`) remap every authored
 *     telegraph colour under a colour-blind mode and resolve the dialogue text
 *     scale;
 *   - the onboarding model (`onboarding-system.js`) fires each prompt once;
 *   - `keybindings.json` declares every remappable action.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MONSTERS_CATALOG,
  CODEX_CATALOG,
  UI_CATALOG,
  KEYBINDINGS_CATALOG,
} from '../data/index.js';
import {
  getCodexEntry,
  listCodexEntries,
  listDiscoveredCodexEntries,
  codexProgress,
  codexEntryCount,
  normalizeDiscoveredFoeIds,
  recordFoeDiscovery,
  isFoeDiscovered,
  resolveCodexRole,
  resolveCodexTier,
} from '../engine/codex-system.js';
import {
  listColorBlindModes,
  isValidColorBlindMode,
  resolveTelegraphColor,
  resolveTelegraphPalette,
  listDialogueTextScales,
  resolveDialogueScale,
  isValidDialogueScale,
} from '../engine/accessibility.js';
import {
  listOnboardingPrompts,
  normalizeSeenPromptIds,
  nextOnboardingPrompt,
  markOnboardingSeen,
  hasSeenPrompt,
  isOnboardingEnabled,
} from '../engine/onboarding-system.js';
import { createPartyPlayer, migratePlayerParty } from '../engine/party.js';

/** Every telegraph colour authored anywhere in monsters.json. */
function authoredTelegraphColors() {
  const colors = new Set();
  for (const monster of Object.values(MONSTERS_CATALOG)) {
    for (const atk of Array.isArray(monster.attacks) ? monster.attacks : []) {
      if (atk.telegraphColor) colors.add(atk.telegraphColor);
      if (atk.projectile && atk.projectile.color) colors.add(atk.projectile.color);
    }
  }
  return [...colors];
}

test('LIV-84 I10 codex, onboarding & accessibility', async (t) => {
  await t.test('codex.json references foes by id and duplicates no stats', () => {
    assert.ok(CODEX_CATALOG && typeof CODEX_CATALOG === 'object');
    assert.equal(CODEX_CATALOG.schemaVersion, 1);
    assert.ok(CODEX_CATALOG.roles && CODEX_CATALOG.roles.chaser);
    assert.ok(CODEX_CATALOG.roles.unknown, 'a safe role fallback must exist');
    assert.ok(CODEX_CATALOG.tiers && CODEX_CATALOG.tiers.normal);

    const statKeys = ['baseHp', 'baseAttack', 'baseDefense', 'damageMin', 'damageMax', 'lootTable', 'svgCode', 'attacks'];
    for (const [id, entry] of Object.entries(CODEX_CATALOG.entries)) {
      assert.ok(MONSTERS_CATALOG[id], `codex entry ${id} references an unknown monster`);
      assert.ok(CODEX_CATALOG.roles[entry.role], `${id} has an unknown role ${entry.role}`);
      assert.ok(CODEX_CATALOG.tiers[entry.tier], `${id} has an unknown tier ${entry.tier}`);
      assert.ok(typeof entry.telegraph === 'string' && entry.telegraph.length > 0, `${id} needs telegraph copy`);
      assert.ok(typeof entry.silhouette === 'string' && entry.silhouette.length > 0, `${id} needs silhouette copy`);
      for (const stat of statKeys) {
        assert.equal(entry[stat], undefined, `codex entry ${id} must not duplicate monster stat ${stat}`);
      }
    }
    // Every authored monster must be catalogued (the codex denominator is complete).
    for (const id of Object.keys(MONSTERS_CATALOG)) {
      assert.ok(CODEX_CATALOG.entries[id], `monster ${id} is missing a codex entry`);
    }
  });

  await t.test('codex resolver reads name/sprite from monsters.json, not codex.json', () => {
    const entry = getCodexEntry('giant_rat');
    assert.equal(entry.name, MONSTERS_CATALOG.giant_rat.name);
    assert.equal(entry.icon, MONSTERS_CATALOG.giant_rat.svgCode);
    assert.equal(entry.role, 'chaser');
    assert.ok(entry.roleName);
    assert.equal(getCodexEntry('does_not_exist'), null);

    const all = listCodexEntries();
    assert.equal(all.length, codexEntryCount());
    assert.equal(all.length, Object.keys(MONSTERS_CATALOG).length);
  });

  await t.test('unknown role/tier resolve through a safe fallback', () => {
    assert.equal(resolveCodexRole('nonsense').key, 'unknown');
    assert.equal(resolveCodexRole(null).name, CODEX_CATALOG.roles.unknown.name);
    assert.equal(resolveCodexTier('nonsense').key, 'normal');
  });

  await t.test('discovery records a first defeat once and never lists undiscovered foes', () => {
    const player = createPartyPlayer('magician');
    assert.deepEqual(player.discoveredFoeIds, []);
    assert.equal(isFoeDiscovered(player, 'giant_rat'), false);

    const first = recordFoeDiscovery(player, 'giant_rat');
    assert.equal(first.isNew, true);
    assert.notEqual(first.player, player, 'a new discovery returns a new envelope');
    assert.deepEqual(first.player.discoveredFoeIds, ['giant_rat']);

    const again = recordFoeDiscovery(first.player, 'giant_rat');
    assert.equal(again.isNew, false);
    assert.equal(again.player, first.player, 'an already-known foe is a reference no-op');

    // Unknown ids never record.
    const bogus = recordFoeDiscovery(first.player, 'not_a_monster');
    assert.equal(bogus.isNew, false);
    assert.equal(bogus.player, first.player);

    // Only discovered foes are listed (no spoilers), and progress is real.
    const listed = listDiscoveredCodexEntries(first.player);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'giant_rat');
    assert.deepEqual(codexProgress(first.player), { discovered: 1, total: codexEntryCount() });
    assert.equal(listDiscoveredCodexEntries(null).length, 0);
  });

  await t.test('discoveredFoeIds normalize to catalog order and drop junk', () => {
    const raw = ['gutter_king', 'giant_rat', 'giant_rat', 'bogus', 42, null];
    const clean = normalizeDiscoveredFoeIds(raw);
    assert.deepEqual(clean, ['giant_rat', 'gutter_king']);
    // Already-clean arrays keep their reference (identity no-op for migrations).
    assert.equal(normalizeDiscoveredFoeIds(clean), clean);
  });

  await t.test('the player envelope carries discovery + onboarding state idempotently', () => {
    const fresh = createPartyPlayer('magician');
    assert.ok(Array.isArray(fresh.discoveredFoeIds));
    assert.ok(Array.isArray(fresh.onboardingSeenIds));
    // migratePlayerParty must be a reference no-op once normalized.
    assert.equal(migratePlayerParty(fresh), fresh);
  });

  await t.test('every authored telegraph colour has a colour-blind-safe mapping', () => {
    const modes = listColorBlindModes().map((m) => m.value).filter((v) => v !== 'none');
    assert.ok(modes.length >= 3, 'at least three colour-blind modes');
    const colors = authoredTelegraphColors();
    assert.ok(colors.length > 0, 'monsters author telegraph colours');
    for (const mode of modes) {
      assert.ok(isValidColorBlindMode(mode));
      const palette = resolveTelegraphPalette(mode);
      for (const color of colors) {
        assert.ok(palette[color], `mode ${mode} is missing a mapping for ${color}`);
        assert.equal(resolveTelegraphColor(color, mode), palette[color]);
      }
    }
  });

  await t.test('colour-blind resolution is identity when off or unknown', () => {
    assert.equal(resolveTelegraphColor('#ef4444', 'none'), '#ef4444');
    assert.equal(resolveTelegraphColor('#ef4444', 'nonsense'), '#ef4444');
    assert.equal(resolveTelegraphColor('#123456', 'deuteranopia'), '#123456', 'unmapped colours pass through');
    assert.equal(isValidColorBlindMode('deuteranopia'), true);
    assert.equal(isValidColorBlindMode('rainbow'), false);
  });

  await t.test('dialogue text scale resolves from the option ranges', () => {
    const scales = listDialogueTextScales().map((s) => s.value);
    assert.deepEqual(scales, ['normal', 'large', 'xlarge']);
    assert.equal(resolveDialogueScale('normal'), 1);
    assert.ok(resolveDialogueScale('large') > 1);
    assert.ok(resolveDialogueScale('xlarge') > resolveDialogueScale('large'));
    assert.equal(resolveDialogueScale('nonsense'), 1);
    assert.equal(isValidDialogueScale('large'), true);
    assert.equal(isValidDialogueScale('huge'), false);
  });

  await t.test('ui.json options expose the accessibility defaults + ranges', () => {
    assert.equal(UI_CATALOG.options.defaults.colorBlindMode, 'none');
    assert.equal(UI_CATALOG.options.defaults.dialogueTextScale, 'normal');
    assert.ok(UI_CATALOG.options.ranges.colorBlindMode.deuteranopia !== undefined);
    assert.equal(UI_CATALOG.options.ranges.dialogueTextScale.large, 1.25);
    assert.ok(UI_CATALOG.accessibility.telegraphPalettes.deuteranopia);
    assert.ok(UI_CATALOG.codex.title);
    assert.equal(UI_CATALOG.onboarding.enabled, true);
  });

  await t.test('onboarding prompts fire once per save and are catalog-valid', () => {
    assert.equal(isOnboardingEnabled(), true);
    const prompts = listOnboardingPrompts();
    assert.ok(prompts.length >= 3, 'a handful of first-minutes prompts');
    for (const p of prompts) {
      assert.ok(p.title && p.body, `${p.id} needs title + body copy`);
      assert.ok(Number(p.durationMs) > 0, `${p.id} needs a display duration`);
    }

    const player = createPartyPlayer('magician');
    const welcome = nextOnboardingPrompt(player, 'game_start');
    assert.ok(welcome, 'the welcome prompt fires on game start');
    assert.equal(nextOnboardingPrompt(player, 'no_such_trigger'), null);

    const marked = markOnboardingSeen(player, welcome.id);
    assert.equal(marked.isNew, true);
    assert.equal(hasSeenPrompt(marked.player, welcome.id), true);
    assert.equal(nextOnboardingPrompt(marked.player, 'game_start'), null, 'a seen prompt never fires again');

    const again = markOnboardingSeen(marked.player, welcome.id);
    assert.equal(again.isNew, false);
    assert.equal(again.player, marked.player, 'marking again is a reference no-op');
  });

  await t.test('keybindings.json declares every remappable action', () => {
    for (const key of ['movement', 'party', 'interact', 'pause', 'codex', 'confirm', 'cancel']) {
      assert.ok(KEYBINDINGS_CATALOG[key], `keybindings.${key} is required for a complete remap`);
    }
    assert.ok(Array.isArray(KEYBINDINGS_CATALOG.pause) && KEYBINDINGS_CATALOG.pause.includes('Escape'));
    assert.ok(Array.isArray(KEYBINDINGS_CATALOG.codex) && KEYBINDINGS_CATALOG.codex.length > 0);
    assert.ok(Array.isArray(KEYBINDINGS_CATALOG.movement.up));
  });
});
