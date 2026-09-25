import type { Tab } from './tab.svelte';

const LOOKAHEAD_S = 0.12; // how far ahead notes are scheduled
const TICK_MS = 25; // how often the scheduler wakes up
const START_DELAY_S = 0.05;
const VELOCITY = 0.5;
const RELEASE_S = 0.015; // time constant for muting a ringing string
const METAL_LEVEL = 0.3; // distorted signal is much hotter than clean, so trim it to match
const SWITCH_S = 0.03; // crossfade time constant when toggling metal mode

type Voice = { src: AudioBufferSourceNode; gain: GainNode };

const midiToFreq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * Karplus-Strong plucked string. Returns the buffer plus the playback rate that
 * corrects the pitch error from rounding the delay line to whole samples.
 */
function synthPluck(ctx: BaseAudioContext, midi: number) {
  const sr = ctx.sampleRate;
  const freq = midiToFreq(midi);
  const period = Math.max(2, Math.floor(sr / freq - 0.5));
  // Low strings ring longer than high ones.
  const t60 = Math.min(4, Math.max(0.8, 4 - 1.1 * Math.log2(freq / 82)));
  const decay = 10 ** (-3 / (freq * t60));
  const length = Math.ceil(sr * Math.min(t60, 3));

  const buffer = ctx.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);

  // Excitation: softened noise burst, with a comb notch to mimic picking near the bridge.
  const excitation = new Float32Array(period);
  let smooth = 0;
  for (let i = 0; i < period; i++) {
    smooth = 0.5 * (Math.random() * 2 - 1) + 0.5 * smooth;
    excitation[i] = smooth;
  }
  const pickOffset = Math.max(1, Math.round(period * 0.13));
  let mean = 0;
  for (let i = 0; i < period; i++) {
    data[i] = excitation[i] - (i >= pickOffset ? excitation[i - pickOffset] : 0);
    mean += data[i] / period;
  }
  for (let i = 0; i < period; i++) data[i] -= mean;

  for (let i = period; i < length; i++) {
    const a = data[i - period];
    const b = i - period - 1 >= 0 ? data[i - period - 1] : 0;
    data[i] = decay * 0.5 * (a + b);
  }

  // Fade the tail so the buffer end doesn't click.
  const fade = Math.min(length, Math.round(sr * 0.05));
  for (let i = 0; i < fade; i++) data[length - 1 - i] *= i / fade;

  // The averaging filter adds half a sample of delay.
  return { buffer, rate: (freq * (period + 0.5)) / sr };
}

/** Asymmetric tanh soft-clip; the asymmetry adds even harmonics like a tube stage. */
function distortionCurve(amount: number, samples = 2048) {
  const curve = new Float32Array(samples);
  const norm = Math.tanh(amount);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = x >= 0 ? Math.tanh(amount * x) / norm : Math.tanh(amount * 0.8 * x) / Math.tanh(amount * 0.8);
  }
  return curve;
}

/**
 * High-gain amp: tighten the lows, drive hard into a clipper, scoop the mids,
 * then roll off the fizz the way a 4x12 cab would.
 */
function metalAmp(ctx: BaseAudioContext, output: AudioNode) {
  const tighten = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 110, Q: 0.7 });
  const drive = new GainNode(ctx, { gain: 6 });
  const shaper = new WaveShaperNode(ctx, { curve: distortionCurve(18), oversample: '4x' });
  const chug = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 140, gain: 6 });
  const scoop = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 700, Q: 0.9, gain: -7 });
  const presence = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2400, Q: 1, gain: 4 });
  const cab1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5000, Q: 0.7 });
  const cab2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5000, Q: 0.7 });
  tighten.connect(drive).connect(shaper).connect(chug).connect(scoop).connect(presence).connect(cab1).connect(cab2).connect(output);
  return tighten;
}

export class Player {
  playing = $state(false);
  loop = $state(false);
  /** Step currently under the playhead, or null when stopped. */
  step = $state<number | null>(null);

  #tab: Tab;
  #volume = $state(0.8);
  #metal = $state(false);
  #ctx: AudioContext | null = null;
  #bus: GainNode | null = null; // every voice feeds this
  #out: GainNode | null = null; // master volume
  #clean: GainNode | null = null;
  #dirty: GainNode | null = null;
  #plucks = new Map<number, { buffer: AudioBuffer; rate: number }>();
  #strings: (Voice | null)[] = [];
  #preview: Voice | null = null;

  #timer: ReturnType<typeof setInterval> | undefined;
  #raf = 0;
  #nextStep = 0;
  #nextTime = 0;
  #endTime: number | null = null;
  #queue: { step: number; time: number }[] = [];

  constructor(tab: Tab) {
    this.#tab = tab;
  }

  /** Master volume, 0–1. */
  get volume() {
    return this.#volume;
  }

  set volume(v: number) {
    this.#volume = Math.max(0, Math.min(1, v));
    if (this.#ctx && this.#out) {
      // Short ramp avoids zipper noise while dragging the slider.
      this.#out.gain.setTargetAtTime(this.#gainFor(this.#volume), this.#ctx.currentTime, 0.02);
    }
  }

  /** Routes everything through a high-gain distortion amp. */
  get metal() {
    return this.#metal;
  }

  set metal(on: boolean) {
    this.#metal = on;
    if (this.#ctx && this.#clean && this.#dirty) {
      const t = this.#ctx.currentTime;
      this.#clean.gain.setTargetAtTime(on ? 0 : 1, t, SWITCH_S);
      this.#dirty.gain.setTargetAtTime(on ? METAL_LEVEL : 0, t, SWITCH_S);
    }
  }

  // Squared so the slider feels even to the ear rather than bunched at the top.
  #gainFor(v: number) {
    return v * v;
  }

  /** Create/resume the audio context. Call from a user gesture. */
  ensure(): AudioContext {
    if (!this.#ctx) {
      const ctx = new AudioContext();
      const gain = new GainNode(ctx, { gain: this.#gainFor(this.#volume) });
      const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000, Q: 0.5 });
      const limiter = new DynamicsCompressorNode(ctx, { threshold: -10, ratio: 8 });
      gain.connect(tone).connect(limiter).connect(ctx.destination);

      // Clean and metal paths both run all the time; toggling crossfades between them.
      const bus = new GainNode(ctx);
      const clean = new GainNode(ctx, { gain: this.#metal ? 0 : 1 });
      const dirty = new GainNode(ctx, { gain: this.#metal ? METAL_LEVEL : 0 });
      bus.connect(clean).connect(gain);
      bus.connect(metalAmp(ctx, dirty));
      dirty.connect(gain);

      this.#ctx = ctx;
      this.#bus = bus;
      this.#out = gain;
      this.#clean = clean;
      this.#dirty = dirty;
    }
    if (this.#ctx.state === 'suspended') void this.#ctx.resume();
    return this.#ctx;
  }

  /** Sound a single note right now, cutting off the previous preview. */
  pluck(string: number, fret: number) {
    const ctx = this.ensure();
    if (this.#preview) this.#release(this.#preview, ctx.currentTime);
    this.#preview = this.#voice(this.#tab.tuning[string].midi + fret, ctx.currentTime);
  }

  play(from = 0) {
    const ctx = this.ensure();
    this.stop();
    this.playing = true;
    this.#nextStep = Math.max(0, Math.min(from, this.#tab.steps - 1));
    this.#nextTime = ctx.currentTime + START_DELAY_S;
    this.#tick();
    this.#timer = setInterval(this.#tick, TICK_MS);
    this.#raf = requestAnimationFrame(this.#frame);
  }

  stop() {
    this.#halt();
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const v of this.#strings) if (v) this.#release(v, ctx.currentTime);
    this.#strings = [];
  }

  toggle(from = 0) {
    if (this.playing) this.stop();
    else this.play(from);
  }

  #halt() {
    clearInterval(this.#timer);
    cancelAnimationFrame(this.#raf);
    this.#queue = [];
    this.#endTime = null;
    this.playing = false;
    this.step = null;
  }

  #stepDuration() {
    return 60 / this.#tab.tempo / 4; // sixteenth notes
  }

  #tick = () => {
    const ctx = this.#ctx!;
    // If timers were throttled (background tab), skip ahead instead of bursting missed notes.
    if (this.#nextTime < ctx.currentTime) this.#nextTime = ctx.currentTime + START_DELAY_S;
    while (this.#nextTime < ctx.currentTime + LOOKAHEAD_S) {
      if (this.#nextStep >= this.#tab.steps) {
        if (!this.loop) {
          this.#endTime = this.#nextTime;
          clearInterval(this.#timer);
          return;
        }
        this.#nextStep = 0;
      }
      this.#scheduleStep(this.#nextStep, this.#nextTime);
      this.#queue.push({ step: this.#nextStep, time: this.#nextTime });
      this.#nextTime += this.#stepDuration();
      this.#nextStep++;
    }
  };

  #frame = () => {
    const now = this.#ctx!.currentTime;
    while (this.#queue.length && this.#queue[0].time <= now) {
      this.step = this.#queue.shift()!.step;
    }
    // Let the last notes ring out naturally rather than cutting them.
    if (this.#endTime !== null && now >= this.#endTime) this.#halt();
    else this.#raf = requestAnimationFrame(this.#frame);
  };

  #scheduleStep(step: number, time: number) {
    this.#tab.tuning.forEach((t, s) => {
      const note = this.#tab.at(s, step);
      if (!note) return;
      // A new note on a string mutes whatever that string was ringing.
      const ringing = this.#strings[s];
      if (ringing) this.#release(ringing, time);
      this.#strings[s] = this.#voice(t.midi + note.fret, time);
    });
  }

  #voice(midi: number, time: number): Voice {
    const ctx = this.#ctx!;
    let pluck = this.#plucks.get(midi);
    if (!pluck) {
      pluck = synthPluck(ctx, midi);
      this.#plucks.set(midi, pluck);
    }
    const src = new AudioBufferSourceNode(ctx, { buffer: pluck.buffer, playbackRate: pluck.rate });
    const gain = new GainNode(ctx, { gain: VELOCITY });
    src.connect(gain).connect(this.#bus!);
    src.start(time);
    return { src, gain };
  }

  #release(v: Voice, time: number) {
    v.gain.gain.setTargetAtTime(0, time, RELEASE_S);
    try {
      v.src.stop(time + RELEASE_S * 8);
    } catch {
      // already stopped
    }
  }
}
