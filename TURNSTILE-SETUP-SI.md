# SingVaza — Cloudflare Turnstile සහ Terms සැකසුම

මෙම වෙනස්කම් මඟින් වෙබ් අඩවියට පිවිසීමේදී Cloudflare Turnstile පරීක්ෂාව පෙන්වයි. Sign in, Sign up සහ Google sign-in සඳහා වෙනම නව පරීක්ෂාවක් අවශ්‍ය වේ. Cloudflare Siteverify API මඟින් පරීක්ෂාව server පැත්තෙන් සත්‍යාපනය කෙරේ.

**වැදගත්: Live site එකට මෙය deploy/merge කිරීමට පෙර පහත production keys දෙකම සකස් කරන්න. ඒවා නොමැති නම් ආරක්ෂක හේතුවෙන් check එක fail closed වන අතර අමුත්තන්ට site එක භාවිත කළ නොහැක.**

## 1. Turnstile widget එක සාදන්න

1. [Cloudflare Dashboard → Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) වෙත යන්න.
2. **Add widget** තෝරා නම `SingVaza` ලෙස දෙන්න.
3. Hostname ලෙස `singvaza.pages.dev` එක් කරන්න (custom domain එකක් තිබේ නම් එයත් එක් කරන්න). Hostname එකට `https://` හෝ මාර්ගයක් ඇතුළත් නොකරන්න.
4. Widget mode එක **Managed** ලෙස තෝරා widget එක සාදන්න.
5. පෙන්වන **Site key** සහ **Secret key** වෙන් වෙන්ව තබාගන්න. **Secret key එක GitHub repository එකට, chat එකට, screenshot එකකට හෝ public code එකට දමන්න එපා.**

Cloudflare විසින් widget එකේ hostname එකට අයත් subdomains ද අවසර දෙන අතර, අවශ්‍ය custom domains වෙන වෙනම එක් කළ යුතුය.

## 2. Cloudflare Pages project එකේ keys සුරක්ෂිතව සකස් කරන්න

1. Cloudflare Dashboard → **Workers & Pages** → **singvaza** → **Settings** → **Variables and Secrets** වෙත යන්න.
2. **Production** environment එකේ පහත දෙක එක් කරන්න:

   | Variable name | Value | Type |
   | --- | --- | --- |
   | `TURNSTILE_SITE_KEY` | Widget එකේ Site key | Plain text variable |
   | `TURNSTILE_SECRET_KEY` | Widget එකේ Secret key | **Encrypted secret** (Encrypt තෝරන්න) |

3. දෙකම **Save** කරන්න. Preview deployment එකත් භාවිත කරන්නේ නම්, එහි environment එකටත් නිවැරදි keys සහ අවසර ලත් hostname සකසන්න.
4. `TURNSTILE_TEST_MODE=true` production හෝ Cloudflare Pages preview environment එකේ නොදමන්න. පහත test keys **සැබෑ bot ආරක්ෂාවක් ලබා නොදේ**.
5. Keys දෙක සකස් කළ පසු පමණක් වෙනස්කම් merge/deploy කරන්න. Settings වෙනස් කිරීමෙන් පසු ඒවා අදාළ deployment එකට යොදාගැනීමට නව deployment එකක් අවශ්‍ය විය හැක.

## 3. Live පරීක්ෂාව

1. Browser එකේ Private/Incognito tab එකක `https://singvaza.pages.dev/` විවෘත කරන්න.
2. Terms & Conditions link එක ක්‍රියාකරන බවත්, checkbox එක තෝරා Cloudflare security check එක සම්පූර්ණ කළ පසු පමණක් ඉදිරියට යා හැකි බවත් බලන්න.
3. **Sign In** සහ **Sign Up** එකක වෙනම security check එක පෙන්වන බව පරීක්ෂා කරන්න. Google sign-in භාවිත කරන්නේ නම් එයත් පරීක්ෂා කරන්න.
4. එකම browser එකේ page එක නැවත විවෘත කළ විට Terms නැවත නොඅසන බව පරීක්ෂා කරන්න. Browser data clear කළහොත් හෝ Terms version වෙනස් කළහොත් නැවත අසනු ඇත.

Cloudflare Managed widget එක තත්ත්වය අනුව සමහර අමුත්තන් ස්වයංක්‍රීයව verify කළ හැක; හැම විටම checkbox එකක් පෙන්වීම Cloudflare විසින් තීරණය කරයි.

## වැඩ කරන ආකාරය සහ සීමාවන්

- Entry check සාර්ථක වූ විට secure, HttpOnly browser-session cookie එකක් යොදා ගනී. එහි උපරිම කාලය පැය 12කි; කාලය අවසන් වූ විට නැවත check කරයි.
- Terms එකේ version එක හා acceptance time එක browser local storage එකේ පමණක් තබයි. එය server-side නීතිමය audit record එකක් නොවේ. Terms වෙනස් කළ විට `public/guard.js` හි `TERMS_VERSION` අලුත් කරන්න.
- `/terms` සහ `/privacy` පිටු terms පිළිගැනීමට පෙර කියවිය හැක. Public HTML/assets තවමත් සෘජුව ලබාගත හැක; මේ entry dialog එක සම්පූර්ණ site-wide Cloudflare WAF firewall එකක් නොවේ. Studio APIs සහ sign-in/sign-up සඳහා server-side checks ඇත.
- Keys නොමැති බව නිසා live site එක block වුවහොත්, keys සකස් කර redeploy කරන්න. හදිසි rollback එකක් අවශ්‍ය නම් මෙම වෙනස්කම් ඇති deployment එක පෙර deployment එකට ආපසු හරවන්න. Keys ඉවත් කිරීමෙන් පරීක්ෂාව bypass නොවේ.

## සංවර්ධක පරීක්ෂණ (local test keys පමණි)

```bash
npm ci
npm test
npm run db:local
npx playwright install chromium
npx wrangler dev --ip 0.0.0.0 --port 8788 --local \
  --var TURNSTILE_SITE_KEY:1x00000000000000000000AA \
  --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA \
  --var TURNSTILE_TEST_MODE:true
```

වෙනත් terminal එකක `npm run test:e2e` ධාවනය කරන්න. Test mode එක local/isolated preview hosts මත පමණක් ඉඩ දෙන අතර production host මත test keys ප්‍රතික්ෂේප කෙරේ.
