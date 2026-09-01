// Hand-rolled instead of pulling in a cookie/session library: Playlister is
// both the sole writer and sole reader of exactly one cookie whose value it
// fully controls, which is what makes the usual cookie-parsing fiddliness
// (Set-Cookie grammar, multi-cookie interop, quoted-value edge cases) not
// really apply here — there's nothing else to interoperate with.
const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_NAME = 'sid';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year — Spotify OAuth is the
// real login here, this cookie just remembers who already completed it.

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function hmac(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

// userId is a Spotify user id — arbitrary but URL/cookie-safe in practice;
// base64url keeps the cookie value itself free of characters (';', '=')
// that would otherwise need escaping.
function sign(userId) {
  const encoded = Buffer.from(userId, 'utf8').toString('base64url');
  return `${encoded}.${hmac(encoded)}`;
}

function verify(cookieValue) {
  if (!cookieValue) return null;
  const [encoded, signature] = cookieValue.split('.');
  if (!encoded || !signature) return null;

  const expected = hmac(encoded);
  const actual = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actual.length !== expectedBuf.length || !crypto.timingSafeEqual(actual, expectedBuf)) return null;

  return Buffer.from(encoded, 'base64url').toString('utf8');
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return cookies;
}

function getSessionUserId(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verify(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, userId) {
  const parts = [
    `${COOKIE_NAME}=${sign(userId)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (isProduction()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'Max-Age=0'];
  if (isProduction()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// OAuth CSRF protection: /login mints a random value, stashes it in its own
// short-lived cookie (no server-side session exists yet at this point —
// nobody's identity is known until the callback's token exchange
// succeeds), and /callback checks the query param it gets back from Spotify
// matches. A distinct cookie from the real session cookie so the two
// concerns (login-in-progress vs. already-logged-in) can't be confused.
const STATE_COOKIE_NAME = 'oauth_state';

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

function setStateCookie(res, state) {
  const parts = [`${STATE_COOKIE_NAME}=${state}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600'];
  if (isProduction()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function verifyState(req, queryState) {
  const cookies = parseCookies(req.headers.cookie);
  const cookieState = cookies[STATE_COOKIE_NAME];
  if (!cookieState || !queryState) return false;
  const a = Buffer.from(cookieState);
  const b = Buffer.from(queryState);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  getSessionUserId,
  setSessionCookie,
  clearSessionCookie,
  generateState,
  setStateCookie,
  verifyState,
};
