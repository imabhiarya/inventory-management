import env from './config/env.js';
import logger from './logger.js';
import { connectDb, disconnectDb } from './db.js';
import { createApp } from './app.js';
import { getSettings } from './models/misc.js';
import User from './models/User.js';
import { migrateVoucherLedgers } from './migrations.js';

async function main() {
  await connectDb(env.MONGODB_URI);
  await getSettings(); // create default settings on first run
  await migrateVoucherLedgers();
  if ((await User.countDocuments({ role: 'admin', active: true })) === 0) {
    logger.warn('No admin user exists yet. Create one with: npm run create-admin');
  }

  const app = createApp();
  const server = app.listen(env.PORT, env.HOST, () =>
    logger.info(`Store Inventory server listening on ${env.HOST || 'all interfaces'}, port ${env.PORT}`),
  );

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
