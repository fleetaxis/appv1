// lib/fmcsa.js
//
// FleetAxis FMCSA Integration Layer
// =================================
// Wraps the FMCSA QCMobile API into clean functions our frontend can use.
//
// API Documentation: https://mobile.fmcsa.dot.gov/QCDevsite/docs/qcApi
//
// All QCMobile endpoints are public and require a webKey query parameter.
// The webKey lives in process.env.FMCSA_WEBKEY (NEVER hardcoded).

const FMCSA_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';

/**
 * Internal helper — makes a request to the FMCSA API and returns parsed JSON.
 * Handles errors gracefully so callers always get a predictable shape.
 */
async function fmcsaFetch(path) {
  const webKey = process.env.FMCSA_WEBKEY;
  if (!webKey) {
    throw new Error('FMCSA_WEBKEY environment variable is not set');
  }

  const url = `${FMCSA_BASE}${path}${path.includes('?') ? '&' : '?'}webKey=${encodeURIComponent(webKey)}`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null; // Carrier not found — caller decides what to do
    }
    throw new Error(`FMCSA API returned ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Normalize a raw FMCSA "carrier" object into a clean shape for our frontend.
 * The FMCSA API returns inconsistent capitalization and abbreviations, so we
 * standardize everything here.
 */
function normalizeCarrier(raw) {
  if (!raw) return null;

  // The API wraps the carrier in a "content" property; sometimes nested.
  const c = raw.content?.carrier || raw.carrier || raw;

  return {
    // Identity
    dotNumber: c.dotNumber || c.DOTNumber,
    legalName: c.legalName || c.LegalName,
    dbaName: c.dbaName || c.DBAName,
    entityType: c.carrierOperation?.carrierOperationDesc || 'Carrier',

    // Status — what the user cares about most
    statusCode: c.statusCode, // 'A' = Active, 'I' = Inactive
    allowedToOperate: c.allowedToOperate, // 'Y' or 'N'
    outOfServiceDate: c.oosDate,

    // Address & contact
    physicalAddress: [
      c.phyStreet,
      c.phyCity,
      c.phyState,
      c.phyZipcode,
    ].filter(Boolean).join(', '),
    phone: c.telephone,

    // Fleet size
    powerUnits: c.totalPowerUnits || 0,
    drivers: c.totalDrivers || 0,
    mcs150Mileage: c.mcs150Mileage,
    mcs150MileageYear: c.mcs150MileageYear,
    mcs150Date: c.mcs150Date,

    // Insurance summary (when included)
    bipdRequired: c.bipdInsuranceRequired,
    bipdOnFile: c.bipdInsuranceOnFile,
    cargoOnFile: c.cargoInsuranceOnFile,
    bondOnFile: c.bondInsuranceOnFile,

    // Inspection summary
    inspections: {
      vehicleTotal: c.vehicleInsp,
      vehicleOOS: c.vehicleOosInsp,
      driverTotal: c.driverInsp,
      driverOOS: c.driverOosInsp,
      hazmatTotal: c.hazmatInsp,
      hazmatOOS: c.hazmatOosInsp,
    },

    // Crashes
    crashes: {
      total: c.crashTotal,
      fatal: c.fatalCrash,
      injury: c.injCrash,
      towed: c.towawayCrash,
    },

    // Operating authority quick-glance
    operation: c.carrierOperation,
  };
}

/**
 * Normalize BASIC scores. Each percentile is what the user most wants to see.
 * Returns one object per BASIC category with a status (low/med/high/na).
 */
function normalizeBasics(raw) {
  if (!raw || !raw.content) return [];

  const basics = Array.isArray(raw.content) ? raw.content : [raw.content];

  return basics.map((b) => {
    const pct = b.basic?.basicPercentile ?? b.basicPercentile;
    let status = 'na';
    if (typeof pct === 'number') {
      if (pct >= 65) status = 'high';
      else if (pct >= 35) status = 'med';
      else status = 'low';
    }
    return {
      category: b.basic?.basicNameDesc ?? b.basicNameDesc, // e.g. "Unsafe Driving"
      shortName: b.basic?.basicShortDesc ?? b.basicShortDesc,
      percentile: pct,
      thresholdExceeded: b.basic?.thresholdExceeded ?? b.thresholdExceeded,
      status, // 'low' | 'med' | 'high' | 'na'
      measureDate: b.basic?.measureDate ?? b.measureDate,
    };
  });
}

/**
 * Normalize cargo carried into a simple list of strings.
 */
function normalizeCargo(raw) {
  if (!raw || !raw.content) return [];
  const arr = Array.isArray(raw.content) ? raw.content : [raw.content];
  return arr
    .map(c => c.cargoClassDesc || c.cargoClassification?.cargoClassDesc)
    .filter(Boolean);
}

/**
 * Normalize operation classification into a simple list.
 */
function normalizeOperation(raw) {
  if (!raw || !raw.content) return [];
  const arr = Array.isArray(raw.content) ? raw.content : [raw.content];
  return arr
    .map(c => c.operationClassDesc || c.operationClassification?.operationClassDesc)
    .filter(Boolean);
}

/**
 * Normalize authority info. Returns object with property/passenger/hhg/hazmat statuses.
 */
function normalizeAuthority(raw) {
  if (!raw || !raw.content) return null;
  const arr = Array.isArray(raw.content) ? raw.content : [raw.content];
  const a = arr[0]?.carrierAuthority || arr[0];
  if (!a) return null;
  return {
    commonAuthorityStatus: a.commonAuthorityStatus,
    commonAuthorityApplied: a.commonAuthorityApplied,
    contractAuthorityStatus: a.contractAuthorityStatus,
    contractAuthorityApplied: a.contractAuthorityApplied,
    brokerAuthorityStatus: a.brokerAuthorityStatus,
    brokerAuthorityApplied: a.brokerAuthorityApplied,
    authorizedForHHG: a.authorizedForHHG,
    authorizedForPassenger: a.authorizedForPassenger,
    authorizedForProperty: a.authorizedForProperty,
  };
}

/**
 * Look up a carrier by USDOT number.
 * Returns a single normalized object combining identity, BASICs, cargo,
 * operation classification, and authority — or null if not found.
 *
 * This is the main function the frontend will use.
 */
export async function lookupByDOT(dotNumber) {
  // Strip non-digits — accepts "USDOT 2589042" or "2589042" etc.
  const dot = String(dotNumber).replace(/\D/g, '');
  if (!dot) throw new Error('Invalid DOT number');

  // Make several API calls in parallel for speed
  const [identity, basics, cargo, operation, authority] = await Promise.all([
    fmcsaFetch(`/carriers/${dot}`),
    fmcsaFetch(`/carriers/${dot}/basics`).catch(() => null),
    fmcsaFetch(`/carriers/${dot}/cargo-carried`).catch(() => null),
    fmcsaFetch(`/carriers/${dot}/operation-classification`).catch(() => null),
    fmcsaFetch(`/carriers/${dot}/authority`).catch(() => null),
  ]);

  if (!identity) return null;

  return {
    dotNumber: dot,
    carrier: normalizeCarrier(identity),
    basics: normalizeBasics(basics),
    cargo: normalizeCargo(cargo),
    operation: normalizeOperation(operation),
    authority: normalizeAuthority(authority),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Look up a carrier by MC docket number.
 * MC numbers map to DOT numbers, so we resolve the DOT first then call lookupByDOT.
 */
export async function lookupByMC(mcNumber) {
  // Strip "MC-" prefix and non-digits
  const mc = String(mcNumber).replace(/MC[-\s]*/i, '').replace(/\D/g, '');
  if (!mc) throw new Error('Invalid MC number');

  const result = await fmcsaFetch(`/carriers/docket-number/${mc}`);
  if (!result || !result.content) return null;

  // The docket lookup returns carrier(s); we use the first
  const carriers = Array.isArray(result.content) ? result.content : [result.content];
  const firstCarrier = carriers[0]?.carrier || carriers[0];
  const dotNumber = firstCarrier?.dotNumber;

  if (!dotNumber) return null;

  // Now fetch full data using the DOT number
  return lookupByDOT(dotNumber);
}
