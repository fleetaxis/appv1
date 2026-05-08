// lib/db.js
//
// Shared Neon Postgres client for Vercel serverless functions.
// Supports both the current Neon/Vercel `DATABASE_URL` variable and the
// legacy Vercel Postgres `POSTGRES_URL` variables during migration.

import { neon } from '@neondatabase/serverless';

const connectionString = process.env.DATABASE_URL
  || process.env.POSTGRES_URL
  || process.env.POSTGRES_URL_NON_POOLING;

if (!connectionString) {
  throw new Error('Missing Postgres connection string. Set DATABASE_URL or POSTGRES_URL in Vercel.');
}

export const sql = neon(connectionString);
