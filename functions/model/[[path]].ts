/* Serves the AI vocal-removal model from SingVaza's own Cloudflare R2 bucket.
 *
 * Why: the model is a single 64 MB file (UVR MDX-Net Inst HQ 3, MIT licence) that a
 * visitor downloads once per browser and then reuses from cache. Serving it from
 * R2 keeps that download fast and reliable, and it never depends on a third
 * party staying online.
 *
 * Privacy: this route only ever returns the shared model file. No visitor audio
 * is uploaded here or anywhere else - separation happens on the device.
 *
 * If the binding or the object is missing (for example before the first upload),
 * the request is answered with a redirect to the public mirror so the feature
 * still works.
 */

const MODEL_KEY = 'UVR-MDX-NET-Inst_HQ_3.onnx';
/* The model ships as two static files next to this route (Cloudflare Pages
 * refuses a single asset over 25 MiB). They are plain assets, so the function
 * has to step aside and let the static handler serve them. */
const STATIC_PREFIX = 'model-part';
const MIRROR_URL = 'https://huggingface.co/Tha456/uvr5-models/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx';

type Env = { MODEL_BUCKET?: R2Bucket };

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const name = url.pathname.replace(/^\/+/, '').replace(/^model\//, '');
  if (name.startsWith(STATIC_PREFIX) && /^model-part[\w.-]+\.part$/.test(name)) {
    return context.next();
  }
  if (name !== MODEL_KEY && name !== `models/${MODEL_KEY}` && name !== '') {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'cache-control': 'public, max-age=604800',
    'access-control-allow-origin': '*',
    'x-model-source': 'r2',
  });

  const bucket = context.env.MODEL_BUCKET;
  if (bucket) {
    try {
      const rangeHeader = context.request.headers.get('range');
      const object = await bucket.get(MODEL_KEY, rangeHeader ? { range: context.request.headers } : undefined);
      if (object) {
        headers.set('etag', object.httpEtag);
        if (object.size) headers.set('content-length', String(object.size));
        let status = 200;
        if (rangeHeader && (object as R2ObjectBody & { range?: { offset: number; length: number } }).range) {
          const r = (object as R2ObjectBody & { range: { offset: number; length: number } }).range;
          headers.set('content-range', `bytes ${r.offset}-${r.offset + r.length - 1}/${object.size}`);
          headers.set('content-length', String(r.length));
          status = 206;
        }
        const body = context.request.method === 'HEAD' ? null : (object as R2ObjectBody).body;
        return new Response(body, { status, headers });
      }
    } catch (_) {
      /* fall through to the mirror */
    }
  }

  return Response.redirect(MIRROR_URL, 302);
};
