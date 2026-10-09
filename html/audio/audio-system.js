/**
 * Lokarta: Come Into The Light - Procedural Web Audio API Sound Synthesizer
 * Provides zero-dependency procedural audio driven by JSON sound definitions.
 */

/**
 * Sound-synthesis dispatch table: `sounds.json` `type` -> private renderer
 * method. Adding a new synthesis shape is a table entry + a method, never a
 * `switch` change. Unknown types are a safe no-op (silent).
 */
const SOUND_RENDERER_METHODS = {
  sweep: '_playSweep',
  sequence: '_playSequence',
  composite: '_playComposite',
};

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.isMuted = false;
    this.isInitialized = false;
    this.sounds = null;
    this.loadingPromise = null;
    this.volumePercent = 70;

    // Ambient bed state (LIV-82). A single looping bed is live at a time; the
    // gain is routed through `masterGain` so mute/volume apply for free.
    // `_ambientRequestedId` is authoritative even before the AudioContext or
    // sounds.json are ready, and is re-applied on init/load.
    this._ambient = null; // { bedId, gain, sources, mods }
    this._ambientBedId = null;
    this._ambientRequestedId = null;
    this._noiseBuffer = null;

    // Check saved mute preference
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const saved = localStorage.getItem('lokarta_audio_muted');
        if (saved !== null) {
          this.isMuted = saved === 'true';
        }
        const savedVolume = localStorage.getItem('lokarta_audio_volume');
        if (savedVolume !== null) {
          const parsed = Number(savedVolume);
          if (Number.isFinite(parsed)) {
            this.volumePercent = Math.max(0, Math.min(100, parsed));
          }
        }
      }
    } catch {
      // Ignore localStorage restrictions
    }
  }

  /**
   * Maps the 0-100 volume percent to the master gain (max 0.5).
   * @returns {number}
   */
  _gainForVolume() {
    return 0.5 * (this.volumePercent / 100);
  }

  /**
   * Returns the current sound volume as an integer 0-100.
   * @returns {number}
   */
  getVolume() {
    return Math.round(this.volumePercent);
  }

  /**
   * Sets the sound volume from an integer 0-100 and applies it live.
   * @param {number} percent
   * @returns {number} The normalized volume percent.
   */
  setVolume(percent) {
    const parsed = Number(percent);
    this.volumePercent = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 70;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('lokarta_audio_volume', String(this.volumePercent));
      }
    } catch {
      // Ignore
    }
    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this._gainForVolume(), now);
    }
    return this.volumePercent;
  }

  static getInstance() {
    if (!AudioSystem.instance) {
      AudioSystem.instance = new AudioSystem();
    }
    return AudioSystem.instance;
  }

  /**
   * Returns whether audio output is enabled (un-muted).
   * @returns {boolean}
   */
  get enabled() {
    return !this.isMuted;
  }

  /**
   * Sets whether audio output is enabled.
   * @param {boolean} enabled
   * @returns {boolean} New enabled status.
   */
  setEnabled(enabled) {
    return !this.setMuted(!enabled);
  }

  /**
   * Loads sound definitions asynchronously from sounds.json.
   * @returns {Promise<Object>}
   */
  async loadSounds() {
    if (this.sounds) return this.sounds;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      try {
        if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
          const res = await fetch('./data/sounds.json');
          if (res.ok) {
            this.sounds = await res.json();
            return this.sounds;
          }
        }
      } catch (e) {
        console.warn('Unable to fetch sounds.json, using fallback definitions:', e);
      }
      this.sounds = this._getFallbackSounds();
      return this.sounds;
    })();

    return this.loadingPromise;
  }

  /**
   * Initializes or unlocks the AudioContext on user interaction.
   */
  init() {
    this.loadSounds().catch(() => {});

    if (this.isInitialized && this.ctx && this.ctx.state === 'running') {
      return;
    }

    try {
      if (typeof window === 'undefined') return;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      if (!this.ctx) {
        this.ctx = new AudioContextClass();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.isMuted ? 0 : this._gainForVolume();
        this.masterGain.connect(this.ctx.destination);
      }

      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }

      this.isInitialized = true;
      // A bed requested before the context existed starts now (LIV-82).
      this._applyAmbient();
    } catch (e) {
      console.warn('AudioContext initialization deferred or unavailable:', e);
    }
  }

  /**
   * Toggles mute state and returns the new muted status.
   * @returns {boolean}
   */
  toggleMute() {
    return this.setMuted(!this.isMuted);
  }

  /**
   * Returns current mute state.
   * @returns {boolean}
   */
  getMuted() {
    return this.isMuted;
  }

  /**
   * Explicitly sets mute state.
   * @param {boolean} muted
   * @returns {boolean}
   */
  setMuted(muted) {
    this.isMuted = Boolean(muted);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('lokarta_audio_muted', String(this.isMuted));
      }
    } catch {
      // Ignore
    }

    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this._gainForVolume(), now);
    }

    return this.isMuted;
  }

  canPlay() {
    if (this.isMuted) return false;
    if (!this.ctx) {
      this.init();
    }
    if (!this.ctx || this.ctx.state !== 'running') {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return false;
    }
    return true;
  }

  /**
   * Computes spatial attenuation volume scale based on tile distance from player.
   * Distance <= 5 tiles: 1.0 (100% volume)
   * Distance > 5 tiles: loses 10% volume per tile down to a minimum floor of 0.10 (10%).
   * @param {number} x1 Origin tile X
   * @param {number} y1 Origin tile Y
   * @param {number} x2 Target tile X (e.g. player.x)
   * @param {number} y2 Target tile Y (e.g. player.y)
   * @returns {number} Volume scale factor between 0.10 and 1.0
   */
  computeDistanceScale(x1, y1, x2, y2) {
    if (typeof x1 !== 'number' || typeof y1 !== 'number' || typeof x2 !== 'number' || typeof y2 !== 'number') {
      return 1.0;
    }
    const dist = Math.hypot(x2 - x1, y2 - y1);
    if (dist <= 5.0) return 1.0;
    const attenuation = (dist - 5.0) * 0.10;
    return Math.max(0.10, 1.0 - attenuation);
  }

  /**
   * Primary playback function to play a procedural sound defined in sounds.json.
   * @param {string} soundKey
   * @param {number} [volumeScale=1.0]
   */
  play(soundKey, volumeScale = 1.0) {
    if (!this.canPlay() || !this.ctx || !this.masterGain) return;
    if (!this.sounds || !this.sounds[soundKey]) return;

    const config = this.sounds[soundKey];
    const now = this.ctx.currentTime;
    const vScale = typeof volumeScale === 'number' ? Math.max(0.10, Math.min(1.0, volumeScale)) : 1.0;

    const renderMethod = SOUND_RENDERER_METHODS[config.type];
    if (renderMethod && typeof this[renderMethod] === 'function') {
      this[renderMethod](config, now, vScale);
    }
  }

  /**
   * Plays a sound spatially attenuated relative to player position.
   * @param {string} soundKey
   * @param {number} targetX
   * @param {number} targetY
   * @param {number} playerX
   * @param {number} playerY
   */
  playAt(soundKey, targetX, targetY, playerX, playerY) {
    const scale = this.computeDistanceScale(targetX, targetY, playerX, playerY);
    this.play(soundKey, scale);
  }

  /** Alias for play() */
  playSound(soundKey, volumeScale = 1.0) {
    this.play(soundKey, volumeScale);
  }

  // ==========================================================================
  // Ambient Beds (LIV-82)
  // ==========================================================================

  /**
   * Requests the looping ambient bed for the current biome/scene. Passing a
   * falsy id stops the current bed. Idempotent; the request is remembered and
   * applied once the AudioContext and sounds.json are available, so callers may
   * set a bed before a user gesture unlocks audio.
   * @param {string|null} bedId
   */
  setAmbientBed(bedId) {
    const next = typeof bedId === 'string' && bedId ? bedId : null;
    if (next === this._ambientRequestedId && next === this._ambientBedId) return;
    this._ambientRequestedId = next;
    this._applyAmbient();
  }

  /** Returns the currently playing ambient bed id, or null. */
  getAmbientBedId() {
    return this._ambientBedId;
  }

  /** Stops the ambient bed with a short fade. */
  stopAmbient() {
    this.setAmbientBed(null);
  }

  /**
   * Reconciles the requested bed with what is playing. Called from `init`,
   * `setAmbientBed`, and after sounds.json resolves.
   */
  _applyAmbient() {
    const requested = this._ambientRequestedId;
    if (requested === this._ambientBedId) return;
    if (!this.ctx || !this.masterGain) return; // retried by init()
    if (!this.sounds) {
      this.loadSounds().then(() => this._applyAmbient()).catch(() => {});
      return;
    }
    // Fade out the outgoing bed before swapping in the next.
    if (this._ambient) this._stopAmbientNodes(this._ambient.fadeSec);
    this._ambientBedId = requested;
    if (!requested) return;
    const config = this.sounds[requested];
    if (!config || config.kind !== 'ambient') {
      this._ambientBedId = null;
      return;
    }
    this._startAmbientBed(requested, config);
  }

  /**
   * Builds the looping graph for a bed config: one gain bus plus one node chain
   * per `layers[]` voice. The dispatch table maps a layer `type` to its builder,
   * so a new ambient voice is a catalog entry plus one handler (no JS branches).
   * @param {string} bedId
   * @param {object} config
   */
  _startAmbientBed(bedId, config) {
    const now = this.ctx.currentTime;
    const fadeSec = Number.isFinite(config.fadeSec) ? Math.max(0.05, config.fadeSec) : 2.0;
    const target = Math.max(0.0001, Number.isFinite(config.gain) ? config.gain : 0.3);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(target, now + fadeSec);
    gain.connect(this.masterGain);

    const sources = [];
    const mods = [];
    for (const layer of config.layers || []) {
      const builder = AMBIENT_LAYER_BUILDERS[layer?.type];
      if (!builder) continue;
      const built = builder(this, layer, gain, now, fadeSec);
      if (built) {
        sources.push(...built.sources);
        mods.push(...built.mods);
      }
    }
    this._ambient = { bedId, gain, sources, mods, fadeSec };
  }

  /** Fades out and tears down the current bed graph. */
  _stopAmbientNodes(fadeSec = 0.6) {
    const cur = this._ambient;
    this._ambient = null;
    if (!cur) return;
    const now = this.ctx.currentTime;
    const fade = Math.max(0.05, Number.isFinite(fadeSec) ? fadeSec : 0.6);
    try {
      cur.gain.gain.cancelScheduledValues(now);
      cur.gain.gain.setValueAtTime(Math.max(0.0001, cur.gain.gain.value), now);
      cur.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
    } catch {
      // Ignore scheduling errors on a torn-down graph.
    }
    const stopAt = now + fade + 0.05;
    for (const src of cur.sources) {
      try { src.stop(stopAt); } catch { /* already stopped */ }
    }
    for (const mod of cur.mods) {
      try { mod.stop(stopAt); } catch { /* already stopped */ }
    }
    const delay = Math.ceil((fade + 0.15) * 1000);
    if (typeof setTimeout === 'function') {
      setTimeout(() => {
        for (const src of cur.sources) { try { src.disconnect(); } catch { /* noop */ } }
        for (const mod of cur.mods) { try { mod.disconnect(); } catch { /* noop */ } }
        try { cur.gain.disconnect(); } catch { /* noop */ }
      }, delay);
    }
  }

  /** Lazily builds and caches a 2 s looping white-noise buffer for ambient beds. */
  _getNoiseBuffer() {
    if (this._noiseBuffer) return this._noiseBuffer;
    const sampleRate = this.ctx.sampleRate || 44100;
    const length = Math.max(1, Math.floor(sampleRate * 2));
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buffer;
    return buffer;
  }

  /**
   * Applies an optional LFO to a filter frequency or gain target.
   * @returns {OscillatorNode|null} The mod oscillator, for teardown.
   */
  _attachAmbientLfo(lfo, param, now, scale = 1) {
    if (!lfo || !param) return null;
    const mod = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    mod.type = lfo.oscType || 'sine';
    mod.frequency.setValueAtTime(Math.max(0.001, lfo.freq || 0.1), now);
    modGain.gain.setValueAtTime((lfo.gain != null ? lfo.gain : 0) * scale, now);
    mod.connect(modGain);
    modGain.connect(param);
    mod.start(now);
    return mod;
  }

  /**
   * Builds a `noise` ambient layer: looping white noise through an optional
   * biquad filter, with optional filter-frequency LFO and gain tremolo/swell.
   * @returns {{ sources: AudioBufferSourceNode[], mods: OscillatorNode[] }}
   */
  _buildAmbientNoise(layer, dest, now) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._getNoiseBuffer();
    src.loop = true;

    let node = src;
    let filter = null;
    const mods = [];
    if (layer.filter) {
      filter = this.ctx.createBiquadFilter();
      filter.type = layer.filter.type || 'lowpass';
      filter.frequency.setValueAtTime(Math.max(0.001, layer.filter.freq || 1000), now);
      if (layer.filter.Q != null) filter.Q.setValueAtTime(layer.filter.Q, now);
      node.connect(filter);
      node = filter;
    }

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0001, layer.gain != null ? layer.gain : 0.5), now);
    node.connect(gain);
    gain.connect(dest);

    if (filter && layer.lfo) {
      const mod = this._attachAmbientLfo(layer.lfo, filter.frequency, now);
      if (mod) mods.push(mod);
    }
    if (layer.gainLfo) {
      const mod = this._attachAmbientLfo(layer.gainLfo, gain.gain, now);
      if (mod) mods.push(mod);
    }

    src.start(now);
    return { sources: [src], mods };
  }

  /**
   * Builds an `osc` ambient layer: a sustained oscillator through an optional
   * filter, with optional filter-frequency LFO and gain tremolo/swell.
   * @returns {{ sources: OscillatorNode[], mods: OscillatorNode[] }}
   */
  _buildAmbientOsc(layer, dest, now) {
    const osc = this.ctx.createOscillator();
    osc.type = layer.oscType || 'sine';
    osc.frequency.setValueAtTime(Math.max(0.001, layer.freq || 100), now);
    if (layer.detune != null && osc.detune) osc.detune.setValueAtTime(layer.detune, now);

    let node = osc;
    let filter = null;
    const mods = [];
    if (layer.filter) {
      filter = this.ctx.createBiquadFilter();
      filter.type = layer.filter.type || 'lowpass';
      filter.frequency.setValueAtTime(Math.max(0.001, layer.filter.freq || 1000), now);
      if (layer.filter.Q != null) filter.Q.setValueAtTime(layer.filter.Q, now);
      node.connect(filter);
      node = filter;
    }

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0001, layer.gain != null ? layer.gain : 0.2), now);
    node.connect(gain);
    gain.connect(dest);

    if (filter && layer.lfo) {
      const mod = this._attachAmbientLfo(layer.lfo, filter.frequency, now);
      if (mod) mods.push(mod);
    }
    if (layer.gainLfo) {
      const mod = this._attachAmbientLfo(layer.gainLfo, gain.gain, now);
      if (mod) mods.push(mod);
    }

    osc.start(now);
    return { sources: [osc], mods };
  }

  // ==========================================================================
  // Internal Sound Synthesizers
  // ==========================================================================

  /**
   * Applies a one-shot gain envelope. When `attack` (seconds) is present the
   * gain ramps up from silence before decaying, which removes the hard onset
   * transient; without it the legacy instant-attack decay is preserved so
   * existing recipes are byte-identical. Purely data-driven — a catalog value.
   */
  _applyOneShotGain(gainParam, now, peak, duration, attack = 0) {
    const safePeak = Math.max(0.0001, peak);
    const a = Math.max(0, Math.min(Number(attack) || 0, duration));
    if (a > 0) {
      gainParam.setValueAtTime(0.0001, now);
      gainParam.linearRampToValueAtTime(safePeak, now + a);
      gainParam.exponentialRampToValueAtTime(0.001, now + duration);
    } else {
      gainParam.setValueAtTime(safePeak, now);
      gainParam.exponentialRampToValueAtTime(0.001, now + duration);
    }
  }

  _playSweep(config, now, volumeScale = 1.0) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    let lastNode = osc;

    if (config.filter) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = config.filter.type || 'lowpass';
      filter.frequency.setValueAtTime(config.filter.freq, now);
      osc.connect(filter);
      lastNode = filter;
    }

    const startFreq = config.startFreq + (config.freqRandom ? Math.random() * config.freqRandom : 0);
    osc.type = config.oscType || 'sine';
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(0.001, config.endFreq), now + config.duration);

    const effGain = Math.max(0.0001, (config.gain || 0.15) * volumeScale);
    this._applyOneShotGain(gain.gain, now, effGain, config.duration, config.attack);

    lastNode.connect(gain);
    gain.connect(this.masterGain);

    const stopTime = config.stopTime || config.duration;
    osc.start(now);
    osc.stop(now + stopTime);
  }

  _playSequence(config, now, volumeScale = 1.0) {
    const oscType = config.oscType || 'sine';
    const masterVolume = Math.max(0.0001, (config.gain || 0.15) * volumeScale);

    config.notes.forEach(note => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = oscType;
      const noteTime = now + (note.time || 0);
      const noteDuration = note.duration || 0.1;

      osc.frequency.setValueAtTime(note.freq, noteTime);
      this._applyOneShotGain(
        gain.gain,
        noteTime,
        masterVolume,
        noteDuration,
        note.attack != null ? note.attack : config.attack
      );

      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start(noteTime);
      osc.stop(noteTime + noteDuration);
    });
  }

  _playComposite(config, now, volumeScale = 1.0) {
    const effGain = Math.max(0.0001, (config.gain || 0.20) * volumeScale);

    if (config.oscillators) {
      const gain = this.ctx.createGain();
      this._applyOneShotGain(gain.gain, now, effGain, config.duration, config.attack);
      gain.connect(this.masterGain);

      config.oscillators.forEach(oscConfig => {
        const osc = this.ctx.createOscillator();
        osc.type = oscConfig.type;
        osc.frequency.setValueAtTime(oscConfig.startFreq, now);
        osc.frequency.exponentialRampToValueAtTime(Math.max(0.001, oscConfig.endFreq), now + config.duration);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + config.duration);
      });
    } else if (config.lfo) {
      const osc = this.ctx.createOscillator();
      const mod = this.ctx.createOscillator();
      const modGain = this.ctx.createGain();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();

      osc.type = config.oscType || 'sawtooth';
      osc.frequency.setValueAtTime(config.startFreq, now);
      osc.frequency.exponentialRampToValueAtTime(config.endFreq, now + config.duration);

      mod.type = config.lfo.oscType || 'sine';
      mod.frequency.setValueAtTime(config.lfo.freq, now);
      modGain.gain.setValueAtTime(config.lfo.gain, now);
      mod.connect(osc.frequency);

      filter.type = config.filter.type || 'bandpass';
      filter.frequency.setValueAtTime(config.filter.startFreq, now);
      filter.frequency.exponentialRampToValueAtTime(config.filter.endFreq, now + config.duration);
      filter.Q.setValueAtTime(config.filter.Q || 1, now);

      this._applyOneShotGain(gain.gain, now, effGain, config.duration, config.attack);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);

      mod.start(now);
      osc.start(now);
      mod.stop(now + config.duration);
      osc.stop(now + config.duration);
    }
  }

  _getFallbackSounds() {
    return {
      "footstep": { "type": "sweep", "oscType": "triangle", "startFreq": 90, "freqRandom": 30, "endFreq": 30, "duration": 0.05, "gain": 0.08, "filter": { "type": "lowpass", "freq": 400 } },
      "wandSpark": { "type": "sweep", "oscType": "sawtooth", "startFreq": 800, "freqRandom": 100, "endFreq": 150, "duration": 0.12, "gain": 0.2 },
      "lightSpell": { "type": "sequence", "oscType": "sine", "gain": 0.12, "notes": [{ "freq": 523.25, "time": 0.00, "duration": 0.6 }, { "freq": 659.25, "time": 0.04, "duration": 0.6 }, { "freq": 783.99, "time": 0.08, "duration": 0.6 }, { "freq": 1046.5, "time": 0.12, "duration": 0.6 }] },
      "energyBeam": { "type": "composite", "oscType": "sawtooth", "startFreq": 450, "endFreq": 120, "duration": 0.35, "gain": 0.25, "lfo": { "oscType": "sine", "freq": 40, "gain": 80 }, "filter": { "type": "bandpass", "startFreq": 1200, "endFreq": 300, "Q": 3 } },
      "bowShot": { "type": "sweep", "oscType": "triangle", "startFreq": 360, "endFreq": 110, "duration": 0.09, "gain": 0.22 },
      "powerShot": { "type": "composite", "duration": 0.2, "gain": 0.28, "oscillators": [{ "type": "square", "startFreq": 500, "endFreq": 80 }, { "type": "sine", "startFreq": 120, "endFreq": 40 }] },
      "hit": { "type": "sweep", "oscType": "square", "startFreq": 180, "endFreq": 40, "duration": 0.1, "gain": 0.25 },
      "monsterAttack": { "type": "sweep", "oscType": "sawtooth", "startFreq": 220, "endFreq": 70, "duration": 0.15, "gain": 0.18 },
      "monsterDeath": { "type": "sweep", "oscType": "sawtooth", "startFreq": 150, "endFreq": 25, "duration": 0.3, "gain": 0.2 },
      "playerHurt": { "type": "sweep", "oscType": "triangle", "startFreq": 110, "endFreq": 30, "duration": 0.18, "gain": 0.3 },
      "itemPickup": { "type": "sequence", "oscType": "sine", "gain": 0.18, "notes": [{ "freq": 587.33, "time": 0.00, "duration": 0.1 }, { "freq": 880.00, "time": 0.05, "duration": 0.1 }] },
      "potionDrink": { "type": "sequence", "oscType": "triangle", "gain": 0.15, "notes": [{ "freq": 330, "time": 0.00, "duration": 0.12 }, { "freq": 440, "time": 0.06, "duration": 0.12 }, { "freq": 550, "time": 0.12, "duration": 0.12 }, { "freq": 660, "time": 0.18, "duration": 0.12 }] },
      "equip": { "type": "sweep", "oscType": "triangle", "startFreq": 280, "endFreq": 560, "duration": 0.06, "stopTime": 0.07, "gain": 0.15 },
      "unequip": { "type": "sweep", "oscType": "triangle", "startFreq": 450, "endFreq": 220, "duration": 0.06, "gain": 0.12 },
      "stairs": { "type": "sequence", "oscType": "sine", "gain": 0.18, "notes": [{ "freq": 330, "time": 0.00, "duration": 0.4 }, { "freq": 440, "time": 0.08, "duration": 0.4 }, { "freq": 554, "time": 0.16, "duration": 0.4 }, { "freq": 659, "time": 0.24, "duration": 0.4 }, { "freq": 880, "time": 0.32, "duration": 0.4 }] },
      "levelUp": { "type": "sequence", "oscType": "sine", "gain": 0.2, "notes": [{ "freq": 440.0, "time": 0.00, "duration": 0.45 }, { "freq": 554.37, "time": 0.08, "duration": 0.45 }, { "freq": 659.25, "time": 0.16, "duration": 0.45 }, { "freq": 880.0, "time": 0.24, "duration": 0.45 }, { "freq": 1108.73, "time": 0.36, "duration": 0.45 }, { "freq": 1318.51, "time": 0.48, "duration": 0.45 }] },
      "victory": { "type": "sequence", "oscType": "triangle", "gain": 0.25, "notes": [{ "freq": 523.25, "time": 0.00, "duration": 0.25 }, { "freq": 659.25, "time": 0.12, "duration": 0.25 }, { "freq": 783.99, "time": 0.24, "duration": 0.25 }, { "freq": 1046.5, "time": 0.36, "duration": 0.25 }, { "freq": 1318.5, "time": 0.60, "duration": 1.00 }] },
      "defeat": { "type": "sequence", "oscType": "sawtooth", "gain": 0.2, "notes": [{ "freq": 220.00, "time": 0.00, "duration": 0.4 }, { "freq": 207.65, "time": 0.25, "duration": 0.4 }, { "freq": 196.00, "time": 0.50, "duration": 0.4 }, { "freq": 174.61, "time": 0.75, "duration": 0.4 }] },
      "click": { "type": "sweep", "oscType": "sine", "startFreq": 600, "endFreq": 300, "duration": 0.03, "gain": 0.12 },
      "questAccept": { "kind": "sfx", "type": "sequence", "oscType": "sine", "gain": 0.18, "notes": [{ "freq": 587.33, "time": 0.00, "duration": 0.14 }, { "freq": 880.00, "time": 0.10, "duration": 0.24 }] },
      "questObjective": { "kind": "sfx", "type": "sequence", "oscType": "triangle", "gain": 0.16, "notes": [{ "freq": 659.25, "time": 0.00, "duration": 0.10 }, { "freq": 987.77, "time": 0.07, "duration": 0.20 }] },
      "questComplete": { "kind": "sfx", "type": "sequence", "oscType": "triangle", "gain": 0.22, "notes": [{ "freq": 523.25, "time": 0.00, "duration": 0.18 }, { "freq": 659.25, "time": 0.10, "duration": 0.18 }, { "freq": 783.99, "time": 0.20, "duration": 0.18 }, { "freq": 1046.50, "time": 0.30, "duration": 0.22 }, { "freq": 1318.51, "time": 0.46, "duration": 0.55 }] },
      "questReady": { "kind": "sfx", "type": "sequence", "oscType": "triangle", "gain": 0.19, "notes": [{ "freq": 587.33, "time": 0.00, "duration": 0.16 }, { "freq": 739.99, "time": 0.09, "duration": 0.16 }, { "freq": 880.00, "time": 0.18, "duration": 0.26 }] },
      "bossEntrance": { "kind": "sfx", "type": "composite", "duration": 1.10, "gain": 0.30, "oscillators": [{ "type": "sawtooth", "startFreq": 110, "endFreq": 55 }, { "type": "square", "startFreq": 55, "endFreq": 36 }] },
      "bossDefeat": { "kind": "sfx", "type": "sequence", "oscType": "sawtooth", "gain": 0.24, "notes": [{ "freq": 196.00, "time": 0.00, "duration": 0.40 }, { "freq": 155.56, "time": 0.22, "duration": 0.45 }, { "freq": 110.00, "time": 0.48, "duration": 0.70 }] },
      "enemyCast": { "kind": "sfx", "type": "composite", "oscType": "sawtooth", "startFreq": 300, "endFreq": 700, "duration": 0.30, "gain": 0.18, "lfo": { "oscType": "sine", "freq": 22, "gain": 60 }, "filter": { "type": "bandpass", "startFreq": 600, "endFreq": 1600, "Q": 4 } },
      "enterVillage": { "kind": "sfx", "type": "sequence", "oscType": "sine", "gain": 0.16, "notes": [{ "freq": 392.00, "time": 0.00, "duration": 0.28 }, { "freq": 523.25, "time": 0.08, "duration": 0.30 }, { "freq": 659.25, "time": 0.16, "duration": 0.40 }] },
      "enterIsle": { "kind": "sfx", "type": "sweep", "oscType": "sine", "startFreq": 261.63, "endFreq": 523.25, "duration": 0.85, "attack": 0.40, "gain": 0.08, "filter": { "type": "lowpass", "freq": 1100 } },
      "gateUnlock": { "kind": "sfx", "type": "composite", "duration": 0.50, "gain": 0.26, "oscillators": [{ "type": "square", "startFreq": 160, "endFreq": 70 }, { "type": "triangle", "startFreq": 320, "endFreq": 150 }] },
      "enterTower": { "kind": "sfx", "type": "sequence", "oscType": "triangle", "gain": 0.20, "notes": [{ "freq": 261.63, "time": 0.00, "duration": 0.30 }, { "freq": 329.63, "time": 0.10, "duration": 0.30 }, { "freq": 392.00, "time": 0.20, "duration": 0.30 }, { "freq": 523.25, "time": 0.32, "duration": 0.50 }] },
      "teleport": { "kind": "sfx", "type": "composite", "oscType": "sine", "startFreq": 1200, "endFreq": 200, "duration": 0.40, "gain": 0.18, "lfo": { "oscType": "sine", "freq": 18, "gain": 120 }, "filter": { "type": "bandpass", "startFreq": 2000, "endFreq": 400, "Q": 5 } },
      "fountain": { "kind": "sfx", "type": "sequence", "oscType": "sine", "gain": 0.12, "notes": [{ "freq": 1046.50, "time": 0.00, "duration": 0.15 }, { "freq": 1318.51, "time": 0.08, "duration": 0.15 }, { "freq": 1567.98, "time": 0.16, "duration": 0.26 }] },
      "healReceived": { "kind": "sfx", "type": "sequence", "oscType": "sine", "gain": 0.16, "notes": [{ "freq": 587.33, "time": 0.00, "duration": 0.25 }, { "freq": 880.00, "time": 0.08, "duration": 0.30 }, { "freq": 1174.66, "time": 0.18, "duration": 0.40 }] },
      "playerStun": { "kind": "sfx", "type": "composite", "oscType": "square", "startFreq": 400, "endFreq": 220, "duration": 0.40, "gain": 0.20, "lfo": { "oscType": "sine", "freq": 12, "gain": 60 }, "filter": { "type": "lowpass", "startFreq": 1200, "endFreq": 600, "Q": 2 } },
      "playerDefeat": { "kind": "sfx", "type": "sequence", "oscType": "sawtooth", "gain": 0.26, "notes": [{ "freq": 330.00, "time": 0.00, "duration": 0.35 }, { "freq": 233.08, "time": 0.22, "duration": 0.40 }, { "freq": 174.61, "time": 0.48, "duration": 1.00 }] },
      "revive": { "kind": "sfx", "type": "sequence", "oscType": "triangle", "gain": 0.22, "notes": [{ "freq": 523.25, "time": 0.00, "duration": 0.18 }, { "freq": 659.25, "time": 0.10, "duration": 0.18 }, { "freq": 783.99, "time": 0.20, "duration": 0.18 }, { "freq": 1046.50, "time": 0.34, "duration": 0.50 }] },
      "holyChime": { "kind": "sfx", "type": "sequence", "oscType": "sine", "gain": 0.16, "notes": [{ "freq": 1046.50, "time": 0.00, "duration": 0.50 }, { "freq": 1318.51, "time": 0.04, "duration": 0.45 }, { "freq": 1567.98, "time": 0.09, "duration": 0.40 }] },
      "manaRegen": { "kind": "sfx", "type": "sequence", "oscType": "sine", "gain": 0.12, "notes": [{ "freq": 440.00, "time": 0.00, "duration": 0.12 }, { "freq": 659.25, "time": 0.06, "duration": 0.12 }, { "freq": 880.00, "time": 0.12, "duration": 0.22 }] },
      "uiDenied": { "kind": "sfx", "type": "sweep", "oscType": "square", "startFreq": 220, "endFreq": 110, "duration": 0.12, "gain": 0.18, "filter": { "type": "lowpass", "freq": 800 } }
    };
  }
}

/**
 * Ambient layer dispatch table (LIV-82). A new ambient voice `type` is a
 * catalog entry plus one builder here — no branching in the bed loop.
 */
const AMBIENT_LAYER_BUILDERS = {
  noise: (audio, layer, dest, now) => audio._buildAmbientNoise(layer, dest, now),
  osc: (audio, layer, dest, now) => audio._buildAmbientOsc(layer, dest, now),
};

export const soundFX = AudioSystem.getInstance();
export default AudioSystem;
