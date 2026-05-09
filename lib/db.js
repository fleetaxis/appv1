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

export async function ensureSubscribersTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS subscribers (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      source TEXT,
      context_dot_number TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      unsubscribed_at TIMESTAMPTZ
    )
  `;

  await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS source TEXT`;
  await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS context_dot_number TEXT`;
  await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS ip_address TEXT`;
  await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS user_agent TEXT`;
  await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`;
  await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS subscribers_email_key ON subscribers(email)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_subscribers_created ON subscribers(created_at)`;
}

export async function ensureSavedCarriersTable() {
  await ensureSubscribersTable();

  await sql`
    CREATE TABLE IF NOT EXISTS saved_carriers (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      dot_number TEXT NOT NULL,
      carrier_name TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      snapshot_status TEXT,
      snapshot_allowed_to_operate TEXT,
      snapshot_data JSONB,
      UNIQUE(email, dot_number)
    )
  `;

  await sql`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS carrier_name TEXT`;
  await sql`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS notes TEXT`;
  await sql`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`;
  await sql`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS snapshot_status TEXT`;
  await sql`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS snapshot_allowed_to_operate TEXT`;
  await sql`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS snapshot_data JSONB`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS saved_carriers_email_dot_number_key ON saved_carriers(email, dot_number)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_saved_carriers_email ON saved_carriers(email)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_saved_carriers_dot ON saved_carriers(dot_number)`;
}
