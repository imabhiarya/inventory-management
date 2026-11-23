import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import User from '../models/User.js';
import { HttpError, forbidden } from '../utils/httpError.js';

export const COOKIE_NAME = 'mes_session';

export function issueSession(res, user) {
  const token = jwt.sign({ sub: user._id.toString(), tv: user.tokenVersion }, env.JWT_SECRET, {
    expiresIn: `${env.JWT_EXPIRES_IN_HOURS}h`,
    algorithm: 'HS256',
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'strict',
    maxAge: env.JWT_EXPIRES_IN_HOURS * 3600 * 1000,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', path: '/' });
}

export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) throw new HttpError(401, 'Please sign in');
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    clearSession(res);
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
  const user = await User.findById(payload.sub);
  if (!user || !user.active || user.tokenVersion !== payload.tv) {
    clearSession(res);
    throw new HttpError(401, 'Your session is no longer valid. Please sign in again.');
  }
  req.user = user;
  next();
}

/** Role guard. admin > storekeeper > viewer. */
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };

export const canWrite = requireRole('admin', 'storekeeper');
export const adminOnly = requireRole('admin');
