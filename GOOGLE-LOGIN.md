# Google Login — මොකද වෙන්නේ, මොකද ඕන (what is needed)

## දැන් තත්ත්වය

- කේතය **හරි**: Google button එක, `/api/auth/google` route එක, token එක Google එකෙන් verify කිරීම — ඔක්කොම site එකේ තියෙනවා.
- Client ID එකත් Settings එකේ දාලා තියෙනවා: `231338068851-ur3mv59hbig5js7re3ls48ldt3tvsjrp.apps.googleusercontent.com`
- නමුත් Google Console එකේ **Authorized JavaScript origins** එකට `https://singvaza.pages.dev` දාලා නෑ. ඒ නිසා Google එකෙන් "Access blocked / origin is not allowed" වගේ එකක් එනවා (හෝ button එක ඔබාම කිසි දෙයක් වෙන්නේ නෑ).

## එක වතාවක් පමණයි — Google Cloud Console එකේ කරන්න

1. https://console.cloud.google.com/apis/credentials → project එක තෝරන්න.
2. **OAuth 2.0 Client ID** එක open කරන්න (`231338068851-…` පටන් ගන්නා එක).
3. **Authorized JavaScript origins** → `+ Add URI` → `https://singvaza.pages.dev` (කෙළවර slash එකක් නෑ, `/*` නෑ).
   - local එකේ test කරන්නත් ඕන නම් `http://localhost:8803` එකත් දාන්න.
4. **Authorized redirect URIs** → මේ විදිහට වෙන්න ඕන නම් විතරයි: `https://singvaza.pages.dev` (අපේ flow එක popup එකෙන්, ඒ නිසා redirect URI අවශ්‍ය නෑ).
5. **Save** → විනාඩි 5–10ක් ඉන්න (Google එකේ cache එක).
6. Browser එකේ singvaza.pages.dev එක **hard refresh** කරන්න (හෝ private tab එකකින් එන්න).

### App එක "Testing" mode එකේ නම්

OAuth consent screen එක **Testing** නම්, ඔබේ Gmail එක **Test users** ලැයිස්තුවේ තියෙන්න ඕන. නැත්නම් "Access blocked: … has not completed the verification process" එයි.
→ **APIs & Services → OAuth consent screen → Test users → + Add users** (ඔබේ Gmail). නැත්නම් app එක **Publish** කරන්න (verification ඕන වෙන්න පුළුවන් — personal use නම් Testing + test users ලේසි).

## පස්සේ පරීක්ෂා කරන්නේ කොහොමද

1. `https://singvaza.pages.dev` → account icon → Sign in.
2. Cloudflare check එක ඉවර වුණාම **Google button** එක පේන්න ඕන ("Continue with Google").
3. ඔබන්න → Google account තෝරන්න → ආපහු site එකට ඇවිත් "30-Day Free Pro" toast එක එන්න ඕන.
4. Button එක පේන්නේ නැත්නම් → Ctrl+Shift+R (hard refresh). තවම නැත්නම් `?v=` cache ප්‍රශ්නයක් — Settings එකේ Client ID එක save කරලා ආපහු බලන්න.

## දැනගන්න ඕන කරුණු

- මේක **admin login එකට** අදාළ නෑ. Admin panel එකට තවම password එකම ඕන (ඒක ඔබ ඉල්ලපු දේ — හැම වෙලාවෙම අහන්න).
- Google login එකෙන් එන්නේ **site users** ලාට (Pro pass / daily quota). Admin ට Google login දුන්නොත් site එකේ Google account එකක් හොරකම් කළ කෙනෙකුට admin එකට එන්න පුළුවන් වෙනවා — ඒක අනතුරුදායක.
- අවශ්‍ය නම් **admin ට විතරක්** Google login දෙන්න පුළුවන්: ඔබේ Gmail එක Settings එකේ allow-list එකට දාලා, Google login එකෙන් ආවත් අලුතින් **recovery code පාර** අහන විදිහට හදන්න පුළුවන්. කැමතිද කියලා කියන්න.
