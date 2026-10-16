import type { AmbientLoop } from "@cgwf/shared";

/**
 * Ambient table sound, synthesised with the Web Audio API (filtered noise), so
 * there are no audio files to license or download. Two loops: rain and a
 * fireplace. Off by default; the player turns it on in Personalize.
 */

let ctx: AudioContext | null = null;
let current: { kind: AmbientLoop; stop: () => void } | null = null;

function noiseBuffer(ac: AudioContext, seconds: number, brown: boolean): AudioBuffer {
  const len = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else {
      data[i] = white;
    }
  }
  return buf;
}

function startRain(ac: AudioContext, out: GainNode): () => void {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, 4, false);
  src.loop = true;
  const band = ac.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1800;
  band.Q.value = 0.6;
  const low = ac.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 5000;
  // Slow swell so it does not sound like a flat hiss.
  const lfo = ac.createOscillator();
  lfo.frequency.value = 0.13;
  const lfoGain = ac.createGain();
  lfoGain.gain.value = 0.08;
  const swell = ac.createGain();
  swell.gain.value = 0.28;
  lfo.connect(lfoGain).connect(swell.gain);
  src.connect(band).connect(low).connect(swell).connect(out);
  src.start();
  lfo.start();
  return () => {
    src.stop();
    lfo.stop();
  };
}

function startFire(ac: AudioContext, out: GainNode): () => void {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, 4, true);
  src.loop = true;
  const low = ac.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 500;
  const body = ac.createGain();
  body.gain.value = 0.5;
  src.connect(low).connect(body).connect(out);
  src.start();
  // Crackle: short bursts of high-passed noise at random intervals.
  const crackleSrc = ac.createBufferSource();
  crackleSrc.buffer = noiseBuffer(ac, 2, false);
  crackleSrc.loop = true;
  const hp = ac.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 2500;
  const crackle = ac.createGain();
  crackle.gain.value = 0;
  crackleSrc.connect(hp).connect(crackle).connect(out);
  crackleSrc.start();
  let alive = true;
  const pop = () => {
    if (!alive) return;
    const t = ac.currentTime;
    crackle.gain.cancelScheduledValues(t);
    crackle.gain.setValueAtTime(0.25 + Math.random() * 0.3, t);
    crackle.gain.exponentialRampToValueAtTime(0.001, t + 0.03 + Math.random() * 0.05);
    setTimeout(pop, 80 + Math.random() * 600);
  };
  pop();
  return () => {
    alive = false;
    src.stop();
    crackleSrc.stop();
  };
}

/** Play the chosen loop (or stop). Safe to call on every settings change. */
export function setAmbient(kind: AmbientLoop): void {
  if (current?.kind === kind) return;
  current?.stop();
  current = null;
  if (kind === "none") return;
  try {
    ctx ??= new AudioContext();
    const ac = ctx;
    void ac.resume();
    const out = ac.createGain();
    out.gain.value = 0.35;
    out.connect(ac.destination);
    const stop = kind === "rain" ? startRain(ac, out) : startFire(ac, out);
    current = {
      kind,
      stop: () => {
        stop();
        out.disconnect();
      },
    };
  } catch {
    current = null;
  }
}

export function stopAmbient(): void {
  setAmbient("none");
}
