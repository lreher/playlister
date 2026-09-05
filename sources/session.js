// Hand-rolled instead of a cookie library — Playlister is the sole writer and reader of
// this one cookie, so there's no interop fiddliness (Set-Cookie grammar, multi-cookie
// parsing) to actually handle.
const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_NAME = 'sid';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // Spotify OAuth is the real login; this cookie just remembers it.

const isProduction = () => process.env.NODE_ENV === 'production';

const hmac = (value) => crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');

// base64url keeps the cookie value free of characters (';', '=') that would need escaping.
const sign = (userId) => {
  const encoded = Buffer.from(userId, 'utf8').toString('base64url');
  return `${encoded}.${hmac(encoded)}`;
};

const verify = (cookieValue) => {
  if (!cookieValue) return null;
  const [encoded, signature] = cookieValue.split('.');
  if (!encoded || !signature) return null;

  const expected = hmac(encoded);
  const actual = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actual.length !== expectedBuf.length || !crypto.timingSafeEqual(actual, expectedBuf)) return null;

  return Buffer.from(encoded, 'base64url').toString('utf8');
};

const parseCookies = (header) => {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return cookies;
};

const getSessionUserId = (req) => {
  const cookies = parseCookies(req.headers.cookie);
  return verify(cookies[COOKIE_NAME]);
};

const setSessionCookie = (res, userId) => {
  const parts = [
    `${COOKIE_NAME}=${sign(userId)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (isProduction()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
};

const clearSessionCookie = (res) => {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'Max-Age=0'];
  if (isProduction()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
};

// OAuth CSRF protection: /login mints a random value in its own short-lived cookie, and
// /callback checks it matches the query param Spotify sends back.
const STATE_COOKIE_NAME = 'oauth_state';

const generateState = () => crypto.randomBytes(16).toString('hex');

const setStateCookie = (res, state) => {
  const parts = [`${STATE_COOKIE_NAME}=${state}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600'];
  if (isProduction()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
};

const verifyState = (req, queryState) => {
  const cookies = parseCookies(req.headers.cookie);
  const cookieState = cookies[STATE_COOKIE_NAME];
  if (!cookieState || !queryState) return false;
  const a = Buffer.from(cookieState);
  const b = Buffer.from(queryState);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = {
  getSessionUserId,
  setSessionCookie,
  clearSessionCookie,
  generateState,
  setStateCookie,
  verifyState,
};
