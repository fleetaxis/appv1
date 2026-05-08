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

const FMCSA_WEBKEY_ENV_NAMES = [
  'FMCSA_WEBKEY',
  'FMCSA_WEB_KEY',
  'FMCSA_API_KEY',
  'QCMOBILE_WEBKEY',
];

export class MissingFmcsaWebKeyError extends Error {
  constructor() {
    super(`FMCSA webkey is not configured. Set ${FMCSA_WEBKEY_ENV_NAMES[0]} in your deployment environment.`);
    this.name = 'MissingFmcsaWebKeyError';
    this.code = 'FMCSA_WEBKEY_MISSING';
    this.envNames = FMCSA_WEBKEY_ENV_NAMES;
  }
}

export class FmcsaAuthenticationError extends Error {
  constructor(message = 'FMCSA rejected the configured webkey.') {
    super(message);
    this.name = 'FmcsaAuthenticationError';
    this.code = 'FMCSA_AUTHENTICATION_FAILED';
  }
}

function getFmcsaWebKey() {
  for (const name of FMCSA_WEBKEY_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }

  throw new MissingFmcsaWebKeyError();
}

const FMCSA_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';
const SAFER_QUERY_URL = 'https://safer.fmcsa.dot.gov/query.asp';

function hasAuthenticationFailure(payload) {
  const text = typeof payload === 'string'
    ? payload
    : `${payload?.message || ''} ${payload?.content || ''} ${payload?.error || ''}`;

  return /authentication\s+failure|invalid\s+webkey|unauthorized/i.test(text);
}

/**
 * Internal helper — makes a request to the FMCSA API and returns parsed JSON.
 * Handles errors gracefully so callers always get a predictable shape.
 */
async function fmcsaFetch(path) {
  const webKey = getFmcsaWebKey();

  const url = `${FMCSA_BASE}${path}${path.includes('?') ? '&' : '?'}webKey=${encodeURIComponent(webKey)}`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (response.status === 401) {
    throw new FmcsaAuthenticationError();
  }

  if (!response.ok) {
    if (response.status === 404) {
      return null; // Carrier not found — caller decides what to do
    }
    throw new Error(`FMCSA API returned ${response.status}: ${response.statusText}`);
  }

  const payload = await response.json();
  if (hasAuthenticationFailure(payload)) {
    throw new FmcsaAuthenticationError();
  }

  return payload;
}

async function fmcsaFetchFirst(paths) {
  for (const path of paths) {
    const result = await fmcsaFetch(path);
    if (result) return result;
  }

  return null;
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlToText(html) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(tr|td|th|div|p|table|font)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSaferValue(text, label, nextLabels) {
  const escapedLabel = escapeRegExp(label);
  const start = text.search(new RegExp(`${escapedLabel}\\s*:?`, 'i'));
  if (start === -1) return undefined;

  const afterLabel = text
    .slice(start)
    .replace(new RegExp(`^[\\s\\S]*?${escapedLabel}\\s*:?`, 'i'), '');
  let end = afterLabel.length;

  for (const next of nextLabels) {
    const index = afterLabel.search(new RegExp(`\\b${escapeRegExp(next)}\\s*:?`, 'i'));
    if (index > 0 && index < end) end = index;
  }

  const value = afterLabel.slice(0, end).replace(/^[\s:]+|[\s:]+$/g, '').trim();
  return value || undefined;
}

function parseNumber(value) {
  if (!value) return undefined;
  const number = Number(String(value).replace(/[^\d]/g, ''));
  return Number.isFinite(number) ? number : undefined;
}

function parseSaferSnapshot(html, dot) {
  const text = htmlToText(html);
  if (!text || /no records? matching|record not found/i.test(text)) return null;

  const labels = [
    'Entity Type',
    'Operating Status',
    'Out of Service Date',
    'Legal Name',
    'DBA Name',
    'Physical Address',
    'Phone',
    'Mailing Address',
    'USDOT Number',
    'State Carrier ID Number',
    'MC/MX/FF Number(s)',
    'DUNS Number',
    'Power Units',
    'Drivers',
    'MCS-150 Form Date',
    'MCS-150 Mileage',
    'Carrier Operation',
    'Cargo Carried',
  ];

  const legalName = getSaferValue(text, 'Legal Name', labels);
  if (!legalName) return null;

  const operatingStatus = getSaferValue(text, 'Operating Status', labels);
  const entityType = getSaferValue(text, 'Entity Type', labels);
  const carrierOperationDesc = getSaferValue(text, 'Carrier Operation', labels) || entityType || 'Carrier';
  const outOfServiceDate = getSaferValue(text, 'Out of Service Date', labels);
  const powerUnits = parseNumber(getSaferValue(text, 'Power Units', labels));
  const drivers = parseNumber(getSaferValue(text, 'Drivers', labels));
  const mcs150Mileage = getSaferValue(text, 'MCS-150 Mileage', labels);
  const mileageMatch = mcs150Mileage?.match(/([\d,]+)\s*\(?\s*(\d{4})?\s*\)?/);

  return {
    source: 'SAFER',
    content: {
      carrier: {
        dotNumber: dot,
        legalName,
        dbaName: getSaferValue(text, 'DBA Name', labels),
        statusCode: /inactive/i.test(operatingStatus || '') ? 'I' : 'A',
        allowedToOperate: /not\s+authorized|out[-\s]+of[-\s]+service/i.test(operatingStatus || '') ? 'N' : 'Y',
        oosDate: outOfServiceDate && !/^none$/i.test(outOfServiceDate) ? outOfServiceDate : undefined,
        physicalAddress: getSaferValue(text, 'Physical Address', labels),
        telephone: getSaferValue(text, 'Phone', labels),
        totalPowerUnits: powerUnits,
        totalDrivers: drivers,
        mcs150Date: getSaferValue(text, 'MCS-150 Form Date', labels),
        mcs150Mileage: mileageMatch?.[1]?.replace(/,/g, '') || mcs150Mileage,
        mcs150MileageYear: mileageMatch?.[2],
        carrierOperation: { carrierOperationDesc },
      },
    },
  };
}

async function saferFetchByDOT(dot) {
  const body = new URLSearchParams({
    searchtype: 'ANY',
    query_type: 'queryCarrierSnapshot',
    query_param: 'USDOT',
    query_string: dot,
  });

  const response = await fetch(SAFER_QUERY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'FleetAxis carrier lookup',
    },
    body,
  });

  if (!response.ok) return null;

  return parseSaferSnapshot(await response.text(), dot);
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
    physicalAddress: c.physicalAddress || [
      c.phyStreet,
      c.phyCity,
      c.phyState,
      c.phyZipcode,
    ].filter(Boolean).join(', '),
    phone: c.telephone || c.phone,

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

  // Fetch identity first. If the DOT does not exist, there is no reason to make
  // the four enrichment calls; doing so turns a simple miss into five upstream
  // 404s in Vercel logs and makes troubleshooting harder.
  const identity = await fmcsaFetch(`/carriers/${dot}`) || await saferFetchByDOT(dot);
  if (!identity) return null;

  // Make enrichment calls in parallel after the carrier is confirmed. These
  // resources are optional in FMCSA, so a missing enrichment endpoint should not
  // fail an otherwise valid carrier lookup.
  const [basics, cargo, operation, authority] = await Promise.all([
    fmcsaFetch(`/carriers/${dot}/basics`).catch(() => null),
    fmcsaFetch(`/carriers/${dot}/cargo-carried`).catch(() => null),
    fmcsaFetch(`/carriers/${dot}/operation-classification`).catch(() => null),
    fmcsaFetch(`/carriers/${dot}/authority`).catch(() => null),
  ]);

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

  const result = await fmcsaFetchFirst([
    `/carriers/docket-number/${mc}`,
    `/carriers/search/docket-number/${mc}`,
  ]);
  if (!result || !result.content) return null;

  // The docket lookup returns carrier(s); we use the first
  const carriers = Array.isArray(result.content) ? result.content : [result.content];
  const firstCarrier = carriers[0]?.carrier || carriers[0];
  const dotNumber = firstCarrier?.dotNumber;

  if (!dotNumber) return null;

  // Now fetch full data using the DOT number
  return lookupByDOT(dotNumber);
}
