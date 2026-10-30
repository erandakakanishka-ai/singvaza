import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

// src/ is TypeScript, so bundle it the same way the other suites load worker code.
async function loadChecker() {
  const out = await build({
    entryPoints: ['src/content-check.ts'],
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const { analyzeContent, compareVersions, fingerprint, localReferences, mergeIssues } = await loadChecker();

/* Everything the admin panel can publish goes through src/content-check.ts. These
 * tests pin the two promises made to the operator:
 *   1. a file that cannot work is reported as an error (so it is not published),
 *   2. an "update" may not quietly delete most of the content that is live today. */

const goodPage = `<!DOCTYPE html>
<html lang="en"><head><title>QR Generator</title><meta name="description" content="Make a QR code"></head>
<body>
  <h1>QR Generator</h1>
  <p>Type a link and download a QR code. Everything runs in your browser and nothing is uploaded.</p>
  <input id="textInput" />
  <button id="makeBtn">Make</button>
  <canvas id="out"></canvas>
  <script>document.getElementById('makeBtn').onclick = () => {};</script>
</body></html>`;

test('a healthy tool passes with no errors', () => {
  const report = analyzeContent(goodPage, 'tool');
  assert.equal(report.ok, true);
  assert.equal(report.issues.filter((i) => i.level === 'error').length, 0);
  assert.equal(report.stats.scripts, 1);
  assert.equal(report.fingerprint.title, 'QR Generator');
  assert.ok(report.fingerprint.headings.includes('QR Generator'));
  assert.ok(report.bytes > 200);
});

test('empty or contentless files are rejected', () => {
  assert.equal(analyzeContent('', 'tool').ok, false);
  assert.equal(analyzeContent('   ', 'blog').ok, false);
  const blank = analyzeContent('<html><body><p>hi</p></body></html>', 'tool');
  assert.equal(blank.ok, false);
  assert.equal(blank.issues[0].code, 'no-content');
});

test('unbalanced script and style tags are errors, not warnings', () => {
  const broken = goodPage.replace('</script>', '');
  const report = analyzeContent(broken, 'tool');
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'script-mismatch'));

  const brokenCss = goodPage.replace('</head>', '<style>body{color:red}</head>');
  assert.ok(analyzeContent(brokenCss, 'tool').issues.some((i) => i.code === 'style-mismatch'));
});

test('a tool without <html> is an error, a blog snippet only a warning', () => {
  const fragment = '<h1>Hello</h1><p>' + 'x'.repeat(60) + '</p>';
  assert.ok(analyzeContent(fragment, 'tool').issues.some((i) => i.code === 'no-html-tag' && i.level === 'error'));
  const asBlog = analyzeContent(fragment, 'blog');
  assert.equal(asBlog.ok, true);
});

test('CDN scripts, document.write, base tags and duplicate ids are reported', () => {
  const risky = goodPage
    .replace('</head>', '<script src="https://cdn.example.com/lib.js"></script><base href="/x/"></head>')
    .replace('<input id="textInput" />', '<input id="textInput" /><input id="textInput" />')
    .replace('</body>', '<script>document.write("x")</script></body>');
  const report = analyzeContent(risky, 'tool');
  const codes = report.issues.map((i) => i.code);
  for (const code of ['external-script', 'duplicate-ids', 'document-write', 'base-tag']) {
    assert.ok(codes.includes(code), 'expected ' + code + ' in ' + codes.join(','));
  }
  assert.equal(report.ok, true, 'these are warnings, not blocking errors');
  assert.equal(report.stats.externalScripts.length, 1);
});

test('local asset references are collected so missing files can be detected', () => {
  const refs = localReferences(`<img src="/assets/logo.png"><a href="/tools/qr">x</a>
    <script src="https://cdn.example.com/a.js"></script><link rel="stylesheet" href="/styles.css?v=2"><img src="data:image/png;base64,AA">`);
  assert.deepEqual(refs.sort(), ['/assets/logo.png', '/styles.css', '/tools/qr']);
});

test('an update that deletes most of the text, ids or scripts is blocked', async () => {
  const live = goodPage.replace('</h1>', '</h1><p>' + 'Long article body. '.repeat(40) + '</p>');
  const stripped = `<!DOCTYPE html><html><head><title>QR Generator</title></head><body><h1>QR Generator</h1><p>Soon.</p></body></html>`;
  const issues = compareVersions(live, stripped);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('content-shrunk'), 'text loss must be an error: ' + codes.join(','));
  assert.ok(codes.includes('ids-lost') || codes.includes('scripts-lost'), codes.join(','));
  assert.ok(issues.some((i) => i.level === 'error'));
});

test('a normal edit of the same file is not flagged as destructive', () => {
  const edited = goodPage.replace('Type a link and download a QR code.', 'Type a link, a phone number or an email and download a QR code.');
  const issues = compareVersions(goodPage, edited);
  assert.equal(issues.filter((i) => i.level === 'error').length, 0);
});

test('a mild trim is a warning, never a silent pass', () => {
  const longLive = goodPage.replace('</h1>', '</h1><p>' + 'x'.repeat(900) + '</p>');
  const trimmed = goodPage.replace('</h1>', '</h1><p>' + 'x'.repeat(650) + '</p>');
  const issues = compareVersions(longLive, trimmed);
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(issues));
  const shrink = issues.find((i) => i.code === 'content-smaller');
  assert.ok(shrink, 'the removed text must be reported: ' + issues.map((i) => i.code).join(','));
});

test('first upload of a brand new item has no destructive-change findings', () => {
  const issues = compareVersions('', goodPage);
  assert.equal(issues.filter((i) => i.level !== 'info').length, 0);
  assert.deepEqual(issues.map((i) => i.code), ['title-added']);
});

test('mergeIssues de-duplicates and keeps errors first', () => {
  const merged = mergeIssues(
    [{ level: 'warn', code: 'a', message: 'A' }],
    [{ level: 'error', code: 'b', message: 'B' }, { level: 'warn', code: 'a', message: 'A' }],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].level, 'error');
});

test('fingerprint captures the shape of a page', () => {
  const fp = fingerprint(goodPage);
  assert.equal(fp.forms, 0);
  assert.equal(fp.images, 0);
  assert.equal(fp.links, 0);
  assert.ok(fp.ids.includes('makeBtn'));
  assert.ok(fp.textLength > 50);
});

test('the admin panel exposes live check, update, download and private controls', async () => {
  const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  for (const call of [
    "AdminApp.openContentModal('blog'", "AdminApp.openContentModal('tool'",
    "AdminApp.quickUpdate(event, 'blog'", "AdminApp.quickUpdate(event, 'tool'",
    "AdminApp.downloadContent('blog'", "AdminApp.downloadContent('tool'",
    "AdminApp.rowMenuAction('private')", "toggleVisibility(type, id, visibility)",
    '/api/admin/ai-review', '/api/admin/content/check',
  ]) {
    assert.ok(html.includes(call), 'admin panel is missing ' + call);
  }
  assert.ok(html.includes('id="blogPrivate"'), 'blog private switch');
  assert.ok(html.includes('id="toolPrivate"'), 'tool private switch');
  assert.ok(html.includes('id="pagesTableBody"'), 'main-site pages table');
});

test('hidden content is filtered on the server, never only in the browser', async () => {
  const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const publicToolList = worker.slice(worker.indexOf("if (url.pathname === '/api/tools' && request.method === 'GET')"), worker.indexOf("if (url.pathname === '/api/tools' && request.method === 'POST')"));
  assert.match(publicToolList, /visibility, 'published'\) = 'published'/, 'the public tools list must filter drafts');
  assert.match(worker, /SELECT \* FROM html_tools WHERE slug = \?/, 'tool detail lookup');
  assert.ok(worker.includes('Tool temporarily unavailable'), 'hidden tool notice');
  assert.ok(worker.includes('Article temporarily unavailable'), 'hidden article notice');
  assert.match(worker, /compareVersions\(String\(existing\.html_code/, 'updates are diffed against the stored file');
  assert.ok(worker.includes('body.force !== true'), 'a blocked update can only pass when forced');
});

test('the admin panel keeps lists and editors apart, with explicit New buttons', async () => {
  const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  // lists
  assert.ok(html.includes('id="tab-tools"'), 'tools list tab');
  assert.ok(html.includes('id="tab-blog"'), 'blog list tab');
  // editors are separate tabs, never below the upload box
  assert.ok(html.includes('id="tab-tools-new"'), 'new-tool tab');
  assert.ok(html.includes('id="tab-blog-new"'), 'new-article tab');
  assert.ok(html.indexOf('id="tab-tools"') < html.indexOf('id="tab-tools-new"'), 'list comes before the editor');
  // a "New" entry in both the sidebar and the mobile tab bar
  assert.ok((html.match(/AdminApp\.newTool\(\)/g) || []).length >= 2, 'new tool entry points');
  assert.ok((html.match(/AdminApp\.newBlog\(\)/g) || []).length >= 2, 'new article entry points');
  // diagnostics surface a missing table or column instead of an empty list
  assert.ok(html.includes('id="diagBox"'), 'diagnostics pane');
  assert.ok(html.includes('/api/admin/diagnostics'), 'diagnostics endpoint');
});

test('the schema migration cannot stop early on a duplicate column', async () => {
  const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
  assert.match(worker, /for \(const sql of statements\) \{\s*try \{ await db\.prepare\(sql\)\.run\(\); \} catch \(_\) \{\}\s*\}/);
  assert.match(worker, /duplicate column name/i);
  assert.ok(worker.includes("PRAGMA table_info("), 'diagnostics reads the real columns');
});

test('the public /tools hub lists usable tools and no Vocal Remover card', async () => {
  const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const hub = worker.slice(worker.indexOf("const bodyHtml = `\n            <h1>Online Tools</h1>"), worker.indexOf('return new Response(', worker.indexOf("const bodyHtml = `\n            <h1>Online Tools</h1>")));
  assert.ok(!hub.includes('/studio/vocal-remover'), 'the Vocal Remover card must not be on /tools');
  for (const href of ['/studio/karaoke-recorder', '/studio/office-to-pdf', '/studio/html-to-pdf']) {
    assert.ok(hub.includes(href), 'missing usable tool card ' + href);
  }
  assert.ok((hub.match(/Use this tool/g) || []).length >= 4, 'every card says how to use it');
});

test('each admin row keeps three primary buttons and hides the rest in a menu', async () => {
  const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  const toolRow = html.slice(html.indexOf('allTools.map((t, idx)'), html.indexOf('allTools.map((t, idx)') + 2000);
  for (const label of ['>Live<', '>Download<', '>Update<']) assert.ok(toolRow.includes(label), 'missing button ' + label);
  assert.ok(toolRow.includes('btn-more'), 'overflow menu');
  assert.ok(html.includes('id="rowMenu"'), 'row menu markup');
  assert.ok(html.includes('AdminApp.rowMenuAction'), 'row menu actions');
  // secondary actions live in the menu, not in the row
  assert.ok(!toolRow.includes('>Delete<'), 'delete moved into the menu');
});
