/**
 * Lokarta: Prop / Tile Art Barrel (keys, chests, gated doors)
 *
 * Same authored-indexed-pixel pipeline as actor sprites (see
 * docs/art-direction.md and docs/art-direction-tower.md), kept in a separate
 * catalog so it does not participate in the actor animation contract.
 *
 * `PROP_CATALOG[id].frames` is a flat frame map (`icon`, `closed`, `open`).
 * `PROP_MANIFEST[id]` carries kind/tier/native/anchor/frame names.
 */

import manifest from './manifest.json' with { type: 'json' };
import keyCopper from './items/key_copper.json' with { type: 'json' };
import keySilver from './items/key_silver.json' with { type: 'json' };
import keyGold from './items/key_gold.json' with { type: 'json' };
import chestCopper from './items/chest_copper.json' with { type: 'json' };
import chestSilver from './items/chest_silver.json' with { type: 'json' };
import chestGold from './items/chest_gold.json' with { type: 'json' };
import doorCopper from './tiles/gated_door_copper.json' with { type: 'json' };
import doorSilver from './tiles/gated_door_silver.json' with { type: 'json' };
import doorGold from './tiles/gated_door_gold.json' with { type: 'json' };
import propTable from './props/prop_table.json' with { type: 'json' };
import propCrate from './props/prop_crate.json' with { type: 'json' };
import propBarrel from './props/prop_barrel.json' with { type: 'json' };
import propBrazier from './props/prop_brazier.json' with { type: 'json' };
import propCandelabra from './props/prop_candelabra.json' with { type: 'json' };
import propBookshelf from './props/prop_bookshelf.json' with { type: 'json' };
import propSarcophagus from './props/prop_sarcophagus.json' with { type: 'json' };
import propAltar from './props/prop_altar.json' with { type: 'json' };
import propThrone from './props/prop_throne.json' with { type: 'json' };
import decorRug from './decor/decor_rug.json' with { type: 'json' };

export const PROP_MANIFEST = manifest.props;

export const PROP_CATALOG = {
  key_copper: keyCopper,
  key_silver: keySilver,
  key_gold: keyGold,
  chest_copper: chestCopper,
  chest_silver: chestSilver,
  chest_gold: chestGold,
  gated_door_copper: doorCopper,
  gated_door_silver: doorSilver,
  gated_door_gold: doorGold,
  // D4 room furniture + floor decor. Flat `idle` frame map, same
  // authored-indexed-pixel pipeline; placement is data-driven (tile_themes.props).
  prop_table: propTable,
  prop_crate: propCrate,
  prop_barrel: propBarrel,
  prop_brazier: propBrazier,
  prop_candelabra: propCandelabra,
  prop_bookshelf: propBookshelf,
  prop_sarcophagus: propSarcophagus,
  prop_altar: propAltar,
  prop_throne: propThrone,
  decor_rug: decorRug,
};

/** Furniture/decor ids grouped by `kind`, for data-driven placement lookups. */
export const PROP_IDS_BY_KIND = {
  prop: ['prop_table', 'prop_crate', 'prop_barrel', 'prop_brazier', 'prop_candelabra', 'prop_bookshelf', 'prop_sarcophagus', 'prop_altar', 'prop_throne'],
  decor: ['decor_rug'],
};

/** Tier -> prop id, for data-driven key/chest/door resolution. */
export const PROP_IDS_BY_TIER = {
  copper: { key: 'key_copper', chest: 'chest_copper', door: 'gated_door_copper' },
  silver: { key: 'key_silver', chest: 'chest_silver', door: 'gated_door_silver' },
  gold: { key: 'key_gold', chest: 'chest_gold', door: 'gated_door_gold' },
};
