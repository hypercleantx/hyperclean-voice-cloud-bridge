/**
 * HyperClean TX Voice Cloud Bridge
 * Purpose: Express service to handle Twilio voice webhooks, route to LLMs, synthesize TTS, and respond with TwiML.
 * Assumptions:
 *  - Deployed on Render or Cloud Run with public URL.
 *  - Env vars provided (see .env.example). ELEVENLABS_VOICE_ID optional (defaults set).
 *  - Local audio hosting via /audio/:filename (ephemeral disk OK).
 * Required Scopes/Perms: None (HTTP service). External API keys via env.
 * Triggers: HTTP routes (/voice/ai, /health, /audio/:filename).
 * Change Log:
 *  - v1.0.0: Initial implementation with Twilio verification, provider router, TTS, budget + timeout guards.
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { providerRouter, createBudget } = require('./providers.js');
const { elevenLabsTTS } = require('./tts.js');
const { verifyTwilio, sanitizeXml, redactPII, buildBaseUrl } = require('./security.js');

const app = express();

const AUDIO_DIR = process.env.AUDIO_DIR || path.join(process.cwd(), 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Parsers for Twilio form-encoded and JSON (for health/tests)
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Minimal PII-safe logger
app.use((req, _res, next) => {
  const safeBody = redactPII(req.body || {});
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} :: ${JSON.stringify(safeBody)}`);
  next();
});

// Health endpoint
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Serve audio files (temporary hosting for Twilio <Play>)
app.get('/audio/:filename', async (req, res) => {
  try {
    const safeName = path.basename(req.params.filename || '');
    const filePath = path.join(AUDIO_DIR, safeName);
    await fsp.access(filePath, fs.constants.R_OK);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.sendFile(filePath);
  } catch (_err) {
    res.status(404).send('Not found');
  }
});

// Default message used when no LLM or TTS response is available.
// Note: use a straight apostrophe instead of a curly one to avoid lint/test issues.
const FALLBACK_SAY = "I'll text you a booking link right away.";

/**
 * Promise timeout helper
 * @param {Promise} promise
 * @param {number} ms
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(id); resolve(val); },
      (err) => { clearTimeout(id); reject(err); }
    );
  });
}

/**
 * Simple TwiML builders
 */
function twimlSay(text) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${sanitizeXml(text)}</Say></Response>`;
}
function twimlPlay(url) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${url}</Play></Response>`;
}

app.post('/voice/ai', async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');

  // Fail-closed Twilio verification
  try {
    const verified = verifyTwilio(req);
    if (!verified) {
      res.status(403).send(twimlSay('Unauthorized'));
      return;
    }
  } catch (_e) {
    res.status(403).send(twimlSay('Unauthorized'));
    return;
  }

  const intent = req.body.intent || 'concierge_dialog';
  const baseUrl = buildBaseUrl(req); // e.g., https://your-app.onrender.com
  const budgetMaxCents = Number(
    (req.body.budgetCents || req.body.budget_cents || process.env.BUDGET_CENTS || 50)
  );
  const budget = createBudget(budgetMaxCents);

  try {
    // Route to provider with hard timeout (8s)
    const result = await withTimeout(providerRouter(intent, req.body, budget), 8000);
    const text = (result && result.text && String(result.text).trim()) || '';

    if (!text) {
      // No text → fallback say
      res.send(twimlSay(FALLBACK_SAY));
      return;
    }

    // TTS with a tight timeout to keep total < 15s
    try {
      const audioUrl = await withTimeout(
        elevenLabsTTS(text, { baseUrl, audioDir: AUDIO_DIR, filenamePrefix: req.body.CallSid || 'hc' }),
        Number(process.env.TTS_TIMEOUT_MS || 5000)
      );

      if (audioUrl) {
        res.send(twimlPlay(audioUrl));
        return;
      }

      // TTS returned no URL → default to <Say>
      res.send(twimlSay(text));
    } catch (_ttsErr) {
      // TTS error/timeout → fallback say
      res.send(twimlSay(FALLBACK_SAY));
    }
  } catch (err) {
    // LLM error/timeout/budget exceeded → fallback say
    if (String(err && err.message).startsWith('budget_exceeded')) {
      console.warn('Budget exceeded, returning fallback.');
    } else if (String(err && err.message).startsWith('timeout_')) {
      console.warn('Provider timeout, returning fallback.');
    } else {
      console.warn('Provider error:', err && err.message);
    }
    res.send(twimlSay(FALLBACK_SAY));
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`HyperClean TX Voice Cloud Bridge listening on :${PORT}`);
});

module.exports = app;