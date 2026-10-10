import test from 'node:test';
import assert from 'node:assert/strict';

import { NPCS_CATALOG, DIALOGUES_CATALOG } from '../data/index.js';

// LIV-81: NPC identity surfaces — distinct 32x32 sprite ids, a complete
// expression->portrait map, resolvable per-stage expressions, and the
// personality hook. Pure data contract; engine/atlas resolution is the Tech
// Lead child (LIV-91).
const EXPRESSIONS = ['neutral', 'warm', 'urgent'];

test('LIV-81 NPC identity surfaces', async (t) => {
  await t.test('every NPC declares a unique own-sprite id and keeps the identity fallbacks', () => {
    const spriteIds = new Set();
    for (const npc of NPCS_CATALOG.npcs) {
      assert.equal(typeof npc.npcSpriteId, 'string', `${npc.id} must declare npcSpriteId`);
      assert.ok(npc.npcSpriteId.length > 0, `${npc.id} npcSpriteId must be non-empty`);
      assert.ok(npc.npcSpriteId.startsWith('npc_'), `${npc.id} npcSpriteId must be an npc_ asset id`);
      assert.ok(!spriteIds.has(npc.npcSpriteId), `${npc.npcSpriteId} must be unique`);
      spriteIds.add(npc.npcSpriteId);
      // Migration fallbacks must remain until every sprite/portrait lands.
      assert.ok(npc.spriteId, `${npc.id} must keep spriteId as the migration fallback`);
      // LIV-144: tinting is not a valid way to diversify town NPCs, so
      // `renderTheme` is no longer a required fallback (inert if still present).
      assert.ok(npc.svgCode && npc.portraitEmoji, `${npc.id} must keep the emoji fallback`);
    }
  });

  await t.test('every NPC carries a complete, unique portrait expression map', () => {
    const portraitIds = new Set();
    for (const npc of NPCS_CATALOG.npcs) {
      assert.ok(npc.portraits && typeof npc.portraits === 'object', `${npc.id} must declare portraits`);
      assert.deepEqual(Object.keys(npc.portraits).sort(), [...EXPRESSIONS].sort(), `${npc.id} portraits keys`);
      for (const expr of EXPRESSIONS) {
        assert.equal(typeof npc.portraits[expr], 'string', `${npc.id}.portraits.${expr}`);
        assert.ok(npc.portraits[expr].length > 0, `${npc.id}.portraits.${expr} must be non-empty`);
        assert.ok(!portraitIds.has(npc.portraits[expr]), `${npc.portraits[expr]} must be unique`);
        portraitIds.add(npc.portraits[expr]);
      }
    }
  });

  await t.test('stage expressions are valid and every NPC dialogue resolves one', () => {
    const dialogues = DIALOGUES_CATALOG.dialogues;
    for (const [id, def] of Object.entries(dialogues)) {
      for (const stage of def.stages || []) {
        if (stage.expression == null) continue;
        assert.ok(EXPRESSIONS.includes(stage.expression), `${id}/${stage.id} has invalid expression "${stage.expression}"`);
      }
      if (!def.npcId) continue;
      const owner = NPCS_CATALOG.npcs.find((npc) => npc.id === def.npcId);
      assert.ok(owner, `${id} references unknown npcId ${def.npcId}`);
      const fallback = (def.stages || []).find((stage) => stage.id === def.fallback);
      assert.ok(fallback, `${id} fallback stage must resolve`);
      assert.ok(EXPRESSIONS.includes(fallback.expression), `${id} fallback stage must declare a resolvable expression`);
      assert.ok(owner.portraits[fallback.expression], `${id} fallback expression must exist in ${owner.id}.portraits`);
    }
  });

  await t.test('every NPC authors idle quips and a night schedule line', () => {
    const ambience = DIALOGUES_CATALOG.ambience;
    assert.ok(ambience && ambience.npcs, 'DIALOGUES_CATALOG.ambience.npcs must exist');
    for (const npc of NPCS_CATALOG.npcs) {
      const entry = ambience.npcs[npc.id];
      assert.ok(entry, `${npc.id} must author an ambience entry`);
      assert.ok(Array.isArray(entry.quips) && entry.quips.length >= 1 && entry.quips.length <= 2, `${npc.id} needs 1-2 quips`);
      for (const quip of entry.quips) assert.ok(typeof quip === 'string' && quip.length > 0, `${npc.id} quip must be non-empty`);
      assert.ok(typeof entry.scheduleLines?.night === 'string' && entry.scheduleLines.night.length > 0, `${npc.id} needs a night schedule line`);
    }
  });
});
