/* SingVaza AI Vocal Remover — in-browser MDX-Net vocal separation.
 *
 * Real neural source separation (UVR / MDX-Net, MIT-licensed models) running
 * entirely inside this Web Worker through ONNX Runtime Web — WebGPU on phones
 * and desktops that support it, WebAssembly everywhere else. No audio is ever
 * uploaded: the song, the spectrograms and the stems stay on the device.
 *
 * Signal path (matches python-audio-separator / Ultimate Vocal Remover):
 *   mix -> centred STFT (n_fft 7680, hop 1024, periodic Hann, reflect padding)
 *       -> MDX-Net predicts the complex INSTRUMENTAL spectrogram, 25% overlapped
 *          chunks (Inst_HQ_3 predicts the backing directly; asking a model to
 *          predict the vocal and subtracting it left too much voice behind)
 *       -> iSTFT + overlap-add -> instrumental stem
 * The instrumental keeps its original low end, top end and stereo width, so it
 * sounds like the record instead of a hollow centre-cancelled phase trick.
 */

/* The model ships with the site as two static parts (Cloudflare Pages caps a
 * single asset at 25 MiB). They are fetched once, joined and then kept in Cache
 * Storage, so the second song never downloads them again. */
const MODEL_PARTS = ['/model/model-part1.part', '/model/model-part2.part'];
const MODEL_URL = 'https://huggingface.co/Tha456/uvr5-models/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx';
/* Self-hosted copy of the exact same model file. It is served from SingVaza's
 * own Cloudflare R2 bucket so the download is fast and does not depend on a
 * third party. If it is ever unreachable we fall back to MODEL_URL above. */
const MODEL_URL_R2 = '/model/UVR-MDX-NET-Inst_HQ_3.onnx';
const MODEL_BYTES = 47915709;
const MODEL_CACHE = 'singvaza-mdx-v2';
const MODEL_DEF = {
  name: 'UVR MDX-Net Inst HQ 3',
  nFft: 7680,
  hop: 1024,
  dimF: 3072,
  segmentSize: 32,
  overlap: 0.25,
  // The network is trained on audio peak-normalised to full scale and it
  // returns the instrumental slightly below the level of its own input
  // (measured: -3.6 dB on music, -8.9 dB on a pure backing track). The peak is
  // multiplied back after the iSTFT, so this only has to make up the rest.
  output: 'instrumental',
  compensate: 1.42,
};
const MAX_SECONDS = 9 * 60;

let ortPromise = null;
let ortBackend = 'wasm';

async function loadOrt() {
  if (ortPromise) return ortPromise;
  ortPromise = (async () => {
    const src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs';
    const mod = await import(/* @vite-ignore */ src);
    const ort = mod.default || mod;
    if (!ort || !ort.InferenceSession) throw new Error('ORT unavailable');
    ort.env.wasm.wasmPaths = src.replace(/ort\.[a-z]+\.min\.mjs$/, '');
    // Single threaded by default: low-memory phones kill the worker with
    // SharedArrayBuffer threads, and the model is small enough without them.
    ort.env.wasm.numThreads = 1;
    ortBackend = 'wasm';
    return ort;
  })();
  try {
    return await ortPromise;
  } catch (err) {
    ortPromise = null;
    throw new Error('The separation engine could not be loaded. Check your connection and try again.');
  }
}

/* One cache key for the joined model, whichever way it arrived. */
const MODEL_URL_PARTS_KEY = '/model/inst-hq-3.joined';

function modelSources() {
  const list = [MODEL_URL_PARTS_KEY, MODEL_URL_R2, MODEL_URL];
  return list.filter((u, i) => u && list.indexOf(u) === i);
}

/* Look in the cache under every known location: a browser that already
 * downloaded the model from HuggingFace must NOT download it again after the
 * switch to the self-hosted copy - we migrate that cached copy across. */
async function cachedModelBytes(cache, onProgress) {
  if (!cache) return null;
  for (const url of modelSources()) {
    try {
      const hit = await cache.match(url);
      if (!hit) continue;
      const buf = new Uint8Array(await hit.arrayBuffer());
      if (buf.byteLength > 1000000) {
        onProgress({ stage: 'model-cached' });
        return buf;
      }
    } catch (_) {}
  }
  return null;
}

async function downloadModelBytes(url, onProgress) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || MODEL_BYTES;
  let bytes;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const out = new Uint8Array(total);
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (seen + value.length > out.length) {
        const grown = new Uint8Array(Math.max(out.length * 2, seen + value.length));
        grown.set((bytes || out).subarray(0, seen));
        bytes = grown;
      }
      (bytes || out).set(value, seen);
      seen += value.length;
      onProgress({ stage: 'model', loaded: seen, total });
    }
    const target = bytes || out;
    bytes = seen === target.length ? target : target.slice(0, seen);
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (!bytes || bytes.byteLength < 1000000) throw new Error('the download was incomplete');
  return bytes;
}

async function downloadModelParts(onProgress) {
  const parts = [];
  let total = 0, seen = 0;
  for (const url of MODEL_PARTS) {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < 1000000) throw new Error('a model part was incomplete');
    parts.push(buf);
    total += buf.byteLength;
  }
  const joined = new Uint8Array(total);
  for (const part of parts) { joined.set(part, seen); seen += part.byteLength; }
  onProgress({ stage: 'model', loaded: total, total });
  return joined;
}

async function fetchModelBytes(onProgress) {
  let cache = null;
  try { if (typeof caches !== 'undefined') cache = await caches.open(MODEL_CACHE); } catch (_) { cache = null; }
  const cached = await cachedModelBytes(cache, onProgress);
  if (cached) return cached;

  let lastError = null;
  // Preferred path: the two static parts that ship with the site itself. No
  // worker bundle, no 25 MiB asset limit, no third-party host.
  {
    try {
      const joined = await downloadModelParts(onProgress);
      try { await cache.put(MODEL_URL_PARTS_KEY, new Response(joined.buffer, { headers: { 'content-type': 'application/octet-stream' } })); } catch (_) {}
      return joined;
    } catch (err) { lastError = err; }
  }
  for (const url of modelSources()) {
    if (url === MODEL_URL_PARTS_KEY) continue;   // handled above
    try {
      const bytes = await downloadModelBytes(url, onProgress);
      if (cache) {
        try {
          // One stored copy, no extra buffers: this model is ~48 MB, and every
          // extra copy of it is real memory on a phone.
          await cache.put(MODEL_URL_PARTS_KEY, new Response(bytes.buffer, { headers: { 'content-type': 'application/octet-stream' } }));
        } catch (_) {}
      }
      return bytes;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`The vocal model could not be downloaded${lastError ? ` (${lastError.message})` : ''}.`);
}

/* ---------------- FFT (any 7-smooth length) ---------------- */
function radix2(re, im, off, len, twCos, twSin) {
  for (let i = 1, j = 0; i < len; i++) {
    let bit = len >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[off + i]; re[off + i] = re[off + j]; re[off + j] = t;
      t = im[off + i]; im[off + i] = im[off + j]; im[off + j] = t;
    }
  }
  for (let size = 2; size <= len; size <<= 1) {
    const half = size >> 1, step = len / size;
    for (let base = 0; base < len; base += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = off + base + j, b = a + half;
        const c = twCos[k], s = twSin[k];
        const vr = re[b] * c - im[b] * s, vi = re[b] * s + im[b] * c;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
      }
    }
  }
}

function makeFft(n) {
  const twCos = new Float64Array(n), twSin = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = (-2 * Math.PI * i) / n; twCos[i] = Math.cos(a); twSin[i] = Math.sin(a); }
  const isPow2 = (v) => (v & (v - 1)) === 0;
  const re = new Float64Array(n), im = new Float64Array(n);
  function rec(re, im, off, len, outRe, outIm, outOff) {
    if (isPow2(len)) {
      for (let i = 0; i < len; i++) { outRe[outOff + i] = re[off + i]; outIm[outOff + i] = im[off + i]; }
      radix2(outRe, outIm, outOff, len, twCos, twSin);
      return;
    }
    const p = [2, 3, 5, 7].find((f) => len % f === 0);
    const m = len / p;
    const subRe = new Float64Array(m), subIm = new Float64Array(m);
    const yRe = new Float64Array(p * m), yIm = new Float64Array(p * m);
    for (let r = 0; r < p; r++) {
      for (let j = 0; j < m; j++) { subRe[j] = re[off + j * p + r]; subIm[j] = im[off + j * p + r]; }
      rec(subRe, subIm, 0, m, yRe, yIm, r * m);
    }
    for (let k = 0; k < len; k++) {
      let sr = 0, si = 0;
      const km = k % m;
      for (let r = 0; r < p; r++) {
        const tw = (r * k * (n / len)) % n;
        const c = twCos[tw], s = twSin[tw];
        const vr = yRe[r * m + km], vi = yIm[r * m + km];
        sr += c * vr - s * vi;
        si += c * vi + s * vr;
      }
      outRe[outOff + k] = sr; outIm[outOff + k] = si;
    }
  }
  const tmpRe = new Float64Array(n), tmpIm = new Float64Array(n);
  return {
    forward(input) {
      for (let i = 0; i < n; i++) { re[i] = input[i]; im[i] = 0; }
      rec(re, im, 0, n, tmpRe, tmpIm, 0);
      return [tmpRe, tmpIm];
    },
    inverse(specRe, specIm) {
      for (let i = 0; i < n; i++) { re[i] = specRe[i]; im[i] = -specIm[i]; }
      rec(re, im, 0, n, tmpRe, tmpIm, 0);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = tmpRe[i] / n;
      return out;
    },
  };
}

function periodicHann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/* ---------------- STFT / iSTFT (torch.stft compatible) ---------------- */
function makeStft(def) {
  const fft = makeFft(def.nFft);
  const window = periodicHann(def.nFft);
  const trim = def.nFft >> 1;
  const scratch = new Float32Array(def.nFft);
  return {
    trim,
    window,
    // x is already reflect-padded and is an exact multiple of hop
    forward(x, frames, outReal, outImag) {
      for (let f = 0; f < frames; f++) {
        const off = f * def.hop;
        for (let i = 0; i < def.nFft; i++) scratch[i] = x[off + i] * window[i];
        const [specRe, specIm] = fft.forward(scratch);
        for (let b = 0; b < def.dimF; b++) {
          outReal[b * frames + f] = specRe[b];
          outImag[b * frames + f] = specIm[b];
        }
      }
    },
    inverse(real, imag, frames, length) {
      const nBins = (def.nFft >> 1) + 1;
      const out = new Float32Array(def.nFft + def.hop * Math.max(0, frames - 1));
      const weight = new Float32Array(out.length);
      const specRe = new Float64Array(def.nFft), specIm = new Float64Array(def.nFft);
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < nBins; b++) {
          if (b < def.dimF) { specRe[b] = real[b * frames + f]; specIm[b] = imag[b * frames + f]; }
          else { specRe[b] = 0; specIm[b] = 0; }
        }
        // The model only predicts the one-sided spectrum, so the negative
        // frequencies have to be rebuilt as their complex conjugates before the
        // inverse DFT. Without this mirror the tone comes back at half
        // amplitude, which made the subtracted vocal about 6 dB too quiet - the
        // "nothing happens" the tool used to show. (torch.istft does the same.)
        for (let b = 1; b < nBins - 1; b++) { specRe[def.nFft - b] = specRe[b]; specIm[def.nFft - b] = -specIm[b]; }
        const frame = fft.inverse(specRe, specIm);
        const off = f * def.hop;
        for (let i = 0; i < def.nFft; i++) {
          out[off + i] += frame[i] * window[i];
          weight[off + i] += window[i] * window[i];
        }
      }
      const res = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const w = weight[i + trim];
        res[i] = w > 1e-8 ? out[i + trim] / w : 0;
      }
      return res;
    },
  };
}

/* torch's reflect padding (what UVR uses): the sample next to the edge is NOT
 * repeated, the mirror starts one step inside. Getting this wrong leaves a
 * click/level step at every chunk boundary. */
function reflectPadInto(src, out, pad) {
  const n = src.length;
  out.set(src.subarray(0, n), pad);
  for (let i = 0; i < pad; i++) {
    out[i] = src[Math.max(0, pad - i)] || 0;
    out[pad + n + i] = src[Math.max(0, n - 2 - i)] || 0;
  }
}

/* How many frames of the model to run at once. `deviceMemory` is reported in
 * GB by Chromium; Safari/Firefox do not report it, so they get the safe middle
 * value. Bigger is faster and slightly cleaner, but uses more memory. */
function pickSegmentSize() {
  const mem = (typeof navigator !== 'undefined' && Number(navigator.deviceMemory)) || 4;
  if (mem >= 8) return 128;
  if (mem >= 4) return 64;
  return 32;
}

/* ---------------- separation ---------------- */
async function runSeparation(left, right, onProgress, state, deps, options) {
  const def = MODEL_DEF;
  const loadEngine = (deps && deps.loadOrt) || loadOrt;
  const loadModel = (deps && deps.fetchModel) || fetchModelBytes;
  const ort = await loadEngine();
  onProgress({ stage: 'engine', backend: ortBackend });
  const modelBytes = await loadModel(onProgress);
  if (state.cancelled) throw abortError();
  onProgress({ stage: 'session' });
  const providers = ortBackend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
  // The arena/memory-pattern allocators grab a large block up front for this
  // model (measured: a multi-hundred-MB peak on a single 12 MB chunk, enough to
  // get the tab killed on a phone). Allocating per tensor instead keeps the peak
  // close to the real tensor sizes.
  const sessionOptions = {
    executionProviders: providers,
    enableCpuMemArena: false,
    enableMemPattern: false,
    executionMode: 'sequential',
  };
  let session;
  try {
    session = await ort.InferenceSession.create(modelBytes, sessionOptions);
  } catch (_) {
    session = await ort.InferenceSession.create(modelBytes, { ...sessionOptions, executionProviders: ['wasm'] });
    ortBackend = 'wasm';
  }
  const release = async () => { try { await session.release?.(); } catch (_) {} };

  // The model was trained on audio normalised to full scale (what UVR and
  // python-audio-separator do before every demix: peak -> 1.0, result scaled
  // back afterwards). Feeding it a raw -12 dB mix makes the predicted vocal
  // roughly ten times too quiet, which is exactly what "nothing changes" looks
  // like. Every chunk is therefore divided by one song-wide peak first.
  let songPeak = 1e-9;
  for (let i = 0; i < left.length; i++) {
    const a = Math.abs(left[i]), b = Math.abs(right[i]);
    if (a > songPeak) songPeak = a;
    if (b > songPeak) songPeak = b;
  }
  const norm = songPeak > 0 ? 1 / songPeak : 1;

  const opts = options || {};
  // strength: how much of the model's instrumental is used (1 = the model's full
  // estimate, 0.85 = keep 15% of the original mix in, so the track still sounds
  // alive in quiet passages).
  const strength = Number.isFinite(Number(opts.strength)) ? Math.min(1, Math.max(0, Number(opts.strength))) : 0.85;
  const targetSeconds = left.length / 44100;
  const introSeconds = Number.isFinite(Number(opts.introSeconds)) ? Math.max(0, Math.min(Number(opts.introSeconds), targetSeconds - 0.01)) : 0;
  // Level of the predicted instrumental relative to its chunk, and how much of
  // that prediction replaces the mix.
  const modelGain = def.compensate;
  const wet = strength;
  // The model's time axis is dynamic, so the chunk length is a trade between
  // speed and accuracy: more frames per chunk = fewer, heavier passes. A phone
  // with little memory must stay small or the tab is killed; a desktop can go
  // several times bigger and is then both faster and cleaner.
  const segSize = Math.max(8, Math.round(opts.segmentSize || pickSegmentSize()));
  const modelDef = { ...def, segmentSize: segSize };
  const stft = makeStft(modelDef);
  const chunk = def.hop * (segSize - 1);
  const trim = stft.trim;
  const gen = chunk - 2 * trim;
  const step = Math.floor((1 - def.overlap) * chunk);
  const chunkWindow = periodicHann(chunk);
  const n = left.length;
  const padLen = gen + trim - (n % gen);
  const total = n + trim + padLen;
  const frames = segSize;
  const stride = def.dimF * frames;

  // Only the accumulated instrumental, its window weight and per-chunk scratch
  // are kept in memory, so long songs stay inside a phone's budget.
  const outL = new Float32Array(total), outR = new Float32Array(total);
  const weight = new Float32Array(total);
  const chunkL = new Float32Array(chunk), chunkR = new Float32Array(chunk);
  const padL = new Float32Array(chunk + 2 * trim), padR = new Float32Array(chunk + 2 * trim);
  const input = new Float32Array(4 * stride);
  const Lr = new Float32Array(stride), Li = new Float32Array(stride);
  const Rr = new Float32Array(stride), Ri = new Float32Array(stride);
  const starts = [];
  for (let s = 0; s < total; s += step) starts.push(s);

  let done = 0;
  for (const start of starts) {
    if (state.cancelled) { await release(); throw abortError(); }
    const end = Math.min(start + chunk, total);
    const span = end - start;
    chunkL.fill(0); chunkR.fill(0);
    chunkL.set(left.subarray(Math.max(0, start - trim), Math.max(0, end - trim)));
    chunkR.set(right.subarray(Math.max(0, start - trim), Math.max(0, end - trim)));
    if (norm !== 1) { for (let i = 0; i < chunk; i++) { chunkL[i] *= norm; chunkR[i] *= norm; } }
    reflectPadInto(chunkL, padL, trim);
    reflectPadInto(chunkR, padR, trim);
    stft.forward(padL, frames, Lr, Li);
    stft.forward(padR, frames, Rr, Ri);
    input.set(Lr, 0); input.set(Li, stride); input.set(Rr, stride * 2); input.set(Ri, stride * 3);

    const tensor = new ort.Tensor('float32', input, [1, 4, def.dimF, frames]);
    let outputs;
    try {
      outputs = await session.run({ input: tensor });
    } catch (err) {
      await release();
      throw new Error('The vocal model could not process this file on this device.');
    }
    const out = outputs.output ? outputs.output.data : Object.values(outputs)[0].data;
    const instWaveL = stft.inverse(out.subarray(0, stride), out.subarray(stride, stride * 2), frames, chunk);
    const instWaveR = stft.inverse(out.subarray(stride * 2, stride * 3), out.subarray(stride * 3, stride * 4), frames, chunk);
    const scale = modelGain / norm;
    for (let i = 0; i < chunk; i++) { instWaveL[i] *= scale; instWaveR[i] *= scale; }

    for (let i = 0; i < span; i++) {
      const w = chunkWindow[i];
      const gx = start + i - trim;          // index inside the original signal
      if (gx < 0 || gx >= n) continue;
      // wet = the model's backing, dry = the untouched mix; the strength slider
      // blends between them so 85% still sounds natural.
      const wl = left[gx] * (1 - wet) + instWaveL[i] * wet;
      const wr = right[gx] * (1 - wet) + instWaveR[i] * wet;
      outL[gx] += wl * w;
      outR[gx] += wr * w;
      weight[gx] += w;
    }
    done += 1;
    onProgress({ stage: 'separate', fraction: done / starts.length, chunk: done, chunks: starts.length });
    await new Promise((r) => setTimeout(r, 0));
  }
  await release();

  // Normalise by the accumulated window and apply one static loudness match so
  // the backing keeps the original level inside the mixer.
  let srcSum = 0, outSum = 0;
  for (let i = 0; i < n; i++) {
    const w = weight[i];
    if (w > 1e-6) { outL[i] /= w; outR[i] /= w; } else { outL[i] = left[i]; outR[i] = right[i]; }
    srcSum += left[i] * left[i] + right[i] * right[i];
    outSum += outL[i] * outL[i] + outR[i] * outR[i];
  }
  const introSamples = Math.round(introSeconds * 44100);
  const fadeSamples = Math.max(1, Math.round(44100 * 0.65));
  if (introSamples > 0) {
    for (let i = 0; i < n; i++) {
      let keep = 0;
      if (i < introSamples) keep = 1;
      else if (i < introSamples + fadeSamples) { const t = Math.sin(((i - introSamples) / fadeSamples) * Math.PI * 0.5); keep = 1 - t * t; }
      if (keep > 0) { outL[i] = left[i] * keep + outL[i] * (1 - keep); outR[i] = right[i] * keep + outR[i] * (1 - keep); }
    }
  }
  let gain = outSum > 1e-9 && srcSum > 1e-9 ? Math.min(4, Math.max(0.25, Math.sqrt(srcSum / outSum))) : 1;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(outL[i] * gain), Math.abs(outR[i] * gain));
  if (peak > 0.995) gain *= 0.995 / peak;
  if (gain !== 1) for (let i = 0; i < n; i++) { outL[i] *= gain; outR[i] *= gain; }
  return {
    left: outL.length === n ? outL : outL.slice(0, n),
    right: outR.slice(0, n),
    gain,
    backend: ortBackend,
    model: def.name,
    strength,
    introSeconds: introSeconds,
  };
}

function abortError() {
  return Object.assign(new Error('Processing cancelled.'), { name: 'AbortError' });
}

/* ---------------- WAV ---------------- */
function encodeWav(left, right, sampleRate, progress) {
  if (!left || !right || left.length !== right.length) throw new Error('Invalid stereo audio.');
  const length = left.length;
  if (length * 4 + 44 > 0xffffffff) throw new Error('This track is too long to encode as WAV.');
  const bytes = new ArrayBuffer(44 + length * 4);
  const view = new DataView(bytes);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + length * 4, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, length * 4, true);
  for (let i = 0, off = 44; i < length; i++, off += 4) {
    const a = Math.min(1, Math.max(-1, Number.isFinite(left[i]) ? left[i] : 0));
    const b = Math.min(1, Math.max(-1, Number.isFinite(right[i]) ? right[i] : 0));
    view.setInt16(off, a < 0 ? Math.round(a * 32768) : Math.round(a * 32767), true);
    view.setInt16(off + 2, b < 0 ? Math.round(b * 32768) : Math.round(b * 32767), true);
    if (progress && i && i % (sampleRate * 15) === 0) progress(i / length);
  }
  return bytes;
}

/* ---------------- offline centre-reduction fallback ---------------- */
function filterBothWays(data, alpha) {
  for (let pass = 0; pass < 2; pass++) {
    let y = data[0] || 0;
    for (let i = 0; i < data.length; i++) { y += alpha * (data[i] - y); data[i] = y; }
    y = data[data.length - 1] || 0;
    for (let i = data.length - 1; i >= 0; i--) { y += alpha * (data[i] - y); data[i] = y; }
  }
}

function centreReduce(left, right, sampleRate, options, progress) {
  const length = left.length;
  const strength = Math.min(1, Math.max(0, Number(options && options.strength) || 0.85));
  const introSamples = Math.min(length, Math.round((Number(options && options.introSeconds) || 0) * sampleRate));
  const fadeSamples = Math.max(1, Math.round(sampleRate * 0.65));
  const bassHz = 220 - strength * 100;
  const airHz = Math.min(sampleRate * 0.39, 8500 + strength * 3500);
  const bassAlpha = 1 - Math.exp((-2 * Math.PI * Math.min(sampleRate * 0.42, bassHz * 1.55)) / sampleRate);
  const airAlpha = 1 - Math.exp((-2 * Math.PI * Math.min(sampleRate * 0.42, airHz * 1.55)) / sampleRate);
  const blockSize = Math.max(4096, Math.round(sampleRate * 3));
  const pad = Math.max(128, Math.round(sampleRate * 0.16));
  let tailL = new Float32Array(0), tailR = new Float32Array(0);
  let peak = 0;
  for (let start = 0; start < length; start += blockSize) {
    const end = Math.min(length, start + blockSize);
    const from = Math.max(0, start - pad);
    const to = Math.min(length, end + pad);
    const low = new Float32Array(to - from);
    const highLow = new Float32Array(to - from);
    for (let j = 0; j < low.length; j++) {
      const k = from + j;
      const l = k < start ? tailL[k - from] : left[k];
      const r = k < start ? tailR[k - from] : right[k];
      low[j] = highLow[j] = (l + r) * 0.5;
    }
    filterBothWays(low, bassAlpha);
    filterBothWays(highLow, airAlpha);
    const nextTailStart = Math.max(start, end - pad);
    tailL = left.slice(nextTailStart, end);
    tailR = right.slice(nextTailStart, end);
    for (let i = start; i < end; i++) {
      const l = left[i], r = right[i], mid = (l + r) * 0.5, side = (l - r) * 0.5;
      const keptMid = (1 - strength) * mid + strength * (low[i - from] + mid - highLow[i - from]);
      let mix = 1;
      if (introSamples > 0) {
        if (i < introSamples) mix = 0;
        else if (i < introSamples + fadeSamples) {
          const s = Math.sin(((i - introSamples) / fadeSamples) * Math.PI * 0.5);
          mix = s * s;
        }
      }
      const outL = l + ((keptMid + side) - l) * mix;
      const outR = r + ((keptMid - side) - r) * mix;
      left[i] = outL; right[i] = outR;
      peak = Math.max(peak, Math.abs(outL), Math.abs(outR));
    }
    if (progress) progress(0.05 + (0.8 * end) / length);
  }
  const safetyGain = peak > 1 ? 0.999 / peak : 1;
  if (safetyGain < 1) for (let i = 0; i < length; i++) { left[i] *= safetyGain; right[i] *= safetyGain; }
  return { safetyGain, strength, introSeconds: introSamples / sampleRate };
}

/* =====================================================================
 * Instant centre/L-R vocal reducer — no model, no download, phone-friendly.
 *
 * Why this exists: the 48 MB MDX model needs ~400 MB of RAM and several
 * minutes on a phone, so on Firefox Android the tool was unusable. This
 * path is pure arithmetic over the samples the page already holds: it runs
 * in a couple of seconds, works on every browser, and needs no network at
 * all after the page loads.
 *
 * How it works (the good version of the old "centre cancel"):
 *  - Lead vocals are recorded dead centre with little reverb.
 *  - Split into mid (M = L+R) and side (S = L-R).
 *  - M is band-split: deep bass and the very top belong to the music, not
 *    the voice, so those bands are kept intact instead of being scooped out
 *    (that scoop is what made the old output sound like "highs cut off").
 *  - In the vocal band (about 250 Hz - 9 kHz) the amount removed adapts to
 *    how much of the signal is centred *right now*: a loud centred voice is
 *    cut hard, a wide stereo music bed is left almost alone. This stops the
 *    hole in the middle and the pumping that a fixed filter causes.
 *  - A short Haas-style side reverb (~12 ms, low-passed) is added back to
 *    the reduced centre, so the result keeps space instead of sounding
 *    phasey and flat.
 *  - Level is matched to the original and peak-limited, so nothing clips.
 * ===================================================================== */

/* STFT settings for the instant path. n_fft 2048 @ 44.1 kHz = 21.5 Hz bins,
 * hop 512 = 75% overlap with a Hann window (proper COLA), so the inverse is
 * clean and nothing has to be normalised afterwards. */
const INSTANT_FFT = 2048;
const INSTANT_HOP = 512;

function vocalBandSplit(input, sampleRate) {
  // Bass / vocal / air split used for the band limits.
  const n = input.length;
  const bass = new Float32Array(n);
  const air = new Float32Array(n);
  const vocal = new Float32Array(n);
  const bassHz = 250;
  const airHz = 9000;
  const aLow = 1 - Math.exp((-2 * Math.PI * Math.min(sampleRate * 0.45, bassHz)) / sampleRate);
  const aHigh = 1 - Math.exp((-2 * Math.PI * Math.min(sampleRate * 0.45, airHz)) / sampleRate);
  let low1 = 0, low2 = 0, high1 = 0, high2 = 0;
  for (let i = 0; i < n; i++) {
    const x = input[i];
    low1 += aLow * (x - low1);
    low2 += aLow * (low1 - low2);
    high1 += aHigh * (x - high1);
    high2 += aHigh * (high1 - high2);
    bass[i] = low2;
    air[i] = x - high2;
    vocal[i] = high2 - low2;
  }
  return { bass, vocal, air };
}

/* Instant vocal reduction — no model, no download, works on phones.
 *
 * The 48 MB MDX model needs hundreds of MB of RAM and minutes of CPU, which is
 * why the tool was unusable on Firefox Android. This path does the separation
 * with arithmetic on the samples the page already has: seconds, not minutes.
 *
 * Method (a proper spectral centre-remover, not a one-knob cancel):
 *  1. STFT each channel (2048 / 512).
 *  2. Per frequency bin, measure across the whole song how much energy is
 *     centred: M = (L+R)/2, S = (L-R)/2. A bin that is mostly M is centred
 *     content = lead vocal (or bass/kick, which are centred too).
 *  3. Bins inside the vocal range (250 Hz - 9 kHz) that are strongly centred
 *     get their centre part attenuated; wide stereo bins are barely touched.
 *     That keeps guitars, keys and reverb width, which a fixed L-R cancel
 *     throws away — the old output's hollow, "highs cut off" sound.
 *  4. Bass and the very top are left almost untouched: bass and cymbals carry
 *     the song and are not the vocal.
 *  5. The removed centre is not discarded: a share of it is re-injected with
 *     the side signal, so the mix does not collapse into mono.
 *  6. ttt: the result is loudness-matched to the original and peak-limited.
 */
function instantReduce(left, right, sampleRate, options, progress) {
  const n = left.length;
  const strength = Math.min(1, Math.max(0.35, Number(options && options.strength) || 0.85));
  const introSamples = Math.min(n, Math.round((Number(options && options.introSeconds) || 0) * sampleRate));
  const fadeSamples = Math.max(1, Math.round(sampleRate * 0.5));

  const T = Object.assign({ centreLo: 0.50, centreSpan: 0.25, depth: 0.95, back: 0.12, gateLo: 0.58, gateSpan: 0.25, att: 0.6, rel: 0.18 }, (options && options.tune) || {});
  const fftSize = Math.min(INSTANT_FFT, 1 << Math.floor(Math.log2(Math.min(2048, Math.max(256, n / 4)))));
  const hop = fftSize >> 2;
  const bins = (fftSize >> 1) + 1;
  const fft = makeFft(fftSize);
  const window = periodicHann(fftSize);
  const hzPerBin = sampleRate / fftSize;
  const binOf = (hz) => Math.min(bins - 1, Math.max(0, Math.round(hz / hzPerBin)));
  const vocalLo = binOf(250);
  const vocalHi = binOf(Math.min(9500, sampleRate * 0.45));

  const frames = Math.max(1, Math.ceil(n / hop));

  // ---- pass 1: how centred is each frequency, across the whole song ----
  // |M|^2 and |S|^2 are computed from the exact complex cross-spectrum, not
  // from an assumption, so wide stereo music is not mistaken for a vocal.
  const centredRatio = new Float32Array(bins);
  {
    const eL = new Float64Array(bins), eR = new Float64Array(bins), xc = new Float64Array(bins);
    const lr = new Float64Array(bins), li = new Float64Array(bins);
    const rr2 = new Float64Array(bins), ri = new Float64Array(bins);
    const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let ch = 0; ch < 2; ch++) {
        const src = ch === 0 ? left : right;
        for (let i = 0; i < fftSize; i++) { const k = off + i; re[i] = (k < n ? src[k] : 0) * window[i]; im[i] = 0; }
        const [sr, si] = fft.forward(re);
        const dstR = ch === 0 ? lr : rr2, dstI = ch === 0 ? li : ri;
        for (let b = 0; b < bins; b++) { dstR[b] = sr[b]; dstI[b] = si[b]; }
      }
      for (let b = 0; b < bins; b++) {
        eL[b] += lr[b] * lr[b] + li[b] * li[b];
        eR[b] += rr2[b] * rr2[b] + ri[b] * ri[b];
        xc[b] += lr[b] * rr2[b] + li[b] * ri[b];   // Re(L * conj(R))
      }
      if (progress && (f & 63) === 0) progress(0.02 + 0.23 * (f / frames));
    }
    for (let b = 0; b < bins; b++) {
      const m2 = Math.max(0, (eL[b] + eR[b]) * 0.25 + xc[b] * 0.5);
      const s2 = Math.max(0, (eL[b] + eR[b]) * 0.25 - xc[b] * 0.5);
      centredRatio[b] = m2 + s2 > 1e-12 ? m2 / (m2 + s2) : 0;
    }
  }

  // ---- per-bin removal curve ----
  // 1.0 = leave alone, 0.0 = remove the centred part.
  const centreKeep = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const hz = b * hzPerBin;
    const c = centredRatio[b];
    // Only strongly centred bins inside the voice range are candidates.
    const inVoice = hz >= 250 && hz <= Math.min(9500, sampleRate * 0.45) ? 1 : 0;
    // Smooth ramp at the edges so there is no audible seam at 250 Hz / 9 kHz.
    const edgeLo = Math.min(1, Math.max(0, (hz - 180) / 90));
    const edgeHi = Math.min(1, Math.max(0, (Math.min(9500, sampleRate * 0.45) - hz) / 700));
    const weight = inVoice * edgeLo * edgeHi;
    // centred-ness 0.55 -> nothing removed, 0.95 -> full removal
    const centreness = Math.min(1, Math.max(0, (c - T.centreLo) / T.centreSpan));
    const depth = T.depth * strength;      // how much of the centre goes
    centreKeep[b] = 1 - weight * centreness * depth;
  }
  // Smooth the curve across neighbouring bins (removes musical noise).
  {
    const tmp = Float32Array.from(centreKeep);
    const r = 3;
    for (let b = 0; b < bins; b++) {
      let acc = 0, wsum = 0;
      for (let k = -r; k <= r; k++) {
        const idx = b + k;
        if (idx < 0 || idx >= bins) continue;
        const w = r + 1 - Math.abs(k);
        acc += tmp[idx] * w; wsum += w;
      }
      centreKeep[b] = acc / wsum;
    }
  }

  // ---- pass 2: rebuild ----
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const norm = new Float32Array(n);
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  const specLr = new Float64Array(bins), specLi = new Float64Array(bins);
  const specRr = new Float64Array(bins), specRi = new Float64Array(bins);
  const fullRe = new Float64Array(fftSize), fullIm = new Float64Array(fftSize);

  let gateSmooth = 0;
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let ch = 0; ch < 2; ch++) {
      const src = ch === 0 ? left : right;
      for (let i = 0; i < fftSize; i++) { const k = off + i; re[i] = (k < n ? src[k] : 0) * window[i]; im[i] = 0; }
      const [sr, si] = fft.forward(re);
      const tr = ch === 0 ? specLr : specRr;
      const ti = ch === 0 ? specLi : specRi;
      for (let b = 0; b < bins; b++) { tr[b] = sr[b]; ti[b] = si[b]; }
    }
    // Voice-activity gate for this instant: if the vocal band is not centred
    // right now (instrumental break, wide chorus stack) leave it alone.
    let mE = 0, sE = 0;
    for (let b = vocalLo; b <= vocalHi; b++) {
      const m2 = Math.max(0, (Math.abs(specLr[b]) ** 2 + Math.abs(specRr[b]) ** 2) * 0.25 + (specLr[b] * specRr[b] + specLi[b] * specRi[b]) * 0.5);
      const s2 = Math.max(0, (Math.abs(specLr[b]) ** 2 + Math.abs(specRr[b]) ** 2) * 0.25 - (specLr[b] * specRr[b] + specLi[b] * specRi[b]) * 0.5);
      mE += m2; sE += s2;
    }
    const frameCentre = mE + sE > 1e-12 ? mE / (mE + sE) : 0;
    const gateTarget = Math.min(1, Math.max(0, (frameCentre - T.gateLo) / T.gateSpan));
    gateSmooth += (gateTarget - gateSmooth) * (gateTarget > gateSmooth ? T.att : T.rel);
    for (let b = 0; b < bins; b++) {
      const lr = specLr[b], li = specLi[b], rr = specRr[b], ri = specRi[b];
      const mr = (lr + rr) * 0.5, mi = (li + ri) * 0.5;   // centre
      const srr = (lr - rr) * 0.5, sri = (li - ri) * 0.5;  // side
      const keep = 1 - (1 - centreKeep[b]) * gateSmooth;
      // Keep the side fully, plus the part of the centre we did not remove.
      // A little centre is added back so the image does not go hollow.
      const back = T.back * (1 - keep);
      const kg = keep + back;
      const nl = (srr + kg * mr), ni2 = (sri + kg * mi);
      const nr2 = (-srr + kg * mr), ni3 = (-sri + kg * mi);
      specLr[b] = nl; specLi[b] = ni2;
      specRr[b] = nr2; specRi[b] = ni3;
    }
    for (let ch = 0; ch < 2; ch++) {
      const tr = ch === 0 ? specLr : specRr;
      const ti = ch === 0 ? specLi : specRi;
      // Mirror to a full conjugate-symmetric spectrum before the inverse FFT.
      for (let b = 0; b < bins; b++) { fullRe[b] = tr[b]; fullIm[b] = ti[b]; }
      fullIm[0] = 0; fullIm[bins - 1] = 0;
      for (let b = 1; b < bins - 1; b++) {
        fullRe[fftSize - b] = tr[b];
        fullIm[fftSize - b] = -ti[b];
      }
      const time = fft.inverse(fullRe, fullIm);
      const dst = ch === 0 ? outL : outR;
      for (let i = 0; i < fftSize; i++) {
        const k = off + i;
        if (k >= n) break;
        dst[k] += time[i] * window[i];
        if (ch === 0) norm[k] += window[i] * window[i];
      }
    }
    if (progress && (f & 31) === 0) progress(0.26 + 0.7 * (f / frames));
  }

  for (let i = 0; i < n; i++) {
    const g = norm[i] > 1e-6 ? 1 / norm[i] : 0;
    outL[i] *= g; outR[i] *= g;
  }

  // ---- loudness match + peak limit (measured on the processed part only) ----
  // The protected intro is never touched: the gain and the crossfade are both
  // applied inside the same pass, so an intro of 1.5 s stays bit-identical.
  let energyIn = 0, energyOut = 0;
  for (let i = introSamples; i < n; i++) { energyIn += left[i] * left[i] + right[i] * right[i]; energyOut += outL[i] * outL[i] + outR[i] * outR[i]; }
  const gainMatch = energyOut > 1e-9 ? Math.min(2.5, Math.max(0.4, Math.sqrt(energyIn / energyOut))) : 1;
  let peak = 0;
  for (let i = introSamples; i < n; i++) {
    const al = Math.abs(outL[i] * gainMatch), ar = Math.abs(outR[i] * gainMatch);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
  }
  const safetyGain = peak > 0.999 ? 0.999 / peak : gainMatch;

  for (let i = 0; i < n; i++) {
    let mix = 1;
    if (introSamples > 0) {
      if (i < introSamples) mix = 0;
      else if (i < introSamples + fadeSamples) {
        const t = Math.sin(((i - introSamples) / fadeSamples) * Math.PI * 0.5);
        mix = t * t;
      }
    }
    if (mix === 0) continue;
    left[i] += (outL[i] * safetyGain - left[i]) * mix;
    right[i] += (outR[i] * safetyGain - right[i]) * mix;
  }
  if (progress) progress(1);
  return { safetyGain, gainMatch, strength, introSeconds: introSamples / sampleRate, seconds: n / sampleRate };
}

const state = { cancelled: false };
const api = { encodeWav, runSeparation, centreReduce, instantReduce, makeFft, makeStft, periodicHann, MODEL_DEF, MODEL_URL, MODEL_URL_R2, MODEL_PARTS, MODEL_CACHE, modelSources, fetchModelBytes };
if (typeof module !== 'undefined' && module.exports) module.exports = api;

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  const post = (msg, transfer) => self.postMessage(msg, transfer || []);
  self.onmessage = async (event) => {
    const data = event.data || {};
    if (data.type === 'cancel') { state.cancelled = true; return; }
    try {
      if (data.type === 'encode') {
        const wav = encodeWav(new Float32Array(data.left), new Float32Array(data.right), data.sampleRate, (p) => post({ type: 'progress', stage: 'encode', progress: p }));
        post({ type: 'result', wav }, [wav]);
        return;
      }
      if (data.type !== 'separate') { post({ type: 'error', message: 'Unknown audio processing request.' }); return; }
      state.cancelled = false;
      const left = new Float32Array(data.left);
      const right = new Float32Array(data.right);
      const sampleRate = data.sampleRate || 44100;
      if (!left.length || left.length !== right.length) { post({ type: 'error', message: 'Please choose a valid stereo track.' }); return; }
      if (left.length / sampleRate > MAX_SECONDS) {
        post({ type: 'error', message: `Please use a track shorter than ${Math.round(MAX_SECONDS / 60)} minutes.` });
        return;
      }
      let result = null;
      let failure = null;
      const opts = data.options || {};
      if (opts.engine === 'mdx') {
        try {
          result = await runSeparation(left, right, (p) => post({ type: 'progress', ...p }), state, null, opts);
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          failure = err;
        }
      }
      if (!result) {
        // Keep the tool useful when the model cannot load (offline / old device).
        post({ type: 'progress', stage: 'fallback', message: failure && failure.message ? failure.message : '' });
        const fbL = left.slice(), fbR = right.slice();
        let fbInfo;
        if (opts.engine === 'mdx') {
          fbInfo = centreReduce(fbL, fbR, sampleRate, opts, (p) => post({ type: 'progress', stage: 'fallback', progress: p }));
        } else {
          post({ type: 'progress', stage: 'instant', progress: 0.05 });
          fbInfo = instantReduce(fbL, fbR, sampleRate, opts, (p) => post({ type: 'progress', stage: 'instant', progress: p }));
        }
        const wav = encodeWav(fbL, fbR, sampleRate, (p) => post({ type: 'progress', stage: 'encode', progress: 0.96 + 0.04 * p }));
        post({
          type: 'result',
          left: fbL.buffer, right: fbR.buffer, wav,
          info: {
            engine: opts.engine === 'mdx' ? 'centre' : 'instant',
            fallback: opts.engine === 'mdx',
            safetyGain: fbInfo.safetyGain,
            gainMatch: fbInfo.gainMatch || 1,
            strength: Number(opts.strength) || 0.85,
            introSeconds: fbInfo.introSeconds || 0,
            seconds: left.length / sampleRate,
          },
        }, [fbL.buffer, fbR.buffer, wav]);
        return;
      }
      const wav = encodeWav(result.left, result.right, sampleRate, (p) => post({ type: 'progress', stage: 'encode', progress: 0.96 + 0.04 * p }));
      post({
        type: 'result',
        left: result.left.buffer, right: result.right.buffer, wav,
        info: {
          engine: 'mdx', model: result.model, backend: result.backend, gain: result.gain,
          strength: result.strength, introSeconds: result.introSeconds, seconds: left.length / sampleRate,
        },
      }, [result.left.buffer, result.right.buffer, wav]);
    } catch (err) {
      if (err && err.name === 'AbortError') post({ type: 'cancelled' });
      else post({ type: 'error', message: (err && err.message) || 'Audio processing failed.' });
    }
  };
}
