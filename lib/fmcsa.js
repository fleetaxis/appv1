// lib/fmcsa.js
//
// FleetAxis FMCSA Integration Layer
// =================================
// Provides a defensive wrapper around FMCSA QCMobile. The public endpoint is
// flaky enough that we keep all network/parsing/auth edge cases contained here
// so the Vercel function can return useful HTTP statuses instead of crashing.

const FMCSA_WEBKEY_ENV_NAMES = [
  'FMCSA_WEBKEY',
  'FMCSA_WEB_KEY',
  'FMCSA_API_KEY',
  'QCMOBILE_WEBKEY',
];

const FMCSA_BASE_URL = 'https://mobile.fmcsa.dot.gov/qc/services';
const SAFER_QUERY_URL = 'https://safer.fmcsa.dot.gov/query.asp';
const REQUEST_TIMEOUT_MS = 8000;

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

export class FmcsaUpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'FmcsaUpstreamError';
    this.code = 'FMCSA_UPSTREAM_ERROR';
    this.status = status;
  }
}

function getFmcsaWebKey() {
  for (const name of FMCSA_WEBKEY_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }

  throw new MissingFmcsaWebKeyError();
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function withTimeout() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

function buildFmcsaUrl(path) {
  const webKey = getFmcsaWebKey();
  const url = new URL(`${FMCSA_BASE_URL}${path}`);
  url.searchParams.set('webKey', webKey);
  return url;
}

function looksLikeAuthFailure(text) {
  return /authentication\s+failure|invalid\s+web\s*key|invalid\s+webkey|unauthorized|access\s+denied/i.test(text || '');
}

function looksLikeNotFound(payload, text) {
  const content = payload?.content;
  if (content === null || content === undefined) return true;
  if (Array.isArray(content) && content.length === 0) return true;
  return /not\s+found|no\s+record|no\s+data|unknown\s+resource/i.test(text || '');
}

function parseJsonResponse(text, url) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    if (looksLikeAuthFailure(text)) {
      throw new FmcsaAuthenticationError();
    }

    const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
    throw new FmcsaUpstreamError(`FMCSA returned non-JSON response for ${url.pathname}: ${snippet}`);
  }
}

async function fmcsaFetch(path, { optional = false } = {}) {
  const url = buildFmcsaUrl(path);
  const timeout = withTimeout();

  let response;
  let text;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: timeout.signal,
    });
    text = await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (optional) return null;
      throw new FmcsaUpstreamError(`FMCSA request timed out after ${REQUEST_TIMEOUT_MS}ms for ${url.pathname}`, 504);
    }

    if (optional) return null;
    throw new FmcsaUpstreamError(`FMCSA request failed for ${url.pathname}: ${error.message}`);
  } finally {
    timeout.clear();
  }

  if (response.status === 401 || response.status === 403 || looksLikeAuthFailure(text)) {
    throw new FmcsaAuthenticationError();
  }

  if (response.status === 404) return null;

  if (!response.ok) {
    if (optional) return null;
    throw new FmcsaUpstreamError(`FMCSA returned ${response.status} ${response.statusText} for ${url.pathname}`, response.status >= 500 ? 502 : response.status);
  }

  const payload = parseJsonResponse(text, url);
  if (looksLikeAuthFailure(JSON.stringify(payload))) {
    throw new FmcsaAuthenticationError();
  }

  if (looksLikeNotFound(payload, text)) return null;
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
  return String(text || '')
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

function getTextValue(text, label, labels) {
  const escapedLabel = escapeRegExp(label);
  const labelMatch = new RegExp(`${escapedLabel}\\s*:?`, 'i').exec(text);
  if (!labelMatch) return undefined;

  const afterLabel = text.slice(labelMatch.index + labelMatch[0].length);
  let end = afterLabel.length;

  for (const nextLabel of labels) {
    if (nextLabel === label) continue;
    const nextMatch = new RegExp(`\\b${escapeRegExp(nextLabel)}\\s*:?`, 'i').exec(afterLabel);
    if (nextMatch && nextMatch.index > 0 && nextMatch.index < end) {
      end = nextMatch.index;
    }
  }

  const value = afterLabel.slice(0, end).replace(/^[\s:]+|[\s:]+$/g, '').trim();
  return value || undefined;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(String(value).replace(/[^\d.-]/g, ''));
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

  const legalName = getTextValue(text, 'Legal Name', labels);
  if (!legalName) return null;

  const operatingStatus = getTextValue(text, 'Operating Status', labels) || '';
  const entityType = getTextValue(text, 'Entity Type', labels);
  const carrierOperationDesc = getTextValue(text, 'Carrier Operation', labels) || entityType || 'Carrier';
  const outOfServiceDate = getTextValue(text, 'Out of Service Date', labels);
  const mcs150Mileage = getTextValue(text, 'MCS-150 Mileage', labels);
  const mileageMatch = mcs150Mileage?.match(/([\d,]+)\s*\(?\s*(\d{4})?\s*\)?/);

  return {
    source: 'SAFER',
    content: {
      carrier: {
        dotNumber: dot,
        legalName,
        dbaName: getTextValue(text, 'DBA Name', labels),
        statusCode: /inactive/i.test(operatingStatus) ? 'I' : 'A',
        allowedToOperate: /not\s+authorized|out[-\s]+of[-\s]+service/i.test(operatingStatus) ? 'N' : 'Y',
        oosDate: outOfServiceDate && !/^none$/i.test(outOfServiceDate) ? outOfServiceDate : undefined,
        physicalAddress: getTextValue(text, 'Physical Address', labels),
        telephone: getTextValue(text, 'Phone', labels),
        totalPowerUnits: parseNumber(getTextValue(text, 'Power Units', labels)),
        totalDrivers: parseNumber(getTextValue(text, 'Drivers', labels)),
        mcs150Date: getTextValue(text, 'MCS-150 Form Date', labels),
        mcs150Mileage: mileageMatch?.[1]?.replace(/,/g, '') || mcs150Mileage,
        mcs150MileageYear: mileageMatch?.[2],
        carrierOperation: { carrierOperationDesc },
      },
    },
  };
}

async function saferFetchByDOT(dot) {
  const timeout = withTimeout();
  const body = new URLSearchParams({
    searchtype: 'ANY',
    query_type: 'queryCarrierSnapshot',
    query_param: 'USDOT',
    query_string: dot,
  });

  try {
    const response = await fetch(SAFER_QUERY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'FleetAxis carrier lookup',
      },
      body,
      signal: timeout.signal,
    });

    if (!response.ok) return null;
    return parseSaferSnapshot(await response.text(), dot);
  } catch {
    return null;
  } finally {
    timeout.clear();
  }
}

async function lookupCarrierIdentity(dot) {
  const qcmobileIdentity = await fmcsaFetch(`/carriers/${dot}`);
  if (qcmobileIdentity) return qcmobileIdentity;

  return saferFetchByDOT(dot);
}

function firstContent(raw) {
  const content = raw?.content ?? raw;
  if (Array.isArray(content)) return content[0];
  return content;
}

function normalizeCarrier(raw) {
  const content = firstContent(raw);
  const c = content?.carrier || content;
  if (!c) return null;

  return {
    dotNumber: c.dotNumber || c.DOTNumber,
    legalName: c.legalName || c.LegalName,
    dbaName: c.dbaName || c.DBAName,
    entityType: c.carrierOperation?.carrierOperationDesc || c.entityType || 'Carrier',
    statusCode: c.statusCode,
    allowedToOperate: c.allowedToOperate,
    outOfServiceDate: c.oosDate,
    physicalAddress: c.physicalAddress || [c.phyStreet, c.phyCity, c.phyState, c.phyZipcode].filter(Boolean).join(', '),
    phone: c.telephone || c.phone,
    powerUnits: parseNumber(c.totalPowerUnits) ?? 0,
    drivers: parseNumber(c.totalDrivers) ?? 0,
    mcs150Mileage: c.mcs150Mileage,
    mcs150MileageYear: c.mcs150MileageYear,
    mcs150Date: c.mcs150Date,
    bipdRequired: c.bipdInsuranceRequired,
    bipdOnFile: c.bipdInsuranceOnFile,
    cargoOnFile: c.cargoInsuranceOnFile,
    bondOnFile: c.bondInsuranceOnFile,
    inspections: {
      vehicleTotal: parseNumber(c.vehicleInsp),
      vehicleOOS: parseNumber(c.vehicleOosInsp),
      driverTotal: parseNumber(c.driverInsp),
      driverOOS: parseNumber(c.driverOosInsp),
      hazmatTotal: parseNumber(c.hazmatInsp),
      hazmatOOS: parseNumber(c.hazmatOosInsp),
    },
    crashes: {
      total: parseNumber(c.crashTotal),
      fatal: parseNumber(c.fatalCrash),
      injury: parseNumber(c.injCrash),
      towed: parseNumber(c.towawayCrash),
    },
    operation: c.carrierOperation,
  };
}

function normalizeBasics(raw) {
  const content = raw?.content;
  if (!content) return [];

  const basics = Array.isArray(content) ? content : [content];
  return basics.map((item) => {
    const b = item.basic || item;
    const pct = parseNumber(b.basicPercentile);
    let status = 'na';
    if (typeof pct === 'number') {
      if (pct >= 65) status = 'high';
      else if (pct >= 35) status = 'med';
      else status = 'low';
    }

    return {
      category: b.basicNameDesc,
      shortName: b.basicShortDesc,
      percentile: pct,
      thresholdExceeded: b.thresholdExceeded,
      status,
      measureDate: b.measureDate,
    };
  }).filter((basic) => basic.category || basic.shortName);
}

function normalizeCargo(raw) {
  const content = raw?.content;
  if (!content) return [];
  const cargo = Array.isArray(content) ? content : [content];
  return cargo
    .map((item) => item.cargoClassDesc || item.cargoClassification?.cargoClassDesc)
    .filter(Boolean);
}

function normalizeOperation(raw) {
  const content = raw?.content;
  if (!content) return [];
  const operation = Array.isArray(content) ? content : [content];
  return operation
    .map((item) => item.operationClassDesc || item.operationClassification?.operationClassDesc)
    .filter(Boolean);
}

function normalizeAuthority(raw) {
  const content = firstContent(raw);
  const authority = content?.carrierAuthority || content;
  if (!authority) return null;

  return {
    commonAuthorityStatus: authority.commonAuthorityStatus,
    commonAuthorityApplied: authority.commonAuthorityApplied,
    contractAuthorityStatus: authority.contractAuthorityStatus,
    contractAuthorityApplied: authority.contractAuthorityApplied,
    brokerAuthorityStatus: authority.brokerAuthorityStatus,
    brokerAuthorityApplied: authority.brokerAuthorityApplied,
    authorizedForHHG: authority.authorizedForHHG,
    authorizedForPassenger: authority.authorizedForPassenger,
    authorizedForProperty: authority.authorizedForProperty,
  };
}

async function optionalFmcsaFetch(path) {
  try {
    return await fmcsaFetch(path, { optional: true });
  } catch (error) {
    if (error instanceof FmcsaAuthenticationError) throw error;
    return null;
  }
}

export async function lookupByDOT(dotNumber) {
  const dot = digitsOnly(dotNumber);
  if (!dot) throw new Error('Invalid DOT number');

  const identity = await lookupCarrierIdentity(dot);
  if (!identity) return null;

  const [basics, cargo, operation, authority] = await Promise.all([
    optionalFmcsaFetch(`/carriers/${dot}/basics`),
    optionalFmcsaFetch(`/carriers/${dot}/cargo-carried`),
    optionalFmcsaFetch(`/carriers/${dot}/operation-classification`),
    optionalFmcsaFetch(`/carriers/${dot}/authority`),
  ]);

  return {
    dotNumber: dot,
    carrier: normalizeCarrier(identity),
    basics: normalizeBasics(basics),
    cargo: normalizeCargo(cargo),
    operation: normalizeOperation(operation),
    authority: normalizeAuthority(authority),
    source: identity.source || 'QCMobile',
    fetchedAt: new Date().toISOString(),
  };
}

export async function lookupByMC(mcNumber) {
  const mc = digitsOnly(String(mcNumber || '').replace(/^MC[-\s]*/i, ''));
  if (!mc) throw new Error('Invalid MC number');

  const docketResult = await fmcsaFetchFirst([
    `/carriers/docket-number/${mc}`,
    `/carriers/docket-number/${mc}/`,
    `/carriers/search/docket-number/${mc}`,
  ]);

  const content = firstContent(docketResult);
  const carrier = content?.carrier || content;
  const dotNumber = digitsOnly(carrier?.dotNumber || carrier?.DOTNumber);
  if (!dotNumber) return null;

  return lookupByDOT(dotNumber);
}
diff --git a/lib/fmcsa.js b/lib/fmcsa.js
index 39d3e4d3b5584ac2cf7c4e0b6185515adba2e3b7..ac844aeb6d670b869890e86a61271ad28cca0318 100644
--- a/lib/fmcsa.js
+++ b/lib/fmcsa.js
@@ -3,115 +3,294 @@
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
 
+export class FmcsaAuthenticationError extends Error {
+  constructor(message = 'FMCSA rejected the configured webkey.') {
+    super(message);
+    this.name = 'FmcsaAuthenticationError';
+    this.code = 'FMCSA_AUTHENTICATION_FAILED';
+  }
+}
+
 function getFmcsaWebKey() {
   for (const name of FMCSA_WEBKEY_ENV_NAMES) {
     const value = process.env[name]?.trim();
     if (value) return value;
   }
 
   throw new MissingFmcsaWebKeyError();
 }
 
 const FMCSA_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';
+const SAFER_QUERY_URL = 'https://safer.fmcsa.dot.gov/query.asp';
+
+function hasAuthenticationFailure(payload) {
+  const text = typeof payload === 'string'
+    ? payload
+    : `${payload?.message || ''} ${payload?.content || ''} ${payload?.error || ''}`;
+
+  return /authentication\s+failure|invalid\s+webkey|unauthorized/i.test(text);
+}
 
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
 
+  if (response.status === 401) {
+    throw new FmcsaAuthenticationError();
+  }
+
   if (!response.ok) {
     if (response.status === 404) {
       return null; // Carrier not found — caller decides what to do
     }
     throw new Error(`FMCSA API returned ${response.status}: ${response.statusText}`);
   }
 
-  return response.json();
+  const payload = await response.json();
+  if (hasAuthenticationFailure(payload)) {
+    throw new FmcsaAuthenticationError();
+  }
+
+  return payload;
+}
+
+async function fmcsaFetchFirst(paths) {
+  for (const path of paths) {
+    const result = await fmcsaFetch(path);
+    if (result) return result;
+  }
+
+  return null;
+}
+
+function decodeHtml(text) {
+  return text
+    .replace(/&nbsp;/gi, ' ')
+    .replace(/&amp;/gi, '&')
+    .replace(/&#39;/g, "'")
+    .replace(/&quot;/gi, '"')
+    .replace(/&lt;/gi, '<')
+    .replace(/&gt;/gi, '>');
+}
+
+function htmlToText(html) {
+  return decodeHtml(html)
+    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
+    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
+    .replace(/<br\s*\/?\s*>/gi, '\n')
+    .replace(/<\/(tr|td|th|div|p|table|font)>/gi, '\n')
+    .replace(/<[^>]+>/g, ' ')
+    .replace(/[ \t\r\f\v]+/g, ' ')
+    .replace(/\n\s+/g, '\n')
+    .replace(/\n{2,}/g, '\n')
+    .trim();
+}
+
+function escapeRegExp(value) {
+  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
+}
+
+function getSaferValue(text, label, nextLabels) {
+  const escapedLabel = escapeRegExp(label);
+  const start = text.search(new RegExp(`${escapedLabel}\\s*:?`, 'i'));
+  if (start === -1) return undefined;
+
+  const afterLabel = text
+    .slice(start)
+    .replace(new RegExp(`^[\\s\\S]*?${escapedLabel}\\s*:?`, 'i'), '');
+  let end = afterLabel.length;
+
+  for (const next of nextLabels) {
+    const index = afterLabel.search(new RegExp(`\\b${escapeRegExp(next)}\\s*:?`, 'i'));
+    if (index > 0 && index < end) end = index;
+  }
+
+  const value = afterLabel.slice(0, end).replace(/^[\s:]+|[\s:]+$/g, '').trim();
+  return value || undefined;
+}
+
+function parseNumber(value) {
+  if (!value) return undefined;
+  const number = Number(String(value).replace(/[^\d]/g, ''));
+  return Number.isFinite(number) ? number : undefined;
+}
+
+function parseSaferSnapshot(html, dot) {
+  const text = htmlToText(html);
+  if (!text || /no records? matching|record not found/i.test(text)) return null;
+
+  const labels = [
+    'Entity Type',
+    'Operating Status',
+    'Out of Service Date',
+    'Legal Name',
+    'DBA Name',
+    'Physical Address',
+    'Phone',
+    'Mailing Address',
+    'USDOT Number',
+    'State Carrier ID Number',
+    'MC/MX/FF Number(s)',
+    'DUNS Number',
+    'Power Units',
+    'Drivers',
+    'MCS-150 Form Date',
+    'MCS-150 Mileage',
+    'Carrier Operation',
+    'Cargo Carried',
+  ];
+
+  const legalName = getSaferValue(text, 'Legal Name', labels);
+  if (!legalName) return null;
+
+  const operatingStatus = getSaferValue(text, 'Operating Status', labels);
+  const entityType = getSaferValue(text, 'Entity Type', labels);
+  const carrierOperationDesc = getSaferValue(text, 'Carrier Operation', labels) || entityType || 'Carrier';
+  const outOfServiceDate = getSaferValue(text, 'Out of Service Date', labels);
+  const powerUnits = parseNumber(getSaferValue(text, 'Power Units', labels));
+  const drivers = parseNumber(getSaferValue(text, 'Drivers', labels));
+  const mcs150Mileage = getSaferValue(text, 'MCS-150 Mileage', labels);
+  const mileageMatch = mcs150Mileage?.match(/([\d,]+)\s*\(?\s*(\d{4})?\s*\)?/);
+
+  return {
+    source: 'SAFER',
+    content: {
+      carrier: {
+        dotNumber: dot,
+        legalName,
+        dbaName: getSaferValue(text, 'DBA Name', labels),
+        statusCode: /inactive/i.test(operatingStatus || '') ? 'I' : 'A',
+        allowedToOperate: /not\s+authorized|out[-\s]+of[-\s]+service/i.test(operatingStatus || '') ? 'N' : 'Y',
+        oosDate: outOfServiceDate && !/^none$/i.test(outOfServiceDate) ? outOfServiceDate : undefined,
+        physicalAddress: getSaferValue(text, 'Physical Address', labels),
+        telephone: getSaferValue(text, 'Phone', labels),
+        totalPowerUnits: powerUnits,
+        totalDrivers: drivers,
+        mcs150Date: getSaferValue(text, 'MCS-150 Form Date', labels),
+        mcs150Mileage: mileageMatch?.[1]?.replace(/,/g, '') || mcs150Mileage,
+        mcs150MileageYear: mileageMatch?.[2],
+        carrierOperation: { carrierOperationDesc },
+      },
+    },
+  };
+}
+
+async function saferFetchByDOT(dot) {
+  const body = new URLSearchParams({
+    searchtype: 'ANY',
+    query_type: 'queryCarrierSnapshot',
+    query_param: 'USDOT',
+    query_string: dot,
+  });
+
+  const response = await fetch(SAFER_QUERY_URL, {
+    method: 'POST',
+    headers: {
+      'Content-Type': 'application/x-www-form-urlencoded',
+      'User-Agent': 'FleetAxis carrier lookup',
+    },
+    body,
+  });
+
+  if (!response.ok) return null;
+
+  return parseSaferSnapshot(await response.text(), dot);
+}
+
+async function lookupCarrierIdentity(dot) {
+  // Prefer QCMobile JSON because it includes the richest structured carrier
+  // record. If QCMobile returns 404 for a valid DOT, SAFER can still provide the
+  // public Company Snapshot identity needed to render the lookup result.
+  const qcmobileIdentity = await fmcsaFetch(`/carriers/${dot}`);
+  if (qcmobileIdentity) return qcmobileIdentity;
+
+  return saferFetchByDOT(dot);
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
-    physicalAddress: [
+    physicalAddress: c.physicalAddress || [
       c.phyStreet,
       c.phyCity,
       c.phyState,
       c.phyZipcode,
     ].filter(Boolean).join(', '),
-    phone: c.telephone,
+    phone: c.telephone || c.phone,
 
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
@@ -188,69 +367,77 @@ function normalizeAuthority(raw) {
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
 
-  // Make several API calls in parallel for speed
-  const [identity, basics, cargo, operation, authority] = await Promise.all([
-    fmcsaFetch(`/carriers/${dot}`),
+  // Fetch identity first. If the DOT does not exist, there is no reason to make
+  // the four enrichment calls; doing so turns a simple miss into five upstream
+  // 404s in Vercel logs and makes troubleshooting harder.
+  const identity = await lookupCarrierIdentity(dot);
+  if (!identity) return null;
+
+  // Make enrichment calls in parallel after the carrier is confirmed. These
+  // resources are optional in FMCSA, so a missing enrichment endpoint should not
+  // fail an otherwise valid carrier lookup.
+  const [basics, cargo, operation, authority] = await Promise.all([
     fmcsaFetch(`/carriers/${dot}/basics`).catch(() => null),
     fmcsaFetch(`/carriers/${dot}/cargo-carried`).catch(() => null),
     fmcsaFetch(`/carriers/${dot}/operation-classification`).catch(() => null),
     fmcsaFetch(`/carriers/${dot}/authority`).catch(() => null),
   ]);
 
-  if (!identity) return null;
-
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
 
-  const result = await fmcsaFetch(`/carriers/docket-number/${mc}`);
+  const result = await fmcsaFetchFirst([
+    `/carriers/docket-number/${mc}`,
+    `/carriers/search/docket-number/${mc}`,
+  ]);
   if (!result || !result.content) return null;
 
   // The docket lookup returns carrier(s); we use the first
   const carriers = Array.isArray(result.content) ? result.content : [result.content];
   const firstCarrier = carriers[0]?.carrier || carriers[0];
   const dotNumber = firstCarrier?.dotNumber;
 
   if (!dotNumber) return null;
 
   // Now fetch full data using the DOT number
   return lookupByDOT(dotNumber);
 }
