// api/save-carrier.js
//
// FleetAxis Save-Carrier (Watchlist) Endpoint
// ============================================
// POST /api/save-carrier
// Body: { email: "...", dot_number: "...", carrier_name: "...", notes?: "..." }
//
// Saves a carrier to the user's watchlist. The user is identified by email
// for now — this lets us send alerts via email later without requiring
// account creation up front.
//
// Once we add proper user accounts (next milestone), we'll migrate this
// to use user_id and merge the saved_carriers rows.

import { db, ensureSavedCarriersTable } from '../lib/db.js';

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > 320) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidDOT(dot) {
  return typeof dot === 'string' && /^\d{1,9}$/.test(dot);
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      email,
      dot_number,
      carrier_name = null,
      notes = null,
      snapshot = null,
    } = request.body || {};

    if (!isValidEmail(email)) {
      return response.status(400).json({ error: 'Valid email is required.' });
    }

    const cleanDot = String(dot_number || '').replace(/\D/g, '');
    if (!isValidDOT(cleanDot)) {
      return response.status(400).json({ error: 'Valid USDOT number is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    await ensureSavedCarriersTable();

    // Auto-add the email to subscribers too (they want monitoring → they're a subscriber)
    await db`
      INSERT INTO subscribers (email, source, context_dot_number)
      VALUES (${cleanEmail}, 'watch_carrier', ${cleanDot})
      ON CONFLICT (email) DO NOTHING
    `;

    // Insert into saved_carriers. If they already saved this carrier, update the snapshot.
    const snapshotStatus = snapshot?.carrier?.statusCode || null;
    const snapshotAllowed = snapshot?.carrier?.allowedToOperate || null;

    await db`
      INSERT INTO saved_carriers (
        email, dot_number, carrier_name, notes,
        snapshot_status, snapshot_allowed_to_operate, snapshot_data
      )
      VALUES (
        ${cleanEmail}, ${cleanDot}, ${carrier_name}, ${notes},
        ${snapshotStatus}, ${snapshotAllowed}, ${snapshot ? JSON.stringify(snapshot) : null}
      )
      ON CONFLICT (email, dot_number) DO UPDATE
        SET notes = EXCLUDED.notes,
            snapshot_status = EXCLUDED.snapshot_status,
            snapshot_allowed_to_operate = EXCLUDED.snapshot_allowed_to_operate,
            snapshot_data = EXCLUDED.snapshot_data
    `;

    return response.status(200).json({
      success: true,
      message: `Watching ${carrier_name || `USDOT ${cleanDot}`}. We'll email you when something changes.`,
    });

  } catch (err) {
    console.error('Save carrier error:', err);
    return response.status(500).json({
      error: 'Could not save carrier. Please try again.',
    });
  }
}
