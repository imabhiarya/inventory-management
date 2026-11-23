import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import pinoHttp from 'pino-http';
import env from './config/env.js';
import logger from './logger.js';
import { requireAuth } from './middleware/auth.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { HttpError } from './utils/httpError.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import settingsRoutes from './routes/settings.js';
import itemRoutes from './routes/items.js';
import receiptRoutes from './routes/receipts.js';
import issueRoutes from './routes/issues.js';
import loanRoutes from './routes/loans.js';
import ledgerRoutes from './routes/ledger.js';
import reportRoutes from './routes/reports.js';
import dashboardRoutes from './routes/dashboard.js';
import auditRoutes from './routes/audits.js';
import orderRoutes from './routes/orders.js';
import demandRoutes from './routes/demands.js';
import dcsRoutes from './routes/dcs.js';
import consolidatedDemandRoutes from './routes/consolidatedDemands.js';
import backupRoutes from './routes/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: env.COOKIE_SECURE ? [] : null,
        },
      },
    }),
  );
  if (env.CORS_ORIGIN) {
    app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }));
  }
  app.use(compression());
  if (!env.isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/api/health' || !req.url.startsWith('/api') },
        // Keep access logs compact: no headers/cookies.
        serializers: {
          req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }
  app.use(cookieParser());

  // Larger body limit only for backup restore.
  app.use('/api/backup/restore', express.json({ limit: '500mb' }));
  // Audit attachments arrive as base64 JSON (15 MB file ≈ 20 MB encoded).
  app.use(/^\/api\/(audits|dcs)\/[0-9a-f]{24}\/files$/, express.json({ limit: '22mb' }));
  app.use(express.json({ limit: '1mb' }));

  // CSRF defence-in-depth (on top of SameSite=strict cookies): any state-changing
  // request that carries a body must be JSON, which a cross-site HTML form cannot send.
  app.use('/api', (req, res, next) => {
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && hasBody && !req.is('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    next();
  });

  app.use(
    '/api',
    rateLimit({ windowMs: 60 * 1000, limit: env.isTest ? 100000 : 600, standardHeaders: 'draft-7', legacyHeaders: false }),
  );

  app.get('/api/health', (req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'connected' : 'disconnected', version: '1.0.0' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', requireAuth);
  app.use('/api/users', userRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/items', itemRoutes);
  app.use('/api/receipts', receiptRoutes);
  app.use('/api/issues', issueRoutes);
  app.use('/api/loans', loanRoutes);
  app.use('/api/ledger', ledgerRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api/audits', auditRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/demands', demandRoutes);
  app.use('/api/dcs', dcsRoutes);
  app.use('/api/consolidated-demands', consolidatedDemandRoutes);
  app.use('/api', notFoundHandler);

  // Serve the built React app (single origin → cookies just work, no CORS needed).
  const clientDist = env.CLIENT_DIST || path.resolve(__dirname, '../../client/dist');
  if (env.SERVE_CLIENT && fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '1y', immutable: true }));
    app.get(/^(?!\/api\/).*/, (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
