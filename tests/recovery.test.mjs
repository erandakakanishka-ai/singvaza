import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

/* What happens the day the admin forgets the password:
 *   - a written-down recovery code opens a small page that can only set a new password;
 *   - a recovery session cannot read or change anything else;
 *   - if the code is lost too, the owner's own terminal is the way back, and the
 *     exact commands are written down in the panel and in ADMIN-RECOVERY.md. */

async function load(entry) {
  const out = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const recovery = await load('src/recovery.ts');
const workerSrc = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
const guide = await readFile(new URL('../ADMIN-RECOVERY.md', import.meta.url), 'utf8');

test('a recovery code is readable and typed-friendly', () => {
  const code = recovery.makeRecoveryCode();
  assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/, 'four groups of four');
  assert.ok(!/[01IO]/.test(code), 'no characters that look like each other');
  // dashes, spaces and small letters do not matter when it is typed back
  assert.equal(recovery.normalizeRecoveryCode(code.toLowerCase()), recovery.normalizeRecoveryCode(code));
  assert.equal(recovery.normalizeRecoveryCode(code.replace(/-/g, ' ')), recovery.normalizeRecoveryCode(code));
  assert.equal(recovery.looksLikeRecoveryCode(code), true);
  assert.equal(recovery.looksLikeRecoveryCode('too-short'), false);
});

test('two codes are never the same', () => {
  const codes = new Set(Array.from({ length: 50 }, () => recovery.makeRecoveryCode()));
  assert.equal(codes.size, 50);
});

test('a weak password is refused, with a reason', () => {
  for (const bad of ['short', 'SingVaza2026', 'password123', 'admin1234']) {
    const verdict = recovery.isWeakAdminPassword(bad);
    assert.equal(verdict.weak, true, bad);
    assert.ok(verdict.reason, `${bad} explains why`);
  }
  assert.equal(recovery.isWeakAdminPassword('Karaoke2026Studio').weak, false);
});

test('the recovery login exists and checks a hashed code', () => {
  const i = workerSrc.indexOf("'/api/admin/recover'");
  assert.ok(i > 0, 'the route exists');
  const route = workerSrc.slice(i, i + 1200);
  assert.match(route, /sha256Hex\('recovery:' \+ normalizeRecoveryCode\(code\)\)/, 'the code is hashed, like a password');
  assert.match(route, /15 \* 60 \* 1000/, 'the session lasts fifteen minutes');
  assert.match(route, /:recovery/, 'and is marked as a recovery session');
  assert.match(route, /No recovery code was ever set/, 'it says so plainly when there is none');
});

test('a recovery session may only set a password', () => {
  // the panel rejects a recovery session ...
  assert.match(workerSrc, /endsWith\(':recovery'\)\) return false/, 'the full panel stays closed');
  // ... and a separate, narrow route does the one thing that is allowed
  const i = workerSrc.indexOf("'/api/admin/recovery-set-password'");
  assert.ok(i > 0, 'the narrow route exists');
  const route = workerSrc.slice(i, i + 1900);
  assert.match(route, /endsWith\(':recovery'\)/, 'only for a recovery session');
  assert.match(route, /DELETE FROM admin_sessions/, 'and the used code dies with the session');
  assert.match(route, /admin_recovery_sha256/, 'a fresh code is issued');
});

test('a new password always comes with a new recovery code', () => {
  const i = workerSrc.indexOf("if (body.new_password &&");
  const block = workerSrc.slice(i, i + 1200);
  assert.match(block, /isWeakAdminPassword\(newPassword\)/, 'the strength is checked');
  assert.match(block, /recoveryCode = makeRecoveryCode\(\)/, 'a code is made at the same time');
  assert.match(block, /admin_recovery_sha256/, 'and stored hashed');
});

test('the way out without the code is written down, not remembered', () => {
  assert.ok(recovery.RECOVERY_COMMANDS.length >= 3);
  assert.ok(recovery.RECOVERY_COMMANDS.some((c) => c.includes('admin_pass_sha256')), 'the command clears the password');
  assert.ok(recovery.RECOVERY_COMMANDS.some((c) => c.includes('admin_sessions')), 'and the sessions');
  assert.match(guide, /wrangler d1 execute karomix-db --remote/, 'the guide has the real command');
  assert.match(guide, /SingVaza@2026/, 'and says what login comes back');
  assert.match(guide, /recovery code/i, 'and explains the code');
});

test('the login screen offers the way in without a password', () => {
  assert.match(admin, /Forgot the password\?/);
  assert.match(admin, /admin\/recover/, 'it calls the recovery route');
  assert.match(admin, /admin\/recovery-set-password/, 'and the narrow route for the new password');
  assert.match(admin, /I lost the recovery code too/, 'with the last-resort steps inside');
  assert.match(admin, /loadLostBoth/, 'which are loaded from the server, not hard-coded twice');
});
