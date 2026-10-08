/**
 * Lokarta: Come Into The Light - Dialogue Beat & Speech-Bubble Geometry
 *
 * Pure, DOM-free helpers for the NPC dialogue presentation (LIV-67):
 *   - which keys advance a dialogue beat (catalog-driven, with a sane default),
 *   - how a beat index steps (data in, data out), and
 *   - where to place the speech bubble so it anchors above the speaking NPC,
 *     flips below when the speaker is near the top edge, and clamps on-screen.
 *
 * Keeping the math here (not in the DOM layer) is what makes it testable under
 * `node --test` with zero dependencies. See `modal-manager.js` for the renderer
 * that consumes these.
 */

/**
 * Default keyboard keys that advance a dialogue beat. `e.key` for Enter/Space/
 * arrows and `e.code` for KeyE/hold keys; the consumer checks both fields.
 * Overridable from `dialogues.json.ui.advanceKeys`.
 */
export const DEFAULT_DIALOGUE_ADVANCE_KEYS = Object.freeze([
  'Enter',
  ' ',
  'Space',
  'KeyE',
  'ArrowRight',
  'ArrowDown',
  'ArrowLeft',
  'ArrowUp',
]);

/**
 * Resolves the catalog's `advanceKeys` list, falling back to the default.
 * @param {object} [ui] - `dialogues.json.ui`
 * @returns {string[]} a fresh, non-empty array of key names
 */
export function resolveDialogueAdvanceKeys(ui = {}) {
  const configured = Array.isArray(ui && ui.advanceKeys)
    ? ui.advanceKeys.filter((key) => typeof key === 'string' && key.length > 0)
    : [];
  return configured.length ? configured.slice() : DEFAULT_DIALOGUE_ADVANCE_KEYS.slice();
}

/**
 * True when an event's `key` or `code` is one of the advance keys.
 * @param {string} key - `KeyboardEvent.key`
 * @param {string[]} [keys]
 * @param {string} [code] - `KeyboardEvent.code`
 */
export function isDialogueAdvanceKey(key, keys = DEFAULT_DIALOGUE_ADVANCE_KEYS, code = '') {
  if (typeof key !== 'string') return false;
  return keys.includes(key) || (typeof code === 'string' && keys.includes(code));
}

/**
 * Steps a beat cursor forward by one, clamping at the end. Pure: callers own
 * the stored index. `advanced` is false once the final beat is showing.
 * @param {number} index
 * @param {number} count
 * @returns {{ index: number, advanced: boolean, atEnd: boolean }}
 */
export function nextDialogueBeat(index, count) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const last = Math.max(0, total - 1);
  const current = Math.min(Math.max(Math.floor(Number(index) || 0), 0), last);
  const atEnd = current >= last;
  return { index: atEnd ? last : current + 1, advanced: !atEnd, atEnd };
}

const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 14;
const DEFAULT_ARROW_INSET = 18;

/**
 * Places a clamped speech bubble relative to a speaker's screen-space anchor.
 *
 * The bubble prefers sitting fully above the speaker. When there is not enough
 * room above (speaker near the top edge) it flips below. In both cases the panel
 * is clamped inside the viewport and reports the arrow `x` so the tail keeps
 * pointing at the speaker.
 *
 * @param {{x:number, top:number, bottom:number}} anchor - viewport coords; `x`
 *   is the speaker's horizontal center, `top`/`bottom` its tile edges.
 * @param {{width:number, height:number}} viewport
 * @param {{width?:number, height?:number}} bubble - measured panel size
 * @param {{margin?:number, gap?:number}} [options]
 * @returns {{placement:'above'|'below', top:number, left:number, width:number, maxWidth:number, arrowX:number}}
 */
export function computeDialogueBubblePosition(anchor, viewport, bubble = {}, options = {}) {
  const margin = Number.isFinite(options.margin) ? Math.max(0, options.margin) : DEFAULT_MARGIN;
  const gap = Number.isFinite(options.gap) ? Math.max(0, options.gap) : DEFAULT_GAP;

  const vw = Math.max(0, Number(viewport && viewport.width) || 0);
  const vh = Math.max(0, Number(viewport && viewport.height) || 0);

  const maxWidth = Math.max(1, vw - margin * 2);
  const requestedWidth = Math.max(0, Number(bubble.width) || 0);
  const width = Math.min(requestedWidth || maxWidth, maxWidth);
  const height = Math.max(0, Number(bubble.height) || 0);

  const anchorX = Number(anchor && anchor.x) || 0;
  const anchorTop = Number(anchor && anchor.top) || 0;
  const anchorBottom = Number.isFinite(anchor && anchor.bottom) ? Number(anchor.bottom) : anchorTop;

  // Prefer above the speaker; flip below when the bubble would clip the top.
  let placement = 'above';
  let top = anchorTop - gap - height;
  if (top < margin) {
    placement = 'below';
    top = anchorBottom + gap;
  }
  const maxTop = Math.max(margin, vh - margin - height);
  top = Math.min(Math.max(top, margin), maxTop);

  const maxLeft = Math.max(margin, vw - margin - width);
  const left = Math.min(Math.max(anchorX - width / 2, margin), maxLeft);

  const arrowX = Math.min(
    Math.max(anchorX - left, DEFAULT_ARROW_INSET),
    Math.max(DEFAULT_ARROW_INSET, width - DEFAULT_ARROW_INSET)
  );

  return { placement, top, left, width, maxWidth, arrowX };
}
