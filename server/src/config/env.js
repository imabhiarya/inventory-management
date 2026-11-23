import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  // Interface to listen on. Unset = all interfaces; the desktop app sets 127.0.0.1.
  HOST: z.string().optional(),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/mes_store?replicaSet=rs0'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN_HOURS: z.coerce.number().positive().default(8),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  CORS_ORIGIN: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  SERVE_CLIENT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  CLIENT_DIST: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const env = parsed.data;
env.isProd = env.NODE_ENV === 'production';
env.isTest = env.NODE_ENV === 'test';
if (env.COOKIE_SECURE === undefined) env.COOKIE_SECURE = env.isProd;

export default env;
