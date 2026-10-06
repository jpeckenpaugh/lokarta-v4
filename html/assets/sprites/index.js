/**
 * Lokarta: Sprite Asset Barrel
 *
 * Art data lives beside the JSON catalogs so the renderer can pre-render and
 * blit authored pixel matrices. This module has no runtime side effects: it is
 * pure data, imported with native JSON import attributes (no bundler).
 *
 * Source of truth: `html/assets/sprites/**` (see docs/art-direction.md).
 */

import manifest from './manifest.json' with { type: 'json' };
import magician from './vocations/magician.json' with { type: 'json' };
import archer from './vocations/archer.json' with { type: 'json' };
import fighter from './vocations/fighter.json' with { type: 'json' };
import paladin from './vocations/paladin.json' with { type: 'json' };
import giantRat from './monsters/giant_rat.json' with { type: 'json' };
import cryptSkeleton from './monsters/crypt_skeleton.json' with { type: 'json' };
import shadowCultist from './monsters/shadow_cultist.json' with { type: 'json' };
import eliteCultist from './monsters/elite_cultist.json' with { type: 'json' };
import abyssalOverlord from './monsters/abyssal_overlord.json' with { type: 'json' };

export const SPRITE_MANIFEST = manifest;

export const SPRITE_CATALOG = {
  magician,
  archer,
  fighter,
  paladin,
  giant_rat: giantRat,
  crypt_skeleton: cryptSkeleton,
  shadow_cultist: shadowCultist,
  elite_cultist: eliteCultist,
  abyssal_overlord: abyssalOverlord,
};

// Prop/tile art (keys, chests, gated doors) lives in a separate catalog so it
// does not participate in the actor animation contract. See props.js.
export { PROP_CATALOG, PROP_MANIFEST, PROP_IDS_BY_TIER, PROP_IDS_BY_KIND } from './props.js';
