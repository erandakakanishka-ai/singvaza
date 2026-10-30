/* What happens when the admin password is forgotten.
 *
 * There is no email reset here, and there should not be: a reset mail is another
 * way into the panel. Instead the panel takes a RECOVERY CODE that is written down
 * once, when the password is set. Losing that too is recoverable, but only by the
 * owner of the Cloudflare account, through the terminal — see ADMIN-RECOVERY.md.
 *
 * Everything is pure: hashing is done by the caller, this file only decides shape
 * and validity. */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid typos

/** A readable recovery code: XXXX-XXXX-XXXX-XXXX. Uses the platform's CSPRNG. */
export function makeRecoveryCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return [chars.slice(0, 4).join(''), chars.slice(4, 8).join(''), chars.slice(8, 12).join(''), chars.slice(12, 16).join('')].join('-');
}

/** Compare what was typed with what is stored, ignoring case, spaces and dashes. */
export function normalizeRecoveryCode(input: string): string {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function looksLikeRecoveryCode(input: string): boolean {
  return normalizeRecoveryCode(input).length === 16;
}

/** The site needs a recovery code too: @singvaza.lk is safer than a free mailbox. */
export function isWeakAdminPassword(password: string): { weak: boolean; reason?: string } {
  const value = String(password || '');
  if (value.length < 10) return { weak: true, reason: 'Use at least 10 characters.' };
  if (/^singvaza/i.test(value)) return { weak: true, reason: 'Do not use the site name.' };
  if (/^(password|admin|123456)/i.test(value)) return { weak: true, reason: 'That is the first password anyone tries.' };
  return { weak: false };
}

/** The exact commands the owner runs in a terminal if both the password and the
 *  recovery code are lost. Shown in the admin panel, so nobody has to guess. */
export const RECOVERY_COMMANDS = [
  'npm install -g wrangler',
  'wrangler login',
  'wrangler d1 execute karomix-db --remote --command "DELETE FROM site_settings WHERE k IN (\'admin_pass_sha256\', \'admin_recovery_sha256\', \'admin_username\');"',
  'wrangler d1 execute karomix-db --remote --command "DELETE FROM admin_sessions;"',
];

export const RECOVERY_NOTE = [
  'After the command runs, the panel opens with the factory login admin / SingVaza@2026 again:',
  'sign in at once and set a new password plus a new recovery code.',
  'Only the owner of the Cloudflare account (and the site database) can do this — which is exactly the point.',
].join(' ');
