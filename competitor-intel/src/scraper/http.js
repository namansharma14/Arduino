// Shared HTTP layer for scrape configs, used by both the engine and the verifier
// so a saved config behaves identically in each.
//
// A config may carry: method (default GET), headers (merged over ours, config
// wins), body (object → JSON, string → sent as-is). Any string in the body that
// is exactly '<uuid>' is replaced with a fresh id per call — several rate APIs
// (Travel Money Oz among them) reject requests without a unique request id.

import { randomUUID } from 'node:crypto';
import { DEFAULTS } from '../config.js';

export const UUID_PLACEHOLDER = '<uuid>';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function fillPlaceholders(value) {
  if (typeof value === 'string') return value === UUID_PLACEHOLDER ? randomUUID() : value;
  if (Array.isArray(value)) return value.map(fillPlaceholders);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v)]));
  }
  return value;
}

// The inverse, for bodies captured from a page: a request id baked into a stored
// config would be replayed forever, so put the placeholder back.
export function templatiseUuids(value) {
  if (typeof value === 'string') return UUID_RE.test(value) ? UUID_PLACEHOLDER : value;
  if (Array.isArray(value)) return value.map(templatiseUuids);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, templatiseUuids(v)]));
  }
  return value;
}

// Case-insensitive set: a config's 'content-type' must replace our 'Content-Type'
// rather than land beside it (fetch would send both).
function setHeader(headers, name, value) {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
  headers[name] = value;
}

export function buildRequest(config = {}, signal = null) {
  const wantsJson = (config.strategy || '').toLowerCase() === 'json';
  const method = String(config.method || 'GET').toUpperCase();
  const headers = {
    'User-Agent': DEFAULTS.userAgent,
    Accept: wantsJson ? 'application/json,*/*' : 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-AU,en;q=0.9',
  };
  let body;
  if (config.body != null && method !== 'GET' && method !== 'HEAD') {
    const filled = fillPlaceholders(config.body);
    if (typeof filled === 'string') {
      body = filled;
    } else {
      body = JSON.stringify(filled);
      setHeader(headers, 'Content-Type', 'application/json');
    }
  }
  for (const [k, v] of Object.entries(config.headers || {})) setHeader(headers, k, v);
  return { method, headers, body, redirect: 'follow', ...(signal ? { signal } : {}) };
}

// Fetch with the scrape timeout. Returns the raw response + body text; callers
// decide what a bad status means.
export async function scrapeFetch(url, config = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULTS.scrapeTimeoutMs);
  try {
    const res = await fetch(url, buildRequest(config, controller.signal));
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch and return the payload a strategy expects: parsed JSON or raw text.
export async function fetchPayload(url, config = {}) {
  const { res, text } = await scrapeFetch(url, config);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return (config.strategy || '').toLowerCase() === 'json' ? JSON.parse(text) : text;
}
