import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { renderTownPreview } from '../../tools/render-town-preview.mjs';
import { composeSceneById } from '../services/scene-composer.js';
import { DEFAULT_TOWN_ID } from '../data/index.js';

// LIV-102: the browser-free town preview renderer is a self-serve review aid
// (docs/engineering/agents.md §8). Lock its determinism and its data-driven
// sizing so it can never silently drop catalog content.

test('LIV-102 town preview renderer', async (t) => {
  await t.test('renders the default town at catalog size', () => {
    const { W, H, scene } = renderTownPreview(DEFAULT_TOWN_ID);
    const def = composeSceneById(DEFAULT_TOWN_ID);
    assert.equal(W, def.width * 64, 'width is tile count x 32px cell x 2x scale');
    assert.equal(H, def.height * 64, 'height matches');
    assert.equal(scene.npcs.length, def.npcs.length, 'every catalog NPC is rendered');
    assert.equal(scene.props.length, def.props.length, 'every catalog prop is rendered');
    assert.equal(scene.buildings.length, def.buildings.length, 'every catalog building is rendered');
  });

  await t.test('render is byte-stable across runs', () => {
    const a = renderTownPreview(DEFAULT_TOWN_ID);
    const b = renderTownPreview(DEFAULT_TOWN_ID);
    const ha = createHash('sha256').update(a.buf).digest('hex');
    const hb = createHash('sha256').update(b.buf).digest('hex');
    assert.equal(ha, hb, 'same catalog input must yield the same pixels');
  });

  await t.test('unknown scene ids throw instead of rendering a blank', () => {
    assert.throws(() => renderTownPreview('scene_that_does_not_exist'), /unknown scene/);
  });
});
