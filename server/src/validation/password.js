import { z } from 'zod';

// Kept free of side effects (no Express, env or database imports) so that command-line
// scripts such as scripts/create-admin.js can use it without loading route code.
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');
