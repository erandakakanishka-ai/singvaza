import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/* The vocal-removal model is a 64 MB file served from our own R2 bucket. These
 * tests pin the route's behaviour: stream the object when the bucket is wired
 * up, redirect to the public mirror when it is not (so the feature never
 * breaks), and only ever expose that one file. */

async function loadRoute() {
  const out = await build({ entryPoints: ['functions/model/[[path]].ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const route = await loadRoute();

function fakeBucket(bytes, { missing = false } = {}) {
  const object = {
    size: bytes.length,
    httpEtag: '"abc"',
    body: new Blob([bytes]).stream(),
  };
  return {
    calls: [],
    async get(key, opts) {
      this.calls.push({ key, opts });
      return missing ? null : object;
    },
  };
}

test('serves the model from R2 with long-lived caching and no visitor data', async () => {
  const bucket = fakeBucket(new Uint8Array([1, 2, 3, 4]));
  const res = await route.onRequest({
    request: new Request('https://singvaza.pages.dev/model/UVR-MDX-NET-Inst_HQ_3.onnx'),
    env: { MODEL_BUCKET: bucket },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('cache-control'), /max-age=604800/);
  assert.equal(bucket.calls[0].key, 'UVR-MDX-NET-Inst_HQ_3.onnx');
  assert.equal(new Uint8Array(await res.arrayBuffer()).byteLength, 4);
});

test('redirects to the public mirror when the bucket is missing, empty or not configured', async () => {
  for (const env of [{}, { MODEL_BUCKET: fakeBucket(new Uint8Array(4), { missing: true }) }, { MODEL_BUCKET: { async get() { throw new Error('boom'); } } }]) {
    const res = await route.onRequest({ request: new Request('https://singvaza.pages.dev/model/UVR-MDX-NET-Inst_HQ_3.onnx'), env });
    assert.ok([302, 307].includes(res.status), `expected a redirect, got ${res.status}`);
    assert.match(res.headers.get('location') || '', /UVR-MDX-NET-Inst_HQ_3\.onnx$/);
  }
});

test('refuses to serve anything other than the model file', async () => {
  const bucket = fakeBucket(new Uint8Array(4));
  const res = await route.onRequest({ request: new Request('https://singvaza.pages.dev/model/secrets.txt'), env: { MODEL_BUCKET: bucket } });
  assert.equal(res.status, 404);
  assert.equal(bucket.calls.length, 0);
});

test('HEAD requests answer with headers and no body', async () => {
  const bucket = fakeBucket(new Uint8Array(4));
  const res = await route.onRequest({ request: new Request('https://singvaza.pages.dev/model/UVR-MDX-NET-Inst_HQ_3.onnx', { method: 'HEAD' }), env: { MODEL_BUCKET: bucket } });
  assert.equal(res.status, 200);
  assert.equal(res.body, null);
});

test('the worker ships the model with the site, keeping R2 and HuggingFace as fallbacks', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const worker = require('../public/karaoke-worker.js');
  assert.equal(worker.MODEL_URL_R2, '/model/UVR-MDX-NET-Inst_HQ_3.onnx');
  assert.deepEqual(worker.MODEL_PARTS, ['/model/model-part1.part', '/model/model-part2.part']);
  assert.deepEqual(worker.modelSources().slice(1), ['/model/UVR-MDX-NET-Inst_HQ_3.onnx', worker.MODEL_URL]);
});
