# SingVaza — handoff prompt (paste this into any new chat)

Copy everything inside the box below as your first message. Nothing else is needed.

```
Project: SingVaza (erandakakanishka-ai/singvaza, branch main). Live: https://singvaza.pages.dev
Hosting: Cloudflare Pages + GitHub Actions (a push to main deploys it, ~2-3 min).
Read the repo before changing anything: TOOL-IDEAS-RANKED.md, public/, tests/.

WHAT IT IS
A phone-first tools site. Two live document tools, both 100% on-device:
  /studio/html-to-pdf   – paste HTML / Markdown / code / text → PDF, Word, Excel, PowerPoint
  /studio/office-to-pdf – .docx / .xlsx / .pptx → PDF
Home page (/) lists the tools with a live counter and a ranked "what to build next" list.

FILES THAT MATTER
  public/studio/html-to-pdf.html  – 3-pane UI: tools | code editor | live preview. Drag/tap to hide panes.
  public/studio/office-to-pdf.html – upload-free Office → PDF page.
  public/pdf-engine.js            – shared engine (window.SingVazaPDF): paper sizes, page layout, real PDF bytes.
  public/office-reader.js         – own ZIP reader, parses .docx/.xlsx/.pptx in the browser.
  public/office-writer.js         – writes real .docx/.xlsx/.pptx (stored ZIP + OOXML), no libraries.
  public/tour.js                  – shared "How it works" tour (spotlight + arrow), shows once, remembers.
  public/index.html, public/app.js – home page, theme, search, tool tiles, tool counter.
  tests/*.mjs                     – node --test suites (55 tests, all must pass).

HARD RULES (never break these)
  1. No uploads. Documents never leave the device. No server calls for conversion.
  2. No CDN libraries, no WASM models, no large downloads — pure local JS only.
  3. No AI-model downloads of any kind (the user cannot download models).
  4. Must work in Firefox on Android, 390px wide, touch only.
  5. Both light and dark themes must work; the palette is graphite + amber (no glowing blue).
  6. Design stays restrained: fewer elements, no clutter, no fake stock/AI hero images.
  7. Reply in short, simple Sinhala. The user is impatient: do the work, then report briefly.
  8. Keep /studio/vocal-remover deployed but DO NOT work on karaoke / vocal-remover code.

HOW TO WORK
  npm ci --no-audit                 # deps (node_modules is not kept between chats)
  npx playwright install firefox    # for browser checks
  cd public && python3 -m http.server 8788 --bind 0.0.0.0   # local preview
  npm test                          # must end with 55 pass, 0 fail
Deploy: bump the cache-buster (/app.js?v=, /pdf-engine.js?v=, /tour.js?v=),
  git -c user.email=agent@arena.ai -c user.name="SingVaza Agent" commit -am "..."
  git fetch origin main && git rebase FETCH_HEAD && git push origin HEAD:main
  then wait ~170s and check GitHub Actions + the live URLs return 200.
Git pushes need a token from ~/.config/gh/hosts.yml (github.com oauth_token).

NEXT TASK
Take the next unbuilt item from TOOL-IDEAS-RANKED.md, in order:
  1 Image compressor (compress to under 50/100/200 KB)
  2 Photos → PDF   3 QR code generator   4 Passport/ID photo sheet
  5 Word counter   6 JPG/PNG → WebP     7 PDF merge/split   8 CSV ↔ Excel
Build it the same way as the existing tools: its own page under /studio/, a tile on the
home page with the live counter, the shared tour, and tests.
```
