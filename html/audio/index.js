/**
 * Lokarta: Come Into The Light - Audio System Barrel Export
 */

import { soundFX } from './audio-system.js';
import { AmbientDirector } from './ambient-director.js';

export * from './audio-system.js';
export * from './ambient-director.js';

/**
 * Shared ambient director bound to the app's audio singleton (LIV-82). The app
 * drives it from scene/floor changes and the game loop; mute/volume are handled
 * downstream by `soundFX`'s master gain.
 */
export const ambientDirector = new AmbientDirector(soundFX);
