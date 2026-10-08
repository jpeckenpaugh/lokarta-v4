/**
 * Lokarta: Come Into The Light - Accessibility Model (I10)
 *
 * Pure, browser-free resolvers for the accessibility options added by I10:
 *   - colour-blind telegraph palettes (so threat colour is never the *only*
 *     channel, the telegraph renderer also pulses and outlines its zone),
 *   - the larger-dialogue-text scale, and
 *   - the list of modes/scales the options UI renders.
 *
 * All tokens live in `ui.json.accessibility` / `ui.json.options`; nothing here
 * hardcodes a palette. Unknown inputs always fall back to the neutral default,
 * so a bad option value can never break rendering.
 */

import { UI_CATALOG } from '../data/index.js';

const A11Y = (UI_CATALOG && UI_CATALOG.accessibility) || {};
const OPTION_RANGES = (UI_CATALOG && UI_CATALOG.options && UI_CATALOG.options.ranges) || {};

export const DEFAULT_COLOR_BLIND_MODE = 'none';
export const DEFAULT_DIALOGUE_TEXT_SCALE = 'normal';

/** Resolved `{ value, label }` descriptors for the colour-blind selector. */
export function listColorBlindModes() {
  const modes = Array.isArray(A11Y.colorBlindModes) ? A11Y.colorBlindModes : [];
  const clean = modes.filter((m) => m && typeof m.value === 'string');
  return clean.length ? clean.map((m) => ({ value: m.value, label: m.label || m.value })) : [{ value: 'none', label: 'Off' }];
}

/** True when `mode` is an authored colour-blind mode. */
export function isValidColorBlindMode(mode) {
  return typeof mode === 'string' && listColorBlindModes().some((m) => m.value === mode);
}

/**
 * The authored source-colour -> replacement-colour map for a mode, or an empty
 * object for `none`/unknown modes.
 * @param {string} mode
 * @returns {Record<string,string>}
 */
export function resolveTelegraphPalette(mode) {
  const palettes = (A11Y && A11Y.telegraphPalettes) || {};
  const palette = mode && mode !== 'none' ? palettes[mode] : null;
  return palette && typeof palette === 'object' ? palette : {};
}

/**
 * Maps an authored telegraph colour onto the active colour-blind ramp. Returns
 * the original colour when the mode is off, unknown, or has no mapping.
 * @param {string} authoredColor
 * @param {string} mode
 * @returns {string}
 */
export function resolveTelegraphColor(authoredColor, mode) {
  if (!isValidColorBlindMode(mode) || mode === DEFAULT_COLOR_BLIND_MODE) return authoredColor;
  const palette = resolveTelegraphPalette(mode);
  const mapped = palette[authoredColor];
  return typeof mapped === 'string' && mapped ? mapped : authoredColor;
}

/** Resolved `{ value, label }` descriptors for the dialogue text scale. */
export function listDialogueTextScales() {
  const scales = Array.isArray(A11Y.dialogueTextScales) ? A11Y.dialogueTextScales : [];
  const clean = scales.filter((s) => s && typeof s.value === 'string');
  return clean.length ? clean.map((s) => ({ value: s.value, label: s.label || s.value })) : [{ value: 'normal', label: 'Normal' }];
}

/** True when `value` is an authored dialogue text scale. */
export function isValidDialogueScale(value) {
  return typeof value === 'string' && listDialogueTextScales().some((s) => s.value === value);
}

/**
 * Numeric multiplier for a dialogue text scale (used as the `--dialogue-scale`
 * CSS custom property). Falls back to 1 for unknown values.
 * @param {string} value
 * @returns {number}
 */
export function resolveDialogueScale(value) {
  const map = OPTION_RANGES.dialogueTextScale;
  const scale = map && typeof map === 'object' ? Number(map[value]) : NaN;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
