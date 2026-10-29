# SingVaza — short handoff prompt (works even if GitHub cannot be connected)

Paste this as the first message of a new chat. It is deliberately short and does not
describe the site's current state — just what has to be followed.

```
Continuation of a project. Repo: erandakakanishka-ai/singvaza (branch main),
live site https://singvaza.pages.dev. If you cannot connect to GitHub, say so in one
line and continue from the rules below — I will paste or attach any file you ask for.

RULES (never break):
- Everything runs on the visitor's device: no uploads, no server conversion, no CDN
  libraries, no WASM, no AI-model downloads.
- Must work in Firefox on Android, 390px wide, touch only.
- Light and dark themes both; palette graphite + amber (no glowing blue).
- Restrained design: few elements, no stock or AI hero images.
- Reply in short, simple Sinhala. Do the work first, report briefly.
- Do not touch the vocal-remover / karaoke code.

STACK: plain HTML + CSS + vanilla JS in public/, served by Cloudflare Pages; deploys
automatically on push to main; tests are node --test files in tests/ (run: npm test,
55 pass / 0 fail today). Existing tools live in public/studio/.

NEXT TASK: build an Image compressor page (compress JPG/PNG to under 50 / 100 / 200 KB,
canvas only, no libraries), as a new page under public/studio/, linked from the home
page tool grid, with tests. Then Photos → PDF, then a QR code generator.
```

## If GitHub cannot be connected in the new chat

The Arena GitHub connector is not always available. Then the fastest path is:

1. Start the new chat and paste the prompt above.
2. Attach these 5 files from the workspace (they contain everything needed):
   - `public/pdf-engine.js`
   - `public/office-writer.js`
   - `public/studio/html-to-pdf.html`
   - `public/index.html`
   - `HANDOFF-PROMPT.md` (this file)
3. Or let the new chat write a new standalone tool, then copy the new file into the repo
   here and push it — nothing else has to change.
