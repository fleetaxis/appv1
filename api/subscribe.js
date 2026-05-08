// api/subscribe.js
//
// FleetAxis Newsletter / Early Access Signup
// ==========================================
// POST /api/subscribe
// Body: { email: "...", source?: "...", context_dot_number?: "..." }
//
// Stores the email in our subscribers table. Returns success even if the
// email is already subscribed (don't leak which emails are on file — that
// would be a privacy issue and a way for bots to enumerate emails).

import { sql } from '@vercel/postgres';

// Basic email format check. Not perfect, but catches obvious garbage.
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > 320) return false; // RFC max email length
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
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
    const { email, source = 'homepage_newsletter', context_dot_number = null } = request.body || {};

    if (!isValidEmail(email)) {
      return response.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Capture IP and user agent for audit log (CAN-SPAM compliance)
    const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || request.headers['x-real-ip']
      || null;
    const userAgent = request.headers['user-agent'] || null;

    // Insert. ON CONFLICT means if email already exists, do nothing (no error).
    await sql`
      INSERT INTO subscribers (email, source, context_dot_number, ip_address, user_agent)
      VALUES (${cleanEmail}, ${source}, ${context_dot_number}, ${ip}, ${userAgent})
      ON CONFLICT (email) DO NOTHING
    `;

    // Always return success, whether or not we actually inserted.
    // This prevents email enumeration attacks.
    return response.status(200).json({
      success: true,
      message: "You're on the list. We'll be in touch.",
    });

  } catch (err) {
    console.error('Subscribe error:', err);
    return response.status(500).json({
      error: 'Could not subscribe. Please try again.',
    });
  }
}
