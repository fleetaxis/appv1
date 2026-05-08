-- FleetAxis Database Schema (MVP)
-- =================================
-- Run this once in your Vercel Postgres database to create the initial tables.
-- Connect to your Postgres dashboard and paste this SQL into the Query tab.

-- ===== SUBSCRIBERS =====
-- Email signups from the newsletter form on the homepage.
-- This is your pre-launch list.
CREATE TABLE IF NOT EXISTS subscribers (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT,                          -- 'homepage_newsletter', 'watch_carrier', etc.
  context_dot_number TEXT,              -- If signed up while looking up a carrier
  ip_address TEXT,                      -- For audit/CAN-SPAM compliance
  user_agent TEXT,                      -- Browser fingerprint for analytics
  created_at TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,             -- Set when they click confirmation link (later)
  unsubscribed_at TIMESTAMPTZ           -- Soft delete — required by CAN-SPAM
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_created ON subscribers(created_at);


-- ===== SAVED CARRIERS (WATCHLIST) =====
-- A user wants to be notified when a carrier's status changes.
-- For MVP we track these by email (not full user accounts yet).
-- When we add login later, we'll add a user_id column and migrate.
CREATE TABLE IF NOT EXISTS saved_carriers (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,                  -- For now, this is the "user identifier"
  dot_number TEXT NOT NULL,             -- The DOT being watched
  carrier_name TEXT,                    -- Cached at time of save for display
  notes TEXT,                           -- Optional user note
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Snapshot of key fields at time of save (for change detection later)
  snapshot_status TEXT,                 -- 'A', 'I', etc.
  snapshot_allowed_to_operate TEXT,     -- 'Y', 'N'
  snapshot_data JSONB,                  -- Full snapshot for diff checking

  UNIQUE(email, dot_number)             -- Don't let same email save same carrier twice
);

CREATE INDEX IF NOT EXISTS idx_saved_carriers_email ON saved_carriers(email);
CREATE INDEX IF NOT EXISTS idx_saved_carriers_dot ON saved_carriers(dot_number);


-- ===== LOOKUP LOG =====
-- Track every lookup performed. Useful for analytics, abuse detection,
-- and understanding what carriers people are interested in.
CREATE TABLE IF NOT EXISTS lookup_log (
  id BIGSERIAL PRIMARY KEY,
  query_type TEXT NOT NULL,             -- 'usdot' | 'mc'
  query_value TEXT NOT NULL,            -- The number searched
  resolved_dot TEXT,                    -- The DOT it resolved to (or null if not found)
  found BOOLEAN NOT NULL,               -- Did we find the carrier?
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lookup_log_created ON lookup_log(created_at);
CREATE INDEX IF NOT EXISTS idx_lookup_log_dot ON lookup_log(resolved_dot);
