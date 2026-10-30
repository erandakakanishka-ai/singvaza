/* Writes public/site-manifest.json: every static file the site serves.
 *
 * The one-click "download the whole site" button asks the worker for this list.
 * Generating it at build time means the list can never drift from what shipped.
 * Deploy-only concerns (the admin panel, the 46 MB karaoke model) are filtered out
 * in the worker, not here, so the list stays an honest inventory. */
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('../public/', import.meta.url).pathname;
const SKIP_DIRS = new Set(['.wrangler', 'node_modules']);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (entry.name === 'site-manifest.json') continue;
      const full = join(dir, entry.name);
      const { size } = await stat(full);
      out.push({ path: relative(ROOT, full).split(sep).join('/'), bytes: size });
    }
  }
  return out;
}

const files = (await walk(ROOT)).sort((a, b) => a.path.localeCompare(b.path));
const payload = {
  generatedAt: new Date().toISOString(),
  count: files.length,
  bytes: files.reduce((n, f) => n + f.bytes, 0),
  files: files.map((f) => f.path),
};
await writeFile(join(ROOT, 'site-manifest.json'), JSON.stringify(payload, null, 1) + '\n');
console.log(`site-manifest.json: ${payload.count} files, ${(payload.bytes / 1024 / 1024).toFixed(1)} MB`);
