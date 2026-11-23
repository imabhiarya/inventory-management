import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { audit } from '../models/misc.js';
import env from '../config/env.js';
import { issueSession, clearSession, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError, badRequest } from '../utils/httpError.js';
import { passwordSchema } from '../validation/password.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isTest ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' },
});

// Used so that unknown usernames take as long as wrong passwords (no user enumeration).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

// Re-exported for existing importers; the definition lives in a side-effect-free module.
export { passwordSchema };

router.post(
  '/login',
  loginLimiter,
  validate(z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) })),
  async (req, res) => {
    const { username, password } = req.valid.body;
    const user = await User.findOne({ username: username.toLowerCase() });
    const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
    if (!user || !ok || !user.active) {
      throw new HttpError(401, user && ok && !user.active ? 'This account has been disabled' : 'Invalid username or password');
    }
    user.lastLoginAt = new Date();
    await user.save();
    issueSession(res, user);
    req.user = user;
    await audit(req, 'LOGIN', 'User', user._id, `${user.username} signed in`);
    res.json({ user: user.toSafeJSON() });
  },
);

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

router.post(
  '/change-password',
  requireAuth,
  validate(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema })),
  async (req, res) => {
    const { currentPassword, newPassword } = req.valid.body;
    if (!(await req.user.verifyPassword(currentPassword))) throw badRequest('Current password is incorrect');
    req.user.passwordHash = await User.hashPassword(newPassword);
    req.user.tokenVersion += 1;
    await req.user.save();
    issueSession(res, req.user); // keep this session, invalidate all others
    await audit(req, 'CHANGE_PASSWORD', 'User', req.user._id, 'Password changed');
    res.json({ ok: true });
  },
);

export default router;
