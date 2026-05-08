// api/lookup.js
//
// FleetAxis Carrier Lookup Endpoint
// =================================
// GET /api/lookup?usdot=2589042
// GET /api/lookup?mc=907873
//
// Returns normalized carrier data combining identity, BASIC scores,
// cargo, operation classification, and authority status.

import { MissingFmcsaWebKeyError, lookupByDOT, lookupByMC } from '../lib/fmcsa.js';

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
    let queryLabel;
    if (usdot) {
      queryLabel = `USDOT ${usdot}`;
      result = await lookupByDOT(usdot);

      // Users often paste an MC docket number into the default USDOT tab. If a
      // numeric USDOT lookup misses, try the same number as an MC docket before
      // surfacing a 404. This fixes cases such as /api/lookup?usdot=1031013
      // when the intended identifier is MC-1031013.
      if (!result) {
        result = await lookupByMC(usdot);
        if (result) queryLabel = `MC-${usdot}`;
      }
    } else {
      queryLabel = `MC-${mc}`;
      result = await lookupByMC(mc);
    }

    if (!result) {
      return response.status(404).json({
        error: 'Carrier not found',
        query: queryLabel,
      });
    }

    // Cache in CDN for 5 minutes — FMCSA data doesn't change minute-to-minute
    // and this saves API calls/cost.
    response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

    return response.status(200).json(result);

  } catch (err) {
    if (err instanceof MissingFmcsaWebKeyError || err.code === 'FMCSA_WEBKEY_MISSING') {
      console.error('Lookup configuration error:', err.message);
      return response.status(503).json({
        error: 'Lookup service is not configured',
        code: err.code,
        message: 'Carrier lookup is missing its FMCSA webkey. Add FMCSA_WEBKEY in Vercel Project Settings → Environment Variables, then redeploy.',
        requiredEnvironmentVariables: err.envNames,
      });
    }

    console.error('Lookup error:', err);
    return response.status(500).json({
      error: 'Lookup failed',
      message: err.message,
    });
  }
}
