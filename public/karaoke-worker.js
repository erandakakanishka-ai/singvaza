/* Browser-local stereo centre reduction, not AI source separation.
 * Work is blocked with overlapping, zero-phase low-pass filters to bound RAM.
 * All samples and WAV data stay in the browser; no audio is uploaded.
 */
(function (root) {
  'use strict';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function filterBothWays(data, alpha) {
    // Two forward/backward passes yield a smooth fourth-order, zero-phase filter.
    for (let pass = 0; pass < 2; pass++) {
      let y = data[0] || 0;
      for (let i = 0; i < data.length; i++) { y += alpha * (data[i] - y); data[i] = y; }
      y = data[data.length - 1] || 0;
      for (let i = data.length - 1; i >= 0; i--) { y += alpha * (data[i] - y); data[i] = y; }
    }
  }

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
      const a = clamp(Number.isFinite(left[i]) ? left[i] : 0, -1, 1);
      const b = clamp(Number.isFinite(right[i]) ? right[i] : 0, -1, 1);
      view.setInt16(off, a < 0 ? Math.round(a * 32768) : Math.round(a * 32767), true);
      view.setInt16(off + 2, b < 0 ? Math.round(b * 32768) : Math.round(b * 32767), true);
      if (progress && i && i % (sampleRate * 15) === 0) progress(i / length);
    }
    return bytes;
  }

  function processStereo(left, right, sampleRate, options = {}, progress) {
    if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length || !left.length) {
      throw new Error('Please choose a valid stereo track.');
    }
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('This audio sample rate is not supported.');
    const length = left.length;
    const strength = clamp(Number.isFinite(Number(options.strength)) ? Number(options.strength) : 0.85, 0, 1);
    const introSeconds = clamp(Number.isFinite(Number(options.introSeconds)) ? Number(options.introSeconds) : 0, 0, length / sampleRate);
    if (introSeconds > 0 && introSeconds >= length / sampleRate - 0.01) throw new Error('The protected intro must be shorter than the track.');
    const introSamples = Math.round(introSeconds * sampleRate);
    const fadeSamples = Math.max(1, Math.round(sampleRate * 0.65));

    // Exact/near dual mono has no stereo information from which to separate a centre.
    let totalEnergy = 0, sideEnergy = 0;
    for (let i = 0; i < length; i++) {
      const l = Number.isFinite(left[i]) ? left[i] : 0;
      const r = Number.isFinite(right[i]) ? right[i] : 0;
      left[i] = l; right[i] = r;
      totalEnergy += l * l + r * r;
      const d = l - r; sideEnergy += d * d;
    }
    if (totalEnergy < 1e-12) throw new Error('This track contains no audible audio.');
    const sideRatio = sideEnergy / (2 * totalEnergy);
    if (sideRatio < 1e-8) throw new Error('This file is dual mono, not true stereo. Vocal reduction cannot safely separate it.');
    if (progress) progress(0.05);

    // Stronger settings reduce more of the vocal band and preserve less centre bass/treble.
    const bassHz = 220 - strength * 100;
    const airHz = Math.min(sampleRate * 0.39, 8500 + strength * 3500);
    // Compensate the four passes' combined cutoff; all frequencies remain bounded by Nyquist.
    const bassAlpha = 1 - Math.exp(-2 * Math.PI * Math.min(sampleRate * 0.42, bassHz * 1.55) / sampleRate);
    const airAlpha = 1 - Math.exp(-2 * Math.PI * Math.min(sampleRate * 0.42, airHz * 1.55) / sampleRate);
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
      // Capture original samples before overwriting the current block.
      tailL = left.slice(nextTailStart, end);
      tailR = right.slice(nextTailStart, end);
      for (let i = start; i < end; i++) {
        const l = left[i], r = right[i], mid = (l + r) * 0.5, side = (l - r) * 0.5;
        const keptMid = (1 - strength) * mid + strength * (low[i - from] + mid - highLow[i - from]);
        let mix = 1;
        if (introSamples > 0) {
          if (i < introSamples) mix = 0;
          else if (i < introSamples + fadeSamples) {
            const s = Math.sin((i - introSamples) / fadeSamples * Math.PI * 0.5);
            mix = s * s;
          }
        }
        const outL = l + ((keptMid + side) - l) * mix;
        const outR = r + ((keptMid - side) - r) * mix;
        left[i] = outL; right[i] = outR;
        peak = Math.max(peak, Math.abs(outL), Math.abs(outR));
      }
      if (progress) progress(0.05 + 0.8 * end / length);
    }
    // A common gain, never a boost, prevents newly-created peaks from clipping.
    const safetyGain = peak > 1 ? 0.999 / peak : 1;
    if (safetyGain < 1) {
      for (let i = 0; i < length; i++) { left[i] *= safetyGain; right[i] *= safetyGain; }
    }
    return { left, right, info: { strength, introSeconds, bassHz, airHz, safetyGain, nearMono: sideRatio < 0.0001, sideRatio } };
  }

  const api = { processStereo, encodeWav };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root.postMessage === 'function' && typeof root.document === 'undefined') {
    root.onmessage = function (event) {
      const data = event.data || {};
      try {
        const left = new Float32Array(data.left);
        const right = new Float32Array(data.right);
        if (data.type === 'process') {
          const result = processStereo(left, right, data.sampleRate, data.options, p => root.postMessage({ type: 'progress', progress: p }));
          root.postMessage({ type: 'progress', progress: 0.87 });
          const wav = encodeWav(left, right, data.sampleRate, p => root.postMessage({ type: 'progress', progress: 0.87 + 0.12 * p }));
          root.postMessage({ type: 'result', left: result.left.buffer, right: result.right.buffer, wav, info: result.info }, [result.left.buffer, result.right.buffer, wav]);
        } else if (data.type === 'encode') {
          const wav = encodeWav(left, right, data.sampleRate, p => root.postMessage({ type: 'progress', progress: p }));
          root.postMessage({ type: 'result', wav }, [wav]);
        } else throw new Error('Unknown audio processing request.');
      } catch (error) {
        root.postMessage({ type: 'error', message: error && error.message ? error.message : 'Audio processing failed.' });
      }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
