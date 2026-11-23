import { Router } from 'express';
import { z } from 'zod';
import User from '../models/User.js';
import { audit } from '../models/misc.js';
import { adminOnly } from '../middleware/auth.js';
import { validate, idParam, zText } from '../middleware/validate.js';
import { ROLES } from '../config/constants.js';
import { badRequest, notFound } from '../utils/httpError.js';
import { passwordSchema } from '../validation/password.js';

const router = Router();
router.use(adminOnly);

router.get('/', async (req, res) => {
  const users = await User.find().sort({ createdAt: 1 });
  res.json({ users: users.map((u) => u.toSafeJSON()) });
});

router.post(
  '/',
  validate(
    z.object({
      username: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9._-]{3,32}$/, 'Username: 3–32 characters, letters, numbers, . _ -'),
      name: z.string().trim().min(1, 'Name is required').max(100),
      designation: zText(100).optional(),
      role: z.enum(ROLES),
      password: passwordSchema,
    }),
  ),
  async (req, res) => {
    const { password, ...data } = req.valid.body;
    const user = await User.create({ ...data, passwordHash: await User.hashPassword(password) });
    await audit(req, 'CREATE', 'User', user._id, `Created user ${user.username} (${user.role})`);
    res.status(201).json({ user: user.toSafeJSON() });
  },
);

router.patch(
  '/:id',
  validate(idParam, 'params'),
  validate(
    z.object({
      name: z.string().trim().min(1).max(100).optional(),
      designation: zText(100).optional(),
      role: z.enum(ROLES).optional(),
      active: z.boolean().optional(),
      password: passwordSchema.optional(),
    }),
  ),
  async (req, res) => {
    const user = await User.findById(req.valid.params.id);
    if (!user) throw notFound('User not found');
    const { password, ...data } = req.valid.body;
    const isSelf = user._id.equals(req.user._id);
    if (isSelf && (data.active === false || (data.role && data.role !== 'admin'))) {
      throw badRequest('You cannot disable or demote your own account');
    }
    if ((data.active === false || (data.role && data.role !== 'admin')) && user.role === 'admin') {
      const otherAdmins = await User.countDocuments({ role: 'admin', active: true, _id: { $ne: user._id } });
      if (otherAdmins === 0) throw badRequest('At least one active admin must remain');
    }
    Object.assign(user, data);
    if (password) user.passwordHash = await User.hashPassword(password);
    if (password || data.active === false || data.role) user.tokenVersion += 1; // force re-login
    await user.save();
    await audit(req, 'UPDATE', 'User', user._id, `Updated user ${user.username}${password ? ' (password reset)' : ''}`);
    res.json({ user: user.toSafeJSON() });
  },
);

export default router;
