# Tools + Blog redesign notes

## Structure

- The homepage discovers the built-in Vocal Remover and Karaoke Recorder, plus tools and articles published through the existing admin tabs. Search indexes their titles, descriptions, categories and SEO tags.
- Built-in tools have reloadable URLs `/studio/vocal-remover` and `/studio/karaoke-recorder`. Existing custom tool URLs `/tools/:slug` and blog URLs remain unchanged. Pages middleware and the standalone Worker must remain in sync.
- Vocal reduction is the existing non-AI, browser-local process; it can download the karaoke WAV or send the result to Sing & Record. Results vary by source audio.
- `public/vendor/fuse.basic-7.5.0.min.js` is Fuse.js 7.5.0 (Apache-2.0), bundled locally from the published package with esbuild; the license is `public/vendor/FUSE-LICENSE.txt`. There is no runtime search-library CDN.
- Admin-published standalone HTML is trusted code running on the site origin. A small floating navigation bar is appended; no existing content is migrated or deleted.

## Quota and rollout

- The default free allowance is **9 total downloads per day**, shared by karaoke backing WAV and recorder/master downloads. Existing Pro eligibility remains in effect.
- Authenticated accounts use a conditional atomic D1 update; if quota tracking fails, the download is not started. Guest usage is kept in localStorage per browser and local day, not enforced across browsers or after the browser's data is cleared.
- `site_settings.daily_free_limit` remains admin-adjustable and overrides the default. **Before any authorized production rollout**, read this one setting, back up its current value, and if necessary update only that row to 9 with a compare-and-set check. Do not reset other settings or counters. If the setting is absent, the default is already 9.
- The Terms and free-access policy were updated for the shared allowance. The Terms consent version changes to 2026-10-27, so existing visitors will be asked to accept the revised Terms again on the new version.

## Local testing only

Use a Wrangler Pages preview with a **separate local persistence directory** and the documented Turnstile dummy keys; never point these tests at production data. The Python `server.py` is a legacy local server and does not implement the Pages security/CMS stack.

```sh
npm ci
./node_modules/.bin/wrangler d1 execute karomix-db --local --persist-to /tmp/sv-test-data --file ./schema.sql
./node_modules/.bin/wrangler pages dev public --ip 0.0.0.0 --port 8788 \
  --compatibility-date 2024-11-01 --d1 DB=88b28623-1da8-42ff-8b52-479097f44650 \
  --persist-to /tmp/sv-test-data \
  --binding TURNSTILE_SITE_KEY=1x00000000000000000000AA \
  --binding TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
  --binding TURNSTILE_TEST_MODE=true
```

In a second terminal:

```sh
npm test
npm run test:e2e
SINGVAZA_LOCAL_PERSIST=/tmp/sv-test-data npm run test:integration
```

The integration suite refuses non-loopback URLs, uses `wrangler --local`, creates disposable fixture users/posts/tools, and restores the prior local limit. Dummy keys are for isolated testing only; do not use real credentials in the preview.
