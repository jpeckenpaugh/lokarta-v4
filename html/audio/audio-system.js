/**
 * Lokarta: Come Into The Light - Procedural Web Audio API Sound Synthesizer
 * Provides zero-dependency procedural audio driven by JSON sound definitions.
 */

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.isMuted = false;
    this.isInitialized = false;
    this.sounds = null;
    this.loadingPromise = null;
    this.volumePercent = 70;

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

    switch (config.type) {
      case 'sweep':
        this._playSweep(config, now, vScale);
        break;
      case 'sequence':
        this._playSequence(config, now, vScale);
        break;
      case 'composite':
        this._playComposite(config, now, vScale);
        break;
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
  // Internal Sound Synthesizers
  // ==========================================================================

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
    gain.gain.setValueAtTime(effGain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + config.duration);

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
      gain.gain.setValueAtTime(masterVolume, noteTime);
      gain.gain.exponentialRampToValueAtTime(0.001, noteTime + noteDuration);

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
      gain.gain.setValueAtTime(effGain, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + config.duration);
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

      gain.gain.setValueAtTime(effGain, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + config.duration);

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
      "click": { "type": "sweep", "oscType": "sine", "startFreq": 600, "endFreq": 300, "duration": 0.03, "gain": 0.12 }
    };
  }
}

export const soundFX = AudioSystem.getInstance();
export default AudioSystem;
