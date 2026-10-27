import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { processStereo, encodeWav } = require('../public/karaoke-worker.js');
const sr = 44100;

function sample(seconds = 7) {
  const n = Math.round(sr * seconds), l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const center = .20 * Math.sin(2 * Math.PI * 440 * t) + .12 * Math.sin(2 * Math.PI * 70 * t);
    const side = .16 * Math.sin(2 * Math.PI * 730 * t + .2);
    l[i] = center + side; r[i] = center - side;
  }
  return { l, r };
}
function amplitude(l, r, hz, fromSec = 1, toSec = 6, side = false) {
  let re = 0, im = 0, count = 0;
  for (let i = Math.floor(sr * fromSec); i < Math.min(l.length, Math.floor(sr * toSec)); i++) {
    const v = side ? (l[i] - r[i]) / 2 : (l[i] + r[i]) / 2;
    re += v * Math.cos(2 * Math.PI * hz * i / sr);
    im += v * Math.sin(2 * Math.PI * hz * i / sr);
    count++;
  }
  return 2 * Math.hypot(re, im) / count;
}

test('stronger reduction attenuates a centred voice more while retaining stereo side and bass', () => {
  const { l, r } = sample();
  const originalVoice = amplitude(l, r, 440);
  const originalSide = amplitude(l, r, 730, 1, 6, true);
  const originalBass = amplitude(l, r, 70);
  const music = processStereo(l.slice(), r.slice(), sr, { strength: .65 });
  const balanced = processStereo(l.slice(), r.slice(), sr, { strength: .85 });
  const strong = processStereo(l.slice(), r.slice(), sr, { strength: 1 });
  const mv = amplitude(music.left, music.right, 440);
  const bv = amplitude(balanced.left, balanced.right, 440);
  const sv = amplitude(strong.left, strong.right, 440);
  assert.ok(mv < originalVoice * .65, `music preset attenuated: ${mv}`);
  assert.ok(bv < mv * .8 && sv < bv * .6, `monotonic reduction: ${mv}, ${bv}, ${sv}`);
  assert.ok(sv < originalVoice * .15, `strong centre reduction: ${sv / originalVoice}`);
  assert.ok(Math.abs(amplitude(strong.left, strong.right, 730, 1, 6, true) / originalSide - 1) < .001);
  assert.ok(amplitude(strong.left, strong.right, 70) > originalBass * .65);
  assert.equal(strong.info.safetyGain, 1);
});

test('intro is unfiltered up to the marked time and smoothly transitions across a worker block boundary', () => {
  const { l, r } = sample();
  const cut = processStereo(l.slice(), r.slice(), sr, { strength: 1, introSeconds: 2.95 });
  for (const i of [0, 100, 40000, Math.floor(sr * 2.9)]) {
    assert.ok(Math.abs(cut.left[i] - l[i]) < 1e-6);
    assert.ok(Math.abs(cut.right[i] - r[i]) < 1e-6);
  }
  // Neighbouring samples cannot jump abruptly at the protected-intro or 3-second block boundary.
  for (const boundary of [Math.floor(sr * 2.95), sr * 3, Math.floor(sr * 3.6), sr * 6]) {
    assert.ok(Math.abs(cut.left[boundary] - cut.left[boundary - 1]) < .08, `smooth at ${boundary / sr}s`);
  }
  assert.ok(amplitude(cut.left, cut.right, 440, 4, 6) < amplitude(l, r, 440, 4, 6) * .15);
});

test('rejects silence, dual mono and intro covering the whole track without modifying the source', () => {
  const a = new Float32Array(sr), b = new Float32Array(sr);
  assert.throws(() => processStereo(a.slice(), b.slice(), sr), /no audible audio/i);
  for (let i = 0; i < a.length; i++) a[i] = Math.sin(2 * Math.PI * 440 * i / sr) * .3;
  assert.throws(() => processStereo(a.slice(), a.slice(), sr), /dual mono/i);
  const s = sample(1);
  assert.throws(() => processStereo(s.l.slice(), s.r.slice(), sr, { introSeconds: 1 }), /shorter/i);
  assert.equal(s.l[100], sample(1).l[100]);
});

test('encodes correct stereo PCM WAV header and finite bounded samples', () => {
  const { l, r } = sample(.1);
  const result = processStereo(l, r, sr, { strength: .85 });
  const wav = encodeWav(result.left, result.right, sr);
  const v = new DataView(wav);
  assert.equal(Buffer.from(wav, 0, 4).toString(), 'RIFF');
  assert.equal(Buffer.from(wav, 8, 4).toString(), 'WAVE');
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), sr);
  assert.equal(v.getUint32(40, true), l.length * 4);
  assert.equal(wav.byteLength, 44 + l.length * 4);
  for (const f of result.left) assert.ok(Number.isFinite(f) && Math.abs(f) <= 1);
});
