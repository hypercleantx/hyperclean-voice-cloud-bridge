/**
 * Security helpers: Twilio signature verification, XML sanitization, and PII redaction for logs.
 * Implements EXACT Twilio validation per spec: URL + sorted form params (key + value, no separators), HMAC-SHA1, Base64.
 */

'use strict';
const crypto = require('crypto');

/**
 * Build base URL for current request
 * Uses https by default; falls back to http for localhost.
 */
function buildBaseUrl(req) {
  const host = req.get('host');
  const isLocal = /localhost|127\.0\.0\.1/i.test(host || '') || process.env.FORCE_HTTP === '1';
  const proto = isLocal ? 'http' : 'https';
  return `${proto}://${host}`;
}

/**
 * Verify Twilio request signature
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function verifyTwilio(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) throw new Error('Missing TWILIO_AUTH_TOKEN');

  const url = `${buildBaseUrl(req)}${req.originalUrl}`;
  const params = req.body || {};

  // Build data: URL + sorted form keys 'key' + 'value' (no separators)
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) {
    const v = params[k];
    if (Array.isArray(v)) {
      // Concatenate array values in order
      data += k + v.join('');
    } else {
      data += k + String(v);
    }
  }

  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  const header = req.get('X-Twilio-Signature') || '';

  // Constant-time comparison
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sanitize text for <Say>
 */
function sanitizeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Redact emails and phone numbers in logs.
 * Accepts string or object; returns redacted copy/string.
 */
function redactPII(input) {
  const redact = (val) => {
    if (val == null) return val;
    const str = String(val);
    return str
      // emails
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      // E.164 or general phone-ish sequences
      .replace(/(\+?\d[\d\-\.\s()]{6,}\d)/g, '[phone]');
  };
  if (typeof input === 'string') return redact(input);
  if (typeof input !== 'object') return input;
  const out = Array.isArray(input) ? [] : {};
  for (const [k, v] of Object.entries(input)) {
    if (v && typeof v === 'object') out[k] = redactPII(v);
    else out[k] = typeof v === 'string' ? redact(v) : v;
  }
  return out;
}

module.exports = { verifyTwilio, sanitizeXml, redactPII, buildBaseUrl };