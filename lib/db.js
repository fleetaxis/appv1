// lib/db.js
//
// Shared Neon/Postgres helpers.
//
// Vercel's newer Neon Marketplace integrations commonly expose DATABASE_URL,
// while older Vercel Postgres projects often expose POSTGRES_URL. Read both so
// the API routes keep working after either integration style is connected.

import { neon } from '@neondatabase/serverless';

let neonSql;
let subscribersTableReady = false;
let savedCarriersTableReady = false;

function getPostgresConnectionString() {
  return process.env.POSTGRES_URL
    || process.env.DATABASE_URL
    || process.env.POSTGRES_PRISMA_URL
    || process.env.DATABASE_URL_UNPOOLED
    || process.env.POSTGRES_URL_NON_POOLING
    || '';
}

function getSql() {
  if (!neonSql) {
    neonSql = neon(getPostgresConnectionString());
  }

  return neonSql;
}

export async function db(strings, ...values) {
  return getSql()(strings, ...values);
}

export async function ensureSubscribersTable() {
  if (subscribersTableReady) return;

  await db`
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

  await db`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS source TEXT`;
  await db`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS context_dot_number TEXT`;
  await db`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS ip_address TEXT`;
  await db`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS user_agent TEXT`;
  await db`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`;
  await db`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`;
  await db`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ`;

  await db`CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_email_unique ON subscribers(email)`;
  await db`CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email)`;
  await db`CREATE INDEX IF NOT EXISTS idx_subscribers_created ON subscribers(created_at)`;

  subscribersTableReady = true;
}

export async function ensureSavedCarriersTable() {
  if (savedCarriersTableReady) return;

  await ensureSubscribersTable();

  await db`
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

  await db`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS carrier_name TEXT`;
  await db`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS notes TEXT`;
  await db`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`;
  await db`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS snapshot_status TEXT`;
  await db`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS snapshot_allowed_to_operate TEXT`;
  await db`ALTER TABLE saved_carriers ADD COLUMN IF NOT EXISTS snapshot_data JSONB`;

  await db`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_carriers_email_dot_unique ON saved_carriers(email, dot_number)`;
  await db`CREATE INDEX IF NOT EXISTS idx_saved_carriers_email ON saved_carriers(email)`;
  await db`CREATE INDEX IF NOT EXISTS idx_saved_carriers_dot ON saved_carriers(dot_number)`;

  savedCarriersTableReady = true;
}
