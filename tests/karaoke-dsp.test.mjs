import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { encodeWav, runSeparation, centreReduce, makeFft, MODEL_DEF } = require('../public/karaoke-worker.js');

const sr = 44100;

/* The separation maths must match a torch/python reference: a centred STFT with
 * a periodic Hann window, MDX-Net chunks of 256 frames and 25% overlap. These
 * tests pin the parts that silently regress (FFT, STFT scaling, stem algebra). */

test('FFT handles MDX-Net sizes (6144 = 2^11 * 3) exactly', () => {
  for (const n of [1024, 2048, 5120, 6144, 7680]) {
    const fft = makeFft(n);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 7 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 301 * i) / n);
    const [re, im] = fft.forward(x);
    for (const k of [0, 1, 7, 301, 1000, n / 2, n - 1]) {
      let sr_ = 0, si = 0;
      for (let i = 0; i < n; i++) {
        const a = (-2 * Math.PI * k * i) / n;
        sr_ += x[i] * Math.cos(a);
        si += x[i] * Math.sin(a);
      }
      assert.ok(Math.abs(sr_ - re[k]) < 1e-4, `n=${n} k=${k} real`);
      assert.ok(Math.abs(si - im[k]) < 1e-4, `n=${n} k=${k} imag`);
    }
    const back = fft.inverse(re, im);
    for (let i = 0; i < n; i += 97) assert.ok(Math.abs(back[i] - x[i]) < 1e-5, `n=${n} inverse at ${i}`);
  }
});

/* A stand-in for ONNX Runtime that returns a predictable complex spectrogram, so
 * the worker's STFT -> model -> iSTFT -> stem algebra can be verified offline.
 * The stub echoes the mix spectrogram back for the first two planes, which is
 * exactly what an MDX "instrumental" model predicts for a mix with no lead vocal. */
function fakeOrt() {
  return {
    Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } },
    InferenceSession: {
      async create() {
        return {
          executionProviders: ['wasm'],
          async run({ input }) {
            const dims = input.dims;            // [1, 4, dimF, frames]
            const dimF = dims[2], frames = dims[3];
            const out = new Float32Array(4 * dimF * frames);
            out.set(input.data.subarray(0, 2 * dimF * frames), 0);
            return { output: { data: out, dims } };
          },
          async release() {},
        };
      },
    },
  };
}

function toneMix(seconds = 3) {
  const n = Math.round(sr * seconds);
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const centre = 0.25 * Math.sin(2 * Math.PI * 440 * t);   // the "vocal"
    const side = 0.18 * Math.sin(2 * Math.PI * 730 * t);     // stereo music
    const bass = 0.12 * Math.sin(2 * Math.PI * 80 * t);
    left[i] = centre + side + bass;
    right[i] = centre - side + bass;
  }
  return { left, right };
}

test('separation keeps a vocal-free mix intact and only touches what the model marks', async () => {
  const { left, right } = toneMix(3);
  const srcLeft = left.slice(), srcRight = right.slice();
  const result = await runSeparation(left, right, () => {}, { cancelled: false }, { loadOrt: async () => fakeOrt(), fetchModel: async () => new Uint8Array(8) }, { strength: 1 });
  assert.equal(result.left.length, srcLeft.length);
  assert.ok(Number.isFinite(result.gain) && result.gain > 0.25 && result.gain <= 4);
  assert.equal(result.model, MODEL_DEF.name);
  // Stereo width, low end and overall shape must survive: no hollow phase trick.
  const rmsRange = (a, b, from, to) => {
    let s = 0;
    for (let i = from; i < to; i++) s += a[i] * a[i] + b[i] * b[i];
    return Math.sqrt(s / (2 * (to - from)));
  };
  const before = rmsRange(srcLeft, srcRight, 20000, 90000);
  const after = rmsRange(result.left, result.right, 20000, 90000);
  assert.ok(after > before * 0.7 && after < before * 1.3, `level preserved (${before.toFixed(4)} -> ${after.toFixed(4)})`);
  let sideBefore = 0, sideAfter = 0;
  for (let i = 20000; i < 90000; i++) {
    sideBefore += ((srcLeft[i] - srcRight[i]) / 2) ** 2;
    sideAfter += ((result.left[i] - result.right[i]) / 2) ** 2;
  }
  assert.ok(sideAfter > sideBefore * 0.7, 'stereo width retained');
});

function vocalMarkingOrt() {
  const base = fakeOrt();
  return {
    Tensor: base.Tensor,
    InferenceSession: {
      async create(bytes, opts) {
        const session = await base.InferenceSession.create(bytes, opts);
        return {
          executionProviders: session.executionProviders,
          async release() {},
          async run({ input }) {
            const dims = input.dims;              // [1, 4, dimF, frames]
            const dimF = dims[2], frames = dims[3];
            const out = new Float32Array(4 * dimF * frames);
            const src = input.data;
            // "Vocal" = the mono sum of the input, i.e. everything centred.
            for (let b = 0; b < dimF; b++) {
              for (let f = 0; f < frames; f++) {
                const i = b * frames + f;
                const re = (src[i] + src[2 * dimF * frames + i]) / 2;
                const im = (src[dimF * frames + i] + src[3 * dimF * frames + i]) / 2;
                out[i] = re; out[dimF * frames + i] = im;
                out[2 * dimF * frames + i] = re; out[3 * dimF * frames + i] = im;
              }
            }
            return { output: { data: out, dims } };
          },
        };
      },
    },
  };
}

test('the strength slider scales the subtraction, from "no change" to the full model estimate', async () => {
  const { left, right } = toneMix(2);
  const deps = { loadOrt: async () => vocalMarkingOrt(), fetchModel: async () => new Uint8Array(8) };
  const rms = (a, b) => { let s = 0; for (let i = 30000; i < 60000; i++) s += a[i] * a[i] + b[i] * b[i]; return Math.sqrt(s / 60000); };
  const none = await runSeparation(left.slice(), right.slice(), () => {}, { cancelled: false }, deps, { strength: 0 });
  const full = await runSeparation(left.slice(), right.slice(), () => {}, { cancelled: false }, deps, { strength: 1 });
  assert.equal(none.strength, 0);
  assert.equal(full.strength, 1);
  // 0% must leave the song alone (gain-matched), 100% must visibly thin the centre.
  const src = rms(left, right);
  assert.ok(Math.abs(rms(none.left, none.right) / src - 1) < 0.12, '0% keeps the original level');
  let centreDiff = 0;
  for (let i = 30000; i < 60000; i++) {
    const midNone = (none.left[i] + none.right[i]) / 2;
    const midFull = (full.left[i] + full.right[i]) / 2;
    centreDiff += (midFull - midNone) ** 2;
  }
  assert.ok(Math.sqrt(centreDiff / 30000) > 0.01, '100% actually removes centre content');
});

test('cancellation stops separation and reports an abort', async () => {
  const { left, right } = toneMix(2);
  const state = { cancelled: false };
  const run = runSeparation(left, right, () => { state.cancelled = true; }, state, { loadOrt: async () => fakeOrt(), fetchModel: async () => new Uint8Array(8) }, {});
  await assert.rejects(run, /cancelled/i);
});

test('centre-reduction fallback still attenuates a centred voice and protects the intro', () => {
  const seconds = 4;
  const n = sr * seconds;
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const centre = 0.2 * Math.sin((2 * Math.PI * 440 * i) / sr) + 0.12 * Math.sin((2 * Math.PI * 70 * i) / sr);
    const side = 0.16 * Math.sin((2 * Math.PI * 730 * i) / sr + 0.2);
    left[i] = centre + side; right[i] = centre - side;
  }
  const original = left.slice();
  const info = centreReduce(left, right, sr, { strength: 1, introSeconds: 1 }, () => {});
  assert.ok(info.safetyGain > 0 && info.safetyGain <= 1);
  for (const i of [0, 1000, sr - 1]) assert.ok(Math.abs(left[i] - original[i]) < 1e-6, 'protected intro untouched');
  const amplitude = (a, b, hz, from, to, useSide) => {
    let re = 0, im = 0;
    for (let i = from; i < to; i++) {
      const v = useSide ? (a[i] - b[i]) / 2 : (a[i] + b[i]) / 2;
      re += v * Math.cos((2 * Math.PI * hz * i) / sr);
      im += v * Math.sin((2 * Math.PI * hz * i) / sr);
    }
    return 2 * Math.hypot(re, im) / (to - from);
  };
  const from = sr * 2, to = sr * 3;
  const before440 = amplitude(original, right, 440, from, to, false);
  const after440 = amplitude(left, right, 440, from, to, false);
  assert.ok(after440 < before440 * 0.5, `centred voice reduced (${before440.toFixed(4)} -> ${after440.toFixed(4)})`);
  const before730 = amplitude(original, right, 730, from, to, true);
  const after730 = amplitude(left, right, 730, from, to, true);
  assert.ok(after730 > before730 * 0.5, 'stereo music survives');
});

test('WAV encoding writes a valid 16-bit stereo header and bounded samples', () => {
  const { left, right } = toneMix(0.2);
  const wav = encodeWav(left, right, sr);
  const view = new DataView(wav);
  assert.equal(Buffer.from(wav, 0, 4).toString(), 'RIFF');
  assert.equal(Buffer.from(wav, 8, 4).toString(), 'WAVE');
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), sr);
  assert.equal(view.getUint32(40, true), left.length * 4);
  assert.equal(wav.byteLength, 44 + left.length * 4);
  for (let i = 44; i < wav.byteLength; i += 2) assert.ok(Math.abs(view.getInt16(i, true)) <= 32768);
});

test('the shipped model definition matches the python-audio-separator MDX parameters', async () => {
  assert.equal(MODEL_DEF.nFft, 6144);
  assert.equal(MODEL_DEF.hop, 1024);
  assert.equal(MODEL_DEF.dimF, 2048);
  assert.equal(MODEL_DEF.segmentSize, 256);
  assert.equal(MODEL_DEF.overlap, 0.25);
  assert.equal(MODEL_DEF.compensate, 1.065);
  const source = await readFile(new URL('../public/karaoke-worker.js', import.meta.url), 'utf8');
  assert.match(source, /UVR_MDXNET_KARA\.onnx/);
  assert.doesNotMatch(source, /postMessage\(\{ type: 'process'.*strength/);
});
