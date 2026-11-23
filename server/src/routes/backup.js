import { Router } from 'express';
import { audit } from '../models/misc.js';
import { adminOnly } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { buildBackup, backupSchema, restoreBackup } from '../services/backup.js';

const router = Router();
router.use(adminOnly);

router.get('/', async (req, res) => {
  const backup = await buildBackup(req.user.username);
  await audit(req, 'BACKUP', 'Database', null, 'Downloaded full backup');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="mes-store-backup-${stamp}.json"`);
  res.json(backup);
});

router.post('/restore', validate(backupSchema), async (req, res) => {
  const result = await restoreBackup(req.valid.body, req);
  res.json({ ok: true, ...result });
});

export default router;
