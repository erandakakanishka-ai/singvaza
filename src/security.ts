/**
 * SingVaza entry and sign-in protection.
 *
 * Turnstile tokens are single-use. A successful entry challenge establishes a
 * short-lived, signed, HttpOnly browser-session cookie; each sign-in or sign-up
 * uses a separate Turnstile token which is validated by Cloudflare directly.
 */
export interface SecurityEnv {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Local preview only. Never set this for a production deployment. */
  TURNSTILE_TEST_MODE?: string;
}

const COOKIE_NAME = '__Host-sv_entry';
const SESSION_SECONDS = 12 * 60 * 60;
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const encoder = new TextEncoder();

function securityJson(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function getKeys(env: SecurityEnv, request: Request): { siteKey: string; secret: string; test: boolean } | null {
  const siteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  const secret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  if (!siteKey || !secret) return null;

  const hostname = new URL(request.url).hostname.toLowerCase();
  const localHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.e2b.app');
  const test = String(env.TURNSTILE_TEST_MODE || '').toLowerCase() === 'true';
  const testSite = /^[123]x0{20}(?:AA|AB|BB|FF)$/i.test(siteKey);
  const testSecret = /^[123]x0{29,}AA$/i.test(secret);

  // Dummy keys bypass real bot detection. Refuse them unless an explicit test
  // mode is enabled on a local/isolated preview host, never on pages.dev.
  if (test || testSite || testSecret) {
    if (!test || !localHost || !testSite || !testSecret) return null;
  }
  return { siteKey, secret, test };
}

function cookieValue(request: Request, name: string): string {
  const cookies = request.headers.get('Cookie') || '';
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value: string): Uint8Array | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch (_) {
    return null;
  }
}

async function cookieKey(secret: string): Promise<CryptoKey> {
  // Domain-separate the cookie signing key from the Turnstile Siteverify use.
  const derived = await crypto.subtle.digest('SHA-256', encoder.encode(`singvaza:entry-cookie:v1:${secret}`));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function makeSessionCookie(secret: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const payload = `${expires}.${nonce}`;
  const signature = await crypto.subtle.sign('HMAC', await cookieKey(secret), encoder.encode(payload));
  const value = `${payload}.${base64url(new Uint8Array(signature))}`;
  // No Max-Age: this cookie is scoped to the browser session, with an
  // independently enforced 12-hour maximum inside the signed payload.
  return `${COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export async function hasValidEntrySession(request: Request, secret: string): Promise<boolean> {
  const value = cookieValue(request, COOKIE_NAME);
  const parts = value.split('.');
  if (parts.length !== 3 || !/^\d{1,12}$/.test(parts[0]) || !/^[a-f0-9]{32}$/.test(parts[1])) return false;
  const now = Math.floor(Date.now() / 1000);
  const expires = Number(parts[0]);
  if (expires <= now || expires > now + SESSION_SECONDS + 60) return false;
  const signature = fromBase64url(parts[2]);
  if (!signature) return false;
  try {
    return await crypto.subtle.verify('HMAC', await cookieKey(secret), signature, encoder.encode(`${parts[0]}.${parts[1]}`));
  } catch (_) {
    return false;
  }
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

async function verifyTurnstile(request: Request, keys: { secret: string; test: boolean }, token: unknown, action: string): Promise<Response | null> {
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
    return securityJson({ error: 'Please complete the security check.' }, 400);
  }
  if (!isSameOrigin(request)) return securityJson({ error: 'Invalid request origin.' }, 403);

  const payload: Record<string, string> = { secret: keys.secret, response: token.trim() };
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) payload.remoteip = ip;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return securityJson({ error: 'Security check is temporarily unavailable. Please try again.' }, 503);
    const result: any = await response.json();
    if (!result.success) return securityJson({ error: 'Security check failed or expired. Please try again.' }, 403);
    // Cloudflare's documented test keys return a fixed test hostname/action;
    // that exemption is only permitted in the restricted local test mode above.
    if (!keys.test) {
      const expectedHost = new URL(request.url).hostname.toLowerCase();
      if (String(result.hostname || '').toLowerCase() !== expectedHost || result.action !== action) {
        return securityJson({ error: 'Security check could not be verified. Please try again.' }, 403);
      }
    }
    return null;
  } catch (_) {
    return securityJson({ error: 'Security check is temporarily unavailable. Please try again.' }, 503);
  }
}

/** Handle the configuration and entry-verification endpoints, if requested. */
export async function handleSecurityRoute(request: Request, env: SecurityEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/api/security/status' && pathname !== '/api/security/entry') return null;

  const keys = getKeys(env, request);
  if (!keys) return securityJson({ error: 'Security check is not configured. Please try again later.' }, 503);

  if (pathname === '/api/security/status') {
    if (request.method !== 'GET') return securityJson({ error: 'Method not allowed.' }, 405);
    return securityJson({ siteKey: keys.siteKey, entryVerified: await hasValidEntrySession(request, keys.secret) });
  }

  if (request.method !== 'POST') return securityJson({ error: 'Method not allowed.' }, 405);
  let body: any;
  try { body = await request.json(); } catch (_) { return securityJson({ error: 'Invalid request.' }, 400); }
  const error = await verifyTurnstile(request, keys, body?.turnstileToken, 'site_entry');
  if (error) return error;
  return securityJson({ ok: true }, 200, { 'Set-Cookie': await makeSessionCookie(keys.secret) });
}

/** Protect studio and account APIs from direct calls that skip the entry gate. */
export function requiresEntrySession(pathname: string, method: string): boolean {
  if (method === 'OPTIONS') return false;
  return pathname.startsWith('/api/auth/') ||
    pathname === '/api/search-karaoke' ||
    pathname === '/api/lyrics' ||
    pathname === '/api/contact' ||
    pathname === '/api/projects' || pathname.startsWith('/api/projects/') ||
    pathname === '/api/presets' ||
    pathname === '/api/track-export' ||
    pathname === '/api/upgrade-demo';
}

export async function requireEntrySession(request: Request, env: SecurityEnv): Promise<Response | null> {
  const keys = getKeys(env, request);
  if (!keys) return securityJson({ error: 'Security check is not configured. Please try again later.' }, 503);
  if (!isSameOrigin(request)) return securityJson({ error: 'Invalid request origin.' }, 403);
  if (!(await hasValidEntrySession(request, keys.secret))) {
    return securityJson({ code: 'ENTRY_REQUIRED', error: 'Please complete the website security check first.' }, 403);
  }
  return null;
}

/** A fresh, single-use authentication challenge is required for each attempt. */
export async function requireAuthChallenge(request: Request, env: SecurityEnv, token: unknown): Promise<Response | null> {
  const keys = getKeys(env, request);
  if (!keys) return securityJson({ error: 'Security check is not configured. Please try again later.' }, 503);
  return verifyTurnstile(request, keys, token, 'auth');
}
