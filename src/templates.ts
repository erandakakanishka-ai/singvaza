/* A tiny, self-contained template library for the admin panel.
 *
 * These are the starting points the panel can hand out and take back: a blank
 * page, a solo tool, an article and a seasonal banner. Every one is a single
 * .html file with no external requests, so it passes the same content checks as
 * anything the admin uploads and it can be edited offline and re-uploaded.
 */

export interface ContentTemplate {
  id: string;
  name: string;
  kind: 'page' | 'tool' | 'blog';
  description: string;
  tags: string[];
  html: string;
  /** A paste-in snippet, not a whole page: never offered as a file download. */
  fragment?: boolean;
}

const sharedHead = (title: string, description: string) => `  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <meta name="description" content="${description}" />`;

const sharedStyle = `    :root { --bg:#07090f; --surface:#111625; --border:rgba(148,163,184,.2); --text:#f8fafc; --muted:#94a3b8; --amber:#fbbf24; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:16px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:24px 16px 64px; }
    .wrap { max-width:820px; margin:0 auto; }
    h1 { font-size:clamp(24px,4vw,34px); line-height:1.2; margin:0 0 10px; }
    h2 { font-size:20px; margin:26px 0 8px; color:var(--amber); }
    p { color:#cbd5e1; margin:0 0 14px; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:22px; margin-bottom:16px; }
    .muted { color:var(--muted); font-size:14px; }
    a { color:var(--amber); }
    label { display:block; font-size:13px; color:var(--muted); margin-bottom:4px; }
    input,textarea,button,select { font:inherit; }
    input,textarea,select { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:#0b101a; color:var(--text); }
    textarea { min-height:120px; }
    button { border:0; border-radius:10px; padding:10px 16px; background:var(--amber); color:#111; font-weight:700; cursor:pointer; }
`;

export const TEMPLATES: ContentTemplate[] = [
  {
    id: 'blank-page',
    name: 'Blank page (SingVaza look)',
    kind: 'page',
    description: 'A clean one-column page with heading, paragraphs and a card. Start here for About, Contact, a policy or a landing page.',
    tags: ['page', 'starter', 'policy', 'landing'],
    html: `<!DOCTYPE html>
<html lang="en">
<head>
${sharedHead('Page title — SingVaza', 'One or two sentences that describe this page for Google.')}
  <link rel="stylesheet" href="/guard.css?v=1" />
  <script defer src="/guard.js?v=2"></script>
  <style>
${sharedStyle}  </style>
</head>
<body>
  <main class="wrap">
    <p class="muted"><a href="/">← SingVaza</a></p>
    <h1>Page title</h1>
    <p>Replace this paragraph with what the page is for. Keep sentences short; the page is read on a phone.</p>
    <section class="card">
      <h2>A section</h2>
      <p>Details go here. Delete or duplicate the card as needed.</p>
    </section>
    <p class="muted">Last updated: 2026</p>
  </main>
</body>
</html>
`,
  },
  {
    id: 'solo-tool',
    name: 'Solo tool (runs on the device)',
    kind: 'tool',
    description: 'A complete single-file tool skeleton: label, input, button, output — no library, no upload, nothing sent anywhere.',
    tags: ['tool', 'starter', 'utils'],
    html: `<!DOCTYPE html>
<html lang="en">
<head>
${sharedHead('Tool name — SingVaza', 'What this tool does, in one sentence.')}
  <style>
${sharedStyle}  </style>
</head>
<body>
  <main class="wrap">
    <p class="muted"><a href="/tools">← All tools</a></p>
    <h1>Tool name</h1>
    <p>Say in one line what the tool does and that everything stays on the visitor's device.</p>

    <section class="card">
      <label for="input">Input</label>
      <textarea id="input" placeholder="Paste or type here…"></textarea>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        <button id="run" type="button">Run</button>
        <button id="copy" type="button" style="background:#1c2434;color:#f8fafc;">Copy result</button>
      </div>
      <h2 style="font-size:15px;">Result</h2>
      <pre id="out" style="white-space:pre-wrap;word-break:break-word;margin:0;background:#0b101a;border:1px solid var(--border);border-radius:12px;padding:14px;min-height:60px;"></pre>
    </section>

    <p class="muted">Nothing is uploaded. Close the tab and the input is gone.</p>
  </main>
  <script>
    (function () {
      var input = document.getElementById('input');
      var out = document.getElementById('out');
      document.getElementById('run').addEventListener('click', function () {
        // Replace this with the real work.
        out.textContent = input.value.trim() ? input.value.trim().toUpperCase() : 'Type something first.';
      });
      document.getElementById('copy').addEventListener('click', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(out.textContent).catch(function () {});
      });
    })();
  </script>
</body>
</html>
`,
  },
  {
    id: 'article',
    name: 'Article (blog body)',
    kind: 'blog',
    description: 'A readable article body with a lead paragraph, sections and a closing note. Paste it as the content of a new blog post.',
    tags: ['blog', 'article', 'guide'],
    fragment: true,
    html: `<h1>Article title</h1>
<p><strong>Lead paragraph.</strong> Two or three sentences that answer the question in the title, so a reader can stop here if that is all they needed.</p>

<h2>First section</h2>
<p>Explain one idea per paragraph. Keep code and file names in <code>&lt;code&gt;</code> tags.</p>
<ul>
  <li>A short point.</li>
  <li>Another short point.</li>
</ul>

<h2>Second section</h2>
<p>Add screenshots or a numbered list here. Link to the tool the article is about.</p>

<h2>Summary</h2>
<p>Repeat the answer in one sentence and say what to do next.</p>
`,
  },
  {
    id: 'occasion-banner',
    name: 'Occasion banner (safe seasonal change)',
    kind: 'page',
    fragment: true,
    description: 'A slim greeting bar for a holiday. Paste it at the top of <body> in a page you have downloaded, or use the Occasions card so it turns itself on and off by date.',
    tags: ['occasion', 'christmas', 'new year', 'banner'],
    html: `<!-- Copy this block and paste it just after <body> in the page you want it on.
     No external file, no library, so nothing else on the page changes. -->
<div id="sv-occasion-banner" role="status" style="position:relative;display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 44px 10px 14px;background:linear-gradient(90deg,#7f1d1d,#0f766e);color:#fff;font:600 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;">
  <span aria-hidden="true" style="font-size:17px;">🎄</span>
  <span>Happy holidays from SingVaza — enjoy the season!</span>
  <button type="button" aria-label="Dismiss" onclick="var b=document.getElementById('sv-occasion-banner');b.remove();try{localStorage.setItem('sv_occasion_dismissed','1')}catch(e){}" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:transparent;border:0;color:#fff;font-size:18px;line-height:1;cursor:pointer;">×</button>
</div>
`,
  },
];

/** Files the panel offers as a download: full documents only. Fragments are
 *  listed separately and pasted into a page, never saved as a page. */
export const DOWNLOADABLE_TEMPLATES = TEMPLATES.filter((t) => /^<!DOCTYPE html>/i.test(t.html.trim()));

export function templateById(id: string): ContentTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templateList() {
  return TEMPLATES.map(({ html, ...rest }) => ({
    ...rest,
    bytes: new TextEncoder().encode(html).length,
    downloadable: /^<!DOCTYPE html>/i.test(html.trim()),
  }));
}
