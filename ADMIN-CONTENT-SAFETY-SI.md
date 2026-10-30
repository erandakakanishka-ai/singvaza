# ඇඩ්මින් පැනල් — Content Safety (ලයිව් චෙක්, අප්ඩේට්, ඩවුන්ලෝඩ්, ප්‍රයිවට්)

`/admin` → **HTML Blog Studio**, **HTML Web Tools**, **Business & Settings** තුනේම දැන් පහත පහසුකම් තියෙනවා.
හැම එකකම ප්‍රතිඵලය server එකේදීම (Cloudflare Worker එකේ) තහවුරු වෙනවා — browser එකට විශ්වාස කරන්නේ නැහැ.

---

## 1. ලයිව් චෙක් බටන් (`Live check`)

row එකක `Live check` ඔබනකොට dialog එකක් එනවා:

| කොටස | පෙන්නන්නේ |
|---|---|
| **Live bar** | ඇත්ත public URL එකට fetch එකක් ගිහින් — HTTP status, ප්‍රතිචාර කාලය (ms), පිටුවේ size, `<title>` |
| **Score / verdict** | 100 න් ලකුණු + "healthy / needs-attention / broken" |
| **Findings** | ⛔ error · ⚠️ warn · ℹ️ info ලැයිස්තුව |
| **AI review** | offline review එකේ සාරාංශය, අංක සහ third-party code අවදානම් |
| **Version safety** | දැන් live තියෙන version එකේ shape එක (title · KB · ids · අකුරු ගණන) |
| **Open live ↗ / Check again ↻** | පිටුව අලුතින් පරීක්ෂා කරන්න |

### Checker එක හඳුනාගන්නා දේවල්

**Errors (පබ්ලිෂ් වෙන්නේ නැහැ):** හිස්/අන්තර්ගතයක් නැති file · `<script>` හෝ `<style>` tag ගැලපීමක් නැති · tool එකක `<html>` නැති · අන්තර්ගතය 60%ට වඩා අඩු වීම · ids 30%ට වඩා නැති වීම.

**Warnings:** CDN/external script (සයිට් රීතිය: CDN library නැහැ) · `document.write()` · `<base>` tag · duplicate ids · local file එකක් 404 · `src` නැති `<img>` · file 640 KB ට වැඩි · `<head>` නැති.

> **AI review** කියන්නේ offline **rule engine + stored-version diff** එකකට. Model එකක් call කරන්නේ නැහැ — ඒ නිසා ඉක්මන්, නොමිලේ, සහ කිසිම අන්තර්ගතයක් එළියට යන්නේ නැහැ. එහෙමයි කියලා panel එකේ ඒක "AI" කියලා බොරු නොකියා "Checked offline on the server" කියලා පැහැදිලිව සඳහන් කරලා තියෙනවා.

---

## 2. HTML file එකකින් අප්ඩේට් (`Update HTML`)

row එකේ `Update HTML` → file එක තෝරන්න. එතකොට:

1. **චෙක්** — අලුත් file එකේ errors/warnings.
2. **Version compare** — දැන් live තියෙන file එකත් එක්ක සංසන්දනය: අකුරු ගණන, ids, headings, forms, images, scripts අඩු වුණොත් එය error/warning විදියට එනවා.
3. **Block** — error එකක් තිබ්බොත් save වෙන්නේ නැහැ. එතකොට ඔබට **Fix it in the editor** හෝ **Force publish anyway** තෝරන්න පුළුවන් (හිතාමතාම කරන වෙනසක් නම්).
4. **Publish** — සාර්ථක නම් "Published" කියලා පෙන්නලා, live check එකයි review එකයි ආයේ run වෙනවා.

මේකෙන් තමයි *"අප්ඩේට් කරාම අන්තර්ගතයන් වලට ගැටලුවක් නොවී තිබිය යුතුයි"* කියන කොන්දේසිය ඉටු වෙන්නේ.

---

## 3. දැනට තියෙන file එක ඩවුන්ලෝඩ් (`⬇`)

`⬇` ඔබනකොට **දැන් published තියෙන HTML file එකම** (`singvaza-<slug>.html`) බාගන්න පුළුවන්.
ඒක ඔබේ editor එකේ හදලා, ආයේ `Update HTML` එකෙන් upload කරන්න — loop එක සම්පූර්ණයි.

---

## 4. ප්‍රයිවට් ටොගල් (`Make private` / `private → public`)

Tool එකක් හෝ blog එකක් ගැටලුවක් තියෙනකොට **Make private** කරන්න:

- Tools directory එකෙන් සහ home grid එකෙන් **අයින් වෙනවා**.
- ඒ URL එකට ගියොත් visitor ට පේන්නේ *"Tool temporarily unavailable"* කියන කෙටි පිටුවක් (HTTP 404).
- **sitemap.xml / rss.xml** එකෙන් අයින් වෙනවා (Google එකට නරක පිටු නොයන්න).
- Admin ට (token එක තියෙන කෙනාට) තාම පේනවා — හදලා බලන්න පුළුවන්.
- හදලා ඉවර වුණාම **private → public** → ආයේ live.

Blog එකටත් එකම තර්කය (`Article temporarily unavailable`).
Editor එකේ **Keep this tool private / Keep this article private** checkbox එකෙන් save කරන වෙලාවෙම තෝරන්නත් පුළුවන්.

---

## 5. ප්‍රධාන වෙබ් පිටු (Business & Settings tab → *Main Website Pages*)

| බටන් | කරන්නේ |
|---|---|
| `⬇ Download` | `/`, `/about`, `/contact`, `/privacy`, `/terms`, `/refunds` — දැනට තියෙන file එක (ඔබගේ upload එකක් තිබ්බොත් ඒක) |
| `Update HTML` | අලුත් file එකක් upload; චෙක් + version safety එකම ආකාරයට |
| `Make private` | පිටුව තාම තියෙනවා, ඒත් visitor ට *"Temporarily unavailable"* |
| `Restore original` | ඔබ upload කරපු version එක මකලා, repo එකේ තියෙන මුල් file එක ආපහු දානවා |

උඩ දාන file එක `site_settings` table එකේ `page_override:/about` විදියට තමයි තියෙන්නේ — **redeploy එකක් අවශ්‍ය නැහැ**, සහ `Restore original` එකෙන් ඕන වෙලාවක ආපහු හරවන්න පුළුවන්. පිටුවේ හැඩය සහ CSS/JS refs ටික එහෙමම තියෙන්නේ ඔබ upload කරන file එකේ තියෙන විදියටමයි.

---

## 6. API (ඔබේම script එකකට)

හැම එකකටම `Authorization: Bearer <admin token>` අවශ්‍යයි.

```bash
POST /api/admin/content/check        { kind: "tool|blog|page", html }
POST /api/admin/ai-review            { kind, html }            → review + report
GET  /api/admin/content/raw?type=tool&id=…                     → ඩවුන්ලෝඩ් (HTML)
GET  /api/admin/content/export?path=/about                     → පිටුවේ file එක
GET  /api/admin/pages                                          → පිටු ලැයිස්තුව
POST /api/admin/pages                { path, html, force? }     → upload
POST /api/admin/pages                { path, reset: true }      → මුල් එකට
POST /api/admin/content/visibility   { type, id, visibility }   → published | hidden
```

`POST /api/tools` සහ `POST /api/blog` දැන් `visibility` සහ `force` fields ගන්නවා, සහ error එකක් තිබ්බොත් `422` + `report` එක එවනවා.

---

## 7. පරීක්ෂණ

```bash
npm test                     # 71 pass (content-safety 14 ඇතුළුව)
npm run test:e2e             # 22 pass (browser 7, redesign 3, vocal-remover 12)
```

`tests/content-safety.test.mjs` එකේ pin කරලා තියෙන්නේ: හිස් file · tag mismatch · CDN script · destructive update block · mild trim warning · admin UI එකේ බටන් ටික · server-side visibility filtering (`hidden` content browser එකෙන් filter වෙන්නේ නැහැ, SQL එකෙන්ම).
