// api/lookup.js
//
// FleetAxis Carrier Lookup Endpoint
// =================================
// GET /api/lookup?usdot=2589042
// GET /api/lookup?mc=907873
//
// Returns normalized carrier data combining identity, BASIC scores,
// cargo, operation classification, and authority status.

import { lookupByDOT, lookupByMC } from '../lib/fmcsa.js';

function getRequestUrl(request) {
  const forwardedProto = request.headers['x-forwarded-proto']?.split(',')[0]?.trim();
  const protocol = forwardedProto || 'https';
  const host = request.headers.host || 'localhost';

  return new URL(request.url, `${protocol}://${host}`);
}

function getFirstQueryParam(request, name) {
  return getRequestUrl(request).searchParams.get(name);
}

export default async function handler(request, response) {
  // Allow our frontend to call this from the browser
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  // Parse query params with the WHATWG URL API instead of relying on
  // framework-provided query parsing that can trigger Node's DEP0169 warning.
  const usdot = getFirstQueryParam(request, 'usdot');
  const mc = getFirstQueryParam(request, 'mc');

  // Must provide one or the other
  if (!usdot && !mc) {
    return response.status(400).json({
      error: 'Provide either ?usdot=NUMBER or ?mc=NUMBER',
    });
  }

  try {
    let result;
    if (usdot) {
      result = await lookupByDOT(usdot);
    } else {
      result = await lookupByMC(mc);
    }

    if (!result) {
      return response.status(404).json({
        error: 'Carrier not found',
        query: usdot ? `USDOT ${usdot}` : `MC-${mc}`,
      });
    }

    // Cache in CDN for 5 minutes — FMCSA data doesn't change minute-to-minute
    // and this saves API calls/cost.
    response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

    return response.status(200).json(result);

  } catch (err) {
    console.error('Lookup error:', err);
    return response.status(500).json({
      error: 'Lookup failed',
      message: err.message,
    });
  }
}
