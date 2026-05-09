// api/lookup.js
//
// FleetAxis Carrier Lookup Endpoint
// =================================
// GET /api/lookup?usdot=NUMBER
// GET /api/lookup?mc=NUMBER

import {
  FmcsaAuthenticationError,
  FmcsaUpstreamError,
  MissingFmcsaWebKeyError,
  lookupByDOT,
  lookupByMC,
} from '../lib/fmcsa.js';

function getRequestUrl(request) {
  const forwardedProto = request.headers['x-forwarded-proto']?.split(',')[0]?.trim();
  const protocol = forwardedProto || 'https';
  const host = request.headers.host || 'localhost';
  return new URL(request.url, `${protocol}://${host}`);
}

function getLookupQuery(request) {
  const params = getRequestUrl(request).searchParams;
  const usdot = params.get('usdot')?.trim();
  const mc = params.get('mc')?.trim();

  if (usdot) return { type: 'usdot', value: usdot, label: `USDOT ${usdot}` };
  if (mc) return { type: 'mc', value: mc, label: `MC-${mc}` };
  return null;
}

function sendJson(response, status, payload) {
  return response.status(status).json(payload);
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'GET') {
    return sendJson(response, 405, { error: 'Method not allowed' });
  }

  const query = getLookupQuery(request);
  if (!query) {
    return sendJson(response, 400, {
      error: 'Provide either ?usdot=NUMBER or ?mc=NUMBER',
    });
  }

  try {
    let result;
    let queryLabel = query.label;

    if (query.type === 'usdot') {
      result = await lookupByDOT(query.value);

      // Users often paste an MC docket number into the default USDOT tab. If a
      // numeric USDOT lookup misses, try the same number as an MC docket before
      // surfacing a 404.
      if (!result) {
        result = await lookupByMC(query.value);
        if (result) queryLabel = `MC-${query.value}`;
      }
    } else {
      result = await lookupByMC(query.value);
    }

    if (!result) {
      return sendJson(response, 404, {
        error: 'Carrier not found',
        query: queryLabel,
      });
    }

    response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof MissingFmcsaWebKeyError || error.code === 'FMCSA_WEBKEY_MISSING') {
      console.error('Lookup configuration error:', error.message);
      return sendJson(response, 503, {
        error: 'Lookup service is not configured',
        code: error.code,
        message: 'Carrier lookup is missing FMCSA_WEBKEY in the deployment environment. Add it in Vercel Project Settings → Environment Variables, then redeploy.',
        requiredEnvironmentVariables: error.envNames,
      });
    }

    if (error instanceof FmcsaAuthenticationError || error.code === 'FMCSA_AUTHENTICATION_FAILED') {
      console.error('Lookup authentication error:', error.message);
      return sendJson(response, 503, {
        error: 'Lookup service authentication failed',
        code: error.code,
        message: 'FMCSA rejected the configured webkey. Verify FMCSA_WEBKEY in Vercel Project Settings → Environment Variables, then redeploy.',
      });
    }

    if (error instanceof FmcsaUpstreamError || error.code === 'FMCSA_UPSTREAM_ERROR') {
      console.error('Lookup upstream error:', error.message);
      return sendJson(response, error.status || 502, {
        error: 'FMCSA lookup service is temporarily unavailable',
        code: error.code,
        message: error.message,
      });
    }

    console.error('Lookup error:', error);
    return sendJson(response, 500, {
      error: 'Lookup failed',
      message: error.message,
    });
  }
}
