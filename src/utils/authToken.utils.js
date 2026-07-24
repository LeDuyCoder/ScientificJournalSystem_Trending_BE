import crypto from 'crypto';

export class AuthRequiredError extends Error {
  constructor(message = 'Vui lòng đăng nhập để tiếp tục.') {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = 'AUTH_REQUIRED';
    this.statusCode = 401;
  }
}

const base64UrlDecode = (value) => {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
};

const base64UrlEncode = (buffer) => Buffer.from(buffer)
  .toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

export const parseCookies = (cookieHeader = '') => {
  return String(cookieHeader || '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .reduce((cookies, cookie) => {
      const separatorIndex = cookie.indexOf('=');
      if (separatorIndex === -1) return cookies;

      const key = cookie.slice(0, separatorIndex).trim();
      const value = cookie.slice(separatorIndex + 1).trim();
      if (key) {
        cookies[key] = decodeURIComponent(value);
      }
      return cookies;
    }, {});
};

export const extractAccessTokenFromRequest = (req) => {
  const cookies = parseCookies(req.headers?.cookie || '');
  if (cookies.access_token) {
    return cookies.access_token;
  }

  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return null;
};

export const verifyJwtToken = (token) => {
  const secret = process.env.JWT_SECRET || 'scientific_journal_secret_key';

  if (!token) {
    throw new AuthRequiredError();
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthRequiredError();
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  let header;
  let payload;

  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    throw new AuthRequiredError();
  }

  if (header.alg !== 'HS256') {
    throw new AuthRequiredError();
  }

  const expectedSignature = base64UrlEncode(
    crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest()
  );

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new AuthRequiredError();
  }

  if (payload.exp && Math.floor(Date.now() / 1000) >= Number(payload.exp)) {
    throw new AuthRequiredError();
  }

  return payload;
};

export const getUserIdFromPayload = (payload) => {
  return payload?.user_id || payload?.userId || payload?.id || payload?.sub || null;
};

export const getAuthenticatedUserId = (req) => {
  const token = extractAccessTokenFromRequest(req);
  const payload = verifyJwtToken(token);
  const userId = getUserIdFromPayload(payload);

  if (!userId) {
    throw new AuthRequiredError();
  }

  return {
    userId: String(userId),
    payload
  };
};
