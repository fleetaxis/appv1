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
const DOT_DATA_BASE_URL = 'https://data.transportation.gov/resource';
const CARRIER_HISTORY_DATASET_IDS = ['u4i8-4m26', '6eyk-hxee'];

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


function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstDefined(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== '');
}

async function dotDataFetch(datasetId, params, { optional = true } = {}) {
  const url = new URL(`${DOT_DATA_BASE_URL}/${datasetId}.json`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const timeout = withTimeout();
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: timeout.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      if (optional) return null;
      throw new FmcsaUpstreamError(`DOT Data Portal returned ${response.status} ${response.statusText} for ${datasetId}`, response.status >= 500 ? 502 : response.status);
    }

    try {
      const payload = JSON.parse(text || '[]');
      return Array.isArray(payload) ? payload : [];
    } catch (error) {
      if (optional) return null;
      throw new FmcsaUpstreamError(`DOT Data Portal returned non-JSON response for ${datasetId}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  } catch (error) {
    if (error instanceof FmcsaUpstreamError) throw error;
    if (optional) return null;

    if (error?.name === 'AbortError') {
      throw new FmcsaUpstreamError(`DOT Data Portal request timed out after ${REQUEST_TIMEOUT_MS}ms for ${datasetId}`, 504);
    }

    throw new FmcsaUpstreamError(`DOT Data Portal request failed for ${datasetId}: ${error.message}`);
  } finally {
    timeout.clear();
  }
}

function docketCandidates(prefix, number) {
  const digits = digitsOnly(number);
  if (!digits) return [];

  return [...new Set([
    `${prefix}${digits}`,
    `${prefix}-${digits}`,
    `${prefix}${digits.padStart(6, '0')}`,
    `${prefix}${digits.padStart(8, '0')}`,
    digits,
  ])];
}

function normalizeAuthorityStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'A') return 'Active';
  if (normalized === 'I') return 'Inactive';
  if (normalized === 'N') return 'No Authority';
  if (normalized === 'Y') return 'Pending';
  return value || undefined;
}

function rowValue(row, ...keys) {
  if (!row) return undefined;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key];
      if (value !== null && value !== undefined && String(value).trim() !== '') return value;
    }
  }

  const normalizedKeys = Object.keys(row).reduce((acc, existingKey) => {
    acc[existingKey.replace(/[^a-z0-9]/gi, '').toLowerCase()] = existingKey;
    return acc;
  }, {});

  for (const key of keys) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const existingKey = normalizedKeys[normalized];
    if (existingKey) {
      const value = row[existingKey];
      if (value !== null && value !== undefined && String(value).trim() !== '') return value;
    }
  }

  return undefined;
}

function normalizeCarrierHistoryRow(row, docketNumber) {
  if (!row) return null;

  const dotNumber = digitsOnly(rowValue(row, 'usdot_number', 'dot_number', 'usdot', 'dot'));
  const legalName = firstDefined(rowValue(row, 'legal_name', 'legalname', 'name'), rowValue(row, 'carrier_name', 'carriername'));
  if (!dotNumber && !legalName) return null;

  const physicalAddress = compactWhitespace([
    rowValue(row, 'phy_street', 'physical_street', 'physical_address', 'street'),
    rowValue(row, 'phy_city', 'physical_city', 'city'),
    rowValue(row, 'phy_state', 'physical_state', 'state'),
    rowValue(row, 'phy_zipcode', 'physical_zip', 'zip_code', 'zip'),
  ].filter(Boolean).join(', '));

  const commonAuthority = rowValue(row, 'common_authority', 'common_auth');
  const contractAuthority = rowValue(row, 'contract_authority', 'contract_auth');
  const brokerAuthority = rowValue(row, 'broker_authority', 'broker_auth');
  const hasActiveAuthority = [commonAuthority, contractAuthority, brokerAuthority]
    .some((authority) => String(authority || '').trim().toUpperCase() === 'A');
  const hasPendingAuthority = [
    rowValue(row, 'pending_common_authority', 'pending_common_auth'),
    rowValue(row, 'pending_contract_authority', 'pending_contract_auth'),
    rowValue(row, 'pending_broker_authority', 'pending_broker_auth'),
  ].some((authority) => String(authority || '').trim().toUpperCase() === 'Y');

  const statusCode = hasActiveAuthority ? 'A' : 'I';
  const mcmisStatus = hasActiveAuthority ? 'Active' : (hasPendingAuthority ? 'Pending Authority' : 'Not Authorized');

  return {
    source: 'DOT Data Portal',
    content: {
      carrier: {
        dotNumber,
        legalName,
        dbaName: rowValue(row, 'dba_name', 'dba'),
        statusCode,
        allowedToOperate: hasActiveAuthority ? 'Y' : 'N',
        allowToOperate: hasActiveAuthority ? 'Y' : 'N',
        outOfService: 'N',
        mcmisStatus,
        physicalAddress,
        telephone: rowValue(row, 'telephone', 'phone'),
        totalPowerUnits: parseNumber(rowValue(row, 'total_power_units', 'power_units')),
        totalDrivers: parseNumber(rowValue(row, 'total_drivers', 'drivers')),
        carrierOperation: {
          carrierOperationDesc: rowValue(row, 'carrier_operation', 'carrier_operation_desc', 'operation_classification') || 'Carrier',
        },
      },
    },
    authority: {
      commonAuthorityStatus: normalizeAuthorityStatus(commonAuthority),
      contractAuthorityStatus: normalizeAuthorityStatus(contractAuthority),
      brokerAuthorityStatus: normalizeAuthorityStatus(brokerAuthority),
      commonAuthorityApplied: rowValue(row, 'pending_common_authority', 'pending_common_auth'),
      contractAuthorityApplied: rowValue(row, 'pending_contract_authority', 'pending_contract_auth'),
      brokerAuthorityApplied: rowValue(row, 'pending_broker_authority', 'pending_broker_auth'),
      docketNumber: docketNumber || rowValue(row, 'docket_number', 'docket'),
    },
  };
}

async function carrierHistoryFetchByDocket(mc) {
  const candidates = docketCandidates('MC', mc);
  const normalizedCandidates = new Set(candidates.map((candidate) => candidate.replace(/[^a-z0-9]/gi, '').toUpperCase()));

  for (const datasetId of CARRIER_HISTORY_DATASET_IDS) {
    for (const docket of candidates) {
      const rows = await dotDataFetch(datasetId, {
        '$limit': '10',
        '$q': docket,
      });

      const matchingRow = rows?.find((row) => {
        const rowDocket = rowValue(row, 'docket_number', 'docket', 'docket_num', 'mc_mx_ff_number');
        return normalizedCandidates.has(String(rowDocket || '').replace(/[^a-z0-9]/gi, '').toUpperCase());
      }) || rows?.[0];

      const normalized = normalizeCarrierHistoryRow(matchingRow, docket);
      if (normalized) return normalized;
    }
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


function normalizeFlag(value) {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim().toUpperCase();
  if (['Y', 'YES', 'TRUE', '1'].includes(normalized)) return 'Y';
  if (['N', 'NO', 'FALSE', '0'].includes(normalized)) return 'N';
  return undefined;
}

function normalizeDateValue(value) {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim();
  if (!normalized || /^(none|n\/?a|null|undefined|0)$/i.test(normalized)) return undefined;
  return normalized;
}

function normalizeMcmisStatusText(value) {
  const text = String(value || '').trim();
  if (!text) return undefined;
  if (/^active$/i.test(text)) return 'Active';
  if (/^inactive$/i.test(text)) return 'Inactive';
  if (/^a$/i.test(text)) return 'Active';
  if (/^i$/i.test(text)) return 'Inactive';
  return text;
}

function normalizeMcmisStatus(statusCode, allowedToOperate, outOfService) {
  const code = String(statusCode || '').trim().toUpperCase();
  if (outOfService === 'Y') return 'Out of Service';
  if (code === 'A') return 'Active';
  if (code === 'I') return 'Inactive';
  if (allowedToOperate === 'Y') return 'Active';
  if (allowedToOperate === 'N') return 'Not Authorized';
  return normalizeMcmisStatusText(code);
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : undefined;
}

function parseSaferSnapshot(html, dotHint) {
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
  const outOfServiceDate = normalizeDateValue(getTextValue(text, 'Out of Service Date', labels));
  const isOutOfService = /out[-\s]+of[-\s]+service/i.test(operatingStatus) || Boolean(outOfServiceDate);
  const statusCode = /inactive/i.test(operatingStatus) ? 'I' : 'A';
  const allowedToOperate = /not\s+authorized|out[-\s]+of[-\s]+service/i.test(operatingStatus) ? 'N' : 'Y';
  const mcs150Mileage = getTextValue(text, 'MCS-150 Mileage', labels);
  const mileageMatch = mcs150Mileage?.match(/([\d,]+)\s*\(?\s*(\d{4})?\s*\)?/);

  const dotNumber = digitsOnly(getTextValue(text, 'USDOT Number', labels)) || digitsOnly(dotHint);
  if (!dotNumber) return null;

  return {
    source: 'SAFER',
    content: {
      carrier: {
        dotNumber,
        legalName,
        dbaName: getTextValue(text, 'DBA Name', labels),
        statusCode,
        allowedToOperate,
        allowToOperate: allowedToOperate,
        outOfService: isOutOfService ? 'Y' : 'N',
        mcmisStatus: normalizeMcmisStatusText(operatingStatus) || normalizeMcmisStatus(statusCode, allowedToOperate, isOutOfService ? 'Y' : 'N'),
        oosDate: outOfServiceDate,
        outOfServiceDate,
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

async function saferFetchSnapshot(queryParam, queryString, dotHint) {
  const timeout = withTimeout();
  const body = new URLSearchParams({
    searchtype: 'ANY',
    query_type: 'queryCarrierSnapshot',
    query_param: queryParam,
    query_string: queryString,
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
    return parseSaferSnapshot(await response.text(), dotHint);
  } catch {
    return null;
  } finally {
    timeout.clear();
  }
}

async function saferFetchByDOT(dot) {
  return saferFetchSnapshot('USDOT', dot, dot);
}

async function saferFetchByMC(mc) {
  return saferFetchSnapshot('MC_MX', mc);
}

async function lookupCarrierIdentity(dot) {
  try {
    const qcmobileIdentity = await fmcsaFetch(`/carriers/${dot}`);
    if (qcmobileIdentity) return qcmobileIdentity;
  } catch (error) {
    if (error instanceof FmcsaAuthenticationError) throw error;
  }

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

  const allowedToOperate = normalizeFlag(c.allowedToOperate ?? c.allowToOperate);
  const outOfService = normalizeFlag(c.outOfService);
  const outOfServiceDate = normalizeDateValue(c.oosDate ?? c.outOfServiceDate);
  const statusCode = String(c.statusCode || '').trim().toUpperCase() || undefined;
  const isOutOfService = outOfService === 'Y' || (outOfService === undefined && Boolean(outOfServiceDate));
  const mcmisStatus = normalizeMcmisStatusText(c.mcmisStatus ?? c.mcmisCarrierStatus) || normalizeMcmisStatus(
    statusCode,
    allowedToOperate,
    isOutOfService ? 'Y' : 'N',
  );

  return {
    dotNumber: c.dotNumber || c.DOTNumber,
    legalName: c.legalName || c.LegalName,
    dbaName: c.dbaName || c.DBAName,
    entityType: c.carrierOperation?.carrierOperationDesc || c.entityType || 'Carrier',
    statusCode,
    allowedToOperate,
    outOfService,
    outOfServiceDate,
    mcmisStatus,
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

async function buildLookupResult(dot, identity) {
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

export async function lookupByDOT(dotNumber) {
  const dot = digitsOnly(dotNumber);
  if (!dot) throw new Error('Invalid DOT number');

  const identity = await lookupCarrierIdentity(dot);
  if (!identity) return null;

  return buildLookupResult(dot, identity);
}

export async function lookupByMC(mcNumber) {
  const mc = digitsOnly(String(mcNumber || '').replace(/^MC[-\s]*/i, ''));
  if (!mc) throw new Error('Invalid MC number');

  const docketResult = await saferFetchByMC(mc)
    || await carrierHistoryFetchByDocket(mc)
    || await fmcsaFetchFirst([
      `/carriers/docket-number/${mc}`,
      `/carriers/docket-number/${mc}/`,
      `/carriers/search/docket-number/${mc}`,
    ]);

  const content = firstContent(docketResult);
  const carrier = content?.carrier || content;
  const dotNumber = digitsOnly(carrier?.dotNumber || carrier?.DOTNumber);
  if (!dotNumber) return null;

  if (docketResult?.source === 'SAFER' || docketResult?.source === 'DOT Data Portal') {
    const result = await buildLookupResult(dotNumber, docketResult);
    if (docketResult.authority) {
      result.authority = { ...docketResult.authority, ...result.authority };
    }
    return result;
  }

  return lookupByDOT(dotNumber);
}
