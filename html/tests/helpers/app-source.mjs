/**
 * Test helper: concatenated source of the `html/app` controller layer.
 *
 * Splits `app-controller.js` into prototype-mixin controller modules
 * (`game-loop.js`, `combat-controller.js`, ...). Source-presence assertions
 * (e.g. "the game loop ticks status effects") should hold across the whole
 * controller layer, not one physical file, so they read through this helper.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_DIR = resolve(process.cwd(), 'html', 'app');

/** Concatenated source of every ES module in `html/app`. */
export function readControllerSources() {
  return readdirSync(APP_DIR)
    .filter(name => name.endsWith('.js'))
    .map(name => readFileSync(resolve(APP_DIR, name), 'utf8'))
    .join('\n');
}
