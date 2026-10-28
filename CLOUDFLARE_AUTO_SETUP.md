# 🔧 GitHub → Cloudflare Auto-Deploy Setup (Link එකට හානියක් නැතුව)

## ✅ මම හැදුවේ මොකක්ද?

`.github/workflows/deploy.yml` file එක හැදුවා - දැන් `git push` කළාම Cloudflare එකට **Auto Live** වෙනවා!

**Link එක:** `https://singvaza.pages.dev` → **එහෙමම තියෙනවා, වෙනසක් නෑ!**

---

## ⚠️ තව එක පියවරක් ඉතිරියි: Secrets 2ක් Add කරන්න

Workflow එකට Cloudflare Account එකට connect වෙන්න Token 2ක් ඕන. මේවා GitHub Secrets වල Add කළාම Auto වැඩ!

### පියවර 1: Cloudflare Account ID ගන්න (තත්පර 30)

1. යන්න: https://dash.cloudflare.com
2. දකුණු පස **Account ID** copy කරගන්න (පහළ Scroll කළාම පේනවා)
   - උදා: `a1b2c3d4e5f6...`

### පියවර 2: API Token හදන්න (විනාඩි 1)

1. යන්න: https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → **Edit Cloudflare Workers** template → **Use template**
3. Permissions:
   - Account → Cloudflare Workers Scripts → Edit
   - Account → Account Resources → Include → Your account
4. **Continue to summary** → **Create Token** → Token එක copy කරන්න (එක පාරයි පේන්නේ!)
   - උදා: `xxxx-YYYY-...`

### පියවර 3: GitHub Secrets වල Add කරන්න (විනාඩි 1)

**Option A: GitHub Website එකෙන්:**
1. Go to: https://github.com/erandakakanishka-ai/singvaza/settings/secrets/actions
2. **New repository secret** → Name: `CLOUDFLARE_ACCOUNT_ID` → Value: (Account ID) → Add
3. **New repository secret** → Name: `CLOUDFLARE_API_TOKEN` → Value: (API Token) → Add

**Option B: Terminal එකෙන් (ඔබේ PC එකේ):**
```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --repo erandakakanishka-ai/singvaza
# paste Account ID

gh secret set CLOUDFLARE_API_TOKEN --repo erandakakanishka-ai/singvaza
# paste API Token
```

---

## 🧪 Test කරන්න

Secrets 2 Add කළාට පස්සේ:

```bash
git commit --allow-empty -m "test: auto deploy"
git push origin main
```

→ Go to: https://github.com/erandakakanishka-ai/singvaza/actions
→ Workflow `🚀 Cloudflare Deploy` → Building → 1-2 min → ✅ Success!
→ Check: https://singvaza.pages.dev (Live!)

---

## 🔍 පරණ GitHub Connection එක හදන්නේ කොහොමද? (Alternative)

ඔබ මුලින් Connect කරපු GitHub integration එක Fix කරන්න නම් (Actions නැතුව):

1. https://github.com/settings/installations → Cloudflare Workers and Pages → Configure → Unsuspend / Re-authorize
2. https://dash.cloudflare.com → Workers & Pages → singvaza → Settings → Builds → Git Repository → Manage → Reconnect

නමුත් **GitHub Actions** method එක වඩා stable - Link එකට හානියක් නෑ, Custom Domain එහෙමම තියෙනවා!

---

## ❓ Help ඕනද?

Cloudflare Account ID / Token හොයන්න බැරි නම් Screenshot එකක් එවන්න, මම mark කරලා දෙන්නම්!
