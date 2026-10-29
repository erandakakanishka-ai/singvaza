# SingVaza — buildable tools, ranked by real search demand

Google does not publish a public "most searched this week" list. What *is* public is
average monthly search volume from Google Ads data, and every keyword tool quotes the same
bands. So the tiers below use those published bands ([1](https://www.trendproservices.co.uk/blog/best-online-tools-website-2026),
[2](https://runfreetools.com/guides/best-free-online-tools), [4](https://toolzy.online/)), and each row is
filtered by one hard rule: **it must run fully on the visitor's device** (no server, no upload, no API key).
That rule is what makes most "AI" tools impossible for us and these 24 possible.

Demand bands: **A** = 1M+ searches/month · **B** = 500k–1M · **C** = 100k–500k · **D** = 10k–100k · **E** = under 10k
Build: ● = a day or two · ●● = a few days · ●●● = a week+

## Tier 1 — build these first (demand × on-device fit × we already own the engine)

| # | Tool | Demand | Build | Why it is a win for us |
|---|------|--------|-------|------------------------|
| 1 | **Image compressor** (target size, e.g. under 50/100/200 KB) | A | ●● | The single most-opened utility on the web. Canvas + quality loop = no library. "Compress to under 50 KB" is the search that converts. |
| 2 | **Photos → PDF** (pick up to 30 photos, one A4 PDF) | A | ● | We already write real PDF bytes. Add an image encoder and this ships fast. Huge on phones. |
| 3 | **QR code generator** (link, Wi-Fi, text → PNG/SVG) | A | ●● | Pure math, no library, works offline. Every shop in Sri Lanka needs one. |
| 4 | **Image resizer / crop to exact px** (passport, visa, forms) | B | ● | Same canvas engine as #1. Passport photo sizes are a big local search. |
| 5 | **JPG / PNG → WebP** | B | ● | Three lines on top of #1. "WebP" is still growing. |
| 6 | **Word counter + character counter** | A | ● | Zero compute. Rank with a good Sinhala/English article and it pays forever. |
| 7 | **PDF merge / split** (no upload) | A | ●●● | The hardest one that matters: real PDF parsing. Online sites charge for exactly this. High moat, do it after the easy six. |
| 8 | **CSV ↔ Excel** (paste CSV → .xlsx, .xlsx → CSV) | C | ● | Half of it is written (we read .xlsx, we write .xlsx). |

## Tier 2 — strong second wave

| # | Tool | Demand | Build | Notes |
|---|------|--------|-------|-------|
| 9 | **Passport / ID photo sheet** (4×6 sheet, printable) | C | ● | Fits our print engine. Local demand is high and the big sites are ad-heavy. |
| 10 | **Word → PDF** (we already do .docx → PDF) | A | ● | Just needs the SEO landing page, the tool exists. Cheapest big win on this list. |
| 11 | **HEIC → JPG** | C | ●● | iPhone photos won't open on Windows. Needs a small HEIC decoder — the only "download" cost, and it stays on device. |
| 12 | **Invoice / receipt maker** | B | ●● | Form → real PDF. Freelancers and small shops search this daily. |
| 13 | **CV / résumé → PDF** | B | ●● | Template + our PDF writer. English + Sinhala templates = unique. |
| 14 | **Image → PDF to exact size** (e.g. fit a form's upload limit) | C | ● | Combines #1 + #2. |
| 15 | **Base64 / URL / HTML encode–decode** | B | ● | Developer traffic, near-zero build. |
| 16 | **JSON formatter + validator** | B | ● | Same. |
| 17 | **Case converter / slug generator** | C | ● | Same. |
| 18 | **Markdown → Word / PDF** | D | ● | The writer already exists; this is a UI only. |

## Tier 3 — local & long tail (small volume, very little competition)

| # | Tool | Demand | Build | Notes |
|---|------|--------|-------|-------|
| 19 | **Loan / EMI calculator** | C (LK) | ● | Monthly payment + amortisation table. Bank-intent searches. |
| 20 | **EPF / ETF take-home calculator** | D (LK) | ● | Almost nobody does it well. Very sticky. |
| 21 | **Age calculator / date difference** | B | ● | Global volume is large, effort is near zero. |
| 22 | **NIC → birthday / gender** (old + new) | D (LK) | ● | Tiny, uniquely local, easy to rank #1. |
| 23 | **Sinhala ↔ legacy font converter** (FM → Unicode) | D | ●● | Old office documents. No good free tool exists. |
| 24 | **Unit + currency converter** (mm↔inch, kg↔lb) | B | ● | Rates need a fetch, so keep it offline-safe with a manual rate field. |

## What I would do, in order

1. **Image compressor → Photos → PDF → QR code** (three tools, all easy, all top-of-market demand).
2. **Word → PDF landing page** — the tool is already live, it just has no page aimed at that search.
3. **PDF merge / split** — the real moat. Nobody local does it on-device.
4. Only then the calculators and the font converter, as content-led pages.

Every one of them keeps the promise already printed on the home page: **on your own phone, nothing uploaded.**

## Sources

1. [Best Free Online Tools Website in 2026 — "PDF tools remain some of the most searched tools online"](https://www.trendproservices.co.uk/blog/best-online-tools-website-2026)
2. [15 Best Free Online Tools in 2026 — "the Image Compressor, it's the tool people open most"](https://runfreetools.com/guides/best-free-online-tools)
4. [Toolzy — most popular in-browser tools: image compressor, compress-to-50KB, QR, PDF](https://toolzy.online/)
