/**
 * Lokarta: Come Into The Light - Ambient Director (LIV-82)
 *
 * Sits between the scene/biome state and `AudioSystem`'s ambient bus. Every
 * decision is catalog-driven (`biomes.json` `ambience` blocks + `sounds.json`
 * ids): which looping bed to play, which positional one-shots fire, how often,
 * and which material a footstep uses. No biome/sound name is hardcoded here.
 *
 * Pure helpers (`normalizeAmbience`, `resolveAmbience`) are browser-free and
 * unit-tested; the class only schedules calls onto the injected audio system.
 */

import { BIOMES_CATALOG } from '../data/index.js';

/** Default cap on re-triggering the same one-shot, in ms. */
export const DEFAULT_ONE_SHOT_RATE_LIMIT_MS = 6000;
/** Default cadence between roaming phase one-shots, in ms. */
export const DEFAULT_ONE_SHOT_INTERVAL_MS = 7000;
/** Default roaming one-shot placement radius around the player, in tiles. */
export const DEFAULT_ONE_SHOT_RADIUS_TILES = 6;
/** Fallback footstep sound when a biome declares no material mapping. */
export const DEFAULT_FOOTSTEP_SOUND = 'footstep';

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v) : [];
}

function normalizeEmitter(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.soundId !== 'string' || !raw.soundId) return null;
  return {
    soundId: raw.soundId,
    x: finiteOr(raw.x, NaN),
    y: finiteOr(raw.y, NaN),
    rateLimitMs: finiteOr(raw.rateLimitMs, null),
    phase: typeof raw.phase === 'string' ? raw.phase : null,
    weather: typeof raw.weather === 'string' ? raw.weather : null,
  };
}

/**
 * Normalizes a raw `biomes.json` `ambience` block into the shape the director
 * consumes. Returns null when no ambience is authored (silent biome).
 * @param {object} [raw]
 * @returns {object|null}
 */
export function normalizeAmbience(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const weatherVariants = {};
  if (raw.weatherVariants && typeof raw.weatherVariants === 'object') {
    for (const [key, bedId] of Object.entries(raw.weatherVariants)) {
      if (typeof bedId === 'string' && bedId) weatherVariants[key] = bedId;
    }
  }
  const footsteps = {};
  if (raw.footsteps && typeof raw.footsteps === 'object') {
    for (const [key, soundId] of Object.entries(raw.footsteps)) {
      if (typeof soundId === 'string' && soundId) footsteps[key] = soundId;
    }
  }
  return {
    bedId: typeof raw.bedId === 'string' && raw.bedId ? raw.bedId : null,
    nightBedId: typeof raw.nightBedId === 'string' && raw.nightBedId ? raw.nightBedId : null,
    dayOneShots: stringArray(raw.dayOneShots),
    nightOneShots: stringArray(raw.nightOneShots),
    weatherVariants,
    emitters: Array.isArray(raw.emitters) ? raw.emitters.map(normalizeEmitter).filter(Boolean) : [],
    footsteps,
    defaultFootstep: typeof raw.defaultFootstep === 'string' && raw.defaultFootstep
      ? raw.defaultFootstep
      : DEFAULT_FOOTSTEP_SOUND,
    oneShotIntervalMs: Math.max(0, finiteOr(raw.oneShotIntervalMs, DEFAULT_ONE_SHOT_INTERVAL_MS)),
    oneShotRateLimitMs: Math.max(0, finiteOr(raw.oneShotRateLimitMs, DEFAULT_ONE_SHOT_RATE_LIMIT_MS)),
    oneShotRadiusTiles: Math.max(0, finiteOr(raw.oneShotRadiusTiles, DEFAULT_ONE_SHOT_RADIUS_TILES)),
    oneShotChance: Math.min(1, Math.max(0, finiteOr(raw.oneShotChance, 1))),
  };
}

/**
 * Resolves a biome id to its normalized ambience from a biomes catalog.
 * @param {string|null} biomeId
 * @param {object} [biomes]
 * @returns {object|null}
 */
export function resolveAmbience(biomeId, biomes = BIOMES_CATALOG) {
  if (!biomeId || !biomes) return null;
  const biome = biomes[biomeId];
  return normalizeAmbience(biome && biome.ambience);
}

/**
 * Coordinates ambient beds and positional one-shots for the live biome.
 */
export class AmbientDirector {
  /**
   * @param {object} audio - An `AudioSystem`-shaped object (`setAmbientBed`/`playAt`/`play`).
   * @param {{ biomes?: object, random?: () => number, clock?: () => number }} [options]
   */
  constructor(audio, options = {}) {
    this.audio = audio;
    this.biomes = options.biomes || BIOMES_CATALOG;
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.clock = typeof options.clock === 'function' ? options.clock : null;
    this.biomeId = null;
    this.ambience = null;
    this.phase = 'day';
    this.weather = 'clear';
    this._lastPlayed = new Map();
    this._nextRoamMs = 0;
  }

  /** Switches biome, resetting rate-limiter state, and re-targets the bed. */
  setBiome(biomeId) {
    const next = biomeId || null;
    if (next === this.biomeId) return this.ambience;
    this.biomeId = next;
    this.ambience = resolveAmbience(next, this.biomes);
    this._lastPlayed.clear();
    this._nextRoamMs = 0;
    this._applyBed();
    return this.ambience;
  }

  /** Sets the time-of-day phase (`'day'`/`'night'`, forward-compat for I4). */
  setPhase(phase) {
    const next = phase === 'night' ? 'night' : 'day';
    if (next === this.phase) return;
    this.phase = next;
    this._applyBed();
  }

  /** Sets the weather variant id (`'clear'`, `'rain'`, `'mist'`, ...). */
  setWeather(weather) {
    const next = typeof weather === 'string' && weather ? weather : 'clear';
    if (next === this.weather) return;
    this.weather = next;
    this._applyBed();
  }

  /** The bed id the current biome/phase/weather resolves to, or null. */
  resolveBedId() {
    const amb = this.ambience;
    if (!amb) return null;
    if (this.weather !== 'clear') {
      const variant = amb.weatherVariants[this.weather];
      if (variant) return variant;
    }
    if (this.phase === 'night' && amb.nightBedId) return amb.nightBedId;
    return amb.bedId;
  }

  /** Stops the ambient bed (e.g. leaving gameplay). */
  stop() {
    this.audio.setAmbientBed(null);
  }

  _applyBed() {
    this.audio.setAmbientBed(this.resolveBedId());
  }

  /** True when `key` has not been used within `limitMs`; records the use. */
  canPlayAt(key, nowMs, limitMs) {
    const last = this._lastPlayed.get(key);
    if (last != null && nowMs - last < limitMs) return false;
    this._lastPlayed.set(key, nowMs);
    return true;
  }

  /**
   * Plays one one-shot positionally if it is not rate-limited.
   * @param {string} soundId
   * @param {number} x
   * @param {number} y
   * @param {{x:number,y:number}} player
   * @param {number} [nowMs]
   * @returns {boolean} true when played
   */
  playOneShot(soundId, x, y, player, nowMs = this._now()) {
    if (!soundId || !player) return false;
    const limit = this.ambience ? this.ambience.oneShotRateLimitMs : DEFAULT_ONE_SHOT_RATE_LIMIT_MS;
    if (!this.canPlayAt(soundId, nowMs, limit)) return false;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.audio.playAt(soundId, x, y, player.x, player.y);
    } else {
      this.audio.play(soundId);
    }
    return true;
  }

  /**
   * Per-ambience scheduler: fires fixed emitters (forge, shop bell) and the
   * roaming phase pool around the player. Rate-limited per sound/emitter.
   * @param {number} nowMs
   * @param {{ player?: {x:number,y:number} }} [ctx]
   */
  tick(nowMs, ctx = {}) {
    const amb = this.ambience;
    const player = ctx.player;
    if (!amb || !player) return;

    for (const emitter of amb.emitters) {
      if (!Number.isFinite(emitter.x) || !Number.isFinite(emitter.y)) continue;
      if (emitter.phase && emitter.phase !== this.phase) continue;
      if (emitter.weather && emitter.weather !== this.weather) continue;
      const limit = emitter.rateLimitMs != null ? emitter.rateLimitMs : amb.oneShotRateLimitMs;
      if (!this.canPlayAt(`${emitter.soundId}@${emitter.x},${emitter.y}`, nowMs, limit)) continue;
      this.audio.playAt(emitter.soundId, emitter.x, emitter.y, player.x, player.y);
    }

    const pool = this.phase === 'night' ? amb.nightOneShots : amb.dayOneShots;
    if (!pool.length) return;
    if (nowMs < this._nextRoamMs) return;
    this._nextRoamMs = nowMs + amb.oneShotIntervalMs;
    if (this.random() > amb.oneShotChance) return;

    const soundId = pool[Math.floor(this.random() * pool.length) % pool.length];
    if (!this.canPlayAt(soundId, nowMs, amb.oneShotRateLimitMs)) return;
    const angle = this.random() * Math.PI * 2;
    const radius = amb.oneShotRadiusTiles;
    const x = Math.round(player.x + Math.cos(angle) * radius);
    const y = Math.round(player.y + Math.sin(angle) * radius);
    this.audio.playAt(soundId, x, y, player.x, player.y);
  }

  /**
   * Resolves the footstep sound for a tile-type name via the biome's material
   * map, falling back to the biome default then the global default.
   * @param {string|null} tileName
   * @returns {string}
   */
  footstepSoundFor(tileName) {
    const amb = this.ambience;
    if (amb) {
      if (tileName && typeof amb.footsteps[tileName] === 'string') return amb.footsteps[tileName];
      if (amb.defaultFootstep) return amb.defaultFootstep;
    }
    return DEFAULT_FOOTSTEP_SOUND;
  }

  _now() {
    if (this.clock) return this.clock();
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }
}

export default AmbientDirector;
