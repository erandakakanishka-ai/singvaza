# Admin password ව මතක නැති වුණොත් (Admin recovery)

මේ පැනලයට email reset එකක් නෑ — ඒක තවත් පිටුවකින් ඇතුළට යන පාරක් නිසා.
ඒ වෙනුවට **recovery code** එකක් තියෙනවා. ඒක **password එක save කරන හැම වෙලාවකම** එක සැරයක් පෙන්නනවා
(`Settings → Admin Login Credentials`). එක ලියලා තියාගන්න — කඩදාසියක, නැත්නම් phone notes වල.

---

## 1. Recovery code එක තියෙනවා නම්

1. `https://singvaza.pages.dev/admin` යන්න.
2. **“Forgot the password?”** ඔබන්න.
3. Code එක ගහන්න (`XXXX-XXXX-XXXX-XXXX` — කුඩා අකුරු, dash, space ප්‍රශ්නයක් නෑ).
4. අලුත් password එකක් දෙකක් ගහලා **Save and sign in** ඔබන්න.
5. එතනම **අලුත් recovery code එකක්** පෙන්නනවා — ඒකත් ලියාගන්න. පරණ එක දැන් වැඩ කරන්නේ නෑ.

Recovery session එක **විනාඩි 15ක්** විතරයි, ඒකෙන් කරන්න පුළුවන් **password එක විතරයි** —
content, settings, users මොකුත් බලන්න/වෙනස් කරන්න බෑ.

## 2. Recovery code එකත් නැති වුණා නම්

එතකොට Cloudflare account එකේ අයිතිකාරයා (ඔබ) terminal එකකින් පැනලය නැවත factory login එකට ගේන්න ඕන:

```bash
npm install -g wrangler
wrangler login

# password එකයි recovery code එකයි මකන්න
wrangler d1 execute karomix-db --remote --command "DELETE FROM site_settings WHERE k IN ('admin_pass_sha256', 'admin_recovery_sha256', 'admin_username');"

# පරණ admin sessions ඔක්කොම ඉවර කරන්න
wrangler d1 execute karomix-db --remote --command "DELETE FROM admin_sessions;"
```

ඊට පස්සේ `https://singvaza.pages.dev/admin` එකේ **`admin` / `SingVaza@2026`** වලින් ඇතුළට යන්න.
**වහාම** අලුත් password එකක් (10+ අකුරු) දාලා save කරන්න — එතකොට අලුත් recovery code එකක් එනවා.

> මේක කරන්න පුළුවන් Cloudflare account එකේ හිමිකරුට විතරයි. ඒක තමයි ආරක්ෂාවේ අදහස:
> website එකට access නැති කෙනෙකුට ඒ පාරෙන් ඇතුළට යන්න බෑ.

## 3. නිතර කරන්න ඕන දේවල්

- Password එක **10+ අකුරු**, site නම (`singvaza…`) නැතුව, `password/admin/123456` වගේ නොවෙන්න.
- හැම password වෙනසකදීම එන **recovery code** එක ලියාගන්න. එක පාරක් විතරයි පෙන්නන්නේ.
- Admin panel එකට දැන් **හැම වෙලාවෙම** password එක ඕන (tab එක වැහුවම session එක ඉවරයි).

---

### ඉංග්‍රීසියෙන් (short version)

1. **Have the code:** `/admin` → *Forgot the password?* → type the 16-character code → set a new password.
   The new recovery code is shown once, right there. The recovery session lasts 15 minutes and can do nothing but set a password.
2. **Lost the code too:** run the two `wrangler d1 execute` commands above (Cloudflare account owner only),
   then sign in with `admin` / `SingVaza@2026` and set a new password immediately.
3. The code is created automatically every time you save a new password — write it down.
