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
import riverPiranha from './monsters/river_piranha.json' with { type: 'json' };
import riverEel from './monsters/river_eel.json' with { type: 'json' };
import riverRat from './monsters/river_rat.json' with { type: 'json' };
import npcElderRowanVane from './npc/npc_elder_rowan_vane.json' with { type: 'json' };
import npcCaptainHalden from './npc/npc_captain_halden.json' with { type: 'json' };
import npcWick from './npc/npc_wick.json' with { type: 'json' };
import npcMara from './npc/npc_mara.json' with { type: 'json' };
import npcPilgrimsApprenticeTam from './npc/npc_pilgrims_apprentice_tam.json' with { type: 'json' };
import npcChildKes from './npc/npc_child_kes.json' with { type: 'json' };
import buildingFishingHut from './buildings/fishing_hut.json' with { type: 'json' };
import buildingFishingHutBack from './buildings/fishing_hut_back.json' with { type: 'json' };
import buildingFishingHutRight from './buildings/fishing_hut_right.json' with { type: 'json' };
import buildingFishingHutLeft from './buildings/fishing_hut_left.json' with { type: 'json' };
import buildingFishingHutLarge from './buildings/fishing_hut_large.json' with { type: 'json' };
import buildingLonghouse from './buildings/longhouse.json' with { type: 'json' };
import buildingFishersHouse from './buildings/fishers_house.json' with { type: 'json' };
import buildingFishersHouseLarge from './buildings/fishers_house_large.json' with { type: 'json' };

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
  river_piranha: riverPiranha,
  river_eel: riverEel,
  river_rat: riverRat,
  npc_elder_rowan_vane: npcElderRowanVane,
  npc_captain_halden: npcCaptainHalden,
  npc_wick: npcWick,
  npc_mara: npcMara,
  npc_pilgrims_apprentice_tam: npcPilgrimsApprenticeTam,
  npc_child_kes: npcChildKes,
};

// Prop/tile art (keys, chests, gated doors) lives in a separate catalog so it
// does not participate in the actor animation contract. See props.js.
export { PROP_CATALOG, PROP_MANIFEST, PROP_IDS_BY_TIER, PROP_IDS_BY_KIND } from './props.js';

// Tier B (LIV-109) multi-tile building sprites, keyed by the `silhouette` value
// a town building declares. Blitted through the existing footprint path
// (renderBuildingSilhouettes) — no separate placement model or actor animation.
export const BUILDING_CATALOG = {
  fishing_hut: buildingFishingHut,
  fishing_hut_back: buildingFishingHutBack,
  fishing_hut_right: buildingFishingHutRight,
  fishing_hut_left: buildingFishingHutLeft,
  fishing_hut_large: buildingFishingHutLarge,
  // LIV-113 fisher assets: the central longhouse landmark + two fishers-house
  // size variants, all baked Tier B from the provided GLBs. Same footprint path.
  longhouse: buildingLonghouse,
  fishers_house: buildingFishersHouse,
  fishers_house_large: buildingFishersHouseLarge,
};
