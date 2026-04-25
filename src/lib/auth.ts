const COOKIE_NAME = 'lucaseats_session';
const MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

async function hmacBase64Url(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function createSessionToken(secret: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacBase64Url(secret, ts);
  return `${ts}.${sig}`;
}

export async function verifySessionToken(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [ts, sig] = token.split('.');
  if (!ts || !sig) return false;
  const issued = Number.parseInt(ts, 10);
  if (!Number.isFinite(issued)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now - issued > MAX_AGE_SEC) return false;
  const expected = await hmacBase64Url(secret, ts);
  return timingSafeEqual(sig, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function sessionSetCookie(token: string, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function sessionClearCookie(secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function getSessionCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match?.[1];
}

export async function isAuthenticated(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const token = getSessionCookie(request.headers.get('cookie'));
  return verifySessionToken(secret, token);
}
