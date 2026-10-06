# Lokarta: Art Direction Specification

Authoritative 16-bit SNES-inspired pixel art direction and rendering contract for *Lokarta: Come Into The Light*.

---

## 1. Resolution & Coordinate Space

* **Native Sprite Canvas:** $32 \times 32\text{ px}$ for actors, player vocations, regular monsters, props, and tiles.
* **Boss Canvas:** $48 \times 48\text{ px}$ for The Spire Warden (`abyssal_overlord`), bottom-aligned with horizontal centering.
* **Display Tile Grid:** Scaled by integer scaling factor `SCALE = CONFIG.GRID_SIZE / 32` ($\times 2$ at $64\text{ px}$ tiles).
* **Rendering Style:** `image-rendering: pixelated; crisp-edges`. No anti-aliasing or sub-pixel coordinate offsets.

---

## 2. Facing & Animation Models

* **3-Direction Facing:** Sprites are authored for three directions (`down`, `up`, `side`). `left` is rendered by mirroring `side` horizontally.
* **Frame Sets per Actor:**
  * `idle`: 3 directions (1 frame each)
  * `walk`: 3 directions (2 frames each, step-driven)
  * `attack`: 3 directions (3 frames each)
  * `hit`: 3 directions (1 frame each)
  * `death`: 4 frames (`death_0`..`death_3`) non-directional (Boss `abyssal_overlord` has 6 frames: `death_0`..`death_5`).
* **Outline & Shading:** Standard $1\text{ px}$ silhouette outline (`#0b0d12`) with $\le 16$-color indexed palettes and flat pixel ramps.

---

## 3. Contrast & Visibility Rule

To guarantee visibility in dark dungeon environments:
* Every actor and monster must maintain a **$\ge 3:1$ WCAG contrast ratio** rim color against the floor background (`tile_themes.floor.fill`, luminance $\le 0.02$).
* Layer render order in `CanvasRenderer` draws tile decor and chests under the light mask, while actors, player VFX, and projectiles are rendered above the light mask to keep silhouettes distinct.

---

## 4. Tile Themes & Decor Props

* **Tile Themes:** Authored per level in `html/data/tile_themes.json` (*The Gatehouse, The Hall of Banners, The Bell Keep, The Solar Gallery, The Crown Spire*), mapped to tier IDs (`crypt`, `catacombs`, `shadow_vaults`, `abyssal_sanctum`, `crown_spire`).
* **Room Decor & Props:** Authored in `html/data/tower_levels.json` (`propPolicy`):
  * Furniture & decor: `throne`, `altar`, `sarcophagus`, `candelabra`, `bookshelf`, `brazier`, `table`, `crate`, `barrel`, `rug`.
  * Braziers emit dynamic ambient light (`brazierLightRadius: 2.5`, max 2 per room).
* **Preview PNGs:** Committed export previews reside in `docs/art/preview/` and are drift-checked by `html/tests/sprite-assets.test.mjs`.
