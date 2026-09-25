import type { Tab } from './tab.svelte';

const LOOKAHEAD_S = 0.12; // how far ahead notes are scheduled
const TICK_MS = 25; // how often the scheduler wakes up
const START_DELAY_S = 0.05;
const VELOCITY = 0.5;
const RELEASE_S = 0.015; // time constant for muting a ringing string

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

export class Player {
  playing = $state(false);
  loop = $state(false);
  /** Step currently under the playhead, or null when stopped. */
  step = $state<number | null>(null);

  #tab: Tab;
  #volume = $state(0.8);
  #ctx: AudioContext | null = null;
  #out: GainNode | null = null;
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
      this.#ctx = ctx;
      this.#out = gain;
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
    src.connect(gain).connect(this.#out!);
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
