/**
 * Lokarta: Portrait Asset Barrel (LIV-81/LIV-91)
 *
 * The portrait sheet is a single authored catalog keyed by the asset ids the
 * NPC `portraits` maps point at (`portrait_<npcId>_<expression>`). Each entry is
 * a 48x48 bust with one frame per expression. Pure data: imported with native
 * JSON import attributes, no bundler, no runtime side effects.
 *
 * Source of truth: `docs/design/npc-identity-spec.md` §3 and
 * `tools/author-npc-assets.mjs`.
 */

import portraitsData from './portraits.json' with { type: 'json' };

export const PORTRAIT_MANIFEST = portraitsData;

export const PORTRAIT_CATALOG = portraitsData.portraits;
